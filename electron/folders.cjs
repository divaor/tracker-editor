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

// ---- Changing folders: new, rename, move, copy --------------------------------

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A name for a new or renamed file or folder, checked for every system; throws with the reason. */
function checkName(name) {
  const clean = String(name ?? '').trim();
  if (!clean || clean === '.' || clean === '..') throw new Error('Type a name.');
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(clean)) throw new Error('A name cannot have any of these: \\ / : * ? " < > |');
  if (/[. ]$/.test(clean)) throw new Error('A name cannot end with a dot or a space.');
  if (RESERVED.test(clean)) throw new Error(`${clean} is a name Windows reserves.`);
  if (clean.length > 240) throw new Error('That name is too long.');
  return clean;
}

const splitName = (name) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
};

/**
 * A free path for `name` in `dir`: the name itself, or "name (2).ext", "name (3).ext"…;
 * with `copy`, "name - Copy.ext", "name - Copy (2).ext"… (as Explorer names copies).
 */
function freePath(dir, name, { copy = false } = {}) {
  const [base, ext] = splitName(name);
  const at = (n) => (copy ? `${base} - Copy${n > 1 ? ` (${n})` : ''}${ext}` : n > 1 ? `${base} (${n})${ext}` : name);
  for (let n = 1; n < 10000; n++) {
    const candidate = path.join(dir, at(n));
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No free name for ${name}.`);
}

/** Refuses putting a folder inside itself. */
function checkNotInside(source, dir) {
  if (isInside(realPath(source), realPath(dir))) throw new Error(`${path.basename(source)} cannot go inside itself.`);
}

/** Copies files and folders into `dir`; a copy in the same folder is named "… - Copy". Returns [{ from, to }]. */
function copyInto(sources, dir) {
  const done = [];
  for (const source of sources) {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) checkNotInside(source, dir);
    const same = path.resolve(path.dirname(source)) === path.resolve(dir);
    const to = freePath(dir, path.basename(source), { copy: same });
    fs.cpSync(source, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    done.push({ from: source, to });
  }
  return done;
}

/** Moves files and folders into `dir` (a name already there gets " (2)"). Returns [{ from, to }]; ones already there are skipped. */
function moveInto(sources, dir) {
  const done = [];
  for (const source of sources) {
    if (path.resolve(path.dirname(source)) === path.resolve(dir)) continue;
    if (fs.statSync(source).isDirectory()) checkNotInside(source, dir);
    const to = freePath(dir, path.basename(source));
    moveEntry(source, to);
    done.push({ from: source, to });
  }
  return done;
}

/** Renames or moves one entry; across drives it is copied, then removed. */
function moveEntry(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Renames a file or folder in its folder. Returns the new path. */
function renameEntry(from, name) {
  const to = path.join(path.dirname(from), checkName(name));
  if (to === from) return to;
  // Only the case changes (the same file on Windows and macOS): allowed.
  const sameFile = to.toLowerCase() === from.toLowerCase() && fs.existsSync(to) && fs.statSync(to).ino === fs.statSync(from).ino;
  if (fs.existsSync(to) && !sameFile) throw new Error(`${path.basename(to)} already exists here.`);
  moveEntry(from, to);
  return to;
}

// ---- Opening with other programs ----------------------------------------------

// Programs, scripts and shortcuts: the editor never starts these (a page could
// otherwise write a script and run it). Scripts that are text open in the editor.
const RUNNABLE = new Set(
  'exe com bat cmd ps1 psm1 psd1 ps1xml vbs vbe js jse mjs cjs wsf wsh wsc msi msp mst scr hta cpl jar lnk url website reg inf pif application appref-ms gadget msc scf sct shb shs ws xbap vb vba sh bash zsh fish csh ksh command tool app pkg mpkg action workflow scpt applescript osx deb rpm appimage desktop run bin elf out py pyw pyc pyz pl rb php lua tcl ahk au3 xll xlam docm dotm xlsm xltm pptm potm ppam sldm library-ms settingcontent-ms diagcab chm jnlp appx appxbundle msix msixbundle ade adp mde accde mda search-ms searchconnector-ms theme themepack deskthemepack iqy slk mof ins isp'.split(' '),
);

/** Whether the editor will open a file with its default program (never programs, scripts, shortcuts, or files without an extension). */
function canOpenExternally(name) {
  const ext = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  return Boolean(ext) && !RUNNABLE.has(ext);
}

const IMAGE = new Set('png jpg jpeg gif bmp webp tif tiff'.split(' '));
const isImage = (name) => IMAGE.has(/\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '');

/** A folder's permissions for a file's (`chmod` inside folders): every r also lets you in (x). */
const dirMode = (mode) => mode | ((mode & 0o444) >> 2);
/** A file's, inside a folder changed with all it holds: runnable only if it was (like chmod's X). */
const fileMode = (mode, before) => (before & 0o111 ? mode : mode & ~0o111);

/** Properties of a file or folder here: { name, path, dir, link, size, mtimeMs, birthtimeMs, mode, owner }. */
function properties(p) {
  const l = fs.lstatSync(p);
  const st = l.isSymbolicLink() ? fs.statSync(p) : l;
  let owner = '';
  try {
    if (process.getuid && st.uid === process.getuid()) owner = require('node:os').userInfo().username;
  } catch {
    // not known
  }
  return { name: path.basename(p), path: p, dir: st.isDirectory(), link: l.isSymbolicLink(), size: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs, mode: st.mode & 0o7777, owner: owner || (process.platform === 'win32' ? '' : String(st.uid)), group: process.platform === 'win32' ? '' : String(st.gid) };
}

/** A folder's size, counting what is inside (links not followed): { size, files, folders, truncated }. */
function folderSize(dir, { maxEntries = 500000, until = Date.now() + 60000 } = {}) {
  const out = { size: 0, files: 0, folders: 0, truncated: false };
  const pending = [dir];
  while (pending.length) {
    if (out.files + out.folders > maxEntries || Date.now() > until) {
      out.truncated = true;
      break;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(pending.shift(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(e.parentPath ?? e.path, e.name);
      if (e.isDirectory()) {
        out.folders++;
        pending.push(full);
      } else if (e.isFile()) {
        out.files++;
        try {
          out.size += fs.statSync(full).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return out;
}

/** Sets permissions here; on Windows only "read-only" (no write bit) means something. */
function chmodEntries(paths, mode, { recursive = false } = {}) {
  let changed = 0;
  const set = (p, m) => {
    fs.chmodSync(p, m);
    changed++;
  };
  for (const p of paths) {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) continue;
    set(p, mode);
    if (!recursive || !st.isDirectory()) continue;
    // Inside: folders as dirMode, files as fileMode.
    const pending = [p];
    while (pending.length) {
      for (const e of fs.readdirSync(pending.shift(), { withFileTypes: true })) {
        const full = path.join(e.parentPath ?? e.path, e.name);
        if (e.isDirectory()) {
          set(full, dirMode(mode));
          pending.push(full);
        } else if (e.isFile()) set(full, fileMode(mode, fs.statSync(full).mode));
      }
    }
  }
  return changed;
}

module.exports = {
  chmodEntries,
  dirMode,
  fileMode,
  folderSize,
  properties,
  isInside, realPath, allowedBy, listFolder, exportName, writeExport, cleanExports, MAX_ENTRIES,
  checkName, freePath, copyInto, moveInto, moveEntry, renameEntry, canOpenExternally, isImage,
};
