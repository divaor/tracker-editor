// Reads text from images in the browser with tesseract.js (vendor/ocr/): the
// library, its worker, the WebAssembly core and the English and Spanish
// models are all served from this app, so images never leave the device.
// The worker stays loaded for the next image.
import { cleanOcrText, ocrScale } from './ocr.js';
import { isAndroidApp } from './platform.js';

const base = new URL('../vendor/ocr/', import.meta.url).href;
// A tiny module that uses SIMD (as wasm-feature-detect checks it): the core needs it.
const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export const ocrSupported = () => typeof Worker === 'function' && typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_TEST);

let current = null; // { langs, worker: Promise }
let listener = null;

// The worker answers at once when it runs (it says it is loading the core); silence this long means it never started.
const START_MS = 20_000;
const startError = (detail) => new Error(`Text recognition could not start here${detail ? ` (${detail})` : ''}. Try again, or restart the app.`);

async function workerFor(langs) {
  if (current?.langs === langs) return current.worker;
  // The worker for other languages goes (once it is ready, never waiting for it here).
  current?.worker.then((w) => w.terminate(), () => {});
  current = null;
  const { default: Tesseract } = await import('../vendor/ocr/tesseract.js');
  let heard = false;
  let fail;
  // tesseract.js gives up on a failed step (a model that cannot be fetched…) without settling
  // createWorker, and a worker that cannot load rejects it with nothing: both become errors here.
  const failed = new Promise((_, reject) => (fail = reject));
  failed.catch(() => {});
  const created = Tesseract.createWorker(langs.split('+'), Tesseract.OEM.LSTM_ONLY, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}tesseract-core-simd-lstm.wasm.js`,
    langPath: base.replace(/\/$/, ''),
    // Android's build unpacks .gz assets (eng.traineddata.gz is eng.traineddata in the app).
    gzip: !isAndroidApp(),
    workerBlobURL: false,
    logger: (m) => {
      heard = true;
      listener?.(m);
    },
    errorHandler: (err) => fail(new Error(String(err?.message ?? err ?? '').replace(/^Error: /, '') || 'Text recognition failed.')),
  }).catch((err) => {
    throw typeof err === 'string' && err ? new Error(err) : err instanceof Error ? err : startError('its worker did not load');
  });
  const timer = setTimeout(() => heard || fail(startError('its worker did not answer')), START_MS);
  const worker = Promise.race([created, failed]).finally(() => clearTimeout(timer));
  current = { langs, worker };
  worker.catch(() => {
    if (current?.worker === worker) current = null;
    created.then((w) => w.terminate(), () => {});
  });
  return worker;
}

// Small screenshots are enlarged first: tesseract reads larger text better.
async function prepare(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = ocrScale(bitmap.width, bitmap.height);
  if (scale === 1) {
    bitmap.close();
    return blob;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

/**
 * The text in an image (a Blob): { text, confidence }. `onProgress({ status,
 * progress })` hears tesseract's steps (loading the model the first time, reading).
 */
export async function recognize(blob, { langs = 'eng+spa', onProgress } = {}) {
  if (!ocrSupported()) throw new Error('This browser cannot read text from images (it needs WebAssembly SIMD).');
  listener = onProgress;
  try {
    const worker = await workerFor(langs);
    const { data } = await worker.recognize(await prepare(blob));
    return { text: cleanOcrText(data.text), confidence: Math.round(data.confidence) };
  } finally {
    listener = null;
  }
}
