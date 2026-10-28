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

/** Text from bytes: { text (with \n), eol, bom, encoding }. Throws for binary files. */
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
    text = bytes.toString('latin1');
    encoding = 'latin1';
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return { text: text.replace(/\r\n?/g, '\n'), eol: crlf > 0 && crlf * 2 >= lf ? 'crlf' : 'lf', bom, encoding };
}

/** Bytes for the editor's text, with the file's line endings, BOM and encoding. */
function encode(text, { eol = 'lf', bom = false, encoding = 'utf-8' } = {}) {
  const body = eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
  const data = Buffer.from(body, encoding === 'latin1' ? 'latin1' : 'utf8');
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
 * A file as the editor opens it: { path, name, text, eol, bom, encoding,
 * mtimeMs, size, truncated }. Above 20 MB only the last 5 MB, from a whole line.
 */
function readTextFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file.`);
  if (documentKind(path.basename(file))) return documentInfo(file, path.basename(file), stat);
  const truncated = stat.size > MAX_FULL;
  const buf = truncated ? readRange(file, stat.size - TAIL, TAIL) : fs.readFileSync(file);
  const decoded = decode(buf);
  if (truncated) decoded.text = decoded.text.slice(decoded.text.indexOf('\n') + 1);
  return { path: file, name: path.basename(file), ...decoded, mtimeMs: stat.mtimeMs, size: stat.size, truncated };
}

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
  const text = (encoding === 'latin1' ? buf.toString('latin1') : buf.toString('utf8')).replace(/\r\n?/g, '\n');
  return { text, size: stat.size, mtimeMs: stat.mtimeMs, skipped: start - offset };
}

/**
 * Saves the editor's text. When the file changed on disk since `expectedMtime`
 * (and `force` is not set), nothing is written: { conflict: true, mtimeMs }.
 */
function writeTextFile(file, text, { eol, bom, encoding, expectedMtime, force = false } = {}) {
  if (!force && expectedMtime && fs.existsSync(file)) {
    const now = fs.statSync(file).mtimeMs;
    if (Math.abs(now - expectedMtime) > 1) return { conflict: true, mtimeMs: now };
  }
  fs.writeFileSync(file, encode(text, { eol, bom, encoding }));
  const stat = fs.statSync(file);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

module.exports = { cutText, decode, documentInfo, documentKind, DOCUMENT_EXTS, encode, readHead, readTextFile, readAppended, writeTextFile, MAX_FULL, TAIL };
