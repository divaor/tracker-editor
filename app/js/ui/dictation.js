import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { Icon } from './icons.js';

const Recognition = () => globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
/** Dictation needs the browser's speech service (Chrome, Edge, Safari); the desktop app has none. */
export const dictationSupported = () => Boolean(Recognition()) && !globalThis.window?.desktop;

const PROBLEMS = {
  'not-allowed': 'Allow the microphone for this app to dictate.',
  'service-not-allowed': 'Allow the microphone for this app to dictate.',
  'audio-capture': 'No microphone was found.',
  network: 'Dictation needs a connection: the browser turns speech into text with its speech service.',
  'language-not-supported': 'The speech service does not know this language. Pick another in Settings.',
};

/**
 * Listens while it is shown and hands each phrase heard to `onPhrase(text, lang)`
 * (it goes in at the cursor). Phones stop listening after a pause; it starts again.
 */
export function DictationBar({ lang, onPhrase, onStop }) {
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const R = Recognition();
    let stopped = false;
    let rec = null;
    // Android repeats earlier results in continuous mode, so there it listens one phrase at a time.
    const continuous = !/Android/i.test(navigator.userAgent);
    const start = () => {
      rec = new R();
      rec.lang = lang || navigator.language || 'en-US';
      rec.continuous = continuous;
      rec.interimResults = true;
      rec.onstart = () => setListening(true);
      rec.onresult = (e) => {
        let pending = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i];
          if (result.isFinal) onPhrase(result[0].transcript, rec.lang);
          else pending += result[0].transcript;
        }
        setInterim(pending);
      };
      rec.onerror = (e) => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        stopped = true;
        setProblem(PROBLEMS[e.error] ?? `Dictation stopped (${e.error}).`);
      };
      rec.onend = () => {
        setInterim('');
        setListening(false);
        if (!stopped) setTimeout(() => !stopped && start(), 150);
      };
      try {
        rec.start();
      } catch (err) {
        stopped = true;
        setProblem(err.message);
      }
    };
    start();
    return () => {
      stopped = true;
      rec?.abort();
    };
  }, [lang]);
  return html`<div class="dictation-bar ${listening ? 'listening' : ''}" role="status" aria-live="polite">
    <span class="dictation-mic"><${Icon} name="mic" size=${16} /></span>
    <span class="dictation-text">${problem || interim || (listening ? 'Listening… say “new line” or “nuevo párrafo” for line breaks' : 'Starting the microphone…')}</span>
    <button type="button" class="btn sm ${problem ? '' : 'primary'}" onClick=${onStop}>${problem ? 'Close' : 'Stop'}</button>
  </div>`;
}
