// Text from a file's bytes and back, by the same rules as the desktop app's
// electron/diskFiles.cjs (line endings, a BOM and the encoding are remembered so
// saving puts them back): for files the Android app reads through its native
// side, which only moves bytes. Pure, so the Node tests can import it.

export const MAX_FULL = 20 * 1024 * 1024; // larger files open by their tail, read-only
export const TAIL = 5 * 1024 * 1024;
export const MAX_APPEND = 2 * 1024 * 1024; // a follow step reads at most this much

const latin1 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};

/** Text from bytes: { text (with \n), eol, bom, encoding }. Throws for binary files. */
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
    text = latin1(body);
    encoding = 'latin1';
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return { text: text.replace(/\r\n?/g, '\n'), eol: crlf > 0 && crlf * 2 >= lf ? 'crlf' : 'lf', bom, encoding };
}

/** Bytes for the editor's text, with the file's line endings, BOM and encoding. */
export function encodeText(text, { eol = 'lf', bom = false, encoding = 'utf-8' } = {}) {
  const body = eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
  let data;
  if (encoding === 'latin1') {
    data = new Uint8Array(body.length);
    // Characters beyond Latin-1 cannot be kept in such a file: they become "?".
    for (let i = 0; i < body.length; i++) data[i] = body.charCodeAt(i) > 0xff ? 0x3f : body.charCodeAt(i);
  } else data = new TextEncoder().encode(body);
  if (!bom) return data;
  const out = new Uint8Array(data.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(data, 3);
  return out;
}

/** Text appended to a followed file (no BOM or binary checks; partial lines are fine). */
export function decodeAppended(bytes, encoding = 'utf-8') {
  const text = encoding === 'latin1' ? latin1(bytes) : new TextDecoder('utf-8').decode(bytes);
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
