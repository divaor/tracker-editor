// Two panes (a comparison tab's 'panes' mode, desktop): two folders side by side, each
// browsed on its own, with files copied and moved between them like WinSCP's or Total
// Commander's. What the lists show, what a key does and how a drag goes. Pure, so the
// Node tests can import it.

import { baseName, filterEntries, isWithin, sortEntries } from './folders.js';
import { isRemotePath, remoteParts } from './where.js';

/** The name the folder above has in a pane. */
export const UP_NAME = '..';

/** The rows of a pane: `..` (the folder above, when there is one) first, then the entries shown, folders first and sorted. */
export function paneRows(entries = [], { up = null, hidden = false, sort = 'name', reverse = false } = {}) {
  const rows = sortEntries(filterEntries(entries, { hidden }), sort, reverse);
  return up ? [{ up: true, name: UP_NAME, path: up, dir: true }, ...rows] : rows;
}

const KEYS = { F2: 'rename', F5: 'copy', F6: 'move', F7: 'newFolder', F8: 'delete', Delete: 'delete', Enter: 'open', Backspace: 'up', Insert: 'mark', ' ': 'view', Escape: 'escape' };

/**
 * What a key does in a pane, or null (the arrows, Home, End and the pages move the cursor
 * there and are not commands): F5 copies and F6 moves to the other side, F7 makes a folder,
 * F8 (or Del) deletes, Tab goes to the other side, Backspace (Alt+↑) goes up.
 */
export function paneCommand({ key = '', ctrlKey = false, metaKey = false, shiftKey = false, altKey = false } = {}) {
  const mod = ctrlKey || metaKey;
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (altKey) return mod ? null : key === 'Enter' ? 'properties' : key === 'ArrowUp' ? 'up' : null;
  if (key === 'Tab') return mod ? null : 'switch';
  if (mod) return shiftKey && k === 'n' ? 'newFolder' : !shiftKey && k === 'a' ? 'selectAll' : null;
  if (shiftKey && key.length === 1) return null;
  return KEYS[key] ?? null;
}

// Where a path is, for a drag: one server, a drive on Windows, or this computer.
const placeOf = (p) => (isRemotePath(p) ? `remote:${remoteParts(p).id}` : (/^([A-Za-z]):/.exec(p)?.[1]?.toLowerCase() ?? (p.startsWith('\\\\') ? p.split('\\')[2]?.toLowerCase() : 'here')));

/**
 * What a drop does when no key says: within the same place (this computer, a drive, a
 * server) it moves, between places (this computer and a server, two servers) it copies,
 * as Explorer does between drives. Ctrl always copies, Shift always moves.
 */
export function dropOperation(from, to, { ctrlKey = false, shiftKey = false } = {}) {
  if (ctrlKey) return 'copy';
  if (shiftKey) return 'move';
  return placeOf(from) === placeOf(to) ? 'move' : 'copy';
}

// The folder a path is in, and folders compared without their last separator, so a server's
// top folder (remote://id/) and C:\ match the folders their entries name.
const dirOf = (p) => {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : p;
};
const trimSep = (p) => p.replace(/[\\/]+$/, '');

/** Whether `p` is right inside the folder `dir`. */
export const inFolder = (p, dir) => trimSep(dirOf(p)) === trimSep(dir);

/**
 * The paths that can go to `target`: { go, here, into } (`here`: already in that folder;
 * `into`: a folder going into itself or one inside it, which cannot be).
 */
export function transferable(paths, target) {
  const here = [];
  const into = [];
  const go = [];
  for (const p of paths) {
    if (inFolder(p, target)) here.push(p);
    else if (isWithin(target, p)) into.push(p);
    else go.push(p);
  }
  return { go, here, into };
}

/** The entry with the same name as `entry` among `entries` (the other side's), or null. */
export function sameNamed(entries = [], entry) {
  if (!entry) return null;
  return entries.find((e) => !e.up && e.name === entry.name) ?? entries.find((e) => !e.up && e.name.toLowerCase() === entry.name.toLowerCase()) ?? null;
}

/** "3 items" or the one name, for messages. */
export function itemsName(paths) {
  return paths.length === 1 ? baseName(paths[0]) : `${paths.length} items`;
}
