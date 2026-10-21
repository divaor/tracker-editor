// All files with their texts, this device's open tabs, files opened from the
// tracker, and pending changes to tracker.json — kept in memory and saved to
// IndexedDB as you type. Sync (syncManager.js) takes changes to GitHub.
import { kvDelete, kvGet, kvSet } from './kv.js';
import { getSettings } from './settings.js';
import { applyFilePatch, createFile, nowIso, tombstone, untitledName } from './model.js';
import { newId } from './tracker-model.js';

const META_FIELDS = ['name', 'project', 'tags', 'language', 'deleted', 'updatedAt', 'updatedBy'];

let files = new Map(); // id → record (+ baseSha, dirty)
let texts = new Map(); // id → text
let projects = []; // project records from tracker.json (last sync)
let trackerItems = []; // tracker items (last sync), to show which items link a file
let trackerOps = []; // pending changes to tracker.json: { id, op: 'project' | 'item', ... }
let repoTabs = new Map(); // path → { path, name, text, baseSha, dirty }
let session = { open: [], active: null, closed: [] }; // tab keys: "f:<id>" | "r:<path>"
let meta = { lastSyncAt: null };
let changeCounter = 0;
const listeners = new Set();
const author = () => getSettings().device || '';

export const fileKey = (id) => `f:${id}`;
export const repoKey = (path) => `r:${path}`;
export const parseKey = (key) => (key?.startsWith('r:') ? { kind: 'repo', path: key.slice(2) } : key?.startsWith('f:') ? { kind: 'file', id: key.slice(2) } : null);

// ---- Persistence (debounced) -------------------------------------------------

const timers = new Map();
let closed = false;
function later(key, fn, ms = 250) {
  if (closed) return;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    fn();
  }, ms));
}
const persist = {
  files: () => later('files', () => kvSet('files', [...files.values()])),
  text: (id) => later(`text:${id}`, () => (texts.has(id) ? kvSet(`text:${id}`, texts.get(id)) : kvDelete(`text:${id}`))),
  session: () => later('session', () => kvSet('session', session)),
  repo: () => later('repoTabs', () => kvSet('repoTabs', [...repoTabs.values()])),
  rest: () => later('rest', () => Promise.all([kvSet('projects', projects), kvSet('trackerItems', trackerItems), kvSet('trackerOps', trackerOps), kvSet('meta', meta)])),
};

/** Writes everything still waiting for its debounce (before closing the app). */
export async function flush() {
  const pending = [...timers.entries()];
  for (const [key, timer] of pending) clearTimeout(timer);
  timers.clear();
  await Promise.all([
    kvSet('files', [...files.values()]),
    kvSet('session', session),
    kvSet('repoTabs', [...repoTabs.values()]),
    kvSet('projects', projects),
    kvSet('trackerItems', trackerItems),
    kvSet('trackerOps', trackerOps),
    kvSet('meta', meta),
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
  closed = true;
  if (save) await flush();
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
    texts = new Map(loaded);
    session = { open: [], active: null, closed: [], ...((await kvGet('session')) ?? {}) };
    repoTabs = new Map(((await kvGet('repoTabs')) ?? []).map((t) => [t.path, t]));
    projects = (await kvGet('projects')) ?? [];
    trackerItems = (await kvGet('trackerItems')) ?? [];
    trackerOps = (await kvGet('trackerOps')) ?? [];
    meta = { ...meta, ...((await kvGet('meta')) ?? {}) };
    // Drop tabs whose file is gone.
    session.open = session.open.filter((k) => (k.startsWith('r:') ? repoTabs.has(k.slice(2)) : files.get(k.slice(2)) && !files.get(k.slice(2)).deleted));
    if (!session.open.includes(session.active)) session.active = session.open[0] ?? null;
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
  // Unsynced: edited text (dirty), changed name/project/tags or deleted (pending).
  pendingCount: () => [...files.values()].filter((f) => f.dirty || f.pending).length + [...repoTabs.values()].filter((t) => t.dirty).length + trackerOps.length,

  // ---- Files ----

  create({ name, text = '', project = '', tags = [], language = '', open = true } = {}) {
    const fileName = name || untitledName(store.live().map((f) => f.name));
    const now = nowIso();
    const file = { ...createFile({ name: fileName, project, tags, language, updatedBy: author(), modifiedBy: author() }, now), baseSha: '', dirty: true };
    files.set(file.id, file);
    texts.set(file.id, text);
    persist.files();
    persist.text(file.id);
    if (open) store.open(fileKey(file.id), { silent: true });
    changed('local', { created: file.id });
    return file.id;
  },

  setText(id, text) {
    const file = files.get(id);
    if (!file || file.deleted || texts.get(id) === text) return;
    texts.set(id, text);
    files.set(id, { ...file, dirty: true, modifiedAt: nowIso(), modifiedBy: author() });
    persist.text(id);
    persist.files();
    changed('text', { id });
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
    const previous = { file, text: texts.get(id) ?? '' };
    files.set(id, { ...tombstone(file, nowIso(), author()), baseSha: file.baseSha, dirty: false, pending: true });
    texts.delete(id);
    persist.files();
    persist.text(id);
    store.close(fileKey(id), { silent: true });
    changed('local', { removed: id });
    return previous;
  },

  /** Undo for remove(): brings the file back with its text. */
  restore({ file, text }) {
    files.set(file.id, { ...applyFilePatch(file, { deleted: false, updatedBy: author() }), baseSha: file.baseSha, dirty: true, sha: file.sha, size: file.size });
    texts.set(file.id, text);
    persist.files();
    persist.text(file.id);
    store.open(fileKey(file.id), { silent: true });
    changed('local', { id: file.id });
  },

  // ---- Tabs ----

  open(key, { silent = false } = {}) {
    if (!session.open.includes(key)) {
      const at = session.open.indexOf(session.active);
      session.open = at === -1 ? [...session.open, key] : [...session.open.slice(0, at + 1), key, ...session.open.slice(at + 1)];
    }
    session.active = key;
    persist.session();
    if (!silent) emit('session');
  },

  close(key, { silent = false } = {}) {
    const at = session.open.indexOf(key);
    if (at === -1) return;
    session.open = session.open.filter((k) => k !== key);
    session.closed = [key, ...session.closed.filter((k) => k !== key)].slice(0, 20);
    if (session.active === key) session.active = session.open[Math.min(at, session.open.length - 1)] ?? null;
    if (key.startsWith('r:') && !repoTabs.get(key.slice(2))?.dirty) {
      repoTabs.delete(key.slice(2));
      persist.repo();
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

  move(key, toIndex) {
    const list = session.open.filter((k) => k !== key);
    list.splice(Math.max(0, Math.min(toIndex, list.length)), 0, key);
    session.open = list;
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

  setRepoText(path, text) {
    const tab = repoTabs.get(path);
    if (!tab || tab.text === text) return;
    repoTabs.set(path, { ...tab, text, dirty: true });
    persist.repo();
    changed('text', { path });
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
      texts: new Map([...files.values()].filter((f) => f.dirty && !f.deleted).map((f) => [f.id, texts.get(f.id) ?? ''])),
      repo: [...repoTabs.values()].filter((t) => t.dirty).map((t) => ({ path: t.path, text: t.text, baseSha: t.baseSha })),
      ops: trackerOps.map((o) => o.id),
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
      const current = texts.get(r.id);
      if (snap.texts.has(r.id)) {
        // Uploaded; typed more since? Then it is still unsynced.
        if (current !== snap.texts.get(r.id)) rec = { ...rec, dirty: true, modifiedAt: local.modifiedAt, modifiedBy: local.modifiedBy };
      } else if (result.texts.has(r.id)) {
        if (local?.dirty) {
          // Edited here during the sync: keep ours; the next round keeps both.
          rec = { ...rec, dirty: true, baseSha: local.baseSha };
        } else {
          texts.set(r.id, result.texts.get(r.id));
          persist.text(r.id);
          remoteTexts.push(r.id);
        }
      } else if (local?.dirty) {
        rec = { ...rec, dirty: true };
      }
      if (rec.deleted) {
        if (texts.delete(r.id)) persist.text(r.id);
        if (session.open.includes(fileKey(r.id))) store.close(fileKey(r.id), { silent: true });
      }
      next.set(r.id, rec);
    }
    // Files created here while the sync ran.
    for (const [id, f] of files) if (!next.has(id)) next.set(id, f);
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
    for (const id of texts.keys()) kvDelete(`text:${id}`);
    files = new Map();
    texts = new Map();
    repoTabs = new Map();
    projects = [];
    trackerItems = [];
    trackerOps = [];
    session = { open: [], active: null, closed: [] };
    meta = { lastSyncAt: null };
    persist.files();
    persist.repo();
    persist.session();
    persist.rest();
    changed('reset');
  },
};
