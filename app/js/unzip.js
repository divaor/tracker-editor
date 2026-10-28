// Reading zip archives in the page: Word, OpenDocument and EPUB files are zips. The central
// directory says where each entry is; stored entries are taken as they are and deflated ones
// go through the browser's own DecompressionStream (Node has it too, for the tests). An entry
// may expand to `limit` bytes at most, so a zip bomb stops early. Pure.

const td = new TextDecoder();
const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const u32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const u64 = (b, at) => u32(b, at) + u32(b, at + 4) * 2 ** 32;

export class ZipError extends Error {}

/** Raw deflate data inflated, stopping (with an error) past `limit` bytes. */
export async function inflateRaw(data, limit = Infinity) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ZipError('A part of this file is too large to open.');
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Whether bytes start like a zip archive. */
export const isZip = (bytes) => bytes?.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);

/**
 * A zip archive's entries: { names, has(name), bytes(name), text(name) } (`bytes` and `text`
 * give null for a name that is not there). Names are as stored ("word/document.xml").
 */
export function readZip(bytes, { limit = 256 * 1024 * 1024 } = {}) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // The end of central directory record: within the last 64 KB (after its comment).
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('This file is damaged or is not what its name says.');
  let count = u16(b, eocd + 10);
  let offset = u32(b, eocd + 16);
  // Zip64: the real numbers are in its own end record.
  if ((offset === 0xffffffff || count === 0xffff) && eocd >= 20 && u32(b, eocd - 20) === 0x07064b50) {
    const rec = u64(b, eocd - 12);
    if (u32(b, rec) === 0x06064b50) {
      count = u64(b, rec + 32);
      offset = u64(b, rec + 48);
    }
  }
  const entries = new Map();
  let at = offset;
  for (let n = 0; n < count && at + 46 <= b.length; n++) {
    if (u32(b, at) !== 0x02014b50) break;
    const method = u16(b, at + 10);
    let compressed = u32(b, at + 20);
    let size = u32(b, at + 24);
    const nameLen = u16(b, at + 28);
    const extraLen = u16(b, at + 30);
    const commentLen = u16(b, at + 32);
    let local = u32(b, at + 42);
    const name = td.decode(b.subarray(at + 46, at + 46 + nameLen));
    // Zip64 sizes and offset, in the order the ones marked 0xffffffff come.
    let x = at + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(b, x);
      const len = u16(b, x + 2);
      if (id === 1) {
        let p = x + 4;
        if (size === 0xffffffff) (size = u64(b, p)), (p += 8);
        if (compressed === 0xffffffff) (compressed = u64(b, p)), (p += 8);
        if (local === 0xffffffff) local = u64(b, p);
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) entries.set(name, { method, compressed, size, local });
    at += 46 + nameLen + extraLen + commentLen;
  }
  // Names as files write them vary in case and slashes ("Word/Document.xml", "./a"): looked up loosely too.
  const loose = new Map([...entries.keys()].map((k) => [k.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase(), k]));
  const keyOf = (name) => (entries.has(name) ? name : loose.get(String(name).replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase()));
  const cache = new Map();
  const read = async (name) => {
    const key = keyOf(name);
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    const e = entries.get(key);
    if (u32(b, e.local) !== 0x04034b50) throw new ZipError(`${key} is damaged.`);
    const start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28);
    const data = b.subarray(start, start + e.compressed);
    let out;
    if (e.method === 0) out = data;
    else if (e.method === 8) out = await inflateRaw(data, Math.min(limit, e.size > 0 ? Math.max(e.size, 1024) * 2 : limit));
    else throw new ZipError(`${key} is packed in a way this app does not read (method ${e.method}).`);
    cache.set(key, out);
    return out;
  };
  return {
    names: [...entries.keys()],
    has: (name) => Boolean(keyOf(name)),
    size: (name) => entries.get(keyOf(name))?.size ?? 0,
    bytes: read,
    async text(name) {
      const got = await read(name);
      if (!got) return null;
      // UTF-16 parts (some old producers) by their byte order mark.
      if (got[0] === 0xff && got[1] === 0xfe) return new TextDecoder('utf-16le').decode(got);
      if (got[0] === 0xfe && got[1] === 0xff) return new TextDecoder('utf-16be').decode(got);
      return td.decode(got);
    },
  };
}

/** A path inside the archive from one relative to `base` ("OEBPS/text/" + "../img/a.png" → "OEBPS/img/a.png"). */
export function resolvePath(base, href) {
  let target = String(href ?? '').split('#')[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    // kept as written
  }
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return parts.join('/');
}
