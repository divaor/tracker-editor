// Read aloud with the device's own voices (Web Speech API). One passage is
// spoken at a time, so reading can be paused, skipped and highlighted, and
// long texts are not cut off. The screen stays on while reading.
import { getSettings, saveSettings } from './settings.js';
import { detectLanguage, passageAt, speechPassages } from './speech.js';

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

let state = { status: 'idle', key: null, name: '', index: 0, total: 0, lang: '' }; // status: idle | playing | paused
let passages = [];
let utterance = null;
let wakeLock = null;
let highlight = () => {};
const listeners = new Set();

const synth = () => window.speechSynthesis;
export const canSpeak = () => typeof window !== 'undefined' && Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);
export const voices = () => (canSpeak() ? synth().getVoices() : []);
export const getReaderState = () => state;

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export function onReaderState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** `fn(key, { from, to } | null)` shows the passage being read. */
export function setReaderHighlighter(fn) {
  highlight = fn;
}

/** The chosen voice, else the device's preferred voice for the text's language, else the default. */
function pickVoice(lang) {
  const all = voices();
  const chosen = getSettings().tts.voice && all.find((v) => v.voiceURI === getSettings().tts.voice);
  if (chosen) return chosen;
  if (!lang) return null;
  const matching = all.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
  return matching.find((v) => v.default) ?? matching.find((v) => v.localService) ?? matching[0] ?? null;
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

// Cancelling fires the current utterance's end/error handlers; forget it first so they do nothing.
function silence() {
  utterance = null;
  if (canSpeak()) synth().cancel();
}

function speakCurrent() {
  const passage = passages[state.index];
  if (!passage) return finish();
  highlight(state.key, passage);
  const u = new SpeechSynthesisUtterance(passage.text);
  const voice = pickVoice(state.lang);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else if (state.lang) u.lang = state.lang;
  u.rate = getSettings().tts.rate;
  u.onend = () => {
    if (utterance !== u) return;
    utterance = null;
    if (state.index + 1 >= passages.length) return finish();
    set({ index: state.index + 1 });
    speakCurrent();
  };
  u.onerror = (e) => {
    if (utterance !== u) return;
    utterance = null;
    finish(e.error === 'not-allowed' ? 'Tap play to start reading.' : `Reading stopped (${e.error}).`);
  };
  utterance = u;
  synth().speak(u);
}

function finish(error = '') {
  silence();
  highlight(state.key, null);
  passages = [];
  set({ status: 'idle', index: 0, total: 0, error });
  keepScreenOn(false);
}

/**
 * Reads `text` aloud from the passage at `from`; with a selection (to > from),
 * only the selection. Markdown is read as prose.
 */
export function startReading({ key, name, text, markdown = false, from = 0, to = 0 }) {
  if (!canSpeak()) throw new Error('This browser cannot read aloud.');
  if (state.status !== 'idle') finish();
  const selection = to > from;
  const list = selection ? speechPassages(text.slice(from, to), { markdown }).map((p) => ({ ...p, from: p.from + from, to: p.to + from })) : speechPassages(text, { markdown });
  if (!list.length) throw new Error('There is nothing to read here.');
  passages = list;
  set({ status: 'playing', key, name, index: selection ? 0 : passageAt(list, from), total: list.length, lang: detectLanguage(text), error: '' });
  keepScreenOn(true);
  speakCurrent();
}

export function pauseReading() {
  if (state.status !== 'playing') return;
  silence();
  set({ status: 'paused' });
  keepScreenOn(false);
}

export function resumeReading() {
  if (state.status !== 'paused') return;
  set({ status: 'playing' });
  keepScreenOn(true);
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

// A new speed or voice applies from the start of the current passage.
function restartPassage() {
  if (state.status !== 'playing') return;
  silence();
  speakCurrent();
}

export function setReadingRate(rate) {
  saveSettings({ tts: { rate } });
  restartPassage();
  set({});
}

export function setReadingVoice(voice) {
  saveSettings({ tts: { voice } });
  restartPassage();
  set({});
}

if (typeof document !== 'undefined') {
  // The screen lock is dropped when the app is hidden; take it again on return.
  document.addEventListener('visibilitychange', () => state.status === 'playing' && keepScreenOn(true));
}
