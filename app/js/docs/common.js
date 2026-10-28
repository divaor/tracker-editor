// What the document converters (documents.js) share: HTML text, ids, addresses, pictures, and
// the plain text of the HTML they build. Pure.

/** What is wrong with a document, said to the person. */
export class DocumentError extends Error {}

/** Text for HTML (element content and attribute values). */
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** An id usable in the page's HTML (letters, digits, - and _). */
export const safeId = (s) => String(s ?? '').replace(/[^\w-]/g, '_').slice(0, 120);

/** Only addresses that lead out of the app: web, mail and phone links. */
export const outsideUrl = (href) => (/^(https?:|mailto:|tel:)/i.test(String(href ?? '').trim()) ? String(href).trim() : null);

// A picture's type by its name (only kinds the browser shows).
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon' };
export const imageType = (name) => IMAGE_TYPES[/\.([^.]+)$/.exec(String(name).toLowerCase())?.[1] ?? ''] ?? null;

// Pictures in the files' own bytes ("Pictures/a.png" in an OpenDocument file), by their type.
const MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46], 'image/gif'],
  [[0x42, 0x4d], 'image/bmp'],
];
export function sniffImage(bytes) {
  for (const [sig, type] of MAGIC) if (sig.every((v, i) => bytes[i] === v)) return type;
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

/** A picture from a zip by its path, with its type, or null when the browser cannot show it. */
export async function zipImage(zip, path) {
  const bytes = await zip.bytes(path);
  if (!bytes) return null;
  const type = imageType(path) ?? sniffImage(bytes);
  return type ? { bytes, type } : null;
}

const BLOCK_END = /<\/(p|h[1-6]|li|tr|div|section|blockquote|pre|table|caption|figcaption|dt|dd|header|footer|aside)>|<br\s*\/?>|<hr[^>]*>/gi;
const TEXT_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': '\u00a0' };

/** The plain text of the HTML built here: a line per paragraph, cells apart by tabs. */
export function htmlToText(html) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Line breaks in the HTML are spaces, as the page shows them (in <pre> they are kept).
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, inner) => `<p>${inner.replace(/\r?\n/g, '<br>')}</p>`)
    .replace(/[\r\n]+/g, ' ')
    .replace(/<a class="doc-noteback"[^>]*>[\s\S]*?<\/a>/g, '')
    // A cell's paragraphs on one line, the cells apart by tabs.
    .replace(/<(t[dh])\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => `${inner.replace(BLOCK_END, ' ').replace(/<[^>]+>/g, '').trim()}\t`)
    .replace(/<\/tr>/gi, '\n')
    .replace(/<(ul|ol|li|table)\b[^>]*>/gi, '\n')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => TEXT_ENTITIES[e])
    .replace(/ {2,}/g, ' ')
    .replace(/\t +/g, '\t')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n +/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** A spreadsheet column's letters: 0 → A, 25 → Z, 26 → AA. */
export function columnName(i) {
  let name = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A column's index from its letters ("AA" → 26). */
export function columnIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
