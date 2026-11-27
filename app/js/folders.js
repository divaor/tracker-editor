// The folders view (desktop): where you are inside a folder you picked
// (breadcrumbs, the folder above), filtering a listing, and what goes to
// Claude for a tab (its path when it is on disk, its text otherwise). Pure,
// so the Node tests can import it.

import { isDocumentName } from './docTypes.js';
import { isArchiveName } from './archives.js';

/** The folder under the temporary directory where dragged tabs are written (main.cjs DRAG_DIR). */
export const DRAG_DIR_NAME = 'Tracker Editor drag';

const sepOf = (p) => (/^[A-Za-z]:\\|^\\\\/.test(p) || (p.includes('\\') && !p.includes('/')) ? '\\' : '/');
const trimSep = (p) => (/^([A-Za-z]:)?[\\/]+$/.test(p) ? p : p.replace(/[\\/]+$/, ''));
const parts = (p) => p.split(/[\\/]+/).filter(Boolean);
const sameName = (a, b, sep) => (sep === '\\' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Whether `dir` is `root` or inside it (Windows paths compared without case). */
export function isWithin(dir, root) {
  if (!dir || !root) return false;
  const sep = sepOf(root);
  const r = parts(trimSep(root));
  const d = parts(trimSep(dir));
  if ((dir.startsWith('/') || dir.startsWith('\\')) !== (root.startsWith('/') || root.startsWith('\\'))) return false;
  return d.length >= r.length && r.every((name, i) => sameName(name, d[i], sep));
}

// ---- Several folders side by side (each a root of the tree) ----

const overlaps = (a, b) => isWithin(a, b) || isWithin(b, a);

/** The open folders with `from` showing `to` instead, in its place; others it holds or is inside of close (a path shows once). */
export function replaceSection(list, from, to) {
  const out = [];
  let placed = false;
  for (const s of list) {
    if (s === from || s === to) {
      if (!placed) out.push(to);
      placed = true;
    } else if (!overlaps(s, to)) out.push(s);
  }
  if (!placed) out.push(to);
  return out;
}

/**
 * The folders open side by side in the folders view, with `current` among them: a new
 * current one takes the place of the open one it is in (or holds), else of `previous`
 * (the one shown before), else comes at the end.
 */
export function withCurrent(list = [], current = '', previous = '') {
  const open = [...new Set((list ?? []).filter(Boolean))];
  if (!current || open.includes(current)) return open.length ? open : current ? [current] : [];
  const holder = open.find((s) => overlaps(s, current));
  return replaceSection(open, holder ?? (open.includes(previous) ? previous : ''), current);
}

/** Settings that show `path` in place of the current folder: { folder, folderSections }. */
export function inPlaceSettings(settings, path) {
  return { folder: path, folderSections: withCurrent(settings.folderSections, path, settings.folder) };
}

/**
 * Settings that open `path` beside the folders open in the tree: { folder, folderSections,
 * folderCollapsed }. A folder inside one that is open shows that one (`already`); a folder
 * holding open ones takes their place.
 */
export function besideSettings(settings, path) {
  const open = withCurrent(settings.folderSections, settings.folder);
  const collapsedWithout = (p) => (settings.folderCollapsed ?? []).filter((c) => c !== p);
  const holder = open.find((s) => isWithin(path, s));
  if (holder) return { folder: holder, folderCollapsed: collapsedWithout(holder), already: holder };
  const inside = open.find((s) => isWithin(s, path));
  return { folder: path, folderSections: inside ? replaceSection(open, inside, path) : [...open, path], folderCollapsed: collapsedWithout(path) };
}

/**
 * The open folders with `path` added after them: a folder holding open ones takes the place
 * of the first (the others close); one inside an open folder leaves the list as it is.
 */
export function addSection(list, path) {
  if (list.some((s) => isWithin(path, s))) return list;
  const held = list.find((s) => isWithin(s, path));
  return held ? replaceSection(list, held, path) : [...list, path];
}

/** The open folders with `path` moved just before `target` (or after it, `after`). */
export function moveSectionTo(list, path, target, after = false) {
  if (path === target || !list.includes(path) || !list.includes(target)) return list;
  const out = list.filter((s) => s !== path);
  out.splice(out.indexOf(target) + (after ? 1 : 0), 0, path);
  return out;
}

/** The picked folder that holds `dir` (the deepest when they nest), or null. */
export function rootOf(dir, roots) {
  return roots.filter((r) => isWithin(dir, r)).sort((a, b) => b.length - a.length)[0] ?? null;
}

/** The last part of a path ("C:\" and "/" stay as they are). */
export function baseName(p) {
  const list = parts(trimSep(p));
  return list.length ? list[list.length - 1] : p;
}

// The phone's storage and its memory cards (Android) are folders named 0 and 1234-ABCD.
const STORAGE = /^(\/storage\/emulated\/(\d+)|\/sdcard|\/storage\/self\/primary|\/storage\/([0-9A-F]{4}-[0-9A-F]{4}))(\/.*)?$/i;

/** A folder's name to show: its last part, or what the phone's storage and memory cards are ("Phone storage", "SD card"). */
export function folderLabel(p) {
  const m = STORAGE.exec(p ?? '');
  if (!m || (m[4] && m[4] !== '/')) return baseName(p);
  if (m[3]) return 'SD card';
  return m[2] && m[2] !== '0' ? `Phone storage (${m[2]})` : 'Phone storage';
}

/** Where a folder is, to show ("Phone storage/Documents" rather than /storage/emulated/0/Documents). */
export function placeLabel(dir) {
  const m = STORAGE.exec(dir ?? '');
  if (m) return m[4] && m[4] !== '/' ? `${folderLabel(m[1])}${m[4]}` : folderLabel(m[1]);
  if (/^\/storage(\/emulated)?\/?$/.test(dir ?? '')) return 'This device';
  return dir;
}

/** [{ name, path }] from the picked folder down to `dir`. */
export function breadcrumbs(dir, root) {
  const sep = sepOf(root);
  const base = trimSep(root);
  const crumbs = [{ name: folderLabel(root), path: root }];
  let at = base;
  for (const name of parts(trimSep(dir)).slice(parts(base).length)) {
    at = at.endsWith(sep) || at.endsWith('/') ? `${at}${name}` : `${at}${sep}${name}`;
    crumbs.push({ name, path: at });
  }
  return crumbs;
}

/** The folder above `dir`, or null at the picked folder (you cannot go above it). */
export function parentOf(dir, root) {
  const crumbs = breadcrumbs(dir, root);
  return crumbs.length > 1 ? crumbs[crumbs.length - 2].path : null;
}

// ---- Going up past the folder picked (0.54): to the top of its drive, share, storage or server ----

const REMOTE = 'remote://';
const isRemote = (p) => typeof p === 'string' && p.startsWith(REMOTE);
const remoteSplit = (p) => {
  const rest = p.slice(REMOTE.length);
  const slash = rest.indexOf('/');
  return { id: slash === -1 ? rest : rest.slice(0, slash), inner: (slash === -1 ? '' : rest.slice(slash)) || '/' };
};
const isWindowsPath = (p) => /^[A-Za-z]:([\\/]|$)|^\\\\/.test(p) || (p.includes('\\') && !p.includes('/'));

/** A path as a key: without the separators at its end (a top folder keeps its own), Windows paths in lower case. */
export function pathKey(p) {
  if (!p) return '';
  if (isRemote(p)) {
    const { id, inner } = remoteSplit(p);
    return `${REMOTE}${id}${inner.replace(/\/+$/, '') || '/'}`;
  }
  const trimmed = /^([A-Za-z]:)?[\\/]+$/.test(p) ? p : p.replace(/[\\/]+$/, '');
  return isWindowsPath(p) ? trimmed.toLowerCase() : trimmed;
}

/** Whether two paths name the same folder. */
export const samePath = (a, b) => Boolean(a) && Boolean(b) && pathKey(a) === pathKey(b);

/** The folder a folder is in, here or on a server; '' at the top ("/", "C:\", "\\server\share", a server's "/"). */
export function parentPath(p) {
  if (!p) return '';
  if (isRemote(p)) {
    const { id, inner } = remoteSplit(p);
    const trimmed = inner.replace(/\/+$/, '');
    return trimmed ? `${REMOTE}${id}${trimmed.slice(0, trimmed.lastIndexOf('/')) || '/'}` : '';
  }
  const trimmed = p.replace(/[\\/]+$/, '');
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return '';
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return '';
  const parent = trimmed.slice(0, cut);
  if (!parent) return trimmed.startsWith('/') ? '/' : '';
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
  // \\server\share is the top of a network folder.
  if (/^\\\\[^\\]+$/.test(parent)) return '';
  return parent;
}

// Folders mounted as volumes on macOS and Linux: each is a place of its own, like a drive.
const VOLUME = /^(\/Volumes\/[^/]+|\/media\/[^/]+\/[^/]+|\/run\/media\/[^/]+\/[^/]+|\/mnt\/[^/]+)(\/|$)/;

/**
 * The top a folder can go up to: a drive ("C:\"), a network share ("\\nas\share"), the phone's
 * storage or a memory card, a server's "/" (remote://id/), else "/".
 */
export function topOf(p) {
  if (!p) return '';
  if (isRemote(p)) return `${REMOTE}${remoteSplit(p).id}/`;
  const drive = /^([A-Za-z]):/.exec(p);
  if (drive) return `${drive[1].toUpperCase()}:\\`;
  const share = /^\\\\[^\\/]+[\\/][^\\/]+/.exec(p);
  if (share) return share[0].replace(/\//g, '\\');
  const storage = STORAGE.exec(p);
  if (storage) return storage[1];
  return '/';
}

/** The place a folder is on, to tell whether two are on the same one: a drive, a share, a server, the phone's storage or a card, a mounted volume, or 'here'. */
export function placeKey(p) {
  if (!p) return '';
  if (isRemote(p)) return `remote:${remoteSplit(p).id}`;
  const top = topOf(p);
  if (top !== '/') return pathKey(top);
  return VOLUME.exec(p)?.[1] ?? 'here';
}

/** The folder above `dir` as far as its top goes (topOf), or null there. */
export function upOf(dir) {
  if (!dir || samePath(dir, topOf(dir))) return null;
  return parentPath(dir) || null;
}

/**
 * The place "Allow all" opens when going up to `parent`: its drive, share or storage; on macOS
 * and Linux the home folder holding it (`home`), else its mounted volume, else "/".
 */
export function wideOf(parent, { home = '' } = {}) {
  const top = topOf(parent);
  if (top !== '/') return top;
  if (home && home !== '/' && isWithin(parent, home)) return home.replace(/\/+$/, '');
  return VOLUME.exec(parent)?.[1] ?? '/';
}

/**
 * [{ name, path }] from the top of `dir` (topOf) down to it: the whole path. On macOS and Linux a
 * folder inside the home folder (`home`) starts at "~". `top` names the first one (a server's).
 */
export function fullCrumbs(dir, { home = '', top = '' } = {}) {
  if (!dir) return [];
  const start = !isRemote(dir) && topOf(dir) === '/' && home && home !== '/' && isWithin(dir, home) ? home.replace(/\/+$/, '') : topOf(dir);
  const crumbs = breadcrumbs(dir, start);
  const name = start !== topOf(dir) ? '~' : STORAGE.test(start) ? folderLabel(start) : start === '/' ? '/' : start.replace(/\\$/, '');
  crumbs[0] = { ...crumbs[0], name: top || name };
  return crumbs;
}

/**
 * How a folder picked in Folders' list opens: 'focus' when it is shown already (it is just worked
 * in), 'replace' (in place of the current folder) when it is on the same place as the current one
 * (a drive, a share, a server: placeKey) or holds or is inside a folder shown, else 'beside' (another
 * root of the tree): a folder on another drive, a server or a place opens side by side.
 */
export function openPlacement(target, sections = [], current = '') {
  if (!target) return 'replace';
  const shown = (sections ?? []).filter(Boolean);
  if (shown.some((s) => samePath(s, target))) return 'focus';
  if (shown.some((s) => isWithin(target, s) || isWithin(s, target))) return 'replace';
  const from = current || shown[0] || '';
  if (!from) return 'replace';
  return placeKey(target) === placeKey(from) ? 'replace' : 'beside';
}

/**
 * Whether a name passes the filter: it has the text in it (any case), or with * or ?
 * it fits the pattern ("*.yml", "test?.js"). An empty filter lets everything through.
 */
export function nameMatcher(query = '') {
  const q = query.trim().toLowerCase();
  if (!q) return () => true;
  if (!/[*?]/.test(q)) return (name) => name.toLowerCase().includes(q);
  const re = new RegExp(`^${q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return (name) => re.test(name.toLowerCase());
}

/** The entries to show: hidden ones (dot files) only when asked, then those whose name passes the filter. */
export function filterEntries(entries, { query = '', hidden = false } = {}) {
  const passes = nameMatcher(query);
  return entries.filter((e) => (hidden || !e.hidden) && passes(e.name));
}

/** A path as a terminal takes it: quoted when it has spaces or shell characters. */
export const quotePath = (p) => (/[\s"'&()<>|;$`]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

/** Whether a dropped file is one of the copies a dragged tab leaves in the temporary folder. */
export const isDragCopy = (p) => typeof p === 'string' && parts(p).includes(DRAG_DIR_NAME);

/**
 * What "Copy for Claude" puts on the clipboard: the path of a file on disk
 * (Claude Code reads it there), or the name and the text in a code block.
 */
export function claudeText({ name, text = '', path = '' }) {
  if (path) return quotePath(path);
  const ext = /\.([A-Za-z0-9+#-]{1,12})$/.exec(name ?? '')?.[1]?.toLowerCase() ?? '';
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${name}:\n\n${fence}${ext}\n${text.replace(/\n$/, '')}\n${fence}\n`;
}

// ---- The explorer: order, selection, what opens where ---------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const extOf = (name) => /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

export const FOLDER_SORTS = [
  { id: 'name', label: 'Name' },
  { id: 'modified', label: 'Date modified' },
  { id: 'size', label: 'Size' },
  { id: 'type', label: 'Type' },
];

/** Folders first, then files: by name, newest first, largest first, or by type (extension); `reverse` turns the order around (folders stay first). */
export function sortEntries(entries, sort = 'name', reverse = false) {
  const byName = (a, b) => collator.compare(a.name, b.name);
  const order = {
    name: byName,
    modified: (a, b) => b.mtimeMs - a.mtimeMs || byName(a, b),
    size: (a, b) => (a.dir || b.dir ? 0 : b.size - a.size) || byName(a, b),
    type: (a, b) => collator.compare(extOf(a.name), extOf(b.name)) || byName(a, b),
  }[sort] ?? byName;
  const way = reverse ? -1 : 1;
  return [...entries].sort((a, b) => (a.dir === b.dir ? way * order(a, b) : a.dir ? -1 : 1));
}

/** Whether a sort goes up (A to Z, oldest first) as shown in a column header: names and types do, dates and sizes start from the top. */
export const sortsUp = (sort, reverse = false) => (sort === 'modified' || sort === 'size') === reverse;

/**
 * The rows of the folder as a tree: [{ entry, depth, expanded }] with the contents of
 * expanded folders (`children`: folder → its entries, as listed) under them. With a
 * query, a file shows when its name passes it and a folder when its name does or
 * something listed inside it does (shown under it while it is open).
 */
export function treeRows(entries, { expanded = new Set(), children = new Map(), query = '', hidden = false, sort = 'name', reverse = false } = {}) {
  const q = query.trim();
  const passes = nameMatcher(q);
  const walk = (list, depth, seen) => {
    const rows = [];
    for (const entry of sortEntries(list.filter((e) => hidden || !e.hidden), sort, reverse)) {
      const open = entry.dir && expanded.has(entry.path) && !seen.has(entry.path);
      // A closed folder with something that matches inside still shows (closed).
      const below = (open || q) && entry.dir && children.has(entry.path) && !seen.has(entry.path) ? walk(children.get(entry.path) ?? [], depth + 1, new Set([...seen, entry.path])) : [];
      if (q && !passes(entry.name) && !below.length) continue;
      rows.push({ entry, depth, expanded: open }, ...(open ? below : []));
    }
    return rows;
  };
  return walk(entries, 0, new Set());
}

/** The paths without those inside another one of them (a folder selected with what is in it acts once). */
export function topmost(paths) {
  return paths.filter((p) => !paths.some((q) => q !== p && isWithin(p, q)));
}

/** The recent folders with `path` first, at most `max`. */
export const pushRecent = (list = [], path, max = 8) => [path, ...list.filter((p) => p !== path)].slice(0, max);
/** The favorite folders with `path` added (at the end) or taken out. */
export const toggleFavorite = (list = [], path) => (list.includes(path) ? list.filter((p) => p !== path) : [...list, path]);

/** The paths from `anchor` to `target` in the order shown (Shift+click); just the target without an anchor. */
export function rangeOf(order, anchor, target) {
  const from = order.indexOf(anchor);
  const to = order.indexOf(target);
  if (from === -1 || to === -1) return to === -1 ? [] : [target];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

// Formats the editor cannot show as text: they open with their own program.
const BINARY = new Set(
  'png jpg jpeg gif bmp webp tif tiff ico heic heif avif psd ai eps pdf doc docx docm dot dotx xls xlsx xlsm xlsb ppt pptx pptm odt ods odp odg rtf pages numbers key vsd vsdx pub one msg eml oft zip 7z rar gz tgz bz2 xz tar iso dmg cab jar war mp3 wav ogg flac m4a aac wma mp4 m4v mov avi mkv webm wmv flv ttf otf woff woff2 eot exe dll msi so dylib class pyc o obj lib a sqlite sqlite3 db mdb accdb dwg dxf skp blend fbx stl 3mf epub mobi'.split(' '),
);
const IMAGES = new Set('png jpg jpeg gif bmp webp tif tiff'.split(' '));

const PEEK_IMAGES = new Set('png jpg jpeg gif bmp webp ico avif'.split(' '));
/** What the folders view's preview shows for a file: 'image', 'doc' (a document shown as it looks: PDF, e-book…), 'archive' (what it holds), 'locked' (a file locked with a password: not read), 'text' (read as text) or 'none'. */
export const peekKind = (name) => (isLockedName(name) ? 'locked' : PEEK_IMAGES.has(extOf(name)) ? 'image' : isDocumentName(name) ? 'doc' : isArchiveName(name) ? 'archive' : BINARY.has(extOf(name)) ? 'none' : 'text');

/** Whether a file opens in the editor as text; the others open with their own program, or as documents (opensHere). Unknown types are tried as text. */
export const opensInEditor = (name) => !BINARY.has(extOf(name)) && !isDocumentName(name) && !isArchiveName(name);
/**
 * A file locked with a password ("notes.md.locked": locked.js keeps the same rule): it opens in the
 * editor, which asks for its password; its text is ciphertext, never searched or read for the model.
 */
export const isLockedName = (name) => typeof name === 'string' && /.\.locked$/i.test(name.split(/[\\/]/).pop());
/** What Find in a folder and Find by asking read: text files, but not locked ones. */
export const searchesText = (name) => opensInEditor(name) && !isLockedName(name);
/** Whether a file opens in a tab here: as text, or as a document shown as it looks. */
export const opensHere = (name) => opensInEditor(name) || isDocumentName(name);
/** Images whose text can be read (OCR). */
export const isImageName = (name) => IMAGES.has(extOf(name));

/** The part of a name selected when renaming: the name without its extension (all of it for a folder). */
export function renameRange(name, dir = false) {
  const dot = name.lastIndexOf('.');
  return [0, dir || dot <= 0 ? name.length : dot];
}

/**
 * Where `p` is after `from` moved to `to` (it, or something inside it), or null when it
 * is not affected. Moved between Windows and a server, the rest takes the new separator.
 */
export function remapPath(p, from, to) {
  if (p === from) return to;
  for (const sep of ['/', '\\']) {
    const base = from.endsWith(sep) ? from : from + sep;
    if (!p.startsWith(base)) continue;
    const rest = p.slice(base.length);
    const next = sepOf(to);
    return (to.endsWith(next) ? to : to + next) + (sepOf(from) === next ? rest : rest.split(sepOf(from)).join(next));
  }
  return null;
}

/** The status line: "12 items", "3 of 12 selected · 1.2 MB". */
export function selectionSummary(entries, selected, formatBytes = (n) => `${n} B`) {
  const count = entries.length;
  const items = `${count} item${count === 1 ? '' : 's'}`;
  const chosen = entries.filter((e) => selected.has(e.path));
  if (!chosen.length) return items;
  const bytes = chosen.filter((e) => !e.dir).reduce((sum, e) => sum + e.size, 0);
  return `${chosen.length} of ${items} selected${bytes ? ` · ${formatBytes(bytes)}` : ''}`;
}

/** "drwxr-xr-x" for a mode (s and t for setuid, setgid and sticky; S and T without x); '' when not known. */
export function modeString(mode, dir = false) {
  if (mode === null || mode === undefined) return '';
  const bit = (b, ch) => (mode & b ? ch : '-');
  let out = dir ? 'd' : '-';
  for (const [shift, special, mark] of [[6, 0o4000, 's'], [3, 0o2000, 's'], [0, 0o1000, 't']]) {
    const x = mode & (1 << shift);
    out += bit(4 << shift, 'r') + bit(2 << shift, 'w') + (mode & special ? (x ? mark : mark.toUpperCase()) : x ? 'x' : '-');
  }
  return out;
}
/** "644", or "4755" with special bits. */
export const octalMode = (mode) => (mode & 0o7777).toString(8).padStart(3, '0');
/** "755" or "0644" as a mode, or null when it is not one. */
export function parseMode(text) {
  const t = String(text ?? '').trim();
  return /^[0-7]{3,4}$/.test(t) ? parseInt(t, 8) : null;
}
/** Who and what in the permissions grid: owner, group, others × read, write, run. */
export const PERMISSION_WHO = [
  { id: 'owner', label: 'Owner', shift: 6 },
  { id: 'group', label: 'Group', shift: 3 },
  { id: 'others', label: 'Others', shift: 0 },
];
export const PERMISSION_WHAT = [
  { id: 'read', label: 'Read', bit: 4 },
  { id: 'write', label: 'Write', bit: 2 },
  { id: 'run', label: 'Run', bit: 1, folderLabel: 'Open' },
];
