// Breadcrumbs over each editor view (breadcrumbs.js draws them): where the tab's file is, then
// the symbols around the cursor ("site › src › store.js › Store › save"). Pure, so the Node
// tests can import it.
import { parentPath } from './folderPick.js';
import { breadcrumbs, folderLabel, rootOf } from './folders.js';
import { isContentPath, isRemotePath, remoteParts, toRemoteUri } from './where.js';

const nameOf = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/**
 * The crumbs of a tab's place, outermost first: [{ kind, label, path?, title }]. Kinds:
 * 'root' (a folder shown in Folders), 'folder', 'server', 'file' (on disk or a server: `path`
 * is the file), 'files' (My files), 'project', 'tracker', 'item' (`itemId`).
 * - `d:` paths: from the folder shown in Folders that holds the file (`roots`, the deepest one),
 *   else (on a server) from the server's top, else the last `keep` folders above it.
 * - `f:` synced files: My files › its project › its name (`file`: { name, project }).
 * - `r:` tracker documents: Tracker › its item › its name (`doc`: { name, item: { id, title } }).
 */
export function placeCrumbs({ key = '', roots = [], serverName = () => '', file = null, doc = null, keep = 2 } = {}) {
  if (key.startsWith('f:')) {
    if (!file) return [];
    return [{ kind: 'files', label: 'My files', title: 'My files' }, file.project && { kind: 'project', label: file.project, title: `Project ${file.project}` }, { kind: 'file', label: file.name, title: file.name }].filter(Boolean);
  }
  if (key.startsWith('r:')) {
    const path = key.slice(2);
    const name = doc?.name || nameOf(path);
    const item = doc?.item;
    return [{ kind: 'tracker', label: 'Tracker', title: 'Tracker documents' }, item?.title && { kind: 'item', label: item.title, itemId: item.id, title: `Item: ${item.title}` }, { kind: 'file', label: name, title: name, path }].filter(Boolean);
  }
  if (!key.startsWith('d:')) return [];
  const path = key.slice(2);
  // A file another Android app gave: no folders to show.
  if (isContentPath(path)) return [{ kind: 'file', label: doc?.name || nameOf(decodeURIComponent(path)), title: path, path }];
  const dir = parentPath(path);
  const leaf = { kind: 'file', label: nameOf(path), title: path, path };
  const root = dir ? rootOf(dir, roots.filter(Boolean)) : null;
  const out = [];
  if (isRemotePath(path)) {
    const { id } = remoteParts(path);
    const top = toRemoteUri(id, '/');
    out.push({ kind: 'server', label: serverName(id) || 'Server', title: `${serverName(id) || 'Server'}: /`, path: top });
    const from = root ?? top;
    const chain = dir ? breadcrumbs(dir, from) : [];
    // From the top of the server, its "/" is the server crumb itself.
    for (const [i, c] of chain.entries()) {
      if (!root && i === 0) continue;
      out.push({ kind: i === 0 ? 'root' : 'folder', label: c.name, title: remoteParts(c.path).path, path: c.path });
    }
    return [...out, leaf];
  }
  if (root) {
    for (const [i, c] of breadcrumbs(dir, root).entries()) out.push({ kind: i === 0 ? 'root' : 'folder', label: i === 0 ? folderLabel(root) : c.name, title: c.path, path: c.path });
    return [...out, leaf];
  }
  // Not in a folder shown in Folders: the last few folders above it.
  const above = [];
  for (let p = dir; p && above.length < keep; p = parentPath(p)) above.unshift(p);
  for (const p of above) out.push({ kind: 'folder', label: folderLabel(p) || p, title: p, path: p });
  return [...out, leaf];
}

/**
 * The symbols around the cursor as crumbs, outermost first: scope entries (outline.js
 * { title, line, level }, as editor.js scopeEntries gives them) with their place among
 * `entries` (the whole outline): [{ kind: 'symbol', label, line, level, index }].
 */
export function symbolCrumbs(entries = [], scope = []) {
  return scope.map((e) => ({ kind: 'symbol', label: e.title, line: e.line, level: e.level, index: entries.indexOf(e) })).filter((c) => c.index !== -1);
}

/** The entries next to `entries[index]`: under the same one (the nearest above it with a lower level), at its level; itself too. */
export function symbolSiblings(entries = [], index = -1) {
  const e = entries[index];
  if (!e) return [];
  let start = 0;
  let end = entries.length;
  for (let i = index - 1; i >= 0; i--) {
    if (entries[i].level < e.level) {
      start = i + 1;
      break;
    }
  }
  for (let i = index + 1; i < entries.length; i++) {
    if (entries[i].level < e.level) {
      end = i;
      break;
    }
  }
  const out = [];
  for (let i = start; i < end; i++) if (entries[i].level === e.level) out.push({ ...entries[i], index: i });
  return out;
}

/** What is inside `entries[index]`: the entries after it that are deeper, up to the next one at its level or above (the shallowest of them). */
export function symbolChildren(entries = [], index = -1) {
  const e = entries[index];
  if (!e) return [];
  const inside = [];
  for (let i = index + 1; i < entries.length && entries[i].level > e.level; i++) inside.push({ ...entries[i], index: i });
  if (!inside.length) return [];
  const top = Math.min(...inside.map((x) => x.level));
  return inside.filter((x) => x.level === top);
}

/** The outline's top level ([{ title, line, level, index }]): for a cursor outside every symbol. */
export function topSymbols(entries = []) {
  if (!entries.length) return [];
  const top = Math.min(...entries.map((e) => e.level));
  return entries.map((e, index) => ({ ...e, index })).filter((e) => e.level === top);
}

/**
 * A listing (folders.list's entries) as a crumb's menu: folders first, then files, by name
 * ({ name, path, dir }); hidden ones only with `hidden`; at most `max` (`more`: how many are left out).
 */
export function listingRows(entries = [], { hidden = false, filesOnly = false, max = 400 } = {}) {
  const shown = entries.filter((e) => (hidden || !e.hidden) && (!filesOnly || !e.dir));
  shown.sort((a, b) => Number(Boolean(b.dir)) - Number(Boolean(a.dir)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { rows: shown.slice(0, max).map((e) => ({ name: e.name, path: e.path, dir: Boolean(e.dir) })), more: Math.max(0, shown.length - max) };
}
