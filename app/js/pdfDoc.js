// PDFs with pdf.js (vendor/pdf/, its legacy build: loaded the first time a PDF is shown, and
// cached then): opening one (asking for its password when it has one), drawing a page on a
// canvas with its text over it (to select and copy), its outline as contents, and its text
// ("As text", search, the model). Scripts and forms in PDFs never run. Page side: not pure.
import './compat.js';

let lib = null;
const at = (p) => new URL(`../vendor/pdf/${p}`, import.meta.url).href;

/** pdf.js itself, loaded once. */
export function pdfLib() {
  lib ??= import('../vendor/pdf/pdf.js').then(
    (m) => {
      // Its worker through pdfWorker.js, which adds what older WebViews lack (compat.js).
      m.GlobalWorkerOptions.workerSrc = new URL('./pdfWorker.js', import.meta.url).href;
      return m;
    },
    (err) => {
      lib = null;
      throw err;
    },
  );
  return lib;
}

export class PdfPasswordNeeded extends Error {
  constructor(wrong) {
    super(wrong ? 'That password is not right.' : 'This PDF is protected by a password.');
    this.wrong = wrong;
  }
}

/**
 * The document in `bytes` (a copy goes to pdf.js's worker, which takes it over). Throws
 * PdfPasswordNeeded when it has a password and none (or a wrong one) was given.
 */
export async function openPdf(bytes, { password } = {}) {
  const pdfjs = await pdfLib();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    cMapUrl: at('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: at('standard_fonts/'),
    wasmUrl: at('wasm/'),
    iccUrl: at('iccs/'),
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: false,
  });
  let asked = 0;
  task.onPassword = () => {
    asked++;
    task.destroy();
  };
  try {
    return await task.promise;
  } catch (err) {
    if (asked || err?.name === 'PasswordException') throw new PdfPasswordNeeded(Boolean(password));
    if (err?.name === 'InvalidPDFException') throw new Error('This PDF is damaged or is not a PDF.');
    throw err;
  }
}

/** The outline (bookmarks) as [{ label, page, depth }] (pages counted from 1). */
export async function pdfOutline(pdf, max = 400) {
  const out = [];
  const walk = async (items, depth) => {
    for (const item of items ?? []) {
      if (out.length >= max) return;
      let page = null;
      try {
        const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        if (Array.isArray(dest) && dest[0]) page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
      } catch {
        // a destination that leads nowhere
      }
      if (item.title?.trim()) out.push({ label: item.title.trim(), page, depth });
      await walk(item.items, depth + 1);
    }
  };
  try {
    await walk(await pdf.getOutline(), 0);
  } catch {
    // no outline
  }
  return out;
}

/** A page's text: lines as pdf.js finds them. */
export async function pageText(page) {
  const content = await page.getTextContent();
  let text = '';
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    text += item.str;
    if (item.hasEOL) text += '\n';
  }
  return text.replace(/[ \t]+\n/g, '\n').trim();
}

/** All the text of a PDF, a page at a time (`stop()` true ends it early); pages apart by a blank line. */
export async function pdfText(pdf, { stop = () => false } = {}) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    if (stop()) return null;
    const page = await pdf.getPage(n);
    pages.push(await pageText(page));
    page.cleanup();
    // Room for the page to answer between pages.
    if (n % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return pages.join('\n\n');
}

// A canvas this large at most (pixels): phones refuse larger ones, and they cost memory.
const MAX_PIXELS = 12_000_000;

/**
 * Draws `page` into `box` (a .pdf-page) at `scale` CSS pixels per point: the canvas (sharp on
 * high-density screens) and the text layer. Gives a cancel function.
 */
export function drawPage(pdfjs, page, box, scale) {
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / Math.max(1, viewport.width * viewport.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  canvas.className = 'pdf-canvas';
  const task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined });
  const text = document.createElement('div');
  text.className = 'textLayer';
  box.style.setProperty('--scale-factor', String(scale));
  box.style.setProperty('--total-scale-factor', String(scale));
  let layer = null;
  let cancelled = false;
  const done = task.promise.then(
    () => {
      if (cancelled) return;
      box.querySelector('.pdf-canvas')?.remove();
      box.querySelector('.textLayer')?.remove();
      box.append(canvas, text);
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      return layer.render().catch(() => {});
    },
    (err) => {
      if (!cancelled && err?.name !== 'RenderingCancelledException') throw err;
    },
  );
  return {
    done,
    cancel() {
      cancelled = true;
      try {
        task.cancel();
        layer?.cancel();
      } catch {
        // already done, or the document already let go
      }
    },
  };
}
