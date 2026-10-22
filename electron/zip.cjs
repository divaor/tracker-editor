// Zip archives for the folders view: compressing files and folders into a .zip,
// and extracting one into a new folder. Both stream (fflate), so large archives
// do not have to fit in memory. Extraction never writes outside its folder (names
// with "..", absolute paths or drive letters are skipped) and stops when the
// archive expands far beyond its size (a "zip bomb").
const fs = require('node:fs');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } = require('fflate');

const MAX_ENTRIES = 100000;
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

// Resolves when a stream can take more (or has failed: the error is checked by the caller).
const drained = (stream) =>
  new Promise((resolve) => {
    if (!stream.writableNeedDrain || stream.destroyed) return resolve();
    const done = () => (stream.off('drain', done), stream.off('error', done), stream.off('close', done), resolve());
    stream.on('drain', done).on('error', done).on('close', done);
  });

// Files and folders under `source` (links left out), each with its name in the archive.
function walk(source, out, maxEntries) {
  const base = path.basename(source);
  const pending = [[source, base]];
  while (pending.length) {
    const [abs, rel] = pending.shift();
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      out.push({ abs, rel: `${rel}/`, dir: true, size: 0, mtime: st.mtime });
      for (const name of fs.readdirSync(abs).sort()) pending.push([path.join(abs, name), `${rel}/${name}`]);
    } else if (st.isFile()) out.push({ abs, rel, dir: false, size: st.size, mtime: st.mtime });
    if (out.length > maxEntries) throw new Error(`Too many files to zip (more than ${maxEntries.toLocaleString('en')}).`);
  }
  return out;
}

/**
 * Compresses files and folders into a new `outFile` (which must not exist).
 * Returns { files, bytes }; a failed run leaves no archive behind.
 */
async function zipPaths(sources, outFile, { maxEntries = MAX_ENTRIES, maxBytes = MAX_ZIP_BYTES, onProgress } = {}) {
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

/**
 * Extracts `zipFile` into `destDir`, a new folder made here. Returns
 * { files, folders, skipped: [names] }. On a failure the folder is removed.
 * `maxBytes` caps what it may expand to (by default 200 times its size, at
 * least 1 GB, at most 16 GB).
 */
async function unzipFile(zipFile, destDir, { maxEntries = MAX_ENTRIES, maxBytes, onProgress } = {}) {
  const size = fs.statSync(zipFile).size;
  const cap = maxBytes ?? Math.min(16 * 1024 ** 3, Math.max(1024 ** 3, size * 200));
  fs.mkdirSync(destDir);
  const streams = new Set();
  const skipped = [];
  let error = null;
  let written = 0;
  let entries = 0;
  let files = 0;
  let folders = 0;
  const discard = (file) => {
    file.ondata = () => {};
    file.start();
  };
  const unzip = new Unzip((file) => {
    if (error) return discard(file);
    if (++entries > maxEntries) {
      error = new Error(`That archive has too many files (more than ${maxEntries.toLocaleString('en')}).`);
      return discard(file);
    }
    const parts = safeEntry(file.name);
    if (!parts) {
      skipped.push(file.name);
      return discard(file);
    }
    const dest = path.join(destDir, ...parts);
    if (path.relative(destDir, dest).startsWith('..') || path.isAbsolute(path.relative(destDir, dest))) {
      skipped.push(file.name);
      return discard(file);
    }
    if (file.name.endsWith('/')) {
      fs.mkdirSync(dest, { recursive: true });
      folders++;
      return discard(file);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // The same name twice in one archive: the first one stays.
    if (fs.existsSync(dest)) {
      skipped.push(file.name);
      return discard(file);
    }
    const ws = fs.createWriteStream(dest, { flags: 'wx' });
    streams.add(ws);
    ws.on('error', (e) => (error ??= e));
    files++;
    file.ondata = (err, data, final) => {
      if (err) {
        error ??= new Error(`${file.name}: ${err.message}`);
        ws.destroy();
        return;
      }
      written += data?.length ?? 0;
      if (written > cap) {
        error ??= new Error('That archive expands to far more than its size; it was not extracted.');
        file.terminate();
        ws.destroy();
        return;
      }
      if (data?.length && !ws.destroyed) ws.write(data);
      if (final && !ws.destroyed) ws.end();
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    let read = 0;
    for await (const chunk of fs.createReadStream(zipFile, { highWaterMark: 256 * 1024 })) {
      unzip.push(chunk);
      read += chunk.length;
      if (error) break;
      for (const ws of streams) await drained(ws);
      for (const ws of [...streams]) if (ws.writableFinished || ws.destroyed) streams.delete(ws);
      onProgress?.({ done: read, total: size });
    }
    if (!error) unzip.push(new Uint8Array(0), true);
    if (!error && !entries) error = new Error('That is not a zip archive, or it is empty.');
  } catch (err) {
    error ??= new Error(/invalid|unexpected|zip/i.test(err.message) ? `That is not a zip archive this can read (${err.message}).` : err.message);
  }
  await Promise.all([...streams].map((ws) => (error ? ws.destroy() : null, finished(ws).catch(() => {}))));
  if (error) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw error;
  }
  return { files, folders, skipped };
}

module.exports = { safeEntry, unzipFile, zipPaths, MAX_ZIP_BYTES };
