// The servers set up on this computer (desktop app) and whether each is
// connected, for the folders view, the tabs and the status bar. The main
// process (electron/remote.cjs) does the connecting; this keeps its list and
// its status events, and tells subscribers when they change.
const bridge = () => globalThis.window?.desktop?.remote;
let list = [];
const status = new Map(); // id → { state, error }
const listeners = new Set();
const emit = () => listeners.forEach((callback) => callback());

export const serversAvailable = () => Boolean(bridge());
export const servers = () => list;
export const server = (id) => list.find((c) => c.id === id) ?? null;
export const serverStatus = (id) => status.get(id) ?? { state: 'disconnected', error: '' };

export function onServers(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export async function refreshServers() {
  if (!bridge()) return [];
  list = await bridge().connections();
  for (const c of list) status.set(c.id, { state: c.state, error: c.error });
  emit();
  return list;
}

/** Follows the main process's status events; `onConnected(id)` runs when a server connects. */
export function watchServers({ onConnected = () => {} } = {}) {
  if (!bridge()) return () => {};
  refreshServers();
  return bridge().onStatus((s) => {
    const before = status.get(s.id)?.state;
    status.set(s.id, { state: s.state, error: s.error });
    emit();
    if (s.state === 'connected' && before !== 'connected') onConnected(s.id);
  });
}
