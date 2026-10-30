// Zip archives for the folders view: compressing files and folders into a .zip,
// and extracting one into a new folder. Both stream (fflate), so large archives
// do not have to fit in memory. Extraction never writes outside its folder (names
// with "..", absolute paths or drive letters are skipped) and stops when the
// archive expands far beyond its size (a "zip bomb").
const fs = require('node:fs');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const zlib = require('node:zlib');
const { Inflate, Zip, ZipDeflate, ZipPassThrough } = require('fflate');

// Extracting reads ZIP64 archives; writing one has no ZIP64 (fflate), so 65,535 entries at most.
const MAX_ENTRIES = 100000;
const MAX_ZIP_ENTRIES = 65535;
// Without ZIP64 (fflate writes none) an archive stops at 4 GB.
const MAX_ZIP_BYTES = 4 * 1024 ** 3 - 64 * 1024 ** 2;
// Formats that are compressed already: stored as they are.
const STORED = new Set('zip 7z rar gz tgz bz2 xz zst jpg jpeg png gif webp heic avif mp3 m4a aac ogg flac mp4 m4v mov mkv webm avi docx xlsx pptx odt ods odp epub jar apk woff woff2 pdf'.split(' '));
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * The parts of a name in an archive that are safe to write under a folder, or null:
 * no absolute paths, drive letters, ".." or names Windows cannot have.
 */
function safeEntry(name) {
  const clean = String(name ?? '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean)) return null;
  const parts = clean.split('/').filter((p) => p && p !== '.');
  if (!parts.length) return null;
  for (const p of parts) {
    if (p === '..' || /[<>:"|?*\u0000-\u001f]/.test(p) || RESERVED.test(p) || p.length > 255) return null;
  }
  return parts;
}

// CRC-32 (the zip checksum) of extracted bytes, carried on from `crc`. Node 18 (the Android
// app's Node.js) has no zlib.crc32: a table does it there.
let crcTable = null;
function tableCrc32(chunk, crc = 0) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = ~crc;
  for (let i = 0; i < chunk.length; i++) c = crcTable[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
const crc32 = (chunk, crc) => (zlib.crc32 ? zlib.crc32(chunk, crc) : tableCrc32(chunk, crc));

// Resolves when a stream can take more (or has failed: the error is checked by the caller).
const drained = (stream) =>
  new Promise((resolve) => {
    if (!stream.writableNeedDrain || stream.destroyed) return resolve();
    const done = () => (stream.off('drain', done), stream.off('error', done), stream.off('close', done), resolve());
    stream.on('drain', done).on('error', done).on('close', done);
  });

// A zip keeps dates from 1980 to 2099 only.
const zipDate = (d) => new Date(Math.min(Math.max(d.getTime(), Date.UTC(1980, 0, 2)), Date.UTC(2099, 11, 30)));

// Files and folders under `source` (links left out), each with its name in the archive.
function walk(source, out, maxEntries) {
  const base = path.basename(source);
  const pending = [[source, base]];
  while (pending.length) {
    const [abs, rel] = pending.shift();
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      out.push({ abs, rel: `${rel}/`, dir: true, size: 0, mtime: zipDate(st.mtime) });
      for (const name of fs.readdirSync(abs).sort()) pending.push([path.join(abs, name), `${rel}/${name}`]);
    } else if (st.isFile()) out.push({ abs, rel, dir: false, size: st.size, mtime: zipDate(st.mtime) });
    if (out.length > maxEntries) throw new Error(`Too many files to zip (more than ${maxEntries.toLocaleString('en')}).`);
  }
  return out;
}

/**
 * Compresses files and folders into a new `outFile` (which must not exist).
 * Returns { files, bytes }; a failed run leaves no archive behind.
 */
async function zipPaths(sources, outFile, { maxEntries = MAX_ZIP_ENTRIES, maxBytes = MAX_ZIP_BYTES, onProgress } = {}) {
  const items = [];
  for (const s of sources) walk(s, items, maxEntries);
  const total = items.reduce((sum, i) => sum + i.size, 0);
  if (total > maxBytes) throw new Error('That is too much to zip here (more than 4 GB).');
  // Made here first (refused when it exists), so a failure removes only what this run wrote.
  const out = fs.createWriteStream(null, { fd: fs.openSync(outFile, 'wx') });
  let error = null;
  out.on('error', (e) => (error ??= e));
  const zip = new Zip((err, chunk, final) => {
    if (err) error ??= err;
    else if (!out.destroyed) out.write(chunk);
    if (final) out.end();
  });
  let done = 0;
  try {
    for (const item of items) {
      if (item.dir) {
        const entry = new ZipPassThrough(item.rel);
        entry.mtime = item.mtime;
        zip.add(entry);
        entry.push(new Uint8Array(0), true);
        continue;
      }
      const ext = /\.([^./]+)$/.exec(item.rel)?.[1]?.toLowerCase() ?? '';
      const entry = STORED.has(ext) ? new ZipPassThrough(item.rel) : new ZipDeflate(item.rel, { level: 6 });
      entry.mtime = item.mtime;
      zip.add(entry);
      for await (const chunk of fs.createReadStream(item.abs, { highWaterMark: 256 * 1024 })) {
        entry.push(chunk);
        done += chunk.length;
        await drained(out);
        if (error) throw error;
      }
      entry.push(new Uint8Array(0), true);
      onProgress?.({ done, total });
    }
    zip.end();
    await finished(out);
    if (error) throw error;
  } catch (err) {
    out.destroy();
    fs.rmSync(outFile, { force: true });
    throw err;
  }
  return { files: items.filter((i) => !i.dir).length, bytes: total };
}

// ---- Reading an archive by its central directory --------------------------------
// Every entry's size and place are known there, so data that happens to hold zip
// signatures (an Office file stored inside, a zip in a database) is never cut short.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const damaged = () => new Error('That zip archive is damaged.');

function readAt(fd, pos, length) {
  const buf = Buffer.alloc(length);
  return buf.subarray(0, fs.readSync(fd, buf, 0, length, pos));
}

// Names without the UTF-8 flag: UTF-8 when they are (many tools leave the flag out), else Latin-1.
function decodeName(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('latin1');
  }
}

/** The entries of a zip: [{ name, method, flags, csize, usize, crc, offset }] (ZIP64 too). */
function readEntries(fd, size) {
  const tailLength = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLength, tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error('That is not a zip archive, or it is empty.');
  let count = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdOffset = tail.readUInt32LE(at + 16);
  if (at >= 20 && tail.readUInt32LE(at - 20) === SIG_LOCATOR64) {
    const end64 = readAt(fd, Number(tail.readBigUInt64LE(at - 12)), 56);
    if (end64.length < 56 || end64.readUInt32LE(0) !== SIG_EOCD64) throw damaged();
    count = Number(end64.readBigUInt64LE(32));
    cdSize = Number(end64.readBigUInt64LE(40));
    cdOffset = Number(end64.readBigUInt64LE(48));
  }
  if (cdOffset + cdSize > size || cdSize > 256 * 1024 * 1024) throw damaged();
  const cd = readAt(fd, cdOffset, cdSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw damaged();
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLength = cd.readUInt16LE(p + 28);
    const extraLength = cd.readUInt16LE(p + 30);
    const commentLength = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLength);
    const extra = cd.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    // ZIP64: the sizes and offset that did not fit, in this order.
    for (let q = 0; q + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(q);
      const length = extra.readUInt16LE(q + 2);
      if (id === 1) {
        let r = q + 4;
        const big = () => {
          if (r + 8 > q + 4 + length) throw damaged();
          const v = Number(extra.readBigUInt64LE(r));
          r += 8;
          return v;
        };
        if (usize === 0xffffffff) usize = big();
        if (csize === 0xffffffff) csize = big();
        if (offset === 0xffffffff) offset = big();
      }
      q += 4 + length;
    }
    entries.push({ name: flags & 0x800 ? nameBytes.toString('utf8') : decodeName(nameBytes), method, flags, csize, usize, crc, offset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Extracts `zipFile` into `destDir`, a new folder made here. Returns
 * { files, folders, skipped: [names] }. On a failure the folder is removed.
 * `maxBytes` caps what it may expand to (by default 200 times its size, at
 * least 1 GB, at most 16 GB).
 */
async function unzipFile(zipFile, destDir, { maxEntries = MAX_ENTRIES, maxBytes, onProgress } = {}) {
  const size = fs.statSync(zipFile).size;
  const cap = maxBytes ?? Math.min(16 * 1024 ** 3, Math.max(1024 ** 3, size * 200));
  const fd = fs.openSync(zipFile, 'r');
  let made = false;
  try {
    const entries = readEntries(fd, size);
    if (!entries.length) throw new Error('That is not a zip archive, or it is empty.');
    if (entries.length > maxEntries) throw new Error(`That archive has too many files (more than ${maxEntries.toLocaleString('en')}).`);
    const tooBig = () => new Error('That archive expands to far more than its size; it was not extracted.');
    if (entries.reduce((sum, e) => sum + e.usize, 0) > cap) throw tooBig();
    fs.mkdirSync(destDir);
    made = true;
    const skipped = [];
    let files = 0;
    let folders = 0;
    let written = 0;
    for (const entry of entries) {
      const parts = safeEntry(entry.name);
      const dest = parts && path.join(destDir, ...parts);
      if (!parts || path.relative(destDir, dest).startsWith('..') || path.isAbsolute(path.relative(destDir, dest))) {
        skipped.push(entry.name);
        continue;
      }
      if (entry.name.endsWith('/')) {
        fs.mkdirSync(dest, { recursive: true });
        folders++;
        continue;
      }
      // Encrypted, compressed some other way, or the same name twice (the first one stays).
      if (entry.flags & 1 || (entry.method !== 0 && entry.method !== 8) || fs.existsSync(dest)) {
        skipped.push(entry.name);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const local = readAt(fd, entry.offset, 30);
      if (local.length < 30 || local.readUInt32LE(0) !== SIG_LOCAL) throw damaged();
      const start = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + entry.csize > size) throw damaged();
      const ws = fs.createWriteStream(dest, { flags: 'wx' });
      let error = null;
      ws.on('error', (e) => (error ??= e));
      let crc = 0;
      let length = 0;
      const out = (chunk) => {
        if (!chunk?.length) return;
        crc = crc32(chunk, crc);
        length += chunk.length;
        written += chunk.length;
        if (written > cap) error ??= tooBig();
        else ws.write(chunk);
      };
      const inflate = entry.method === 8 ? new Inflate((chunk) => out(chunk)) : null;
      try {
        if (entry.csize) {
          // A stream of its own (not on `fd`): a stream stopped early closes its file, which on
          // Node 18 it does even with autoClose off, and `fd` is still needed for the next entry.
          for await (const chunk of fs.createReadStream(zipFile, { start, end: start + entry.csize - 1, highWaterMark: 256 * 1024 })) {
            if (inflate) inflate.push(chunk);
            else out(chunk);
            if (error) break;
            await drained(ws);
          }
        }
        if (inflate && !error) inflate.push(new Uint8Array(0), true);
      } catch (err) {
        error ??= new Error(`${entry.name}: ${err.message}`);
      }
      ws.end();
      await finished(ws).catch((e) => (error ??= e));
      if (error) throw error;
      if (length !== entry.usize || crc !== entry.crc) throw new Error(`${entry.name} in that archive is damaged.`);
      files++;
      onProgress?.({ done: written, total: cap });
    }
    return { files, folders, skipped };
  } catch (err) {
    if (made) fs.rmSync(destDir, { recursive: true, force: true });
    throw err;
  } finally {
    // Never in the way of the error that ended the extraction.
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  }
}

module.exports = { safeEntry, unzipFile, zipPaths, tableCrc32, MAX_ZIP_BYTES };
