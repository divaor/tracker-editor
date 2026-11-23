// Line endings of many files at once (Folders → Line endings: Windows (CRLF) / Unix (LF)), on this
// computer, on servers and in places: the files under what was picked are found (folders walked
// breadth-first without following links, SKIP_DIRS left out, text names only, a size and a count
// cap), each read to tell its line endings (the dry run the page shows before anything changes),
// then converted at the text level (its BOM and encoding kept), each written only if it did not
// change since it was read, with what it held kept for Undo (which writes back only over what it
// wrote). `list`, `stat`, `read` and `write` are this computer's or a server's (main.cjs).
const { SKIP_DIRS } = require('./findInFolder.cjs');

const EOLS = ['crlf', 'lf', 'cr'];

/** What a read file holds: 'lf', 'crlf', 'cr', 'mixed', or 'none' (no line break: right for either). */
const eolOfRead = (read) => (read.breaks === 0 ? 'none' : read.mixed ? 'mixed' : read.eol);

// Runs `job` on each of `items`, `concurrency` at a time; stops taking new ones once `stop()` says so.
async function eachLimited(items, concurrency, job, stop = () => false) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) await job(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
}

/**
 * The text files under `paths` (files picked, and the files in folders picked, at any depth):
 * { files: [{ path, size }], skipped: { notText, large, unreadable, open }, truncated, stopped }.
 * `stat(p)` → { dir, size, link } or null, `list(dir)` → [{ name, path, dir, size, link }],
 * `isText(name)` whether a name is a text file the editor opens (not a locked one), `skip` paths
 * left out (open tabs with unsaved edits), `hidden` whether names starting with "." are taken.
 */
async function eolFiles({ paths, stat, list, isText, skip = [], hidden = false, maxFiles = 20000, maxSize = 5 * 1024 * 1024, maxFolders = 5000, signal, concurrency = 4 }) {
  const files = [];
  const seen = new Set();
  const skipped = { notText: 0, large: 0, unreadable: 0, open: 0 };
  const skipping = new Set(skip);
  let truncated = false;
  let listed = 0;
  const take = (entry) => {
    if (seen.has(entry.path)) return;
    seen.add(entry.path);
    if (skipping.has(entry.path)) skipped.open++;
    else if (!isText(entry.name)) skipped.notText++;
    else if (entry.size > maxSize) skipped.large++;
    else if (files.length >= maxFiles) truncated = true;
    else files.push({ path: entry.path, size: entry.size ?? 0 });
  };
  const dirs = [];
  for (const p of paths) {
    if (signal?.aborted) break;
    const st = await Promise.resolve(stat(p)).catch(() => null);
    if (!st || st.link) skipped.unreadable++;
    else if (st.dir) dirs.push(p);
    else take({ path: p, name: String(p).split(/[\\/]/).pop(), size: st.size });
  }
  while (dirs.length && !signal?.aborted) {
    if (listed >= maxFolders || files.length >= maxFiles) {
      truncated = true;
      break;
    }
    await Promise.all(
      dirs.splice(0, concurrency).map(async (dir) => {
        let entries = [];
        try {
          entries = await list(dir);
        } catch {
          skipped.unreadable++;
          return;
        }
        listed++;
        for (const e of entries) {
          if (!hidden && e.name.startsWith('.')) continue;
          if (e.link) continue;
          if (e.dir) {
            if (!SKIP_DIRS.has(e.name)) dirs.push(e.path);
          } else take(e);
        }
      }),
    );
  }
  return { files, skipped, truncated: truncated && !signal?.aborted, stopped: Boolean(signal?.aborted) };
}

/**
 * Reads each file to tell its line endings: { files: [{ path, eol, size }] (eol: eolOfRead's),
 * skipped: { binary, large, unreadable } }. `read(p)` → diskFiles.cjs's readTextFile shape (throws
 * "not a text file" for binary ones).
 */
async function eolScan({ files, read, signal, onProgress = () => {}, concurrency = 4 }) {
  const out = [];
  const skipped = { binary: 0, large: 0, unreadable: 0 };
  let done = 0;
  await eachLimited(
    files,
    concurrency,
    async (f) => {
      try {
        const r = await read(f.path);
        if (r.truncated || r.doc) skipped[r.doc ? 'binary' : 'large']++;
        else out.push({ path: f.path, eol: eolOfRead(r), size: r.size ?? f.size });
      } catch (err) {
        if (/not a text file/i.test(err?.message ?? '')) skipped.binary++;
        else skipped.unreadable++;
      }
      onProgress({ done: ++done, total: files.length });
    },
    () => signal?.aborted,
  );
  // In the order they were found (the reads finish in any order).
  const order = new Map(files.map((f, i) => [f.path, i]));
  out.sort((a, b) => order.get(a.path) - order.get(b.path));
  return { files: out, skipped, stopped: Boolean(signal?.aborted) };
}

/**
 * Converts each file to `eol` ('crlf', 'lf' or 'cr'): read again, left alone when it has those (or
 * no line break), else its text written with them (BOM and encoding kept), only if it did not
 * change since this read (`write` → { conflict } then). { done: [path], right, skipped: [{ path,
 * reason }], undo: [{ path, before, mtimeMs, size }], undoable, stopped }: undo keeps what each held
 * while the texts kept stay under `maxUndo` characters (the rest: done, but not undoable).
 */
async function eolConvert({ files, eol, read, write, signal, onProgress = () => {}, maxUndo = 64 * 1024 * 1024 }) {
  if (!EOLS.includes(eol)) throw new Error('Not a kind of line ending.');
  const done = [];
  const skipped = [];
  const undo = [];
  let right = 0;
  let kept = 0;
  let undoable = true;
  let n = 0;
  for (const f of files) {
    if (signal?.aborted) break;
    try {
      const r = await read(f.path);
      if (r.truncated || r.doc) throw new Error('too large');
      const now = eolOfRead(r);
      if (now === eol || now === 'none') right++;
      else {
        const written = await write(f.path, r.text, { eol, eols: '', bom: r.bom, encoding: r.encoding, expectedMtime: r.mtimeMs, expectedSize: r.size });
        if (written.conflict) skipped.push({ path: f.path, reason: 'changed meanwhile' });
        else {
          done.push(f.path);
          if (undoable && kept + r.text.length <= maxUndo) {
            kept += r.text.length;
            undo.push({ path: f.path, before: { text: r.text, eol: r.eol, eols: r.eols ?? '', bom: r.bom, encoding: r.encoding }, mtimeMs: written.mtimeMs, size: written.size });
          } else undoable = false;
        }
      }
    } catch (err) {
      skipped.push({ path: f.path, reason: /not a text file/i.test(err?.message ?? '') ? 'not text' : err?.message || 'unreadable' });
    }
    onProgress({ done: ++n, total: files.length });
  }
  return { done, right, skipped, undo, undoable: undo.length, stopped: Boolean(signal?.aborted) };
}

/** Puts back what Undo kept, each only over what the conversion wrote: { restored: [path], skipped: [{ path, reason }] }. */
async function eolUndo({ undo, write }) {
  const restored = [];
  const skipped = [];
  for (const u of undo) {
    try {
      const written = await write(u.path, u.before.text, { ...u.before, expectedMtime: u.mtimeMs, expectedSize: u.size });
      if (written.conflict) skipped.push({ path: u.path, reason: 'changed since' });
      else restored.push(u.path);
    } catch (err) {
      skipped.push({ path: u.path, reason: err?.message || 'not written' });
    }
  }
  return { restored, skipped };
}

module.exports = { eolFiles, eolScan, eolConvert, eolUndo, eolOfRead };
