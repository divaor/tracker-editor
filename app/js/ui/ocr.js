import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { cleanVisionReply, confidenceLabel, OCR_LANGUAGES, visionMessages, visionScale } from '../ocr.js';
import { recognize } from '../ocrEngine.js';
import { llmClient } from '../semantic.js';
import { getSettings, saveSettings } from '../settings.js';
import { Modal, Segmented, toast } from './components.js';
import { Icon } from './icons.js';

const readAsDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** An image as a data URL for a model: scaled down when large (PNG for screenshots, JPEG for photos). */
async function forModel(blob) {
  const bitmap = await createImageBitmap(blob).catch(() => {
    throw new Error('This image could not be read here. Try reading it on this device.');
  });
  const scale = visionScale(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return /jpe?g/i.test(blob.type) ? canvas.toDataURL('image/jpeg', 0.92) : canvas.toDataURL('image/png');
}

/** The model that reads images, when one is connected (an OpenAI-compatible server): { model, host, local }. */
function imageModel(settings = getSettings()) {
  const { llm } = settings;
  if (!llm.enabled || llm.provider === 'async') return null;
  const model = llm.visionModel || llm.chatModel;
  if (!model) return null;
  let host = '';
  try {
    host = new URL(llm.baseUrl).hostname;
  } catch {
    // shown without a host
  }
  return { model, host, local: /^(localhost|127\.|\[::1\]|::1)/.test(host) };
}

const STEPS = {
  'loading tesseract core': 'Loading text recognition (the first time takes a moment)…',
  'loading language traineddata': 'Loading the language models…',
  'initializing tesseract': 'Getting ready…',
  'initializing api': 'Getting ready…',
  'recognizing text': 'Reading the text…',
};

// "photo.png" → "photo.txt"; several images → "Text from 3 images.txt".
const textNameFor = (images) => (images.length > 1 ? `Text from ${images.length} images.txt` : `${images[0].name.replace(/\.[^.]+$/, '') || 'Image'}.txt`);

/**
 * Text from one or more images (pasted, dropped, picked, or a screenshot):
 * read on this device, shown to correct, then inserted, kept as a new file or copied.
 * `saveTo`: the folder of images opened from the folders view, where the text can be saved next to them.
 */
export function OcrDialog({ images, saveTo, actions, onClose }) {
  const [lang, setLang] = useState(() => getSettings().ocrLang || 'eng+spa');
  const vision = imageModel();
  // Who reads it: this device (Tesseract), or the connected model.
  const [engine, setEngine] = useState(() => (vision && getSettings().ocrEngine === 'model' ? 'model' : 'device'));
  const [streamed, setStreamed] = useState('');
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
    const controller = new AbortController();
    setResult(null);
    setError('');
    setStreamed('');
    const byModel = async () => {
      setStep({ label: `Sending ${images.length > 1 ? `${images.length} images` : 'the image'} to ${vision.model}…`, progress: 0 });
      const urls = [];
      for (const image of images) urls.push(await forModel(image.blob));
      setStep({ label: `${vision.model} is reading…`, progress: null });
      let text = '';
      const reply = await llmClient().chat({
        model: vision.model,
        messages: visionMessages(urls, { langs: lang }),
        signal: controller.signal,
        temperature: 0,
        onToken: (piece) => !cancelled && setStreamed((text += piece)),
      });
      return { text: cleanVisionReply(reply), confidence: null, model: vision.model };
    };
    (engine === 'model' ? byModel() : (async () => {
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
    })()).then(
      (read) => {
        if (cancelled) return;
        setResult(read);
        setText(read.text);
      },
      (err) => {
        if (cancelled) return;
        const why = err?.message || (err ? String(err) : '');
        setError(engine === 'model' ? `${vision.model} could not read it: ${why || 'no answer'}. Try reading it on this device, or another model in Settings → Model.` : why || 'The text could not be read.');
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [lang, engine]);
  useLayoutEffect(() => {
    if (result) area.current?.focus();
  }, [result]);

  const chooseLang = (value) => {
    setLang(value);
    saveSettings({ ocrLang: value });
  };
  const chooseEngine = (value) => {
    setEngine(value);
    saveSettings({ ocrEngine: value });
  };
  const done = (fn) => {
    onClose();
    fn();
  };
  const empty = result && !text.trim();
  return html`<${Modal} title="Text from an image" wide className="ocr-dialog" onClose=${onClose}
    footer=${result &&
    html`<span class="muted small ocr-confidence">${empty ? 'No text found in the image.' : result.model ? `Read by ${result.model}: check the text` : confidenceLabel(result.confidence)}</span>
      <span class="spacer" />
      <button type="button" class="btn" disabled=${empty} onClick=${() => navigator.clipboard.writeText(text).then(() => done(() => toast('Copied the text')))}><${Icon} name="copy" size=${15} />Copy</button>
      <button type="button" class="btn" disabled=${empty} onClick=${() => done(() => actions.newFile({ text: `${text.trim()}\n` }))}><${Icon} name="file" size=${15} />New file</button>
      ${saveTo
        ? html`<button type="button" class="btn" disabled=${empty} onClick=${() => done(() => actions.insertText(text))}><${Icon} name="filePlus" size=${15} />Insert at the cursor</button>
          <button type="button" class="btn primary" disabled=${empty} title=${`${textNameFor(images)}, a text file in ${saveTo} (not synced)`} onClick=${() => done(() => actions.saveTextInFolder(saveTo, textNameFor(images), `${text.trim()}\n`))}><${Icon} name="save" size=${15} /><span class="btn-text">Save here as <span class="btn-clip">${textNameFor(images)}</span></span></button>`
        : html`<button type="button" class="btn primary" disabled=${empty} onClick=${() => done(() => actions.insertText(text))}><${Icon} name="filePlus" size=${15} />Insert at the cursor</button>`}`}>
    <div class="ocr-body">
      <div class="ocr-image">${preview && html`<img src=${preview} alt=${images[0].name} />`}${images.length > 1 && html`<span class="muted small">+${images.length - 1} more</span>`}</div>
      <div class="ocr-text">
        ${vision &&
        html`<div class="field ocr-engine"><span>Read by</span>
          <${Segmented} small value=${engine} onChange=${chooseEngine} label="Read by"
            options=${[{ id: 'device', label: 'This device', icon: 'scan' }, { id: 'model', label: vision.model, icon: 'sparkle' }]} />
        </div>`}
        <label class="field ocr-lang"><span>Language</span>
          <select value=${lang} onChange=${(e) => chooseLang(e.currentTarget.value)}>
            ${OCR_LANGUAGES.map((l) => html`<option key=${l.id} value=${l.id}>${l.label}</option>`)}
          </select>
        </label>
        ${error
          ? html`<p class="notice error" role="alert"><${Icon} name="alert" size=${16} />${error}</p>`
          : result
            ? html`<textarea ref=${area} class="ocr-result" aria-label="The text read from the image" spellcheck="true" value=${text} onInput=${(e) => setText(e.currentTarget.value)} />`
            : streamed
              ? html`<textarea class="ocr-result streaming" aria-label="The text being read" readonly value=${streamed} />`
              : html`<div class="ocr-progress" role="status">
                <span>${step.label}</span>
                ${step.progress === null ? html`<progress />` : html`<progress max="1" value=${step.progress} />`}
                <span class="muted small">${engine === 'model' ? (vision.local ? `Read by your model on this computer (${vision.host}).` : `The image is sent to your model at ${vision.host}.`) : 'Read on this device: the image is not sent anywhere.'}</span>
              </div>`}
      </div>
    </div>
  </${Modal}>`;
}
