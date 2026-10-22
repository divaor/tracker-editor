import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { confidenceLabel, OCR_LANGUAGES } from '../ocr.js';
import { recognize } from '../ocrEngine.js';
import { getSettings, saveSettings } from '../settings.js';
import { Modal, toast } from './components.js';
import { Icon } from './icons.js';

const readAsDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

const STEPS = {
  'loading tesseract core': 'Loading text recognition (the first time takes a moment)…',
  'loading language traineddata': 'Loading the language models…',
  'initializing tesseract': 'Getting ready…',
  'initializing api': 'Getting ready…',
  'recognizing text': 'Reading the text…',
};

/**
 * Text from one or more images (pasted, dropped, picked, or a screenshot):
 * read on this device, shown to correct, then inserted, kept as a new file or copied.
 */
export function OcrDialog({ images, actions, onClose }) {
  const [lang, setLang] = useState(() => getSettings().ocrLang || 'eng+spa');
  const [preview, setPreview] = useState('');
  const [step, setStep] = useState({ label: 'Starting…', progress: 0 });
  const [result, setResult] = useState(null); // { text, confidence }
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const area = useRef(null);

  useEffect(() => {
    readAsDataUrl(images[0].blob).then(setPreview, () => {});
  }, []);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError('');
    (async () => {
      const parts = [];
      let confidence = 100;
      for (const [i, image] of images.entries()) {
        const read = await recognize(image.blob, {
          langs: lang,
          onProgress: (m) => !cancelled && setStep({ label: `${STEPS[m.status] ?? 'Working…'}${images.length > 1 ? ` (image ${i + 1} of ${images.length})` : ''}`, progress: m.progress ?? 0 }),
        });
        parts.push(images.length > 1 ? `## ${image.name}\n\n${read.text}` : read.text);
        confidence = Math.min(confidence, read.confidence);
      }
      return { text: parts.join('\n\n'), confidence };
    })().then(
      (read) => {
        if (cancelled) return;
        setResult(read);
        setText(read.text);
      },
      (err) => !cancelled && setError(err.message || String(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [lang]);
  useLayoutEffect(() => {
    if (result) area.current?.focus();
  }, [result]);

  const chooseLang = (value) => {
    setLang(value);
    saveSettings({ ocrLang: value });
  };
  const done = (fn) => {
    onClose();
    fn();
  };
  const empty = result && !text.trim();
  return html`<${Modal} title="Text from an image" wide className="ocr-dialog" onClose=${onClose}
    footer=${result &&
    html`<span class="muted small ocr-confidence">${empty ? 'No text found in the image.' : confidenceLabel(result.confidence)}</span>
      <span class="spacer" />
      <button type="button" class="btn" disabled=${empty} onClick=${() => navigator.clipboard.writeText(text).then(() => done(() => toast('Copied the text')))}><${Icon} name="copy" size=${15} />Copy</button>
      <button type="button" class="btn" disabled=${empty} onClick=${() => done(() => actions.newFile({ text: `${text.trim()}\n` }))}><${Icon} name="file" size=${15} />New file</button>
      <button type="button" class="btn primary" disabled=${empty} onClick=${() => done(() => actions.insertText(text))}><${Icon} name="filePlus" size=${15} />Insert at the cursor</button>`}>
    <div class="ocr-body">
      <div class="ocr-image">${preview && html`<img src=${preview} alt=${images[0].name} />`}${images.length > 1 && html`<span class="muted small">+${images.length - 1} more</span>`}</div>
      <div class="ocr-text">
        <label class="field ocr-lang"><span>Language</span>
          <select value=${lang} onChange=${(e) => chooseLang(e.currentTarget.value)}>
            ${OCR_LANGUAGES.map((l) => html`<option key=${l.id} value=${l.id}>${l.label}</option>`)}
          </select>
        </label>
        ${error
          ? html`<p class="notice error" role="alert"><${Icon} name="alert" size=${16} />${error}</p>`
          : result
            ? html`<textarea ref=${area} class="ocr-result" aria-label="The text read from the image" spellcheck="true" value=${text} onInput=${(e) => setText(e.currentTarget.value)} />`
            : html`<div class="ocr-progress" role="status">
                <span>${step.label}</span>
                <progress max="1" value=${step.progress} />
                <span class="muted small">Read on this device: the image is not sent anywhere.</span>
              </div>`}
      </div>
    </div>
  </${Modal}>`;
}
