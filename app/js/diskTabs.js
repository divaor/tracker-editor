// Files on disk edited in place (desktop app): opening them, saving them back
// (refusing when they changed on disk meanwhile), reloading, and following
// them as they grow (tail -f). The main process does the reading and writing
// (electron/diskFiles.cjs) for the files picked in its open dialog.
import { diskKey, store } from './store.js';
import { isRemotePath, remoteParts } from './where.js';

const bridge = () => globalThis.window?.desktop?.disk;
export const diskAvailable = () => Boolean(bridge());
/** A tab that cannot be edited: followed, the end of a large file, a document (PDF, e-book…), or one its app (Android) lets us only read. */
export const diskReadOnly = (tab) => Boolean(tab && (tab.follow || tab.truncated || tab.readOnly || tab.doc));

/** Picks files and opens them as disk tabs. Returns the problems to show ([] when all opened). */
export async function openDiskFiles() {
  const problems = [];
  for (const info of await bridge().open()) {
    if (info.error) {
      problems.push(`${info.name}: ${info.error}`);
      continue;
    }
    store.openDiskFile(info);
    await bridge().watch(info.path);
  }
  return problems;
}

// A file on a server that could not be reached (rather than one that is not there).
const unreachable = (path, err) => isRemotePath(path) && !/Not found/i.test(err?.message ?? '');

/** Writes the tab's text: 'saved', or 'conflict' when the file changed on disk or on the server (unless `force`). */
export async function saveDiskTab(path, { force = false } = {}) {
  const tab = store.diskTab(path);
  if (!tab) return 'missing';
  const text = tab.text;
  store.diskPatch(path, { saving: true });
  let result;
  try {
    // The size too: some FTP servers give no exact time.
    result = await bridge().write(path, text, { eol: tab.eol, bom: tab.bom, encoding: tab.encoding, expectedMtime: tab.mtimeMs, expectedSize: tab.size, force });
  } catch (err) {
    store.diskPatch(path, { saving: false, ...(unreachable(path, err) ? { offline: true } : {}) });
    throw err;
  }
  if (result.conflict) {
    store.diskPatch(path, { conflict: true, saving: false, offline: false });
    return 'conflict';
  }
  store.diskSaved(path, { text, ...result });
  store.diskPatch(path, { saving: false, offline: false });
  return 'saved';
}

/** The file as it is on disk now; returns its text (a document's: what its view read, until it changes). */
export async function reloadDiskTab(path) {
  const info = await bridge().read(path);
  store.diskReloaded(path, info);
  return store.diskTab(path)?.text ?? info.text;
}

/**
 * Watches the open disk tabs: a file changed elsewhere is reloaded when it has
 * no unsaved edits here (`onReplace(key, text)`), flagged as a conflict when it
 * has, and a followed one gets its new lines (`onAppend(key, text)`).
 */
let recheck = () => {};
/** Looks again at the tabs of a server that just connected (changes made there meanwhile). */
export const recheckServerTabs = (id) => recheck((tab) => isRemotePath(tab.path) && remoteParts(tab.path).id === id);

export function watchDiskTabs({ onReplace, onAppend }) {
  if (!diskAvailable()) return () => {};
  const handle = async ({ path, mtimeMs, size, exists }) => {
    const tab = store.diskTab(path);
    if (!tab) return;
    if (tab.offline) store.diskPatch(path, { offline: false });
    if (!exists) return store.diskPatch(path, { missing: true });
    if (tab.stale) return onReplace(diskKey(path), await reloadDiskTab(path).catch(() => (store.diskPatch(path, { missing: true }), '')));
    // Unchanged (our own save, or back after being missing).
    if (Math.abs(mtimeMs - tab.mtimeMs) <= 1 && size === tab.size) return tab.missing && store.diskPatch(path, { missing: false });
    try {
      if (tab.follow && !tab.dirty) {
        const added = await bridge().readAppended(path, tab.size, { encoding: tab.encoding });
        if (added.reset || added.skipped > 0) return onReplace(diskKey(path), await reloadDiskTab(path));
        store.diskAppended(path, added.text, added);
        return onAppend(diskKey(path), added.text);
      }
      if (!tab.dirty) return onReplace(diskKey(path), await reloadDiskTab(path));
      store.diskPatch(path, { conflict: true, missing: false });
    } catch (err) {
      store.diskPatch(path, unreachable(path, err) ? { offline: true } : { missing: true });
    }
  };
  const off = bridge().onChanged(handle);
  // After a restart (and when a server connects again): watch, and catch up with changes made meanwhile.
  recheck = (which = () => true) => {
    for (const tab of store.diskTabs().filter(which)) {
      bridge()
        .watch(tab.path)
        .then(() => bridge().stat(tab.path))
        .then((stat) => (stat ? handle({ path: tab.path, ...stat, exists: true }) : store.diskPatch(tab.path, { missing: true, offline: false })))
        .catch((err) => store.diskPatch(tab.path, unreachable(tab.path, err) ? { offline: true } : { missing: true }));
    }
  };
  recheck();
  return off;
}

/** Stops watching a file whose tab closed. */
export const unwatchDisk = (path) => bridge()?.watch(path, false).catch(() => {});
