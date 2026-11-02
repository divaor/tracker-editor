// The servers set up on this computer (desktop app) and whether each is
// connected, for the folders view, the tabs and the status bar. The main
// process (electron/remote.cjs) does the connecting; this keeps its list and
// its status events, and tells subscribers when they change. Docker containers
// and WSL distributions are connections too (places); `placeKinds` says which of
// the two this computer has (asked once: whether docker and wsl.exe are here).
const bridge = () => globalThis.window?.desktop?.remote;
let list = [];
let kinds = { docker: false, wsl: false };
let kindsAsked = null;
const status = new Map(); // id → { state, error }
const listeners = new Set();
const emit = () => listeners.forEach((callback) => callback());

export const serversAvailable = () => Boolean(bridge());
export const servers = () => list;
export const server = (id) => list.find((c) => c.id === id) ?? null;
export const serverStatus = (id) => status.get(id) ?? { state: 'disconnected', error: '' };
/** Which places this computer can open: { docker, wsl } (false until the main process said). */
export const placeKinds = () => kinds;
/** Asks the main process which places it can open (once; again with `fresh`). */
export function refreshPlaceKinds({ fresh = false } = {}) {
  if (!bridge()?.placeKinds) return Promise.resolve(kinds);
  if (!kindsAsked || fresh) {
    kindsAsked = bridge()
      .placeKinds()
      .then((k) => {
        kinds = { docker: Boolean(k?.docker), wsl: Boolean(k?.wsl) };
        emit();
        return kinds;
      })
      .catch(() => kinds);
  }
  return kindsAsked;
}

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
  refreshServers().catch((err) => console.warn('Servers', err));
  refreshPlaceKinds();
  return bridge().onStatus((s) => {
    const before = status.get(s.id)?.state;
    status.set(s.id, { state: s.state, error: s.error });
    emit();
    if (s.state === 'connected' && before !== 'connected') onConnected(s.id);
  });
}
