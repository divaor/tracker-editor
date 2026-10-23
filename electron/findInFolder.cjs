// Find in a folder and the folders inside it, on this computer or on a server:
// files are listed with `list` and read with `read`, so the same walk works for
// both. Folders like .git and node_modules are skipped, and so are files that
// are not text, larger than `maxSize`, or past `maxFiles`. Each file with
// matches is reported as soon as it is read (`onFound`).

const SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', '.idea', '.vs', '.next', '.terraform']);

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/**
 * A file-name filter from "*.js, *.md" (or "log" for names containing it); a "!"
 * in front excludes. Empty: every file.
 */
function nameFilter(spec = '') {
  const parts = String(spec)
    .split(/[,;\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const test = (p) => (/[*?]/.test(p) ? globToRegExp(p) : { test: (name) => name.toLowerCase().includes(p.toLowerCase()) });
  const include = parts.filter((p) => !p.startsWith('!')).map(test);
  const exclude = parts.filter((p) => p.startsWith('!')).map((p) => test(p.slice(1)));
  return (name) => (!include.length || include.some((r) => r.test(name))) && !exclude.some((r) => r.test(name));
}

/**
 * Walks `root` and searches its files. `list(dir)` gives [{ name, path, dir, size }],
 * `read(path)` the bytes, `decode(bytes)` the text (throws for binary files),
 * `match(name, text)` (may be async) { count, matches } or null; one that throws
 * with `fatal` stops the search (`error` says why), `isText(name)` whether a name can
 * be text at all, `relative(path)` the name shown. Returns { scanned, found, skipped,
 * truncated, stopped }.
 */
async function findInFolder({ root, list, read, decode, match, isText = () => true, relative = (p) => p, onFound = () => {}, onProgress = () => {}, signal, hidden = false, files = '', maxFiles = 5000, maxSize = 5 * 1024 * 1024, maxResults = 500, concurrency = 4 }) {
  const wanted = nameFilter(files);
  const stats = { scanned: 0, found: 0, matches: 0, skipped: { large: 0, binary: 0, unreadable: 0 }, truncated: false, stopped: false };
  const dirs = [root];
  const queue = [];
  const stop = () => stats.stopped || signal?.aborted || stats.found >= maxResults || stats.scanned >= maxFiles;

  // Folders breadth-first, files searched a few at a time while the walk goes on.
  async function searchFile(entry) {
    try {
      const text = decode(await read(entry.path, entry.size));
      if (stats.stopped || signal?.aborted) return;
      const hit = await match(entry.name, text);
      if (hit && !signal?.aborted) {
        stats.found++;
        stats.matches += hit.count;
        onFound({ path: entry.path, name: relative(entry.path), count: hit.count, matches: hit.matches });
      }
    } catch (err) {
      // A pattern that takes too long stops the whole search, and says why.
      if (err?.fatal) {
        stats.error = err.message;
        stats.stopped = true;
      } else if (signal?.aborted) return;
      else if (/not a text file/i.test(err?.message ?? '')) stats.skipped.binary++;
      else stats.skipped.unreadable++;
    }
  }
  const running = new Set();
  const runQueued = async () => {
    while (queue.length && running.size < concurrency && !stop()) {
      const entry = queue.shift();
      stats.scanned++;
      const job = searchFile(entry).finally(() => running.delete(job));
      running.add(job);
    }
    if (running.size >= concurrency) await Promise.race(running);
  };
  let lastProgress = 0;
  while ((dirs.length || queue.length) && !stop()) {
    if (dirs.length) {
      const dir = dirs.shift();
      let entries = [];
      try {
        entries = await list(dir);
      } catch {
        stats.skipped.unreadable++;
      }
      for (const e of entries) {
        if (!hidden && e.name.startsWith('.')) continue;
        if (e.dir) {
          if (!SKIP_DIRS.has(e.name)) dirs.push(e.path);
        } else if (!wanted(e.name)) continue;
        else if (!isText(e.name)) stats.skipped.binary++;
        else if (e.size > maxSize) stats.skipped.large++;
        else queue.push(e);
      }
    }
    while (queue.length && !stop() && (running.size < concurrency || !dirs.length)) await runQueued();
    if (Date.now() - lastProgress > 200) {
      lastProgress = Date.now();
      onProgress({ ...stats });
    }
  }
  await Promise.all(running);
  if (signal?.aborted) stats.stopped = true;
  stats.truncated = !stats.stopped && (stats.found >= maxResults || (stats.scanned >= maxFiles && (queue.length > 0 || dirs.length > 0)));
  onProgress({ ...stats });
  return stats;
}

/**
 * The folders view's filter in the folders inside `root`: entries whose name passes
 * `matches(name)`, folder by folder (a few listed at a time), skipping hidden ones
 * unless `hidden`, SKIP_DIRS and links (`entry.link`, never followed). Stops at
 * `maxResults` found, `maxFolders` listed or `timeLimit` ms. Returns { found: [{ entry,
 * parent }], folders: [{ entry, parent }] (the folders on the way to what was found),
 * listed, truncated, stopped } (parent: the folder holding it).
 */
async function findNames({ root, list, matches, hidden = false, signal, maxResults = 500, maxFolders = 5000, timeLimit = 10000, concurrency = 4, now = Date.now }) {
  const ends = now() + timeLimit;
  const found = [];
  const folderOf = new Map(); // folder → { entry, parent }
  const pending = [root];
  let listed = 0;
  let truncated = false;
  const full = () => found.length >= maxResults || listed >= maxFolders || now() > ends;
  const visit = async (dir) => {
    let entries = [];
    try {
      entries = await list(dir);
    } catch {
      return; // unreadable: left out
    }
    listed++;
    for (const entry of entries) {
      if (signal?.aborted) return;
      if (!hidden && entry.name.startsWith('.')) continue;
      // Directly in `root`: the listing shows those already.
      if (dir !== root && matches(entry.name)) {
        if (found.length >= maxResults) return void (truncated = true);
        found.push({ entry, parent: dir });
      }
      if (entry.dir && !entry.link && !SKIP_DIRS.has(entry.name)) {
        folderOf.set(entry.path, { entry, parent: dir });
        pending.push(entry.path);
      }
    }
  };
  while (pending.length && !signal?.aborted) {
    if (full()) {
      truncated = true;
      break;
    }
    await Promise.all(pending.splice(0, concurrency).map(visit));
  }
  // The folders between `root` and each one found, once each.
  const folders = new Map();
  for (const { parent } of found) {
    for (let at = parent; at !== root && folderOf.has(at) && !folders.has(at); at = folderOf.get(at).parent) folders.set(at, folderOf.get(at));
  }
  return { found, folders: [...folders.values()], listed, truncated: truncated && !signal?.aborted, stopped: Boolean(signal?.aborted) };
}

/**
 * Every file under `root`, for opening by name (Ctrl+P): { files: [{ path, name, rel, size,
 * mtimeMs }], truncated } (rel: the path inside `root`, with "/"), the nearest first.
 * Folders like .git are skipped, links are not followed, and hidden names are left out
 * unless `hidden`. It stops at `maxFiles`, `maxFolders` or `timeLimit` (truncated).
 */
async function listFiles({ root, list, hidden = false, signal, maxFiles = 20000, maxFolders = 5000, timeLimit = 8000, concurrency = 4, now = Date.now }) {
  const ends = now() + timeLimit;
  const files = [];
  const pending = [root];
  const base = root.replace(/[\\/]+$/, '');
  const relOf = (p) => p.slice(base.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  let listed = 0;
  let truncated = false;
  const visit = async (dir) => {
    let entries = [];
    try {
      entries = await list(dir);
    } catch {
      return; // unreadable: left out
    }
    listed++;
    for (const entry of entries) {
      if (!hidden && entry.name.startsWith('.')) continue;
      if (entry.dir) {
        if (!entry.link && !SKIP_DIRS.has(entry.name)) pending.push(entry.path);
      } else if (files.length < maxFiles) {
        files.push({ path: entry.path, name: entry.name, rel: relOf(entry.path), size: entry.size ?? 0, mtimeMs: entry.mtimeMs ?? (entry.mtime ? Date.parse(entry.mtime) : 0) });
      } else truncated = true;
    }
  };
  while (pending.length && !signal?.aborted) {
    if (files.length >= maxFiles || listed >= maxFolders || now() > ends) {
      truncated = true;
      break;
    }
    await Promise.all(pending.splice(0, concurrency).map(visit));
  }
  return { files, truncated: truncated && !signal?.aborted, stopped: Boolean(signal?.aborted) };
}

module.exports = { findInFolder, findNames, listFiles, nameFilter, SKIP_DIRS };
