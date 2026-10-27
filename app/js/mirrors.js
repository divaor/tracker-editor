// Mirrors (desktop): a folder on a server kept the same as one here. The list and
// each one's status come from the main process (mirror:*); the folders view, the
// tabs and the dialogs read them here.
import { isRemotePath, remoteParts } from './where.js';

let list = [];
const listeners = new Set();
let wired = false;
const bridge = () => window.desktop?.mirrors;

export const mirrorsAvailable = () => Boolean(bridge());
export const mirrors = () => list;
export const mirror = (id) => list.find((m) => m.id === id) ?? null;

export function onMirrors(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
const changed = () => listeners.forEach((l) => l(list));

export async function refreshMirrors() {
  if (!bridge()) return list;
  list = await bridge().list();
  changed();
  return list;
}

/** Status changes from the main process; call once. */
export function watchMirrors() {
  if (!bridge() || wired) return () => {};
  wired = true;
  refreshMirrors().catch((err) => console.warn('Mirrors', err));
  return bridge().onStatus((m) => {
    const at = list.findIndex((x) => x.id === m.id);
    list = at === -1 ? [...list, m] : list.map((x) => (x.id === m.id ? m : x));
    changed();
  });
}

const insideLocal = (p, root) => {
  const norm = (x) => x.replace(/[\\/]+$/, '');
  const a = norm(p);
  const b = norm(root);
  return a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}\\`);
};
const insideRemote = (p, root) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);

/**
 * The mirror a folder or file is in: { mirror, side: 'local' | 'remote', rel }, or null.
 * `path` is a path here or a remote:// one.
 */
export function mirrorOf(path) {
  if (!path) return null;
  for (const m of list) {
    if (isRemotePath(path)) {
      const { id, path: p } = remoteParts(path);
      if (id === m.conn && insideRemote(p, m.remote)) return { mirror: m, side: 'remote', rel: p.slice(m.remote.length).replace(/^\//, '') };
    } else if (insideLocal(path, m.local)) return { mirror: m, side: 'local', rel: path.slice(m.local.replace(/[\\/]+$/, '').length).replace(/^[\\/]/, '').split('\\').join('/') };
  }
  return null;
}

/** "3 up, 2 down, 1 deleted here" for the last sync, or "" when nothing changed. */
export function lastSyncText(last) {
  if (!last) return '';
  const parts = [
    last.uploaded && `${last.uploaded} up`,
    last.downloaded && `${last.downloaded} down`,
    last.deletedLocal && `${last.deletedLocal} deleted here`,
    last.deletedRemote && `${last.deletedRemote} deleted on the server`,
    last.conflicts && `${last.conflicts} changed on both sides (both kept)`,
  ].filter(Boolean);
  return parts.join(', ');
}
