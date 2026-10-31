// Git state for the folders shown in Folders (desktop, folders on this computer): asked of
// the main process (git:status), kept a few seconds, read again when a folder changes or
// the window comes back. The folders view colors its rows with it.
import { statusOf } from './gitStatus.js';

const FRESH_MS = 5000;
const known = new Map(); // folder → { status (or null), at, loading }
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

/** Calls `fn` when a folder's Git state was read again; returns the unsubscribe function. */
export function onGitState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reads the Git state of `dirs` again (all of them, or those not read lately). */
export function refreshGit(dirs, { force = false } = {}) {
  const bridge = window.desktop?.git;
  if (!bridge) return;
  for (const dir of dirs) {
    const k = known.get(dir);
    if (k?.loading || (!force && k && Date.now() - k.at < FRESH_MS)) continue;
    const entry = k ?? { status: null, at: 0, loading: null };
    known.set(dir, entry);
    entry.loading = bridge
      .status(dir)
      .then((status) => {
        const same = JSON.stringify(status) === JSON.stringify(entry.status);
        entry.status = status;
        if (!same) changed();
      })
      .catch(() => {})
      .finally(() => {
        entry.at = Date.now();
        entry.loading = null;
      });
  }
}

/** After a Git command (commit, switch, pull…): every folder known is read again. */
export const refreshAllGit = () => refreshGit([...known.keys()], { force: true });

/** The repository state a folder is in ({ root, branch, ahead, behind, files, staged, unstaged }), or null. */
export const gitOf = (dir) => known.get(dir)?.status ?? null;

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * What Git says about `path` (in the folder `dir` shown): 'M', 'A', 'R', 'U', 'C' for a file,
 * 'dot' for a folder holding changes, or null.
 */
export function gitCodeOf(dir, path, isDir = false) {
  const status = gitOf(dir);
  if (!status) return null;
  const root = norm(status.root);
  const p = norm(path);
  const lower = (s) => (/^[a-z]:/i.test(s) ? s.toLowerCase() : s);
  if (lower(p) !== lower(root) && !lower(p).startsWith(`${lower(root)}/`)) return null;
  return statusOf(status.files, p.slice(root.length + 1), isDir);
}

/**
 * Whether `path` (a file in the folder `dir` shown) has changes staged and not staged:
 * { root, rel, staged, unstaged } (codes or null), or null outside a repository.
 */
export function stageStateOf(dir, path) {
  const status = gitOf(dir);
  if (!status) return null;
  const root = norm(status.root);
  const p = norm(path);
  const lower = (s) => (/^[a-z]:/i.test(s) ? s.toLowerCase() : s);
  if (!lower(p).startsWith(`${lower(root)}/`)) return null;
  const rel = p.slice(root.length + 1);
  return { root: status.root, rel, staged: status.staged?.[rel] ?? null, unstaged: status.unstaged?.[rel] ?? null };
}
