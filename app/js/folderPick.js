// The folder picker (ui/compareFolderPick.js: the other folder of a comparison or of two panes)
// as one tree in blocks, each a root: the folder holding the other side (its siblings), the
// folders shown in Folders, other folders picked before, servers (their start folder once
// connected). Folders are listed as they are opened and flattened into rows with a depth; the
// filter works on what is listed, chips open the tree down to a folder (`revealChain`), and a
// folder is said as "site › src › lib" from its block. Pure, so the tests import it.
import { breadcrumbs, isWithin, nameMatcher } from './folders.js';
import { isRemotePath, remoteParts, toRemoteUri } from './where.js';

const isWindowsPath = (p) => /^[A-Za-z]:([\\/]|$)|^\\\\/.test(p) || (p.includes('\\') && !p.includes('/'));

/** A path as a key: without the separators at its end (a top folder keeps its own), Windows paths in lower case. */
export function pathKey(p) {
  if (!p) return '';
  if (isRemotePath(p)) {
    const { id, path } = remoteParts(p);
    return `remote://${id}${path.replace(/\/+$/, '') || '/'}`;
  }
  const trimmed = /^([A-Za-z]:)?[\\/]+$/.test(p) ? p : p.replace(/[\\/]+$/, '');
  return isWindowsPath(p) ? trimmed.toLowerCase() : trimmed;
}

/** Whether two paths name the same folder. */
export const samePath = (a, b) => Boolean(a) && Boolean(b) && pathKey(a) === pathKey(b);

/** The folder a folder is in, here or on a server; '' at the top ("/", "C:\", a server's "/"). */
export function parentPath(p) {
  if (!p) return '';
  if (isRemotePath(p)) {
    const { id, path } = remoteParts(p);
    const inner = path.replace(/\/+$/, '');
    return inner ? toRemoteUri(id, inner.slice(0, inner.lastIndexOf('/')) || '/') : '';
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

/** The folders of a listing (folders.list's entries), by name: { name, path, hidden }. */
export function subfolders(entries = []) {
  return entries
    .filter((e) => e?.dir)
    .map((e) => ({ name: e.name, path: e.path, hidden: e.hidden ?? e.name.startsWith('.') }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * The picker's blocks, in order, each { id, kind, root, server } (`root` '' for a server not
 * connected yet; `server` the connection id of a block on a server):
 * - 'next': the folder holding the other side, to pick one next to it (not when that is the
 *   root of another block, which lists them already);
 * - 'shown': each folder shown in Folders, in its order;
 * - 'picked': the other folders picked before (not one shown, nor one inside a folder shown);
 * - 'server': each server Folders shows no folder of (`connected`: id → its start folder).
 */
export function pickBlocks({ other = '', shown = [], picked = [], servers = [], connected = {} } = {}) {
  const blocks = [];
  const seen = new Set();
  for (const root of shown) {
    if (!root || seen.has(pathKey(root))) continue;
    seen.add(pathKey(root));
    blocks.push({ id: `shown:${pathKey(root)}`, kind: 'shown', root, server: isRemotePath(root) ? remoteParts(root).id : '' });
  }
  for (const root of picked) {
    if (!root || isRemotePath(root) || seen.has(pathKey(root)) || shown.some((s) => s && isWithin(root, s))) continue;
    seen.add(pathKey(root));
    blocks.push({ id: `picked:${pathKey(root)}`, kind: 'picked', root, server: '' });
  }
  const onServers = new Set(shown.filter(isRemotePath).map((p) => remoteParts(p).id));
  for (const id of servers) {
    if (!onServers.has(id)) blocks.push({ id: `server:${id}`, kind: 'server', root: connected[id] ?? '', server: id });
  }
  const next = other ? parentPath(other) : '';
  if (next && !seen.has(pathKey(next)) && !(isRemotePath(next) && samePath(next, connected[remoteParts(next).id]))) {
    blocks.unshift({ id: 'next', kind: 'next', root: next, server: isRemotePath(next) ? remoteParts(next).id : '' });
  }
  return blocks;
}

/** A row's key: its block's id, then the folder (the block's own root: nothing after the bar). */
export const rowKey = (block, path = '') => `${block}|${path ? pathKey(path) : ''}`;

/**
 * The rows of the tree, in order: each block's head (its root, depth 0), then, when the root is
 * open, the folders listed under it, open ones with theirs (depth 1, 2…), and a status row where
 * a listing is being read ('loading'), failed ('error'), holds no folders ('empty') or was cut
 * short ('truncated'). `blocks` carry a `label` (the head's name); `expanded` is a Set of open
 * folders' keys (pathKey); `listings` maps a key to { state: 'loading' } | { state: 'error',
 * error } | { state: 'done', folders, truncated }. Hidden folders only with `hidden`.
 * With `filter`: the folders whose name fits it among all those listed (open or not) and the
 * folders on the way to them, opened; a head stays when its block has one or it fits itself.
 * `other` marks the folder on the other side (`isOther`).
 */
export function pickRows(blocks, { expanded = new Set(), listings = new Map(), filter = '', hidden = false, other = '' } = {}) {
  const rows = [];
  const keep = (f) => hidden || !f.hidden;
  const listed = (path) => {
    const l = listings.get(pathKey(path));
    return l?.state === 'done' ? l.folders.filter(keep) : null;
  };
  const folderRow = (b, f, depth) => {
    const l = listings.get(pathKey(f.path));
    return {
      type: 'folder',
      key: rowKey(b.id, f.path),
      block: b.id,
      path: f.path,
      name: f.name,
      depth,
      open: expanded.has(pathKey(f.path)),
      canOpen: !(l?.state === 'done' && !l.folders.some(keep)),
      isOther: samePath(f.path, other),
    };
  };
  const status = (b, path, depth, state, error = '') => ({ type: 'status', key: `${rowKey(b.id, path)}|${state}`, block: b.id, path, depth, state, error });
  const walkOpen = (b, path, depth) => {
    const l = listings.get(pathKey(path));
    if (!l || l.state === 'loading') return rows.push(status(b, path, depth, 'loading'));
    if (l.state === 'error') return rows.push(status(b, path, depth, 'error', l.error));
    const list = l.folders.filter(keep);
    for (const f of list) {
      const row = folderRow(b, f, depth);
      rows.push(row);
      if (row.open && row.canOpen) walkOpen(b, f.path, depth + 1);
    }
    if (!list.length) rows.push(status(b, path, depth, 'empty'));
    if (l.truncated) rows.push(status(b, path, depth, 'truncated'));
  };
  const fits = filter.trim() ? nameMatcher(filter) : null;
  for (const b of blocks) {
    const head = { type: 'head', key: rowKey(b.id), block: b.id, path: b.root, name: b.label ?? '', depth: 0, open: Boolean(b.root) && expanded.has(pathKey(b.root)), canOpen: true, isOther: samePath(b.root, other) };
    if (!fits) {
      rows.push(head);
      if (head.open) walkOpen(b, b.root, 1);
      continue;
    }
    // Filtering: what fits among everything listed, with the folders on the way to it.
    const found = [];
    const walk = (path, depth) => {
      let any = false;
      for (const f of listed(path) ?? []) {
        const at = found.length;
        const row = folderRow(b, f, depth);
        found.push(row);
        const inside = walk(f.path, depth + 1);
        const own = fits(f.name);
        if (own || inside) {
          any = true;
          row.open = inside;
          row.match = own;
        } else found.length = at;
      }
      return any;
    };
    const inside = b.root ? walk(b.root, 1) : false;
    if (inside || fits(head.name)) rows.push({ ...head, open: inside, match: fits(head.name) }, ...found);
  }
  return rows;
}

/**
 * The folders to open so `path` shows in a block rooted at `root`: the root and each folder
 * down to the one holding `path` ([] when `path` is the root or not inside it).
 */
export function revealChain(path, root) {
  if (!path || !root || !isWithin(path, root)) return [];
  return breadcrumbs(path, root)
    .slice(0, -1)
    .map((c) => c.path);
}

/** The block a folder is in: the one whose root holds it, the deepest when they nest (blocks without a root left out). */
export function blockFor(path, blocks) {
  let best = null;
  for (const b of blocks) {
    if (!path || !b.root || !isWithin(path, b.root)) continue;
    if (!best || pathKey(b.root).length > pathKey(best.root).length) best = b;
  }
  return best;
}

/** Where a folder is, as "site › src › lib": its block's name (`label`), then the folders down to it; null when it is not inside `root`. */
export function trailLabel(path, root, label) {
  if (!path || !root || !isWithin(path, root)) return null;
  return [
    label,
    ...breadcrumbs(path, root)
      .slice(1)
      .map((c) => c.name),
  ].join(' › ');
}

/**
 * The row the cursor goes to from the row `key` ('down', 'up', 'home', 'end'; 'parent': the
 * folder it is in; 'child': its first folder, when open). Status rows are passed over.
 */
export function moveIn(rows, key, how) {
  const picks = rows.filter((r) => r.type !== 'status');
  if (!picks.length) return null;
  const at = picks.findIndex((r) => r.key === key);
  if (how === 'home') return picks[0].key;
  if (how === 'end') return picks.at(-1).key;
  if (how === 'down') return picks[Math.min(picks.length - 1, at + 1)].key;
  if (how === 'up') return picks[Math.max(0, at - 1)].key;
  if (at < 0) return picks[0].key;
  const row = picks[at];
  if (how === 'parent') {
    for (let i = at - 1; i >= 0; i -= 1) if (picks[i].block === row.block && picks[i].depth < row.depth) return picks[i].key;
    return row.key;
  }
  if (how === 'child') {
    const next = picks[at + 1];
    return next && next.block === row.block && next.depth > row.depth ? next.key : row.key;
  }
  return row.key;
}

/**
 * The chips above the tree: favorites, then recent folders not among them (`max` in all), each
 * { path, kind: 'favorite' | 'recent' }; `leave` (the other side, unless two panes may show it
 * twice) is left out.
 */
export function quickFolders(favorites = [], recent = [], { leave = '', max = 14 } = {}) {
  const out = [];
  const seen = new Set(leave ? [pathKey(leave)] : []);
  for (const [list, kind] of [
    [favorites, 'favorite'],
    [recent, 'recent'],
  ]) {
    for (const path of list ?? []) {
      if (!path || seen.has(pathKey(path))) continue;
      seen.add(pathKey(path));
      out.push({ path, kind });
    }
  }
  return out.slice(0, max);
}
