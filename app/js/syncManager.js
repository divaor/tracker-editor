// Decides when to sync: on start, a little after you stop typing, every few
// minutes, when the network comes back, when the app goes to the background
// with unsynced changes, and before the desktop app closes.
import { createGitHubClient } from './github.js';
import { syncOnce } from './sync.js';
import { getSettings, getToken, isSyncConfigured } from './settings.js';
import { store } from './store.js';
import { normalizeItem, nowIso, upsertProjectRecord } from './tracker-model.js';

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

async function run() {
  const settings = getSettings();
  const token = await getToken();
  if (!isSyncConfigured(settings) || !token) {
    set({ phase: 'disabled', error: null });
    return null;
  }
  if (navigator.onLine === false) {
    set({ phase: 'offline' });
    return null;
  }
  set({ phase: 'syncing', error: null });
  const snap = store.snapshot();
  const device = settings.device || 'unknown device';
  try {
    const result = await syncOnce({
      client: syncClient(settings, token),
      branch: settings.branch,
      trackerPath: settings.trackerPath,
      files: store.all(),
      texts: snap.texts,
      repoEdits: snap.repo,
      trackerChange: trackerChange(store.trackerOps().filter((o) => snap.ops.includes(o.id)), device),
      device,
    });
    store.applySynced(result, snap);
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
  window.addEventListener('offline', () => set({ phase: 'offline' }));
  document.addEventListener('visibilitychange', () => {
    if (!getSettings().autoSync) return;
    if (document.visibilityState === 'hidden' && store.pendingCount()) syncNow();
    if (document.visibilityState === 'visible' && sinceLast() > FOCUS_MIN_GAP) syncNow();
  });
  if (getSettings().autoSync) syncNow();
  else getToken().then((token) => (isSyncConfigured() && token) || set({ phase: 'disabled' }));
}

/** Stops syncing for good (another tab took over); resolves once a running sync has finished. */
export async function stopSync() {
  stopped = true;
  clearTimeout(timer);
  clearInterval(interval);
  await running;
}
