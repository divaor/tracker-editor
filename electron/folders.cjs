// Folders on disk (desktop): which paths the page may reach (inside a folder
// the user picked in the open dialog, symlinks resolved so they cannot lead
// out), listing a folder, and the temporary copies a dragged tab leaves on
// disk so other apps can take it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Whether `target` is `root` or inside it (both absolute, already resolved). */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The real path: symlinks resolved for the part that exists, the rest appended (a file about to be created). */
function realPath(p) {
  let existing = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = fs.realpathSync.native(existing);
  } catch {
    // keep the resolved path
  }
  return path.join(real, ...rest);
}

/** Whether a path is inside one of the folders (`roots`), after resolving symlinks. */
function allowedBy(roots, target) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
  const real = realPath(target);
  return roots.some((root) => isInside(realPath(root), real));
}

const MAX_ENTRIES = 3000;

/**
 * A folder's contents: [{ name, path, dir, size, mtimeMs, hidden }], folders
 * first, then files, by name (numbers in order). At most 3,000 entries;
 * `truncated` says when there were more.
 */
function listFolder(dir) {
  const names = fs.readdirSync(dir);
  const entries = [];
  for (const name of names) {
    if (entries.length >= MAX_ENTRIES) break;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isDirectory() && !stat.isFile()) continue;
      entries.push({ name, path: full, dir: stat.isDirectory(), size: stat.isFile() ? stat.size : 0, mtimeMs: stat.mtimeMs, hidden: name.startsWith('.') });
    } catch {
      // a broken link, or no permission: left out
    }
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  entries.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));
  return { dir, entries, truncated: names.length > MAX_ENTRIES };
}

/** A file name that works on every system: no path separators or reserved characters; text files get an extension. */
function exportName(name) {
  let clean = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Untitled';
  if (!/\.[A-Za-z0-9]{1,10}$/.test(clean)) clean += '.txt';
  return clean.slice(0, 180);
}

/** Writes a temporary copy for a drag (`<base>/<random>/<name>`) and returns its path. */
function writeExport(base, name, text) {
  const dir = path.join(base, crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, exportName(name));
  fs.writeFileSync(file, text);
  return file;
}

/** Removes temporary copies older than `maxAgeMs` (a dropped copy may still be read a while, e.g. by Claude Code). */
function cleanExports(base, maxAgeMs = 7 * 24 * 3600 * 1000, now = Date.now()) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      try {
        if (now - fs.statSync(dir).mtimeMs > maxAgeMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // gone already
      }
    }
  } catch {
    // no exports yet
  }
  return removed;
}

module.exports = { isInside, realPath, allowedBy, listFolder, exportName, writeExport, cleanExports, MAX_ENTRIES };
