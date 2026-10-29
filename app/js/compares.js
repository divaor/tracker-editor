// Comparisons in tabs of their own (store's c:<id> tabs): what each side is called and where
// it is, for the tab, its bar and saved comparisons. A side of folders is { path } (here or
// remote://); of files { key } (an open-able tab key: f:, r:, d:) or { text, label, detail }.
import { baseName, folderLabel, placeLabel } from './folders.js';
import { server } from './servers.js';
import { parseKey, store } from './store.js';
import { isRemotePath, remoteParts } from './where.js';

const innerPath = (p) => remoteParts(p).path.replace(/\/+$/, '');
const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) || p;

/** A folder's or file's own name: a server's top folder by the server. */
export function pathName(p) {
  if (!isRemotePath(p)) return folderLabel(p) || baseName(p);
  const inner = innerPath(p);
  return inner ? baseName(inner) : (server(remoteParts(p).id)?.name ?? 'Server');
}

/** Where a path is: its folder (on a server, the server's name first). */
export function pathWhere(p) {
  if (!isRemotePath(p)) return placeLabel(dirOf(p));
  const inner = innerPath(p);
  return `${server(remoteParts(p).id)?.name ?? 'Server'} · ${inner ? inner.slice(0, inner.lastIndexOf('/')) || '/' : '/'}`;
}

/** The name a side shows. */
export function sideName(side) {
  if (!side) return '';
  if (side.path) return pathName(side.path);
  if (side.text != null) return side.label || 'Text';
  const k = parseKey(side.key);
  if (k?.kind === 'file') return store.get(k.id)?.name ?? 'file';
  if (k?.kind === 'repo') return store.repoTab(k.path)?.name ?? store.doc(k.path)?.name ?? baseName(k.path);
  if (k?.kind === 'disk') return pathName(k.path);
  return '';
}

/** Where a side is, under its name: a folder (on a server, by its name), "My files · project", "Tracker · item". */
export function sideWhere(side) {
  if (!side) return '';
  if (side.path) return isRemotePath(side.path) ? `${server(remoteParts(side.path).id)?.name ?? 'Server'}: ${innerPath(side.path) || '/'}` : side.path;
  if (side.text != null) return side.detail ?? '';
  const k = parseKey(side.key);
  if (k?.kind === 'file') return ['My files', store.get(k.id)?.project].filter(Boolean).join(' · ');
  if (k?.kind === 'repo') return ['Tracker', store.doc(k.path)?.item.title].filter(Boolean).join(' · ');
  if (k?.kind === 'disk') return isRemotePath(k.path) ? `${server(remoteParts(k.path).id)?.name ?? 'Server'}: ${innerPath(k.path)}` : k.path;
  return '';
}

/** A comparison's name for its tab: "site ↔ site". */
export function compareName(c) {
  if (!c) return 'Comparison';
  if (c.name) return c.name;
  return `${sideName(c.left) || '?'} ↔ ${sideName(c.right) || '?'}`;
}

/** Its tooltip: both sides in full. */
export function compareTitle(c) {
  if (!c) return '';
  const what = c.mode === 'folders' ? 'Folders compared' : 'Files compared';
  return `${what}:\n← ${[sideName(c.left), sideWhere(c.left)].filter(Boolean).join(' · ')}\n→ ${[sideName(c.right), sideWhere(c.right)].filter(Boolean).join(' · ')}`;
}

/** Whether a comparison can be saved: both sides are places (not a text taken once). */
export const canSave = (c) => Boolean(c) && [c.left, c.right].every((s) => s && (s.path || s.key));

/** The same two places, for a saved comparison and to tell whether one is saved already. */
export const sameSides = (a, b) => Boolean(a && b) && a.mode === b.mode && ['left', 'right'].every((s) => (a[s]?.path ?? a[s]?.key) === (b[s]?.path ?? b[s]?.key));
