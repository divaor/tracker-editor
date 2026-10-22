// Read aloud, one passage at a time, so reading can be paused, skipped and
// highlighted, with a reader's pauses between passages. Two engines:
// - device: the device's own voices (Web Speech API). Free and offline; how
//   natural it sounds depends on the voices installed. The screen stays on
//   while reading, because phones stop speech when it turns off.
// - server: a speech server with an OpenAI-compatible API (Kokoro on this
//   computer, OpenAI, …) for natural voices. Played as audio, the next passage
//   fetched ahead, with play/pause on the lock screen and the screen free to
//   turn off.
import { localFetch } from './localFetch.js';
import { getSettings, saveSettings } from './settings.js';
import { detectLanguage, passageAt, rankVoices, serverVoiceFor, speechPassages } from './speech.js';

export const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
// Passage size: device voices speak sentence by sentence, a speech server gets whole paragraphs for better intonation.
const MAX_PASSAGE = { device: 240, server: 700 };
const AHEAD = 2; // speech-server passages fetched ahead of the one playing

let state = { status: 'idle', key: null, name: '', index: 0, total: 0, lang: '', engine: 'device', loading: false, error: '' };
let passages = [];
let highlight = () => {};
const listeners = new Set();

let run = 0; // bumped whenever speech is interrupted, so callbacks of the old passage do nothing
let gapTimer = null;
let wakeLock = null;
let audio = null; // the server engine's player
let audioIndex = -1; // the passage loaded in it
let audioUrls = new Map(); // passage index → Promise of an object URL
let fetches = null; // AbortController for this reading's server requests

const synth = () => window.speechSynthesis;
export const canSpeak = () => typeof window !== 'undefined' && Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);
export const voices = () => (canSpeak() ? synth().getVoices() : []);
export const getReaderState = () => state;
const usesServer = () => getSettings().tts.engine === 'server';

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
  updateMediaSession();
}

export function onReaderState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** `fn(key, { from, to } | null)` shows the passage being read. */
export function setReaderHighlighter(fn) {
  highlight = fn;
}

async function keepScreenOn(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    // Not allowed here; reading goes on with the screen's normal timeout.
  }
}

// ---- Device voices -----------------------------------------------------------------

/** The chosen voice, else the most natural-sounding one for the text's language, else the device default. */
function pickVoice(lang) {
  const all = voices();
  const chosen = getSettings().tts.voice && all.find((v) => v.voiceURI === getSettings().tts.voice);
  if (chosen) return chosen;
  const best = rankVoices(all, lang)[0];
  return best && lang && best.lang.toLowerCase().replace('_', '-').startsWith(lang) ? best : null;
}

function speakDevice(passage, next, fail) {
  const u = new SpeechSynthesisUtterance(passage.text);
  const voice = pickVoice(state.lang);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else if (state.lang) u.lang = state.lang;
  const { rate } = getSettings().tts;
  // Headings a touch slower, like a reader announcing a section.
  u.rate = passage.kind === 'heading' ? rate * 0.92 : rate;
  u.onend = next;
  u.onerror = (e) => e.error !== 'interrupted' && e.error !== 'canceled' && fail(e.error === 'not-allowed' ? 'Tap play to start reading.' : `Reading stopped (${e.error}).`);
  synth().speak(u);
}

// ---- Speech server -----------------------------------------------------------------

/** Asks the speech server for one passage; resolves to an object URL of the audio. */
async function synthesize(text, signal) {
  const s = getSettings().tts.server;
  const base = s.baseUrl.trim().replace(/\/+$/, '');
  let res;
  try {
    res = await localFetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {}) },
      body: JSON.stringify({ model: s.model, voice: serverVoiceFor(s, state.lang), input: text, response_format: 'mp3', ...(s.instructions.trim() ? { instructions: s.instructions.trim() } : {}) }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error(`Could not reach the speech server at ${base}. Is it running?`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let detail = body.slice(0, 200);
    try {
      detail = JSON.parse(body)?.error?.message ?? JSON.parse(body)?.detail ?? detail;
    } catch {
      // not JSON
    }
    throw new Error(`The speech server answered ${res.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
  return URL.createObjectURL(await res.blob());
}

function audioFor(index) {
  if (!audioUrls.has(index)) {
    const promise = synthesize(passages[index].text, fetches?.signal);
    promise.catch(() => audioUrls.get(index) === promise && audioUrls.delete(index));
    audioUrls.set(index, promise);
  }
  return audioUrls.get(index);
}

function forgetAudio(keep = () => false) {
  for (const [i, promise] of audioUrls) {
    if (keep(i)) continue;
    promise.then(URL.revokeObjectURL, () => {});
    audioUrls.delete(i);
  }
}

async function playServer(passage, myRun, next, fail) {
  const index = state.index;
  if (!audioUrls.has(index)) set({ loading: true });
  let url;
  try {
    url = await audioFor(index);
  } catch (err) {
    if (err?.name !== 'AbortError') fail(err.message);
    return;
  } finally {
    if (myRun === run) set({ loading: false });
  }
  if (myRun !== run || state.status !== 'playing') return;
  for (let i = index + 1; i <= Math.min(index + AHEAD, passages.length - 1); i++) audioFor(i).catch(() => {});
  forgetAudio((i) => i >= index - 1);
  audio ??= new Audio();
  audio.src = url;
  audioIndex = index;
  audio.playbackRate = getSettings().tts.rate;
  audio.preservesPitch = true;
  audio.onended = next;
  audio.onerror = () => fail('This device cannot play the audio the speech server sent.');
  try {
    await audio.play();
  } catch (err) {
    // A pause right after the start cancels play() (AbortError); that is not a failure.
    if (err?.name !== 'AbortError' && myRun === run) fail(err?.name === 'NotAllowedError' ? 'Tap play to start reading.' : err.message);
  }
}

function updateMediaSession() {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || state.engine !== 'server') return;
  const session = navigator.mediaSession;
  if (state.status === 'idle') {
    session.metadata = null;
    session.playbackState = 'none';
    return;
  }
  if (typeof MediaMetadata === 'function') session.metadata = new MediaMetadata({ title: state.name, artist: 'Tracker Editor', album: `Passage ${state.index + 1} of ${state.total}` });
  session.playbackState = state.status === 'playing' ? 'playing' : 'paused';
}

function setMediaHandlers(on) {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
  const handlers = { play: resumeReading, pause: pauseReading, stop: stopReading, previoustrack: () => skipReading(-1), nexttrack: () => skipReading(1) };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, on ? fn : null);
    } catch {
      // action not supported here
    }
  }
}

// ---- Reading ---------------------------------------------------------------------

// Stops whatever is speaking; the passage and position stay.
function silence() {
  run++;
  clearTimeout(gapTimer);
  gapTimer = null;
  if (canSpeak()) synth().cancel();
  if (audio) audio.pause();
  audioIndex = -1;
}

function speakCurrent() {
  const passage = passages[state.index];
  if (!passage) return finish();
  const myRun = run;
  highlight(state.key, passage);
  const next = () => {
    if (myRun !== run) return;
    if (state.index + 1 >= passages.length) return finish();
    // The device voices get a reader's pause; a speech server's audio already breathes.
    const gap = state.engine === 'device' ? passage.pause / getSettings().tts.rate : 0;
    gapTimer = setTimeout(() => {
      gapTimer = null;
      if (myRun !== run) return;
      set({ index: state.index + 1 });
      speakCurrent();
    }, gap);
  };
  const fail = (message) => myRun === run && finish(message);
  if (state.engine === 'server') playServer(passage, myRun, next, fail);
  else speakDevice(passage, next, fail);
}

function finish(error = '') {
  silence();
  highlight(state.key, null);
  fetches?.abort();
  forgetAudio();
  passages = [];
  set({ status: 'idle', index: 0, total: 0, loading: false, error });
  setMediaHandlers(false);
  keepScreenOn(false);
}

/**
 * Reads `text` aloud from the passage at `from`; with a selection (to > from),
 * only the selection. Markdown is read as prose. The language (en, es, …) is
 * guessed from the text unless given.
 */
export function startReading({ key, name, text, markdown = false, from = 0, to = 0, lang: language = '' }) {
  const engine = usesServer() ? 'server' : 'device';
  if (engine === 'device' && !canSpeak()) throw new Error('This browser cannot read aloud. Choose a speech server in Settings → Read aloud.');
  if (state.status !== 'idle') finish();
  const lang = language || detectLanguage(text) || (navigator.language || 'en').slice(0, 2).toLowerCase();
  const options = { markdown, lang, maxPassage: MAX_PASSAGE[engine] };
  const selection = to > from;
  const list = selection ? speechPassages(text.slice(from, to), options).map((p) => ({ ...p, from: p.from + from, to: p.to + from })) : speechPassages(text, options);
  if (!list.length) throw new Error('There is nothing to read here.');
  passages = list;
  fetches = new AbortController();
  if (engine === 'device') {
    synth().cancel(); // clears a queue some browsers keep after a page reload
    keepScreenOn(true);
  } else setMediaHandlers(true);
  set({ status: 'playing', key, name, index: selection ? 0 : passageAt(list, from), total: list.length, lang, engine, loading: false, error: '' });
  speakCurrent();
}

export function pauseReading() {
  if (state.status !== 'playing') return;
  // The server engine pauses mid-sentence; device voices restart the passage on resume.
  if (state.engine === 'server' && audioIndex === state.index && !gapTimer) audio.pause();
  else silence();
  set({ status: 'paused' });
  keepScreenOn(false);
}

export function resumeReading() {
  if (state.status !== 'paused') return;
  set({ status: 'playing' });
  if (state.engine === 'server' && audio && audioIndex === state.index && !audio.ended) {
    audio.play().catch(() => speakCurrent());
    return;
  }
  if (state.engine === 'device') keepScreenOn(true);
  speakCurrent();
}

export const toggleReading = () => (state.status === 'playing' ? pauseReading() : resumeReading());
export const stopReading = () => state.status !== 'idle' && finish();

/** Moves `step` passages forward or back. */
export function skipReading(step) {
  if (state.status === 'idle') return;
  const index = Math.max(0, Math.min(passages.length - 1, state.index + step));
  silence();
  set({ index });
  if (state.status === 'playing') speakCurrent();
  else highlight(state.key, passages[index]);
}

export function setReadingRate(rate) {
  saveSettings({ tts: { rate } });
  if (state.engine === 'server' && audio) audio.playbackRate = rate;
  else if (state.status === 'playing') {
    // A new speed applies from the start of the current passage.
    silence();
    speakCurrent();
  }
  set({});
}

export function setReadingVoice(voice) {
  saveSettings({ tts: { voice } });
  if (state.engine === 'device' && state.status === 'playing') {
    silence();
    speakCurrent();
  }
  set({});
}

if (typeof document !== 'undefined') {
  // The screen lock is dropped when the app is hidden; take it again on return.
  document.addEventListener('visibilitychange', () => state.status === 'playing' && state.engine === 'device' && keepScreenOn(true));
}
