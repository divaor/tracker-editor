// The Android app: this page in the app's WebView (Capacitor), with `window.desktop` for
// what a phone can do, backed by the app's own plugin (android/app/src/main/java/…/
// TrackerNativePlugin.java). Loaded before main.js, so the rest of the page finds it; in a
// browser or the desktop app it does nothing.
//
// Files given to the app (Open with, Edit with, the file picker) are content:// addresses:
// they open as tabs edited where they are, like files on disk on a computer. The native side
// only moves bytes; textBytes.js decodes and encodes them by the desktop's rules.
import { decodeAppended, decodeText, encodeText, fromBase64, fromWholeLine, MAX_APPEND, MAX_FULL, TAIL, toBase64 } from './textBytes.js';

const cap = globalThis.Capacitor;
const inAndroidApp = Boolean(cap?.isNativePlatform?.() && cap.getPlatform?.() === 'android');

const PLUGIN = 'TrackerNative';
const WATCH_EVERY = 4000;

// Plugin calls reject with { message, code }: an Error the page can show.
const call = (method, options = {}) =>
  cap.nativePromise(PLUGIN, method, options).catch((err) => {
    throw new Error(err?.message ?? String(err));
  });

/** A file the app reads as the editor opens it: { path, name, text, eol, bom, encoding, mtimeMs, size, truncated, readOnly }. */
async function readFile(uri) {
  const info = await call('stat', { uri });
  const big = info.size > MAX_FULL;
  const { data } = await call('read', big ? { uri, offset: info.size - TAIL, length: TAIL } : { uri });
  const bytes = fromBase64(data);
  const decoded = decodeText(bytes);
  if (big) decoded.text = fromWholeLine(decoded.text);
  return { path: uri, name: info.name, ...decoded, mtimeMs: info.mtimeMs, size: info.size >= 0 ? info.size : bytes.length, truncated: big, readOnly: !info.writable };
}

/**
 * Whether a file changed since it was read: by its time when the app that has it says it,
 * else by its size (some apps say neither: then it is written over).
 */
export function changedSince(now, { expectedMtime, expectedSize }) {
  if (now.mtimeMs > 0 && expectedMtime > 0) return Math.abs(now.mtimeMs - expectedMtime) > 1;
  if (now.size >= 0 && expectedSize >= 0) return now.size !== expectedSize;
  return false;
}

async function writeFile(uri, text, { eol, bom, encoding, expectedMtime, expectedSize, force = false } = {}) {
  if (!force) {
    const now = await call('stat', { uri });
    if (changedSince(now, { expectedMtime, expectedSize })) return { conflict: true, mtimeMs: now.mtimeMs };
  }
  const info = await call('write', { uri, data: toBase64(encodeText(text, { eol, bom, encoding })) });
  return { mtimeMs: info.mtimeMs, size: info.size };
}

async function readAppended(uri, offset, { encoding = 'utf-8' } = {}) {
  const info = await call('stat', { uri });
  if (info.size < offset) return { reset: true, size: info.size, mtimeMs: info.mtimeMs };
  const length = Math.min(info.size - offset, MAX_APPEND);
  const start = info.size - length;
  const { data } = length ? await call('read', { uri, offset: start, length }) : { data: '' };
  return { text: decodeAppended(fromBase64(data), encoding), size: info.size, mtimeMs: info.mtimeMs, skipped: start - offset };
}

// What the app was given, sorted for the page: files to open where they are, things shared
// (text, and files sent as copies) and links. Kept until the page takes them.
const queue = { launched: [], shared: [], links: [] };
const subscribers = { launched: new Set(), shared: new Set() };

/** [{ kind, action, … }] from the native side → the queues ({ path } to open; { title, text, files } shared). */
export async function sortLaunch(items, readBytes) {
  const out = { launched: [], shared: [], links: [] };
  for (const item of items) {
    if (item.kind === 'link') out.links.push(item.url);
    else if (item.kind === 'text') out.shared.push({ title: item.title ?? '', text: item.text ?? '', url: '', files: [] });
    else if (item.action === 'send') {
      try {
        out.shared.push({ title: '', text: '', url: '', files: [new File([await readBytes(item.uri)], item.name || 'Shared file', { type: item.mime || '' })] });
      } catch (err) {
        console.warn('A shared file could not be read', err);
      }
    } else out.launched.push({ path: item.uri, name: item.name });
  }
  return out;
}

/** tracker-editor://file/<id>, repo/<path>, new, voice → the page's address (#/file/<id>…). */
export function routeOfLink(url) {
  const m = /^tracker-editor:\/\/([^?#]*)/i.exec(url ?? '');
  if (!m) return null;
  const path = m[1].replace(/^\/+/, '');
  if (path === 'new' || path === 'voice') return `#/${path}`;
  if (/^(file|repo)\//.test(path)) return `#/${path}`;
  return null;
}

async function drain() {
  const { items = [] } = await call('takeLaunch').catch(() => ({ items: [] }));
  if (!items.length) return;
  const sorted = await sortLaunch(items, async (uri) => fromBase64((await call('read', { uri })).data));
  queue.launched.push(...sorted.launched);
  queue.shared.push(...sorted.shared);
  for (const link of sorted.links) {
    const route = routeOfLink(link);
    if (route) location.hash = route;
  }
  if (sorted.launched.length) for (const cb of subscribers.launched) cb();
  if (sorted.shared.length) for (const cb of subscribers.shared) cb();
}
const take = (kind) => queue[kind].splice(0);
const subscribe = (kind, callback) => {
  subscribers[kind].add(callback);
  return () => subscribers[kind].delete(callback);
};

// Files open in tabs: the app cannot be told when one changes, so it looks while the app is
// in front (a few seconds apart) and says so as the desktop's watcher does.
const watched = new Map(); // uri → { mtimeMs, size } last seen
const changeListeners = new Set();
let watchTimer = null;
async function lookAtWatched() {
  for (const [uri, last] of watched) {
    let now;
    try {
      now = await call('stat', { uri });
    } catch {
      now = null;
    }
    const seen = now ? { mtimeMs: now.mtimeMs, size: now.size } : null;
    if (JSON.stringify(seen) === JSON.stringify(last) || !watched.has(uri)) continue;
    watched.set(uri, seen);
    // Not known yet (watching just began): only learned.
    if (last === undefined) continue;
    for (const cb of changeListeners) cb({ path: uri, ...(seen ?? {}), exists: Boolean(seen) });
  }
}
function startWatching() {
  if (watchTimer || !watched.size) return;
  watchTimer = setInterval(() => document.visibilityState === 'visible' && lookAtWatched(), WATCH_EVERY);
}

function mimeOf(name) {
  const ext = /\.([^.]+)$/.exec(name ?? '')?.[1]?.toLowerCase();
  return { json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', md: 'text/markdown', csv: 'text/csv', css: 'text/css', js: 'text/javascript' }[ext] ?? 'text/plain';
}

function install() {
  const backListeners = new Set();
  cap.addListener(PLUGIN, 'back', () => {
    // The newest listener decides; nothing listening: as Home.
    const last = [...backListeners].at(-1);
    if (!last || !last()) call('minimize').catch(() => {});
  });
  cap.addListener(PLUGIN, 'launch', () => drain());

  window.desktop = {
    platform: 'android',
    versions: { chrome: /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '' },
    secrets: {
      get: (key) => call('secretGet', { key }).then((r) => r.value ?? ''),
      set: (key, value) => call('secretSet', { key, value: value || null }),
    },
    // Import files (copies that sync): the system's picker.
    async openFiles() {
      const { items = [] } = await call('pick', { multiple: true });
      const out = [];
      for (const item of items) {
        try {
          out.push({ name: item.name, text: decodeText(fromBase64((await call('read', { uri: item.uri })).data)).text });
        } catch (err) {
          console.warn(item.name, err);
        }
      }
      return out;
    },
    // Save a copy: the system asks where.
    async saveFile(name, text) {
      const saved = await call('saveAs', { name, mime: mimeOf(name), data: toBase64(new TextEncoder().encode(text)) });
      return saved.canceled ? null : saved.name;
    },
    disk: {
      // The system's picker; the files stay reachable after a restart.
      async open(opts = {}) {
        const { items = [] } = await call('pick', { multiple: !opts.single });
        const out = [];
        for (const item of items) {
          try {
            out.push(await readFile(item.uri));
          } catch (err) {
            out.push({ name: item.name, error: err.message });
          }
        }
        return out;
      },
      read: (path) => readFile(path),
      editorConfig: async () => null,
      readAppended: (path, offset, opts) => readAppended(path, offset, opts),
      write: (path, text, opts) => writeFile(path, text, opts),
      async stat(path) {
        try {
          const info = await call('stat', { uri: path });
          return { mtimeMs: info.mtimeMs, size: info.size };
        } catch {
          return null;
        }
      },
      async watch(path, on = true) {
        if (!on) return void watched.delete(path);
        if (watched.has(path)) return;
        // What it is like now (just read): later looks compare with it.
        watched.set(path, undefined);
        startWatching();
        const now = await call('stat', { uri: path }).catch(() => null);
        if (watched.get(path) === undefined) watched.set(path, now ? { mtimeMs: now.mtimeMs, size: now.size } : null);
      },
      pathOf: () => '',
      onChanged(callback) {
        changeListeners.add(callback);
        return () => changeListeners.delete(callback);
      },
      // Open with / Edit with: [{ path }] to open as tabs.
      takeLaunched: async () => take('launched'),
      onLaunched: (callback) => subscribe('launched', callback),
    },
    // Share → Tracker Editor, and text selected in another app: [{ title, text, url, files }].
    shared: {
      take: async () => take('shared'),
      onShared: (callback) => subscribe('shared', callback),
    },
    android: {
      // Back: `handler()` returns true when it closed something; the newest one is asked.
      onBack(handler) {
        backListeners.add(handler);
        return () => backListeners.delete(handler);
      },
      minimize: () => call('minimize'),
      shareText: (text, title = '') => call('shareText', { text, title }),
      openWith: (uri, mime = '') => call('openWith', { uri, mime }),
      info: () => call('info'),
      // The status and navigation bars' icons follow the page's theme.
      barStyle: (dark) => cap.nativePromise('SystemBars', 'setStyle', { style: dark ? 'DARK' : 'LIGHT' }).catch(() => {}),
    },
  };
  const root = document.documentElement;
  root.dataset.native = 'android';
  // The bars' icons: light on a dark page, dark on a light one.
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const barStyle = () => window.desktop.android.barStyle(root.dataset.theme ? root.dataset.theme === 'dark' : dark.matches);
  new MutationObserver(barStyle).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  dark.addEventListener('change', barStyle);
  barStyle();
  drain();
}

if (inAndroidApp && !globalThis.window?.desktop) install();
