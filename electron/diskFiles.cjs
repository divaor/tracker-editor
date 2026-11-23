// Files on disk, edited in place (desktop): reading them as text the editor
// can show (line endings, a BOM and the encoding remembered so saving puts
// them back), very large files by their last part, writing them only when
// they did not change meanwhile, and watching them for changes (follow mode).
// Only paths the user picked are read or written (see the allowlist in main.cjs).
const fs = require('node:fs');
const path = require('node:path');

const MAX_FULL = 20 * 1024 * 1024; // larger files open by their tail, read-only

// Documents the page shows as they look (app/js/docTypes.js has the same list, and a test
// keeps them in step): opened as tabs without their text, which the page reads from their bytes.
const DOCUMENT_EXTS = {
  pdf: 'pdf', epub: 'epub', fb2: 'fb2', docx: 'docx', docm: 'docx', dotx: 'docx', dotm: 'docx', odt: 'odt', ott: 'odt', rtf: 'rtf',
  xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx', ods: 'ods', ots: 'ods', pptx: 'pptx', pptm: 'pptx', ppsx: 'pptx', potx: 'pptx', odp: 'odp', otp: 'odp',
};
/** The kind of document a file is, by its name ('pdf', 'docx'…), or null. */
const documentKind = (name) => DOCUMENT_EXTS[/\.([^.\\/]+)$/.exec(String(name))?.[1]?.toLowerCase() ?? ''] ?? null;
/** A document as a tab: no text (read-only; the page shows it from its bytes). */
const documentInfo = (file, name, stat) => ({ path: file, name, text: '', eol: 'lf', bom: false, encoding: 'utf-8', mtimeMs: stat.mtimeMs, size: stat.size, truncated: false, doc: documentKind(name) });
const TAIL = 5 * 1024 * 1024;
const MAX_APPEND = 2 * 1024 * 1024; // a follow step reads at most this much

// Windows-1252 (what "Windows (Western)" files are, and what files that are not UTF-8 are read
// as): bytes 0x80–0x9F are € ‚ ƒ „ … † ‡ ˆ ‰ Š ‹ Œ Ž ‘ ’ “ ” • – — ˜ ™ š › œ ž Ÿ, the rest is
// Latin-1. The five bytes it leaves undefined (0x81 0x8D 0x8F 0x90 0x9D) stay U+0081…, as browsers
// read them, so every file comes back byte for byte. Our own table: the phone's Node.js has no ICU
// (only UTF-8 and Latin-1). app/js/textBytes.js has the same table (a test keeps them equal). The
// encoding is still called 'latin1' in tabs and calls (tabs saved by older versions say so).
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
const FROM_HIGH = new Map(CP1252_HIGH.map((c, i) => [String.fromCharCode(c), String.fromCharCode(0x80 + i)]));
// What Latin-1 alone does not have: the C1 range (U+0080–U+009F) and everything above U+00FF.
const NOT_LATIN1 = /[\u0080-\u009f]|[^\u0000-ÿ]/gu;
/** Windows-1252 bytes as text. */
const decode1252 = (bytes) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
    .toString('latin1')
    .replace(/[\x80-\x9f]/g, (c) => String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80]));
/** The characters of `text` a Windows-1252 file cannot hold (each once, at most `max`); [] for UTF-8. */
function cannotHold(text, encoding = 'latin1', max = 5) {
  if (encoding !== 'latin1') return [];
  const out = [];
  for (const [c] of String(text).matchAll(NOT_LATIN1)) {
    if (FROM_HIGH.has(c) || out.includes(c)) continue;
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}
/** Text as Windows-1252 bytes; throws (so nothing wrong is written) for a character it cannot hold. */
function encode1252(text) {
  const mapped = text.replace(NOT_LATIN1, (c) => {
    const b = FROM_HIGH.get(c);
    if (b === undefined) throw Object.assign(new Error(`Windows-1252 cannot hold “${c}”: save the file as UTF-8.`), { unencodable: true });
    return b;
  });
  return Buffer.from(mapped, 'latin1');
}

// Line endings: each break of a text as one letter ('C' CRLF, 'L' LF, 'R' a lone CR, as old Macs
// wrote), counted to tell what a file uses. A file with more than one kind is mixed: decode then
// gives `eols`, the letter of every break in order, so saving can keep each line's own.
// app/js/textBytes.js does the same for the Android app's content:// files.
const EOL_OF = { C: 'crlf', L: 'lf', R: 'cr' };
const BREAK = { crlf: '\r\n', lf: '\n', cr: '\r' };
/** { counts: { crlf, lf, cr }, kinds } of raw text: kinds, the letters of its breaks, only when `letters`. */
function countBreaks(raw, letters = false) {
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
function majorityEol({ crlf = 0, lf = 0, cr = 0 }) {
  const eol = crlf > 0 && crlf >= lf && crlf >= cr ? 'crlf' : cr > lf ? 'cr' : 'lf';
  return { eol, mixed: [crlf, lf, cr].filter(Boolean).length > 1 };
}

/**
 * Text from bytes: { text (with \n), eol, bom, encoding, breaks } plus, for a file with more than
 * one kind of line ending, `mixed` ({ crlf, lf, cr }) and `eols` (each break's letter). `eol` is
 * what most lines end with (LF when there is no line break at all: `breaks` 0). Throws for binary files.
 */
function decode(buf) {
  if (buf.subarray(0, 8000).includes(0)) throw new Error('This is not a text file.');
  let bom = false;
  let bytes = buf;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bom = true;
    bytes = bytes.subarray(3);
  }
  let text;
  let encoding = 'utf-8';
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: most likely a Windows (Western) file.
    text = decode1252(bytes);
    encoding = 'latin1';
  }
  const { counts } = countBreaks(text);
  const { eol, mixed } = majorityEol(counts);
  const out = { text: text.replace(/\r\n?/g, '\n'), eol, bom, encoding, breaks: counts.crlf + counts.lf + counts.cr };
  if (mixed) Object.assign(out, { mixed: counts, eols: countBreaks(text, true).kinds });
  return out;
}

/** The tail of a large file from its first whole line (read-only, so its breaks' letters are dropped). */
function fromWholeLine(decoded) {
  const { eols, ...rest } = decoded;
  return { ...rest, text: rest.text.slice(rest.text.indexOf('\n') + 1) };
}

/** Text (with \n) with line endings: `eol` for every line, or `eols` (decode's letters, one per break; the rest `eol`). */
function withEols(text, eol = 'lf', eols = '') {
  if (!eols) return eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : eol === 'cr' ? text.replace(/\r?\n/g, '\r') : text;
  let i = 0;
  return text.replace(/\r?\n/g, () => BREAK[EOL_OF[eols[i++]] ?? eol] ?? '\n');
}

/** A new file's text with the line endings the page chose for its place and kind (lf, crlf or cr); as given without one. */
const newFileText = (text, eol) => (BREAK[eol] ? withEols(String(text ?? '').replace(/\r\n?/g, '\n'), eol) : String(text ?? ''));

/**
 * Bytes for the editor's text, with the file's line endings (`eols`: each line's own), BOM and
 * encoding. Throws for a character a Windows-1252 file cannot hold (nothing is written wrong).
 */
function encode(text, { eol = 'lf', bom = false, encoding = 'utf-8', eols = '' } = {}) {
  const body = withEols(text, eol, eols);
  const data = encoding === 'latin1' ? encode1252(body) : Buffer.from(body, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data]) : data;
}

function readRange(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/** Bytes cut to whole lines, or (one long line) never in the middle of a UTF-8 character. */
function cutText(buf) {
  if (buf.lastIndexOf(10) > 0) return buf.subarray(0, buf.lastIndexOf(10) + 1);
  let i = buf.length - 1;
  while (i > 0 && i > buf.length - 4 && (buf[i] & 0xc0) === 0x80) i--;
  const lead = buf[i];
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return buf.length - i < length ? buf.subarray(0, i) : buf;
}

/** The start of a file as text, for a preview: { text, more } (whole lines when cut). Throws for binary files. */
function readHead(file, max = 256 * 1024) {
  const size = fs.statSync(file).size;
  let buf = readRange(file, 0, Math.min(size, max));
  const more = size > buf.length;
  if (more) buf = cutText(buf);
  return { text: decode(buf).text, more };
}

/**
 * A file as the editor opens it: { path, name, text, eol, bom, encoding, breaks (and mixed, eols),
 * mtimeMs, size, truncated }. Above 20 MB only the last 5 MB, from a whole line.
 */
function readTextFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file.`);
  if (documentKind(path.basename(file))) return documentInfo(file, path.basename(file), stat);
  const truncated = stat.size > MAX_FULL;
  const buf = truncated ? readRange(file, stat.size - TAIL, TAIL) : fs.readFileSync(file);
  const decoded = truncated ? fromWholeLine(decode(buf)) : decode(buf);
  return { path: file, name: path.basename(file), ...decoded, mtimeMs: stat.mtimeMs, size: stat.size, truncated };
}

/** Text appended to a followed file (no BOM or binary checks; partial lines are fine), with \n. */
const decodeAppended = (buf, encoding = 'utf-8') => (encoding === 'latin1' ? decode1252(buf) : buf.toString('utf8')).replace(/\r\n?/g, '\n');

/**
 * What was added since `offset` (for follow mode): { text, size, mtimeMs }, or
 * { reset: true } when the file got shorter (rotated or truncated).
 */
function readAppended(file, offset, { encoding = 'utf-8' } = {}) {
  const stat = fs.statSync(file);
  if (stat.size < offset) return { reset: true, size: stat.size, mtimeMs: stat.mtimeMs };
  const length = Math.min(stat.size - offset, MAX_APPEND);
  const start = stat.size - length;
  const buf = length ? readRange(file, start, length) : Buffer.alloc(0);
  return { text: decodeAppended(buf, encoding), size: stat.size, mtimeMs: stat.mtimeMs, skipped: start - offset };
}

/**
 * Saves the editor's text. When the file changed on disk since `expectedMtime`
 * (and `force` is not set), nothing is written: { conflict: true, mtimeMs }.
 */
function writeTextFile(file, text, { eol, bom, encoding, eols, expectedMtime, force = false } = {}) {
  if (!force && expectedMtime && fs.existsSync(file)) {
    const now = fs.statSync(file).mtimeMs;
    if (Math.abs(now - expectedMtime) > 1) return { conflict: true, mtimeMs: now };
  }
  fs.writeFileSync(file, encode(text, { eol, bom, encoding, eols }));
  const stat = fs.statSync(file);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

module.exports = {
  cannotHold, countBreaks, CP1252_HIGH, cutText, decode, decodeAppended, documentInfo, documentKind, DOCUMENT_EXTS, encode, fromWholeLine, majorityEol,
  newFileText, readHead, readTextFile, readAppended, withEols, writeTextFile, MAX_FULL, TAIL,
};
