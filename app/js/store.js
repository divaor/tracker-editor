// All files with their texts, this device's open tabs, files opened from the
// tracker, and pending changes to tracker.json — kept in memory and saved to
// IndexedDB as you type. Sync (syncManager.js) takes changes to GitHub.
import { isSealed } from './crypto.js';
import { kvDelete, kvGet, kvSet } from './kv.js';
import { getSettings } from './settings.js';
import { applyFilePatch, createFile, nowIso, tombstone, trackerDocs, untitledName } from './model.js';
import { newId } from './tracker-model.js';

const META_FIELDS = ['name', 'project', 'tags', 'language', 'deleted', 'encrypted', 'snippet', 'updatedAt', 'updatedBy'];

let files = new Map(); // id → record (+ baseSha, dirty)
let texts = new Map(); // id → text
let sealed = new Map(); // id → ciphertext of an encrypted file this device cannot read (locked)
let projects = []; // project records from tracker.json (last sync)
let trackerItems = []; // tracker items (last sync), to show which items link a file
let trackerOps = []; // pending changes to tracker.json: { id, op: 'project' | 'item', ... }
let repoTabs = new Map(); // path → { path, name, text, baseSha, dirty }
// Files on disk edited in place (desktop), never synced: path → { path, name, text,
// eol, bom, encoding, mtimeMs, size, truncated, dirty, follow, conflict, missing,
// stale (text not read yet after a restart) }.
let diskTabs = new Map();
let docTexts = new Map(); // blob sha → text of a tracker document (for search and offline reading)
let docs = { items: null, list: [] }; // trackerDocs(trackerItems), computed once per sync
// Tab keys are "f:<id>" | "r:<path>". Pinned tabs come first in `open`; `side` is
// the tab in the split view's second pane (never the active one); `collapsed`
// lists project keys whose tab group is folded.
let session = { open: [], active: null, closed: [], pinned: [], side: null, collapsed: [] };
let meta = { lastSyncAt: null };
let trashed = new Set(); // deleted files whose text this device kept (kv "trash:<id>")
let changeCounter = 0;
const listeners = new Set();
const author = () => getSettings().device || '';

export const fileKey = (id) => `f:${id}`;
export const repoKey = (path) => `r:${path}`;
export const diskKey = (path) => `d:${path}`;
export const parseKey = (key) =>
  key?.startsWith('r:') ? { kind: 'repo', path: key.slice(2) }
  : key?.startsWith('f:') ? { kind: 'file', id: key.slice(2) }
  : key?.startsWith('d:') ? { kind: 'disk', path: key.slice(2) }
  : null;

// ---- Persistence (debounced) -------------------------------------------------

const timers = new Map();
let closed = false;
// Saves after `ms` without further changes; 0 saves now (pasted text, new files).
function later(key, fn, ms = 250) {
  if (closed) return;
  clearTimeout(timers.get(key));
  if (ms === 0) {
    timers.delete(key);
    fn();
    return;
  }
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    fn();
  }, ms));
}
// A disk tab's text is kept only while it has unsaved edits; otherwise it is read from disk again.
const savedDiskTabs = () => [...diskTabs.values()].map((t) => (t.dirty ? t : { ...t, text: '', stale: true }));

const persist = {
  files: (ms) => later('files', () => kvSet('files', [...files.values()]), ms),
  text: (id, ms) => later(`text:${id}`, () => (texts.has(id) ? kvSet(`text:${id}`, texts.get(id)) : sealed.has(id) ? kvSet(`text:${id}`, sealed.get(id)) : kvDelete(`text:${id}`)), ms),
  session: (ms) => later('session', () => kvSet('session', session), ms),
  repo: (ms) => later('repoTabs', () => kvSet('repoTabs', [...repoTabs.values()]), ms),
  disk: (ms) => later('diskTabs', () => kvSet('diskTabs', savedDiskTabs()), ms),
  rest: () => later('rest', () => Promise.all([kvSet('projects', projects), kvSet('trackerItems', trackerItems), kvSet('trackerOps', trackerOps), kvSet('meta', meta)])),
  docs: () => later('docTexts', () => kvSet('docTexts', [...docTexts])),
};

// A file's text from elsewhere (sync, the trash): ciphertext this device cannot
// read stays sealed, apart from the texts the app shows and searches.
function putText(id, text, encrypted = files.get(id)?.encrypted) {
  if (isSealed(text) && encrypted) {
    sealed.set(id, text);
    texts.delete(id);
  } else {
    texts.set(id, text);
    sealed.delete(id);
  }
}

// The text of a deleted file stays on this device until its tombstone is pruned,
// so the trash can bring it back offline.
function keepInTrash(id, text) {
  if (!text) return;
  trashed.add(id);
  kvSet(`trash:${id}`, text);
  kvSet('trashIds', [...trashed]);
}
function forgetTrash(ids) {
  let any = false;
  for (const id of ids) {
    if (!trashed.delete(id)) continue;
    kvDelete(`trash:${id}`);
    any = true;
  }
  if (any) kvSet('trashIds', [...trashed]);
}

// Keeps the session's rules: pinned tabs are open and first, the side tab is open and not the active one.
function tidySession() {
  session.pinned = session.pinned.filter((k) => session.open.includes(k));
  session.open = [...session.pinned, ...session.open.filter((k) => !session.pinned.includes(k))];
  if (session.side && (!session.open.includes(session.side) || session.side === session.active)) session.side = null;
  if (!session.active && session.side) {
    session.active = session.side;
    session.side = null;
  }
}

/** Writes everything still waiting for its debounce (before closing the app). */
export async function flush() {
  if (closed) return;
  const pending = [...timers.entries()];
  for (const [key, timer] of pending) clearTimeout(timer);
  timers.clear();
  await Promise.all([
    kvSet('files', [...files.values()]),
    kvSet('session', session),
    kvSet('repoTabs', [...repoTabs.values()]),
    kvSet('diskTabs', savedDiskTabs()),
    kvSet('projects', projects),
    kvSet('trackerItems', trackerItems),
    kvSet('trackerOps', trackerOps),
    kvSet('meta', meta),
    kvSet('docTexts', [...docTexts]),
    ...pending.filter(([k]) => k.startsWith('text:')).map(([k]) => {
      const id = k.slice(5);
      return texts.has(id) ? kvSet(k, texts.get(id)) : kvDelete(k);
    }),
  ]);
}

/**
 * Stops writing to this device's storage (another tab took over). With
 * save: false, changes still waiting for their debounce are dropped.
 */
export async function closeStore({ save = true } = {}) {
  if (save) await flush();
  closed = true;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

function emit(reason, detail) {
  for (const fn of listeners) fn(reason, detail);
}

function changed(reason = 'local', detail) {
  changeCounter++;
  emit(reason, detail);
}

// ---- Store ---------------------------------------------------------------------

export const store = {
  async load() {
    const saved = (await kvGet('files')) ?? [];
    files = new Map(saved.map((f) => [f.id, f]));
    const loaded = await Promise.all([...files.values()].filter((f) => !f.deleted).map(async (f) => [f.id, (await kvGet(`text:${f.id}`)) ?? '']));
    texts = new Map(loaded.filter(([id, t]) => !(files.get(id).encrypted && isSealed(t))));
    sealed = new Map(loaded.filter(([id, t]) => files.get(id).encrypted && isSealed(t)));
    session = { open: [], active: null, closed: [], pinned: [], side: null, collapsed: [], ...((await kvGet('session')) ?? {}) };
    repoTabs = new Map(((await kvGet('repoTabs')) ?? []).map((t) => [t.path, t]));
    diskTabs = new Map(((await kvGet('diskTabs')) ?? []).map((t) => [t.path, t]));
    projects = (await kvGet('projects')) ?? [];
    trackerItems = (await kvGet('trackerItems')) ?? [];
    trackerOps = (await kvGet('trackerOps')) ?? [];
    docTexts = new Map((await kvGet('docTexts')) ?? []);
    meta = { ...meta, ...((await kvGet('meta')) ?? {}) };
    trashed = new Set(((await kvGet('trashIds')) ?? []).filter((id) => files.get(id)?.deleted));
    // Drop tabs whose file is gone.
    session.open = session.open.filter((k) =>
      k.startsWith('r:') ? repoTabs.has(k.slice(2)) : k.startsWith('d:') ? diskTabs.has(k.slice(2)) : files.get(k.slice(2)) && !files.get(k.slice(2)).deleted,
    );
    if (!session.open.includes(session.active)) session.active = session.open[0] ?? null;
    tidySession();
    emit('load');
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  get changeCounter() {
    return changeCounter;
  },
  get meta() {
    return meta;
  },
  get session() {
    return session;
  },

  all: () => [...files.values()],
  live: () => [...files.values()].filter((f) => !f.deleted),
  get: (id) => {
    const f = files.get(id);
    return f && !f.deleted ? f : undefined;
  },
  text: (id) => texts.get(id) ?? '',
  texts: () => texts,
  projects: () => projects,
  trackerItems: () => trackerItems,
  trackerOps: () => trackerOps,
  repoTab: (path) => repoTabs.get(path),
  repoTabs: () => [...repoTabs.values()],

  // ---- The tracker's documents (attached files), from the last sync ----

  docs() {
    if (docs.items !== trackerItems) docs = { items: trackerItems, list: trackerDocs(trackerItems) };
    return docs.list;
  },
  doc: (path) => store.docs().find((d) => d.path === path),
  /** A document's text: the open tab's (it may have edits), else the cached copy; null if not downloaded yet. */
  docText(path) {
    const tab = repoTabs.get(path);
    if (tab) return tab.text;
    const sha = store.doc(path)?.sha;
    return sha && docTexts.has(sha) ? docTexts.get(sha) : null;
  },
  hasDocText: (sha) => docTexts.has(sha),
  cachedDocText: (sha) => docTexts.get(sha) ?? null,
  /** Keeps downloaded document texts ([sha, text] pairs), dropping versions no document uses any more. */
  cacheDocTexts(entries) {
    for (const [sha, text] of entries) docTexts.set(sha, text);
    const used = new Set(store.docs().map((d) => d.sha));
    for (const sha of [...docTexts.keys()]) if (!used.has(sha)) docTexts.delete(sha);
    // Open, unedited tabs of documents that changed elsewhere show the new version.
    const refreshed = [];
    for (const doc of store.docs()) {
      const tab = repoTabs.get(doc.path);
      if (!tab || tab.dirty || tab.baseSha === doc.sha || !docTexts.has(doc.sha)) continue;
      repoTabs.set(doc.path, { ...tab, text: docTexts.get(doc.sha), baseSha: doc.sha });
      refreshed.push({ path: doc.path, text: docTexts.get(doc.sha) });
    }
    if (refreshed.length) persist.repo();
    persist.docs();
    emit('docs', { refreshed });
  },
  // Unsynced: edited text (dirty), changed name/project/tags or deleted (pending).
  pendingCount: () => [...files.values()].filter((f) => f.dirty || f.pending).length + [...repoTabs.values()].filter((t) => t.dirty).length + trackerOps.length,

  // ---- Files ----

  create({ name, text = '', project = '', tags = [], language = '', encrypted = false, snippet = false, open = true } = {}) {
    const fileName = name || untitledName(store.live().map((f) => f.name));
    const now = nowIso();
    const file = { ...createFile({ name: fileName, project, tags, language, encrypted, snippet, updatedBy: author(), modifiedBy: author() }, now), baseSha: '', dirty: true };
    files.set(file.id, file);
    texts.set(file.id, text);
    if (open) store.open(fileKey(file.id), { silent: true });
    // A new tab is saved at once, so it is there after a crash.
    persist.files(0);
    persist.text(file.id, 0);
    persist.session(0);
    changed('local', { created: file.id });
    return file.id;
  },

  /** New text for a file; `urgent` (pasted text) saves it at once instead of after a moment. */
  setText(id, text, { urgent = false } = {}) {
    const file = files.get(id);
    if (!file || file.deleted || sealed.has(id) || texts.get(id) === text) return;
    texts.set(id, text);
    files.set(id, { ...file, dirty: true, modifiedAt: nowIso(), modifiedBy: author() });
    persist.text(id, urgent ? 0 : undefined);
    persist.files(urgent ? 0 : undefined);
    changed('text', { id, urgent });
  },

  patch(id, patch) {
    const file = files.get(id);
    if (!file || file.deleted) return;
    files.set(id, { ...applyFilePatch(file, { ...patch, updatedBy: author() }), baseSha: file.baseSha, dirty: file.dirty, pending: true, modifiedAt: file.modifiedAt, modifiedBy: file.modifiedBy, sha: file.sha, size: file.size });
    persist.files();
    changed('local', { id });
  },

  remove(id) {
    const file = files.get(id);
    if (!file || file.deleted) return null;
    const previous = { file, text: texts.get(id) ?? sealed.get(id) ?? '' };
    files.set(id, { ...tombstone(file, nowIso(), author()), baseSha: file.baseSha, dirty: false, pending: true });
    keepInTrash(id, previous.text);
    texts.delete(id);
    sealed.delete(id);
    persist.files();
    persist.text(id);
    store.close(fileKey(id), { silent: true });
    changed('local', { removed: id });
    return previous;
  },

  /** Undo for remove(), and the trash: brings the file back with its text. */
  restore({ file, text }) {
    files.set(file.id, { ...applyFilePatch(file, { deleted: false, updatedBy: author() }), baseSha: file.baseSha, dirty: !isSealed(text), sha: file.sha, size: file.size });
    putText(file.id, text);
    forgetTrash([file.id]);
    persist.files();
    persist.text(file.id);
    store.open(fileKey(file.id), { silent: true });
    changed('local', { id: file.id });
  },

  // ---- Trash ----

  /** Deleted files that can come back: synced ones (text on GitHub) and ones whose text is kept here. Newest first. */
  trash: () =>
    [...files.values()].filter((f) => f.deleted && (f.sha || trashed.has(f.id))).sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1)),
  /** The text this device kept for a deleted file, or null. */
  trashText: async (id) => (trashed.has(id) ? ((await kvGet(`trash:${id}`)) ?? null) : null),

  // ---- Encrypted files ----

  /** True when the file is encrypted and this device has only its ciphertext (locked). */
  isSealed: (id) => sealed.has(id),
  sealedIds: () => [...sealed.keys()],
  sealedText: (id) => sealed.get(id),
  /** Keeps only the ciphertext of a file here (locking this device). */
  seal(id, cipher) {
    if (!texts.has(id)) return;
    putText(id, cipher);
    persist.text(id, 0);
    changed('local', { id });
  },
  /** The decrypted text of a sealed file (after unlocking). */
  unseal(id, text) {
    if (!sealed.has(id)) return;
    sealed.delete(id);
    texts.set(id, text);
    persist.text(id, 0);
    changed('local', { id });
  },
  /** Uploads the file's text again at the next sync (after turning encryption on or off). */
  markDirty(id) {
    const file = files.get(id);
    if (!file || file.deleted || sealed.has(id)) return;
    files.set(id, { ...file, dirty: true });
    persist.files();
    changed('local', { id });
  },

  // ---- Tabs ----

  open(key, { silent = false } = {}) {
    if (!session.open.includes(key)) {
      // Next to the active tab, after the pinned ones.
      const at = Math.max(session.open.indexOf(session.active), session.pinned.length - 1);
      session.open = at === -1 ? [...session.open, key] : [...session.open.slice(0, at + 1), key, ...session.open.slice(at + 1)];
    }
    // The side pane's tab opened in the main one: the split ends.
    if (session.side === key) session.side = null;
    session.active = key;
    persist.session();
    if (!silent) emit('session');
  },

  close(key, { silent = false } = {}) {
    const at = session.open.indexOf(key);
    if (at === -1) return;
    session.open = session.open.filter((k) => k !== key);
    session.pinned = session.pinned.filter((k) => k !== key);
    session.closed = [key, ...session.closed.filter((k) => k !== key)].slice(0, 20);
    if (session.side === key) session.side = null;
    if (session.active === key) {
      const rest = session.open.filter((k) => k !== session.side);
      session.active = rest[Math.min(at, rest.length - 1)] ?? null;
    }
    tidySession();
    if (key.startsWith('r:') && !repoTabs.get(key.slice(2))?.dirty) {
      repoTabs.delete(key.slice(2));
      persist.repo();
    }
    if (key.startsWith('d:')) {
      diskTabs.delete(key.slice(2));
      persist.disk(0);
    }
    persist.session();
    if (!silent) emit('session');
  },

  reopenClosed() {
    const key = session.closed.find((k) => (k.startsWith('f:') ? store.get(k.slice(2)) : repoTabs.has(k.slice(2))));
    if (key) {
      session.closed = session.closed.filter((k) => k !== key);
      store.open(key);
    }
    return key;
  },

  /** Moves a tab to `toIndex` in the tab bar, staying among the pinned tabs or the others. */
  move(key, toIndex) {
    const list = session.open.filter((k) => k !== key);
    const pinned = session.pinned.includes(key);
    const n = session.pinned.filter((k) => k !== key).length;
    list.splice(pinned ? Math.max(0, Math.min(toIndex, n)) : Math.max(n, Math.min(toIndex, list.length)), 0, key);
    session.open = list;
    persist.session();
    emit('session');
  },

  /** Pins a tab (first in the bar, kept by "Close others") or unpins it. */
  pin(key, on = true) {
    if (!session.open.includes(key) || session.pinned.includes(key) === on) return;
    session.pinned = on ? [...session.pinned, key] : session.pinned.filter((k) => k !== key);
    tidySession();
    persist.session();
    emit('session');
  },

  /**
   * Shows a tab in the split view's second pane (null closes it). The active tab
   * moves aside for it: the main pane shows a neighbor. False when no other tab is open.
   */
  setSide(key) {
    if (key && !session.open.includes(key)) return false;
    if (key && key === session.active) {
      const others = session.open.filter((k) => k !== key);
      if (!others.length) return false;
      const at = session.open.indexOf(key);
      session.active = [...session.open.slice(0, at)].reverse().find((k) => k !== key) ?? others[0];
    }
    session.side = key;
    persist.session();
    emit('session');
    return true;
  },

  /** Swaps the tabs of the two panes. */
  swapSides() {
    if (!session.side) return;
    [session.active, session.side] = [session.side, session.active];
    persist.session();
    emit('session');
  },

  /** Folds or unfolds a project's tab group. */
  toggleGroup(group) {
    session.collapsed = session.collapsed.includes(group) ? session.collapsed.filter((g) => g !== group) : [...session.collapsed, group];
    persist.session();
    emit('session');
  },

  // ---- Files elsewhere in the repo (tracker attachments) ----

  openRepoFile({ path, text, sha }) {
    const existing = repoTabs.get(path);
    if (!existing || !existing.dirty) repoTabs.set(path, { path, name: path.split('/').pop(), text, baseSha: sha, dirty: false });
    persist.repo();
    store.open(repoKey(path));
  },

  setRepoText(path, text, { urgent = false } = {}) {
    const tab = repoTabs.get(path);
    if (!tab || tab.text === text) return;
    repoTabs.set(path, { ...tab, text, dirty: true });
    persist.repo(urgent ? 0 : undefined);
    changed('text', { path, urgent });
  },

  // ---- Files on disk (desktop), edited in place ----

  diskTab: (path) => diskTabs.get(path),
  diskTabs: () => [...diskTabs.values()],

  /** A file read from disk (diskFiles.cjs readTextFile) as a tab; one with unsaved edits keeps them. */
  openDiskFile(info) {
    const existing = diskTabs.get(info.path);
    if (!existing?.dirty) {
      const { path, name, text, eol, bom, encoding, mtimeMs, size, truncated } = info;
      diskTabs.set(path, { path, name, text, eol, bom, encoding, mtimeMs, size, truncated, dirty: false, follow: existing?.follow ?? false, conflict: false, missing: false });
    }
    persist.disk(0);
    store.open(diskKey(info.path));
  },

  setDiskText(path, text, { urgent = false } = {}) {
    const tab = diskTabs.get(path);
    if (!tab || tab.text === text) return;
    diskTabs.set(path, { ...tab, text, dirty: true });
    persist.disk(urgent ? 0 : undefined);
    emit('disk', { path, text: true });
  },

  /** Saved to disk: `text` is what was written. Edits made since stay unsaved. */
  diskSaved(path, { text, mtimeMs, size }) {
    const tab = diskTabs.get(path);
    if (!tab) return;
    diskTabs.set(path, { ...tab, mtimeMs, size, dirty: tab.text !== text, conflict: false, missing: false });
    persist.disk(0);
    emit('disk', { path });
  },

  /** The file as it is on disk now, replacing the tab's text. */
  diskReloaded(path, info) {
    const tab = diskTabs.get(path);
    if (!tab) return;
    const { text, eol, bom, encoding, mtimeMs, size, truncated } = info;
    diskTabs.set(path, { ...tab, text, eol, bom, encoding, mtimeMs, size, truncated, dirty: false, conflict: false, missing: false, stale: false });
    persist.disk();
    emit('disk', { path });
  },

  /** Lines added at the end of a followed file. */
  diskAppended(path, text, { mtimeMs, size }) {
    const tab = diskTabs.get(path);
    if (!tab) return;
    diskTabs.set(path, { ...tab, text: tab.text + text, mtimeMs, size });
    persist.disk();
    emit('disk', { path });
  },

  /** Flags of a disk tab: follow, conflict (changed on disk while edited here), missing. */
  diskPatch(path, patch) {
    const tab = diskTabs.get(path);
    if (!tab) return;
    diskTabs.set(path, { ...tab, ...patch });
    persist.disk();
    emit('disk', { path });
  },

  // ---- tracker.json ----

  addTrackerOp(op) {
    trackerOps = [...trackerOps, { id: newId(), ...op }];
    persist.rest();
    changed('local');
  },

  // ---- Sync results ----

  /** Snapshot of what a sync round will send. */
  snapshot() {
    return {
      counter: changeCounter,
      texts: new Map([...files.values()].filter((f) => f.dirty && !f.deleted).map((f) => [f.id, texts.get(f.id) ?? sealed.get(f.id) ?? ''])),
      repo: [...repoTabs.values()].filter((t) => t.dirty).map((t) => ({ path: t.path, text: t.text, baseSha: t.baseSha })),
      ops: trackerOps.map((o) => o.id),
      ids: new Set(files.keys()),
    };
  },

  /** Applies a sync result; edits made while it ran stay unsynced (and win). */
  applySynced(result, snap) {
    const remoteTexts = [];
    const next = new Map();
    for (const r of result.files) {
      const local = files.get(r.id);
      let rec = r;
      // Metadata edited here while the sync ran is newer: keep it.
      if (local && local.updatedAt > r.updatedAt) rec = { ...r, ...Object.fromEntries(META_FIELDS.map((k) => [k, local[k]])), pending: true };
      const current = texts.get(r.id) ?? sealed.get(r.id);
      if (snap.texts.has(r.id)) {
        // Uploaded; typed more since? Then it is still unsynced.
        if (current !== snap.texts.get(r.id)) rec = { ...rec, dirty: true, modifiedAt: local.modifiedAt, modifiedBy: local.modifiedBy };
      } else if (result.texts.has(r.id)) {
        if (local?.dirty) {
          // Edited here during the sync: keep ours; the next round keeps both.
          rec = { ...rec, dirty: true, baseSha: local.baseSha };
        } else {
          putText(r.id, result.texts.get(r.id), rec.encrypted);
          persist.text(r.id);
          remoteTexts.push(r.id);
        }
      } else if (local?.dirty) {
        rec = { ...rec, dirty: true };
      }
      if (rec.deleted) {
        if (texts.has(r.id) || sealed.has(r.id)) {
          keepInTrash(r.id, texts.get(r.id) ?? sealed.get(r.id));
          texts.delete(r.id);
          sealed.delete(r.id);
          persist.text(r.id);
        }
        if (session.open.includes(fileKey(r.id))) store.close(fileKey(r.id), { silent: true });
      }
      next.set(r.id, rec);
    }
    // Files created here while the sync ran (the others missing were pruned).
    for (const [id, f] of files) if (!next.has(id) && !snap.ids?.has(id)) next.set(id, f);
    forgetTrash([...trashed].filter((id) => !next.get(id)?.deleted));
    files = next;

    for (const res of result.repoResults ?? []) {
      const tab = repoTabs.get(res.path);
      if (!tab) continue;
      const sent = snap.repo.find((e) => e.path === res.path)?.text;
      if (res.conflict) repoTabs.set(res.path, { ...tab, text: res.text, baseSha: res.sha, dirty: false });
      else repoTabs.set(res.path, { ...tab, baseSha: res.sha, dirty: tab.text !== sent });
    }
    projects = result.projects ?? projects;
    trackerItems = result.trackerItems ?? trackerItems;
    trackerOps = trackerOps.filter((o) => !snap.ops.includes(o.id));
    meta = { ...meta, lastSyncAt: nowIso() };
    persist.files();
    persist.repo();
    persist.session();
    persist.rest();
    emit('remote', { texts: remoteTexts, conflicts: result.conflicts ?? [], repo: result.repoResults ?? [] });
  },

  clear() {
    for (const id of [...texts.keys(), ...sealed.keys()]) kvDelete(`text:${id}`);
    sealed = new Map();
    forgetTrash([...trashed]);
    files = new Map();
    texts = new Map();
    repoTabs = new Map();
    diskTabs = new Map();
    persist.disk(0);
    projects = [];
    trackerItems = [];
    trackerOps = [];
    docTexts = new Map();
    persist.docs();
    session = { open: [], active: null, closed: [], pinned: [], side: null, collapsed: [] };
    meta = { lastSyncAt: null };
    persist.files();
    persist.repo();
    persist.session();
    persist.rest();
    changed('reset');
  },
};
