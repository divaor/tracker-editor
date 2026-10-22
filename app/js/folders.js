// The folders view (desktop): where you are inside a folder you picked
// (breadcrumbs, the folder above), filtering a listing, and what goes to
// Claude for a tab (its path when it is on disk, its text otherwise). Pure,
// so the Node tests can import it.

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

/** The picked folder that holds `dir` (the deepest when they nest), or null. */
export function rootOf(dir, roots) {
  return roots.filter((r) => isWithin(dir, r)).sort((a, b) => b.length - a.length)[0] ?? null;
}

/** The last part of a path ("C:\" and "/" stay as they are). */
export function baseName(p) {
  const list = parts(trimSep(p));
  return list.length ? list[list.length - 1] : p;
}

/** [{ name, path }] from the picked folder down to `dir`. */
export function breadcrumbs(dir, root) {
  const sep = sepOf(root);
  const base = trimSep(root);
  const crumbs = [{ name: baseName(root), path: root }];
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

/** The entries to show: hidden ones (dot files) only when asked, then those whose name has the query. */
export function filterEntries(entries, { query = '', hidden = false } = {}) {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => (hidden || !e.hidden) && (!q || e.name.toLowerCase().includes(q)));
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

/** Folders first, then files: by name, newest first, largest first, or by type (extension). */
export function sortEntries(entries, sort = 'name') {
  const byName = (a, b) => collator.compare(a.name, b.name);
  const order = {
    name: byName,
    modified: (a, b) => b.mtimeMs - a.mtimeMs || byName(a, b),
    size: (a, b) => (a.dir || b.dir ? 0 : b.size - a.size) || byName(a, b),
    type: (a, b) => collator.compare(extOf(a.name), extOf(b.name)) || byName(a, b),
  }[sort] ?? byName;
  return [...entries].sort((a, b) => (a.dir === b.dir ? order(a, b) : a.dir ? -1 : 1));
}

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

/** Whether a file opens in the editor (text); the others open with their own program. Unknown types are tried as text. */
export const opensInEditor = (name) => !BINARY.has(extOf(name));
/** Images whose text can be read (OCR). */
export const isImageName = (name) => IMAGES.has(extOf(name));

/** The part of a name selected when renaming: the name without its extension (all of it for a folder). */
export function renameRange(name, dir = false) {
  const dot = name.lastIndexOf('.');
  return [0, dir || dot <= 0 ? name.length : dot];
}

/** Where `p` is after `from` moved to `to` (it, or something inside it), or null when it is not affected. */
export function remapPath(p, from, to) {
  if (p === from) return to;
  for (const sep of ['/', '\\']) if (p.startsWith(from.endsWith(sep) ? from : from + sep)) return to + (from.endsWith(sep) ? sep : '') + p.slice(from.length);
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
