// Text from a file's bytes and back, by the same rules as the desktop app's
// electron/diskFiles.cjs (line endings, a BOM and the encoding are remembered so
// saving puts them back; a file with mixed line endings gets each break's letter;
// files that are not UTF-8 are Windows-1252): for files the Android app reads through
// its native side, which only moves bytes. Pure, so the Node tests can import it.

export const MAX_FULL = 20 * 1024 * 1024; // larger files open by their tail, read-only
export const TAIL = 5 * 1024 * 1024;
export const MAX_APPEND = 2 * 1024 * 1024; // a follow step reads at most this much

// Windows-1252's bytes 0x80–0x9F (diskFiles.cjs has the same table; a test keeps them equal).
// The five it leaves undefined stay U+0081…, so bytes come back exactly.
export const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
const FROM_HIGH = new Map(CP1252_HIGH.map((c, i) => [String.fromCharCode(c), 0x80 + i]));
const NOT_LATIN1 = /[\u0080-\u009f]|[^\u0000-ÿ]/gu;

const decode1252 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out.replace(/[\x80-\x9f]/g, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80]));
};

/** The characters of `text` a Windows-1252 file ('latin1') cannot hold (each once, at most `max`); [] for UTF-8. */
export function cannotHold(text, encoding = 'latin1', max = 5) {
  if (encoding !== 'latin1') return [];
  const out = [];
  for (const [c] of String(text).matchAll(NOT_LATIN1)) {
    if (FROM_HIGH.has(c) || out.includes(c)) continue;
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function encode1252(text) {
  const data = new Uint8Array(text.length);
  let n = 0;
  for (const c of text) {
    const code = c.codePointAt(0);
    const b = code < 0x80 || (code >= 0xa0 && code <= 0xff) ? code : FROM_HIGH.get(c);
    if (b === undefined) throw Object.assign(new Error(`Windows-1252 cannot hold “${c}”: save the file as UTF-8.`), { unencodable: true });
    data[n++] = b;
  }
  return data.subarray(0, n);
}

const EOL_OF = { C: 'crlf', L: 'lf', R: 'cr' };
const BREAK = { crlf: '\r\n', lf: '\n', cr: '\r' };
/** { counts: { crlf, lf, cr }, kinds } of raw text: kinds, the letters of its breaks ('C', 'L', 'R'), only when `letters`. */
export function countBreaks(raw, letters = false) {
  const counts = { crlf: 0, lf: 0, cr: 0 };
  let kinds = '';
  for (const [b] of String(raw).matchAll(/\r\n|\n|\r/g)) {
    const kind = b === '\r\n' ? 'crlf' : b === '\n' ? 'lf' : 'cr';
    counts[kind]++;
    if (letters) kinds += kind === 'crlf' ? 'C' : kind === 'lf' ? 'L' : 'R';
  }
  return { counts, kinds };
}
/** The endings most lines have (a tie: CRLF, then LF), and whether there is more than one kind. */
export function majorityEol({ crlf = 0, lf = 0, cr = 0 }) {
  const eol = crlf > 0 && crlf >= lf && crlf >= cr ? 'crlf' : cr > lf ? 'cr' : 'lf';
  return { eol, mixed: [crlf, lf, cr].filter(Boolean).length > 1 };
}

/**
 * Text from bytes: { text (with \n), eol, bom, encoding, breaks } plus `mixed` and `eols` for a
 * file with more than one kind of line ending. Throws for binary files.
 */
export function decodeText(bytes) {
  if (bytes.subarray(0, 8000).includes(0)) throw new Error('This is not a text file.');
  let bom = false;
  let body = bytes;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    bom = true;
    body = body.subarray(3);
  }
  let text;
  let encoding = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    // Not UTF-8: most likely a Windows (Western) file.
    text = decode1252(body);
    encoding = 'latin1';
  }
  const { counts } = countBreaks(text);
  const { eol, mixed } = majorityEol(counts);
  const out = { text: text.replace(/\r\n?/g, '\n'), eol, bom, encoding, breaks: counts.crlf + counts.lf + counts.cr };
  if (mixed) Object.assign(out, { mixed: counts, eols: countBreaks(text, true).kinds });
  return out;
}

/** Text (with \n) with line endings: `eol` for every line, or `eols` (a letter per break; the rest `eol`). */
export function withEols(text, eol = 'lf', eols = '') {
  if (!eols) return eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : eol === 'cr' ? text.replace(/\r?\n/g, '\r') : text;
  let i = 0;
  return text.replace(/\r?\n/g, () => BREAK[EOL_OF[eols[i++]] ?? eol] ?? '\n');
}

/** Bytes for the editor's text, with the file's line endings, BOM and encoding. Throws for a character Windows-1252 cannot hold. */
export function encodeText(text, { eol = 'lf', bom = false, encoding = 'utf-8', eols = '' } = {}) {
  const body = withEols(text, eol, eols);
  const data = encoding === 'latin1' ? encode1252(body) : new TextEncoder().encode(body);
  if (!bom) return data;
  const out = new Uint8Array(data.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(data, 3);
  return out;
}

/** Text appended to a followed file (no BOM or binary checks; partial lines are fine). */
export function decodeAppended(bytes, encoding = 'utf-8') {
  const text = encoding === 'latin1' ? decode1252(bytes) : new TextDecoder('utf-8').decode(bytes);
  return text.replace(/\r\n?/g, '\n');
}

/** The tail of a large file starts on a whole line. */
export const fromWholeLine = (text) => text.slice(text.indexOf('\n') + 1);

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(data) {
  const binary = atob(data ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
