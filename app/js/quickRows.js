// Quick open's rows (Ctrl+P) and the keys of every pick list, pure: which section a row goes
// under, where its file is in words, which letters to mark, the rows grouped so the best match
// still comes first, and where ↑ ↓ PageUp PageDown Home End take the selection.
import { matchRanges } from './search.js';

/** The sections' headers ('' for the rows that come without one: a typed path, the Ask row). */
export const QUICK_SECTIONS = {
  typed: '',
  ask: '',
  tabs: 'Open tabs',
  recent: 'Recent',
  files: 'My files',
  docs: 'Tracker documents',
  folders: 'In your folders',
};

/**
 * A row's section: a typed path, the Ask row, a tab open on disk or a server (`tab`), a file in
 * the folders shown (`path`), else a synced file or a tracker document (`r:` ids): "Recent" while
 * nothing is typed, then each in its own.
 */
export function quickSection(row, { searching = false } = {}) {
  if (row.typed) return 'typed';
  if (row.ask) return 'ask';
  if (row.tab) return 'tabs';
  if (row.path) return 'folders';
  if (!searching) return 'recent';
  return String(row.id ?? '').startsWith('r:') ? 'docs' : 'files';
}

/**
 * The rows under their sections: [{ id, label, rows }], the sections in the order their first
 * row comes (so the best match, first in `rows`, stays first), the rows in order inside each.
 */
export function groupQuick(rows, { searching = false } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const id = quickSection(row, { searching });
    if (!groups.has(id)) groups.set(id, { id, label: QUICK_SECTIONS[id] ?? '', rows: [] });
    groups.get(id).rows.push(row);
  }
  return [...groups.values()];
}

const innerPath = (p) => String(p ?? '').replace(/^remote:\/\/[^/]+/, '');

/**
 * Where a row's file is, in words, for the muted part after its name: the folders inside the
 * one shown (a file in the folders), the last folders of an open tab's path, "Tracker · item"
 * for a tracker document, "My files" for a synced one.
 */
export function quickPlace(row) {
  if (row.typed) return row.typed;
  if (row.ask) return '';
  if (row.path) {
    const rel = String(row.rel ?? '');
    if (rel.includes('/')) return rel.slice(0, rel.lastIndexOf('/'));
    if (!row.tab) return '';
    const parts = innerPath(row.path).split(/[\\/]+/).filter(Boolean);
    parts.pop();
    return parts.slice(-2).join('/');
  }
  if (row.item) return `Tracker · ${row.item}`;
  return 'My files';
}

/** Where a row's file lives (where.js kinds): a tab or a file in the folders says, a tracker document is 'doc', a typed path 'disk', else 'synced'. */
export function quickKind(row) {
  if (row.typed) return 'disk';
  if (row.path) return row.kind || 'disk';
  return String(row.id ?? '').startsWith('r:') ? 'doc' : 'synced';
}

// Ranges moved by `by` and kept inside [0, length).
const moved = (ranges, by, length) =>
  ranges
    .map(([a, b]) => [Math.max(a - by, 0), Math.min(b - by, length)])
    .filter(([a, b]) => b > a);

/**
 * Which letters to mark for `query` in a row's name, its place (quickPlace) and its project: the
 * name's own match when it has one; else, for a file in the folders, the match in its path inside
 * the folder ("lib/util"), split between the folders and the name; else the match in "item name"
 * (a tracker document: the item's part goes to the place) or "project name" (split between the
 * project and the name). { name: [[from, to], …], place: […], project: […] }, as quickOpen ranks them.
 */
export function quickMarks(row, query) {
  const none = { name: [], place: [], project: [] };
  const q = String(query ?? '').trim();
  if (!q || row.ask || row.typed) return none;
  const name = String(row.name ?? '');
  const own = matchRanges(name, q);
  if (own.length) return { name: own, place: [], project: [] };
  if (row.path) {
    const rel = String(row.rel ?? '');
    const cut = rel.lastIndexOf('/') + 1;
    if (!cut) return none;
    const found = matchRanges(rel, q);
    return { name: moved(found, cut, rel.length - cut), place: moved(found, 0, cut - 1), project: [] };
  }
  if (row.item) {
    const found = matchRanges(`${row.item} ${name}`, q);
    const lead = 'Tracker · '.length;
    if (found.length) return { name: moved(found, row.item.length + 1, name.length), place: moved(found, -lead, lead + row.item.length), project: [] };
  }
  if (row.project) {
    const found = matchRanges(`${row.project} ${name}`, q);
    return { name: moved(found, row.project.length + 1, name.length), place: [], project: moved(found, 0, row.project.length) };
  }
  return none;
}

/** Where each word of `words` is in `text` (the first time), for marking: [[from, to], …] in order, joined when they touch. */
export function wordRanges(text, words) {
  const t = String(text ?? '').toLowerCase();
  const found = (words ?? [])
    .map((w) => String(w).toLowerCase())
    .filter(Boolean)
    .map((w) => [t.indexOf(w), w.length])
    .filter(([at]) => at !== -1)
    .map(([at, n]) => [at, at + n])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of found) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/**
 * Where a key takes a pick list's selection: ↑ ↓ one row, PageUp PageDown a `page`, Home End the
 * first and the last with Ctrl or Cmd, or alone when the field is `empty` (otherwise they stay
 * the field's). null for a key the list does not take. Never past the ends.
 */
export function stepIndex({ key, ctrlKey = false, metaKey = false } = {}, index, count, { page = 8, empty = false } = {}) {
  if (!count) return null;
  const last = count - 1;
  // Nothing chosen yet (-1): ↓ goes to the first row. Past the end (the list got shorter): the last.
  const at = index < 0 ? -1 : Math.min(index, last);
  if (key === 'ArrowDown') return Math.min(at + 1, last);
  if (key === 'ArrowUp') return Math.max(at - 1, 0);
  if (key === 'PageDown') return Math.min(at + Math.max(1, page), last);
  if (key === 'PageUp') return Math.max(at - Math.max(1, page), 0);
  if ((key === 'Home' || key === 'End') && (ctrlKey || metaKey || empty)) return key === 'Home' ? 0 : last;
  return null;
}
