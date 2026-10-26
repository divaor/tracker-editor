// The rows of the Compare with… picker (ui/comparePicker.js), by section: the open tabs, those
// next to the open tab first (two files to compare are usually side by side in the bar); the
// files in the folders open in Folders, while typing; my files; tracker documents.
// Pure, so the Node tests can import it.
import { quickOpen } from './search.js';

/**
 * The open tabs nearest `active` first: by their distance from it in `order` (the tabs
 * the bar shows, in its order); among equals a tab with the same name, then the one on
 * the left. Then `rest` (open tabs the bar's view hides), in their order. `nameOf(key)`
 * names a tab. [{ key, near }], `near` 'left' or 'right' for the tabs right next to it.
 */
export function nearestTabs(order, active, nameOf = () => '', rest = []) {
  const at = order.indexOf(active);
  const name = String(nameOf(active) ?? '').toLowerCase();
  const near = order
    .map((key, i) => ({ key, i, d: at === -1 ? i + 1 : Math.abs(i - at), same: Boolean(name) && String(nameOf(key) ?? '').toLowerCase() === name }))
    .filter((t) => t.key !== active)
    .sort((a, b) => a.d - b.d || b.same - a.same || a.i - b.i)
    .map((t) => ({ key: t.key, near: at !== -1 && t.d === 1 ? (t.i < at ? 'left' : 'right') : '' }));
  const shown = new Set(order);
  return [...near, ...rest.filter((k, i) => k !== active && !shown.has(k) && rest.indexOf(k) === i).map((key) => ({ key, near: '' }))];
}

export const COMPARE_SECTIONS = [
  { id: 'tabs', title: 'Open tabs' },
  { id: 'folders', title: 'In your folders' },
  { id: 'files', title: 'My files' },
  { id: 'docs', title: 'Tracker documents' },
];

/**
 * The sections for `query`: [{ id, title, rows, more }], empty ones left out. Rows are
 * entries as quickOpen ranks them ({ id, name, rel?, project?, item?, path? }): `tabs` in
 * the order given, `folders` (only while typing, not the ones open in a tab), `files` and
 * `docs` (the latest `recent` of each without a query, not the ones open). With a query,
 * each section is ranked on its own and keeps its best `limit`. `more`: rows left out.
 */
export function compareSections({ tabs = [], folders = [], files = [], docs = [] }, query = '', { recent = 40, limit = 40 } = {}) {
  const q = query.trim();
  const open = new Set(tabs.map((t) => t.id));
  const notOpen = (list) => list.filter((f) => !open.has(f.id));
  const rank = (list, n) => {
    const rows = q ? quickOpen(list, q, list.length) : list;
    return { rows: rows.slice(0, n), more: Math.max(0, rows.length - n) };
  };
  const lists = {
    tabs: rank(tabs, q ? limit : tabs.length),
    folders: q ? rank(notOpen(folders), limit) : { rows: [], more: 0 },
    files: rank(notOpen(files), q ? limit : recent),
    docs: rank(notOpen(docs), q ? limit : recent),
  };
  return COMPARE_SECTIONS.map((s) => ({ ...s, ...lists[s.id] })).filter((s) => s.rows.length);
}

/** The folder a path is in, as the picker shows it under the name ("C:\www\site", "/var/www"). */
export function folderOfPath(path) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut <= 0) return path.slice(0, cut + 1);
  // "C:\file" → "C:\"; "/file" → "/".
  return /^[A-Za-z]:$/.test(path.slice(0, cut)) ? path.slice(0, cut + 1) : path.slice(0, cut);
}
