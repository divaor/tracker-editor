// Mirrors by hand (0.54; desktop and the Android app): the page's side of Upload, Download,
// Compare and Sync for files and folders inside a mirror, from either side (a folder here, or
// the server's), as an IDE's deployment does. Each upload or download is checked first
// (mirror:check, mirrorCheck.js's states): nothing at risk goes at once with a toast (Undo,
// History); something at risk (or setting mirrorConfirm 'always') asks in TransferDialog. A
// mirrored file's tab gets a note when the server's copy differs (mirrorNoteFor), and a mirror
// with uploadOnSave uploads a file saved here when nothing is at risk.
//
// The state of the notes is kept here (the module), since the actions are made on each render.
import { mirror as mirrorById, mirrorOf } from './mirrors.js';
import { server, serverStatus } from './servers.js';
import { childPath } from './folderCompare.js';
import { diskKey, parseKey, store } from './store.js';
import { getSettings } from './settings.js';
import { atRisk, needsDialog, noteKey, transferable, transferredText } from './mirrorCheck.js';
import { isLockedName } from './locked.js';
import { isAndroidApp } from './platform.js';
import { toRemoteUri } from './where.js';
import { dismissToast, toast } from './ui/components.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const parentRel = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const many = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
const bridge = () => window.desktop?.mirrors;
export const mirrorsByHand = () => Boolean(bridge()?.check);

/** A mirror's server by its name. */
export const serverNameOf = (m) => server(m?.conn)?.name ?? 'the server';
/** `rel` inside the mirror on one side ('local' | 'remote'): a path here, or a remote:// one. */
export function sidePath(m, side, rel) {
  const root = side === 'local' ? m.local : toRemoteUri(m.conn, m.remote);
  return rel ? childPath(root, rel) : root;
}
/** What `paths` are, when all are inside one mirror: { mirror, side (of the first), rels }; else null. */
export function inOneMirror(paths) {
  const found = (paths ?? []).map((p) => mirrorOf(p));
  if (!found.length || found.some((f) => !f) || new Set(found.map((f) => f.mirror.id)).size !== 1) return null;
  return { mirror: found[0].mirror, side: found[0].side, rels: found.map((f) => f.rel) };
}
const inside = (p, root) => p === root || p.startsWith(`${root.replace(/[\\/]+$/, '')}/`) || p.startsWith(`${root.replace(/[\\/]+$/, '')}\\`);

// ---- The notes over mirrored files' tabs ----

const notes = new Map(); // path → { row (null: the same), key, at, mirror }
const dismissed = new Map(); // path → the note's key when × was pressed
const noteListeners = new Set();
const notesChanged = () => noteListeners.forEach((l) => l());
export function onMirrorNotes(callback) {
  noteListeners.add(callback);
  return () => noteListeners.delete(callback);
}
/** The note for a tab's file: { row, mirror } while there is one not dismissed; else null. */
export function mirrorNoteFor(path) {
  const n = notes.get(path);
  if (!n?.row || dismissed.get(path) === n.key) return null;
  const m = mirrorById(n.mirror);
  if (!m || serverStatus(m.conn).state !== 'connected') return null;
  return { row: n.row, mirror: m };
}
/** × on a note: hidden until either side's version changes. */
export function dismissMirrorNote(path) {
  const n = notes.get(path);
  if (n) dismissed.set(path, n.key);
  notesChanged();
}

// Undo of a folder comparison's copies: the entries of the last few seconds go together.
let recentCopies = { at: 0, mirror: '', entries: [], done: 0 };

/**
 * The actions (on app.js's `actions`): `actions` (compareFiles, compareFolders, openTextCompare,
 * reloadCleanDiskTabs, saveDisk, newMirror), `setDialog`, `flush` (the editor's pending text),
 * `runInFolders` (a command for what is picked in Folders).
 */
export function createMirrorActions({ actions, setDialog, flush = () => {}, runInFolders = () => false }) {
  const reloadAfter = (m, rels, side) => {
    window.dispatchEvent(new CustomEvent('folders:reload'));
    actions.reloadCleanDiskTabs?.(rels.map((rel) => sidePath(m, side, rel)));
    for (const path of notes.keys()) if (mirrorOf(path)?.mirror.id === m.id) checkTab(path, { force: true });
  };
  const itemOf = (direction) => (r) => ({ rel: r.rel, expect: (direction === 'upload' ? r.there : r.here) ?? null, size: (direction === 'upload' ? r.here : r.there)?.size ?? 0 });

  /** The toast after a transfer: what got there, what was left, Undo and History. */
  function report(m, r, direction, { key = 'mirror-done', prefix = '' } = {}) {
    const name = serverNameOf(m);
    const lines = [];
    if (r.done.length) lines.push(`${transferredText(r.done, direction, name, baseName(r.done[0]))}.`);
    if (r.skipped.length) lines.push(`${r.skipped.length === 1 ? baseName(r.skipped[0].rel) : many(r.skipped.length, 'file')} left as ${r.skipped.length === 1 ? 'it is' : 'they are'}: ${r.skipped[0].why}${r.skipped.length > 1 ? '…' : ''}.`);
    if (r.errors.length) lines.push(`${many(r.errors.length, 'file')} failed: ${baseName(r.errors[0].rel)}: ${r.errors[0].why}.`);
    if (r.notKept.length) lines.push(`Undo cannot bring back ${r.notKept.length === 1 ? 'its old version' : `${r.notKept.length} old versions`} (over 100 MB, not kept).`);
    toast(`${prefix}${lines.join(' ') || 'Nothing was copied.'}`, {
      kind: r.errors.length && !r.done.length ? 'error' : 'info',
      key,
      timeout: r.entry ? 15000 : 9000,
      actions: [r.entry && { label: 'Undo', run: () => undo([r.entry]) }, { label: 'History', run: () => history(m.id) }],
    });
  }

  /** Copies the files a check found (`items`: { rel, expect, size }) one way; the toast says how it went. */
  async function run(m, items, direction) {
    if (!items.length) return null;
    toast(`${direction === 'upload' ? 'Uploading' : 'Downloading'} ${items.length === 1 ? baseName(items[0].rel) : many(items.length, 'file')}…`, { key: 'mirror-run', timeout: 120000 });
    let r;
    try {
      r = await bridge().transfer(m.id, items, direction);
    } catch (err) {
      dismissToast('mirror-run');
      toast(message(err), { kind: 'error', timeout: 10000 });
      return null;
    }
    dismissToast('mirror-run');
    report(m, r, direction);
    reloadAfter(m, r.done, direction === 'upload' ? 'remote' : 'local');
    return r;
  }

  /** Open tabs of what a transfer would touch, with edits not saved (either side). */
  const unsavedIn = (m, rels) => {
    const roots = rels.flatMap((rel) => [sidePath(m, 'local', rel), sidePath(m, 'remote', rel)]);
    return store.diskTabs().filter((t) => t.dirty && roots.some((r) => inside(t.path, r)));
  };

  /** Upload or download what `paths` name (either side of one mirror): checked first, asked only when something is at risk. */
  async function transferPaths(paths, direction) {
    if (!mirrorsByHand()) return toast('Mirrors work in the desktop app and the Android app.');
    const f = inOneMirror(paths);
    if (!f) return toast('Pick files or folders inside one mirror.');
    const m = f.mirror;
    const verb = direction === 'upload' ? 'upload' : 'download';
    flush();
    const dirty = unsavedIn(m, f.rels);
    if (dirty.length) {
      return toast(`${dirty.length === 1 ? `${dirty[0].name} has` : `${dirty.length} open files have`} changes that are not saved: save first, then ${verb}.`, {
        timeout: 12000,
        action: {
          label: `Save and ${verb}`,
          run: async () => {
            for (const t of dirty) if ((await actions.saveDisk(t.path)) !== 'saved') return;
            transferPaths(paths, direction);
          },
        },
      });
    }
    toast(`Comparing with ${serverNameOf(m)}…`, { key: 'mirror-check', timeout: 120000 });
    let check;
    try {
      check = await bridge().check(m.id, paths, direction);
    } catch (err) {
      dismissToast('mirror-check');
      return toast(message(err), { kind: 'error', timeout: 10000 });
    }
    dismissToast('mirror-check');
    if (check.tooBig) return toast(`Too many files to ${verb} at once: Sync… compares the two folders, to pick what goes.`, { timeout: 10000, action: { label: 'Sync…', run: () => sync(paths[0], { dir: true }) } });
    const going = check.files.filter((r) => transferable(r.state));
    if (!going.length) {
      const same = check.counts.same;
      return toast(`Nothing to ${verb}: ${same ? (same === 1 ? 'the same on both sides' : `all ${same} files the same on both sides`) : direction === 'upload' ? 'nothing here' : `nothing on ${serverNameOf(m)}`}.`);
    }
    if (needsDialog(check.files, getSettings().mirrorConfirm)) return setDialog({ type: 'mirrorTransfer', mirrorId: m.id, check, direction });
    return run(m, going.map(itemOf(direction)), direction);
  }

  /** The files compared (a file: local vs the server's; a folder: the two folders). */
  function compare(path, { dir = false } = {}) {
    const f = inOneMirror([path]);
    if (!f) return toast('That is not inside a mirror.');
    const m = f.mirror;
    const rel = f.rels[0];
    if (dir || !rel) return actions.compareFolders(sidePath(m, 'local', rel), sidePath(m, 'remote', rel));
    if (isLockedName(path)) return toast(`${baseName(path)} is locked with a password: it is not compared.`);
    flush();
    actions.compareFiles({ key: diskKey(sidePath(m, 'local', rel)) }, { key: diskKey(sidePath(m, 'remote', rel)) });
  }
  /** A file in the comparison its history kept: its old version (read-only) against the file now. */
  async function compareKept(entry, file) {
    const m = mirrorById(entry.mirror);
    if (!m) return toast('That mirror is not set up here any more.');
    const got = await bridge().historyText(entry.id, file.rel).catch(() => null);
    if (!got || got.binary) return toast(got?.binary ? 'Not a text file: it cannot be compared here.' : 'Its old version is not kept any more.');
    const now = sidePath(m, entry.direction === 'upload' ? 'remote' : 'local', file.rel);
    const word = entry.direction === 'upload' ? 'upload' : 'download';
    // Both read-only: a look at what the transfer replaced (Undo puts it back).
    let current;
    try {
      current = await actions.readCompareSide({ key: diskKey(now) });
    } catch (err) {
      return toast(`${baseName(file.rel)} cannot be read now: ${message(err)}`, { kind: 'error' });
    }
    actions.openTextCompare({
      name: `${baseName(file.rel)} before the ${word}`,
      left: { text: got.text, label: `Before the ${word}`, detail: `Kept on ${new Date(entry.at).toLocaleString()}`, readOnly: true },
      right: { text: current.text, label: entry.direction === 'upload' ? `On ${serverNameOf(m)} now` : 'Here now', detail: file.rel, readOnly: true },
    });
  }
  /** The two folders compared in a tab with the sync bar open (newer replaces older): a file's folder for a file. */
  function sync(path, { dir = false } = {}) {
    const f = inOneMirror([path]);
    if (!f) return toast('That is not inside a mirror.');
    const m = f.mirror;
    const rel = dir ? f.rels[0] : parentRel(f.rels[0]);
    flush();
    actions.compareFolders(sidePath(m, 'local', rel), sidePath(m, 'remote', rel), { sync: 'newer' });
  }
  const history = (id = null) => setDialog({ type: 'mirrorHistory', id });

  /** Undoes transfers (newest first), after saying what is deleted for good. */
  async function undo(entryIds) {
    const list = await bridge().history(null).catch(() => []);
    const entries = entryIds.map((id) => list.find((e) => e.id === id)).filter((e) => e && !e.undone);
    if (!entries.length) return toast('Nothing to undo: it is not in the history, or it was undone already.');
    const m = mirrorById(entries[0].mirror);
    const name = serverNameOf(m);
    // What was new on the destination is removed: on a server (or on a phone) for good.
    const forGood = entries.flatMap((e) => (e.direction === 'upload' || isAndroidApp() ? e.files.filter((x) => !x.before).map((x) => ({ ...x, where: e.direction === 'upload' ? name : 'this device' })) : []));
    if (forGood.length && !confirm(`Undo deletes ${forGood.length === 1 ? baseName(forGood[0].rel) : many(forGood.length, 'file')} on ${forGood[0].where}: ${forGood.length === 1 ? 'it was' : 'they were'} new there. Deleted there, ${forGood.length === 1 ? 'it' : 'they'} cannot be brought back. Undo?`)) return;
    const done = { restored: [], removed: [], left: [] };
    for (const e of [...entries].sort((a, b) => b.at - a.at)) {
      try {
        const r = await bridge().undo(e.id);
        done.restored.push(...r.restored);
        done.removed.push(...r.removed);
        done.left.push(...r.left);
        if (m) reloadAfter(m, [...r.restored, ...r.removed], e.direction === 'upload' ? 'remote' : 'local');
      } catch (err) {
        return toast(message(err), { kind: 'error', timeout: 10000 });
      }
    }
    const parts = [done.restored.length && `${many(done.restored.length, 'file')} put back as ${done.restored.length === 1 ? 'it was' : 'they were'}`, done.removed.length && `${many(done.removed.length, 'new file')} removed`].filter(Boolean);
    const left = done.left.length ? ` ${done.left.length === 1 ? baseName(done.left[0].rel) : many(done.left.length, 'file')} left as ${done.left.length === 1 ? 'it is' : 'they are'}: ${done.left[0].why}.` : '';
    toast(`Undone: ${parts.join(', ') || 'nothing to put back'}.${left}`, { timeout: left ? 12000 : 6000, kind: left && !parts.length ? 'error' : 'info', actions: [m && { label: 'History', run: () => history(m.id) }] });
    return done;
  }

  /** A folder comparison's copies between a mirror's two sides (compare:copy): the toast with Undo for them all. */
  function copiedInCompare(res) {
    const m = mirrorById(res?.id);
    if (!m) return;
    const fresh = Date.now() - recentCopies.at < 30000 && recentCopies.mirror === m.id;
    recentCopies = { at: Date.now(), mirror: m.id, entries: [...(fresh ? recentCopies.entries : []), res.entry].filter(Boolean), done: (fresh ? recentCopies.done : 0) + res.done.length };
    const entries = recentCopies.entries.slice();
    const failed = res.errors.length + res.skipped.length;
    const why = failed ? ` ${many(failed, 'file')} not copied: ${baseName((res.errors[0] ?? res.skipped[0]).rel)}: ${(res.errors[0] ?? res.skipped[0]).why}.` : '';
    toast(`${many(recentCopies.done, 'file')} copied between this computer and ${serverNameOf(m)}${entries.length ? '; the ones they replaced are kept (Undo)' : ''}.${why}`, {
      key: 'mirror-compare',
      kind: failed && !res.done.length ? 'error' : 'info',
      timeout: 15000,
      actions: [entries.length && { label: 'Undo', run: () => undo(entries) }, { label: 'History', run: () => history(m.id) }],
    });
    for (const path of notes.keys()) if (mirrorOf(path)?.mirror.id === m.id) checkTab(path, { force: true });
  }

  /** Looks at a mirrored file's tab (here) again: the note when the server's copy is not the same. At most once a minute unless `force`. */
  async function checkTab(path, { force = false } = {}) {
    if (!mirrorsByHand() || !path) return;
    const f = inOneMirror([path]);
    if (!f || f.side !== 'local' || isLockedName(path) || store.diskTab(path)?.doc) return;
    const m = f.mirror;
    if (serverStatus(m.conn).state !== 'connected') return;
    const last = notes.get(path);
    if (!force && last && Date.now() - last.at < 60000) return;
    notes.set(path, { ...(last ?? { row: null, key: '' }), at: Date.now(), mirror: m.id });
    const check = await bridge().check(m.id, [path], 'upload', { quiet: true }).catch(() => null);
    if (!check || check.offline) return;
    const row = check.files.find((r) => r.rel === f.rels[0]) ?? null;
    notes.set(path, { row, key: noteKey(row), at: Date.now(), mirror: m.id });
    notesChanged();
  }

  /** A file saved here: uploaded when its mirror says so and nothing is at risk; else its note looked at again. */
  async function afterSave(path) {
    const f = inOneMirror([path]);
    if (!f || f.side !== 'local' || !mirrorsByHand()) return;
    const m = f.mirror;
    if (!m.uploadOnSave) return checkTab(path, { force: true });
    const name = serverNameOf(m);
    let check;
    try {
      check = await bridge().check(m.id, [path], 'upload');
    } catch (err) {
      return toast(`${baseName(path)} is saved here, but not uploaded: ${message(err)}`, { kind: 'error', timeout: 10000 });
    }
    const row = check.files.find((r) => r.rel === f.rels[0]);
    if (!row || !transferable(row.state)) return checkTab(path, { force: true });
    // Just saved, this copy is always the newer one by time: without a record of the two being
    // the same once ('newer' has none), the server's copy may hold changes of its own. Asked too.
    if (atRisk(row.state) || row.state === 'newer') {
      checkTab(path, { force: true });
      const why =
        row.state === 'both'
          ? `it changed on ${name} too`
          : row.state === 'newer'
            ? `${name} has another copy, never the same as this one here`
            : row.state === 'differ'
              ? `${name}’s copy is different and there is no way to tell which is newer`
              : `${name}’s copy changed since it was last uploaded`;
      return toast(`${baseName(path)} is saved here but not uploaded: ${why}.`, {
        kind: 'error',
        key: `mirror-save:${path}`,
        timeout: 20000,
        actions: [
          { label: 'Compare', run: () => compare(path) },
          { label: 'Upload anyway', run: () => run(m, [itemOf('upload')(row)], 'upload') },
          { label: 'Download', run: () => transferPaths([path], 'download') },
        ],
      });
    }
    await run(m, [itemOf('upload')(row)], 'upload');
  }

  /** Menu items for `paths` inside one mirror (Folders' rows, a folder's head, a tab): [] when they are not. `dir`: the one picked is a folder. */
  function items(paths, { dir = false } = {}) {
    if (!mirrorsByHand()) return [];
    const f = inOneMirror(paths);
    if (!f) return [];
    const m = f.mirror;
    const name = serverNameOf(m);
    const here = f.side === 'local';
    const one = paths.length === 1;
    return [
      { label: here ? `Upload to ${name}` : 'Download to this computer', icon: here ? 'upload' : 'download', hint: 'Checked first: you are asked when it would replace a newer copy', run: () => transferPaths(paths, here ? 'upload' : 'download') },
      { label: here ? `Download from ${name}` : 'Upload from this computer', icon: here ? 'download' : 'upload', hint: 'Checked first: you are asked when it would replace a newer copy', run: () => transferPaths(paths, here ? 'download' : 'upload') },
      one && { label: here ? `Compare with ${name}` : 'Compare with this computer', icon: 'compare', run: () => compare(paths[0], { dir }) },
      window.desktop?.compare && { label: here ? `Sync with ${name}…` : 'Sync with this computer…', icon: 'sync', hint: 'The two folders compared, with the sync bar: pick which way each difference goes', run: () => sync(paths[0], { dir: one && dir }) },
      { label: 'Upload and download history…', icon: 'history', run: () => history(m.id) },
    ];
  }

  /** A command (palette, keys) or Folders' pick: 'upload' | 'download' | 'compare' | 'sync' | 'history'. */
  function act(id, paths, { dir = false } = {}) {
    const f = inOneMirror(paths);
    if (!f) return toast('That is not inside a mirror. Right-click a folder → Mirror on a server… sets one up.');
    if (id === 'upload' || id === 'download') return transferPaths(paths, id);
    if (id === 'compare') return compare(paths[0], { dir: paths.length === 1 && dir });
    if (id === 'sync') return sync(paths[0], { dir: paths.length === 1 && dir });
    return history(f.mirror.id);
  }
  /** The commands: the open disk tab's file when it is in a mirror, else what is picked in Folders. */
  function command(id) {
    if (!mirrorsByHand()) return toast('Mirrors work in the desktop app and the Android app.');
    const k = parseKey(store.session.active ?? '');
    if (k?.kind === 'disk' && mirrorOf(k.path)) return act(id, [k.path]);
    if (runInFolders(`mirror-${id}`)) return;
    toast('Open a file inside a mirror, or pick files in Folders inside one (right-click a folder → Mirror on a server… sets one up).', { timeout: 8000 });
  }

  return {
    mirrorUpload: (paths) => transferPaths(paths, 'upload'),
    mirrorDownload: (paths) => transferPaths(paths, 'download'),
    mirrorRun: (mirrorId, items, direction) => run(mirrorById(mirrorId), items, direction),
    /** The check's dialog again (back from a comparison): { mirrorId, check, direction, ticked }. */
    mirrorAsk: (state) => setDialog({ type: 'mirrorTransfer', ...state }),
    mirrorCompare: compare,
    mirrorCompareKept: compareKept,
    mirrorSyncTab: sync,
    mirrorHistory: history,
    mirrorUndo: undo,
    mirrorCopied: copiedInCompare,
    mirrorCheckTab: checkTab,
    mirrorAfterSave: afterSave,
    mirrorItems: items,
    mirrorAct: act,
    mirrorCommand: command,
    /** Folders' Mirror on a server…: a folder here kept with one on a server, by hand at first. */
    mirrorOnServer: (dir) => actions.newMirror({ local: dir, auto: false, mode: 'both', uploadOnSave: false }),
  };
}
