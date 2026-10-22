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
