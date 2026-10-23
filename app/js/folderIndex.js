// The files in the folders open in Folders (desktop), for opening by name with Ctrl+P.
// Each folder is listed in the main process ('folder:index'), kept for a while, and read
// again in the background when quick open shows it after that.
import { opensInEditor } from './folders.js';

const FRESH_MS = 30_000;
const cache = new Map(); // dir → { files, truncated, at, loading }
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

/** Calls `fn` when a folder's files have been listed; returns the unsubscribe function. */
export function onFolderIndex(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Forgets what was listed (all folders, or the ones given), so the next look lists them again. */
export function forgetFolderIndex(dirs = null) {
  for (const dir of dirs ?? [...cache.keys()]) {
    const known = cache.get(dir);
    if (known) known.at = 0;
  }
}

function refresh(dir, hidden) {
  const known = cache.get(dir);
  if (known?.loading) return;
  const entry = known ?? { files: [], truncated: false, at: 0, loading: null };
  cache.set(dir, entry);
  entry.loading = window.desktop.folders
    .index(dir, { hidden })
    .then((r) => {
      entry.files = r.files.filter((f) => opensInEditor(f.name));
      entry.truncated = r.truncated;
      entry.offline = Boolean(r.offline);
    })
    .catch(() => {
      entry.files = [];
    })
    .finally(() => {
      entry.at = Date.now();
      entry.loading = null;
      changed();
    });
}

/**
 * The files known in `roots` ([{ dir, label, kind }]) as quick open entries
 * ({ id: 'd:<path>', name, rel, where, kind, modifiedAt, path }), starting a new
 * listing for those not listed lately. { files, loading, truncated }.
 */
let watching = false;
export function folderFiles(roots, { hidden = false } = {}) {
  if (!window.desktop?.folders?.index) return { files: [], loading: false, truncated: false };
  // A change in a folder shown makes its list old (it is read again next time).
  if (!watching) watching = Boolean(window.desktop.folders.onChanged?.((change) => forgetFolderIndex(change?.dir ? [change.dir] : null)));
  let files = [];
  let loading = false;
  let truncated = false;
  for (const { dir, label, kind } of roots) {
    const known = cache.get(dir);
    if (!known || Date.now() - known.at > FRESH_MS) refresh(dir, hidden);
    const now = cache.get(dir);
    loading ||= Boolean(now.loading) && !now.at;
    truncated ||= now.truncated;
    // Made once per listing (quick open ranks them on every key).
    const made = `${now.at}|${label}|${kind}`;
    if (now.made !== made) {
      now.entries = now.files.map((f) => ({ id: `d:${f.path}`, path: f.path, name: f.name, rel: f.rel, where: label, kind, modifiedAt: f.mtimeMs ? new Date(f.mtimeMs).toISOString() : '' }));
      now.made = made;
    }
    files = files.concat(now.entries);
  }
  return { files, loading, truncated };
}
