// Files on disk edited in place (desktop app): opening them, saving them back
// (refusing when they changed on disk meanwhile), reloading, and following
// them as they grow (tail -f). The main process does the reading and writing
// (electron/diskFiles.cjs) for the files picked in its open dialog.
import { diskKey, store } from './store.js';

const bridge = () => globalThis.window?.desktop?.disk;
export const diskAvailable = () => Boolean(bridge());

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

/** Writes the tab's text: 'saved', or 'conflict' when the file changed on disk (unless `force`). */
export async function saveDiskTab(path, { force = false } = {}) {
  const tab = store.diskTab(path);
  if (!tab) return 'missing';
  const text = tab.text;
  const result = await bridge().write(path, text, { eol: tab.eol, bom: tab.bom, encoding: tab.encoding, expectedMtime: tab.mtimeMs, force });
  if (result.conflict) {
    store.diskPatch(path, { conflict: true });
    return 'conflict';
  }
  store.diskSaved(path, { text, ...result });
  return 'saved';
}

/** The file as it is on disk now; returns its text. */
export async function reloadDiskTab(path) {
  const info = await bridge().read(path);
  store.diskReloaded(path, info);
  return info.text;
}

/**
 * Watches the open disk tabs: a file changed elsewhere is reloaded when it has
 * no unsaved edits here (`onReplace(key, text)`), flagged as a conflict when it
 * has, and a followed one gets its new lines (`onAppend(key, text)`).
 */
export function watchDiskTabs({ onReplace, onAppend }) {
  if (!diskAvailable()) return () => {};
  const handle = async ({ path, mtimeMs, size, exists }) => {
    const tab = store.diskTab(path);
    if (!tab) return;
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
    } catch {
      store.diskPatch(path, { missing: true });
    }
  };
  const off = bridge().onChanged(handle);
  // After a restart: watch again, and catch up with changes made while closed.
  for (const tab of store.diskTabs()) {
    bridge()
      .watch(tab.path)
      .then(() => bridge().stat(tab.path))
      .then((stat) => (stat ? handle({ path: tab.path, ...stat, exists: true }) : store.diskPatch(tab.path, { missing: true })))
      .catch(() => store.diskPatch(tab.path, { missing: true }));
  }
  return off;
}

/** Stops watching a file whose tab closed. */
export const unwatchDisk = (path) => bridge()?.watch(path, false).catch(() => {});
