// Decides when to sync: on start, a little after you stop typing, every few
// minutes, when the network comes back, when the app goes to the background
// with unsynced changes, and before the desktop app closes. In local mode
// ("on this computer") the same sync goes to the data on this device
// (localData.js), at once when the tracker changed it; switchStorage moves the
// data between it and GitHub.
import { createGitHubClient } from './github.js';
import { syncOnce } from './sync.js';
import { getSettings, getToken, isLocal, isSyncConfigured, saveSettings } from './settings.js';
import { store } from './store.js';
import { mergeItems, mergeProjects, normalizeItem, nowIso, parseData, serializeDocument, upsertProjectRecord } from './tracker-model.js';
import { decodeFor, encodeFor, fetchVault, vaultState } from './vault.js';
import { localRepo, onLocalDataChange } from './localData.js';
import { moveData } from './moveData.js';

// Tracker documents larger than this are opened on demand instead of downloaded ahead.
const MAX_DOC_BYTES = 2 * 1024 * 1024;

// Typing produces many edits; wait for a pause so a sync carries a batch.
const TEXT_DELAY = 15 * 1000;
const EDIT_DELAY = 3000;
const INTERVAL = 3 * 60 * 1000;
const DESKTOP_INTERVAL = 60 * 1000;
const FOCUS_MIN_GAP = 30 * 1000;

let state = { phase: 'idle', error: null, lastSyncAt: null };
const listeners = new Set();
const resultListeners = new Set();
let running = null;
let again = false;
let timer = null;
let interval = null;
let stopped = false;

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

/** Turns queued tracker changes (new projects, "Send to tracker") into a tracker.json change. */
function trackerChange(ops, device) {
  if (!ops.length) return null;
  return ({ items, projects }) => {
    const now = nowIso();
    for (const op of ops) {
      if (op.op === 'project') projects = upsertProjectRecord(projects, op.name, op.area || op.color ? { area: op.area, color: op.color } : {}, now, device);
      if (op.op === 'item' && !items.some((i) => i.id === op.item.id)) {
        items = [...items, normalizeItem({ status: 'pending', ...op.item, createdAt: now, updatedAt: now, updatedBy: device })];
      }
    }
    return { items, projects };
  };
}

export function syncClient(settings, token) {
  return createGitHubClient({ token, owner: settings.owner, repo: settings.repo });
}

/** Where the data is now: { client, branch, local } (the data on this device, or GitHub's repo). */
export async function dataClient(settings = getSettings()) {
  if (isLocal(settings)) return { client: localRepo(), branch: '', local: true };
  const token = await getToken();
  if (!isSyncConfigured(settings) || !token) throw new Error('Set up sync in Settings first: this comes from your GitHub data repo.');
  return { client: syncClient(settings, token), branch: settings.branch, local: false };
}

// The tracker's data file in local mode (the tracker's own name for it there).
const LOCAL_TRACKER = 'tracker.json';
const trackerPathOf = (settings) => (isLocal(settings) ? LOCAL_TRACKER : settings.trackerPath || LOCAL_TRACKER);

// tracker.json from two places, item by item (theirs unreadable: nothing is written).
const mergeTracker = (theirs, ours) => {
  const a = parseData(theirs);
  const b = parseData(ours);
  return serializeDocument(mergeItems(a.items, b.items), mergeProjects(a.projects, b.projects), a.extra);
};

/**
 * Moves the data to GitHub ('github', with `patch`: owner, repo, branch…, the token
 * already saved) or back to this device ('local'): this device's data is synced
 * where it is, copied to the other place (nothing removed there), then the app
 * syncs there. The data on this device remembers where it went, so the tracker
 * offers to follow.
 */
export async function switchStorage(to, patch = {}) {
  await syncNow();
  const before = await dataClient();
  const settings = { ...getSettings(), ...patch, storage: to };
  const after = await dataClient(settings);
  if (to === 'github') await after.client.getRepo();
  const result = await moveData({
    from: before.client,
    to: after.client,
    fromBranch: before.branch,
    toBranch: after.branch,
    fromTrackerPath: trackerPathOf(getSettings()),
    toTrackerPath: trackerPathOf(settings),
    mergeTracker,
    device: settings.device || 'this device',
  });
  await localRepo().setMeta({ movedTo: to === 'github' ? { owner: settings.owner, repo: settings.repo, branch: settings.branch || '', at: nowIso(), by: settings.device || '' } : null });
  saveSettings({ ...patch, storage: to });
  if (to === 'local') watchLocal();
  await syncNow();
  return result;
}

/** Where the data on this device went (the tracker or this app moved it to GitHub): { owner, repo, branch } or null. */
export async function movedTo() {
  if (!isLocal()) return null;
  return (await localRepo().getMeta().catch(() => ({}))).movedTo ?? null;
}

let watchingLocal = false;
function watchLocal() {
  if (watchingLocal) return;
  watchingLocal = true;
  onLocalDataChange(() => isLocal() && syncNow());
}

// The data on this device is tidied (old versions dropped) once a day.
async function tidyLocal(client) {
  const { prunedAt } = await client.getMeta();
  if (prunedAt && Date.now() - Date.parse(prunedAt) < 86400000) return;
  await client.prune();
}

/** Downloads the tracker documents this device has no copy of yet, so they open offline and can be searched. */
async function downloadDocs(client) {
  const missing = store.docs().filter((d) => d.sha && !store.hasDocText(d.sha) && d.size <= MAX_DOC_BYTES);
  const got = [];
  for (let i = 0; i < missing.length && !stopped; i += 4) {
    const batch = await Promise.all(missing.slice(i, i + 4).map((d) => client.getBlobText(d.sha).then((text) => [d.sha, text], () => null)));
    got.push(...batch.filter(Boolean));
  }
  if (!stopped) store.cacheDocTexts(got);
}

async function run() {
  const settings = getSettings();
  const local = isLocal(settings);
  const token = local ? null : await getToken();
  if (!local && (!isSyncConfigured(settings) || !token)) {
    set({ phase: 'disabled', error: null });
    return null;
  }
  if (!local && navigator.onLine === false) {
    set({ phase: 'offline' });
    return null;
  }
  set({ phase: 'syncing', error: null });
  const snap = store.snapshot();
  const device = settings.device || 'unknown device';
  const client = local ? localRepo() : syncClient(settings, token);
  const branch = local ? '' : settings.branch;
  try {
    const result = await syncOnce({
      client,
      branch,
      trackerPath: local ? LOCAL_TRACKER : settings.trackerPath,
      files: store.all(),
      texts: snap.texts,
      repoEdits: snap.repo,
      trackerChange: trackerChange(store.trackerOps().filter((o) => snap.ops.includes(o.id)), device),
      device,
      encode: encodeFor,
      decode: decodeFor,
    });
    store.applySynced(result, snap);
    // Encrypted files here and no vault yet: it is in the data repo.
    if (!vaultState().exists && store.all().some((f) => f.encrypted && !f.deleted)) await fetchVault(client, branch).catch((err) => console.warn('Could not read the vault', err));
    await downloadDocs(client).catch((err) => console.warn('Could not download tracker documents', err));
    if (local) tidyLocal(client).catch((err) => console.warn('Could not tidy the data on this device', err));
    set({ phase: 'idle', error: null, lastSyncAt: nowIso() });
    for (const fn of resultListeners) fn(result);
    return result;
  } catch (err) {
    console.warn('Sync failed', err);
    set({ phase: 'error', error: err?.message ?? String(err) });
    return null;
  }
}

export function syncNow() {
  clearTimeout(timer);
  if (stopped) return Promise.resolve(null);
  if (running) {
    again = true;
    return running;
  }
  running = run().finally(() => {
    running = null;
    if (again) {
      again = false;
      requestSync(1500);
    }
  });
  return running;
}

export function requestSync(delay = EDIT_DELAY) {
  if (stopped || !getSettings().autoSync) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export const getSyncState = () => ({ ...state, pending: store.pendingCount(), lastSyncAt: state.lastSyncAt ?? store.meta.lastSyncAt });

export function onSyncState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called with each successful sync result (for conflict messages). */
export function onSyncResult(fn) {
  resultListeners.add(fn);
  return () => resultListeners.delete(fn);
}

export function startSync() {
  store.subscribe((reason) => {
    if (reason === 'local') requestSync();
    if (reason === 'text') requestSync(TEXT_DELAY);
    if (reason === 'local' || reason === 'text' || reason === 'remote') set({});
  });
  const sinceLast = () => Date.now() - Date.parse(getSyncState().lastSyncAt ?? 0);
  const desktop = Boolean(window.desktop);
  interval = setInterval(
    () => {
      if (getSettings().autoSync && (desktop || document.visibilityState === 'visible')) syncNow();
    },
    desktop ? DESKTOP_INTERVAL : INTERVAL,
  );
  window.addEventListener('online', () => getSettings().autoSync && syncNow());
  // The tracker changed the data on this device: sync at once (local mode only, so GitHub users get no data folder).
  if (isLocal()) watchLocal();
  window.addEventListener('offline', () => set({ phase: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    if (!getSettings().autoSync) return;
    if (document.visibilityState === 'hidden' && store.pendingCount()) syncNow();
    if (document.visibilityState === 'visible' && sinceLast() > FOCUS_MIN_GAP) syncNow();
  });
  if (getSettings().autoSync || isLocal()) syncNow();
  else getToken().then((token) => (isSyncConfigured() && token) || set({ phase: 'disabled' }));
}

/** Stops syncing for good (another tab took over); resolves once a running sync has finished. */
export async function stopSync() {
  stopped = true;
  clearTimeout(timer);
  clearInterval(interval);
  await running;
}
