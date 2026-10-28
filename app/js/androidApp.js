// The Android app: this page in the app's WebView (Capacitor), with `window.desktop` for
// what a phone can do, backed by the app's own plugin (android/app/src/main/java/…/
// TrackerNativePlugin.java). Loaded before main.js, so the rest of the page finds it; in a
// browser or the desktop app it does nothing.
//
// Files given to the app (Open with, Edit with, the file picker) are content:// addresses:
// they open as tabs edited where they are, like files on disk on a computer. The native side
// only moves bytes; textBytes.js decodes and encodes them by the desktop's rules.
import { documentKind } from './docTypes.js';
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

// ---- The app's log (Send a log): the page's errors and what it did, in batches ----
const logLines = [];
let logTimer = null;
/** One line for the app's log (AppLog.java). Never secrets or the text of files. */
export function logLine(text) {
  logLines.push(String(text));
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  if (!logTimer) logTimer = setTimeout(flushLog, 1500);
}
function flushLog() {
  logTimer = null;
  if (!logLines.length) return;
  cap.nativePromise(PLUGIN, 'log', { lines: logLines.splice(0) }).catch(() => {});
}
/** A console argument as text: errors with their stack, objects as JSON (cut short). */
export function logText(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value)?.slice(0, 1000) ?? String(value);
  } catch {
    return String(value);
  }
}
function watchPage() {
  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      logLine(`${level}: ${args.map(logText).join(' ')}`);
      original(...args);
    };
  }
  addEventListener('error', (e) => logLine(`error: ${e.error ? logText(e.error) : `${e.message} (${e.filename}:${e.lineno})`}`));
  addEventListener('unhandledrejection', (e) => logLine(`unhandled: ${logText(e.reason)}`));
  addEventListener('pagehide', flushLog);
  // The page too busy to answer touches.
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (entry.duration > 1500) logLine(`The page was busy for ${Math.round(entry.duration)} ms`);
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  logLine(`Page started (WebView ${/Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? '?'})`);
}

/** A file the app reads as the editor opens it: { path, name, text, eol, bom, encoding, mtimeMs, size, truncated, readOnly }. */
async function readFile(uri) {
  const info = await call('stat', { uri });
  // A document (PDF, e-book, Word…): shown from its bytes, so no text is read here.
  const doc = documentKind(info.name, info.mime);
  if (doc) return { path: uri, name: info.name, text: '', eol: 'lf', bom: false, encoding: 'utf-8', mtimeMs: info.mtimeMs, size: info.size, truncated: false, readOnly: !info.writable, doc };
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

// A document's bytes, 8 MB at a time (each part crosses to the page as base64).
const BYTES_PART = 8 * 1024 * 1024;
const MAX_DOCUMENT = 200 * 1024 * 1024;
async function readBytes(uri) {
  const info = await call('stat', { uri });
  if (info.size > MAX_DOCUMENT) throw new Error(`${info.name} is larger than 200 MB.`);
  const parts = [];
  let total = 0;
  for (;;) {
    const { data } = await call('read', { uri, offset: total, length: BYTES_PART });
    const part = fromBase64(data);
    parts.push(part);
    total += part.length;
    if (part.length < BYTES_PART || total > MAX_DOCUMENT || (info.size >= 0 && total >= info.size)) break;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
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

// ---- The app's own Node.js: the desktop's main process for folders, servers, terminals ----
// Started the first time something needs it; the native side gives its port and token. When
// Android has ended it (it ends processes it does not need), the next call starts it again.
let backend = null;
let events = null;
const nodeListeners = new Map(); // channel → Set of callbacks

const unpackBytes = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.__bytes === 'string' && Object.keys(value).length === 1) return fromBase64(value.__bytes);
  if (Array.isArray(value)) return value.map(unpackBytes);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unpackBytes(v)]));
};
const packBytes = (value) => {
  if (value instanceof Uint8Array) return { __bytes: toBase64(value) };
  if (Array.isArray(value)) return value.map(packBytes);
  if (value && typeof value === 'object' && value.constructor === Object) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, packBytes(v)]));
  return value;
};

function startBackend(restart = false) {
  if (!backend || restart) {
    const t0 = performance.now();
    logLine(restart ? 'Starting the app’s file access again' : 'Starting the app’s file access');
    backend = call('backend', { restart }).then(({ port, token }) => {
      logLine(`File access ready (${Math.round(performance.now() - t0)} ms)`);
      const info = { base: `http://127.0.0.1:${port}`, token };
      listenTo(info);
      return info;
    });
    backend.catch((err) => {
      logLine(`File access did not start: ${err.message}`);
      backend = null;
    });
  }
  return backend;
}

function listenTo({ base, token }) {
  events?.close();
  events = new EventSource(`${base}/events?token=${encodeURIComponent(token)}`);
  let lost = false;
  events.onopen = () => (lost = false);
  events.onerror = () => !lost && ((lost = true), logLine('Lost the file access events (trying again)'));
  events.onmessage = (e) => {
    let message;
    try {
      message = JSON.parse(e.data);
    } catch {
      return;
    }
    const args = unpackBytes(message.args ?? []);
    for (const cb of nodeListeners.get(message.channel) ?? []) {
      try {
        cb(...args);
      } catch (err) {
        console.error(message.channel, err);
      }
    }
  };
}

/** A handler of the desktop's main process (ipcRenderer.invoke there). */
export async function nodeInvoke(channel, ...args) {
  for (let attempt = 0; ; attempt++) {
    const { base, token } = await startBackend(attempt > 0);
    let res;
    try {
      res = await fetch(`${base}/invoke`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ channel, args: packBytes(args) }) });
    } catch (err) {
      logLine(`Could not reach the app’s file access (${channel}): ${err.message}`);
      if (attempt) throw new Error('The app’s access to files and servers stopped. Try again.');
      continue;
    }
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    return unpackBytes(body.value);
  }
}

/** A message with no answer (ipcRenderer.send there). */
function nodeSend(channel, ...args) {
  startBackend()
    .then(({ base, token }) => fetch(`${base}/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ channel, args: packBytes(args) }) }))
    .catch(() => {});
}

/** What the main process sends the page (webContents.send there). Listening does not start it. */
function nodeOn(channel, callback) {
  if (!nodeListeners.has(channel)) nodeListeners.set(channel, new Set());
  nodeListeners.get(channel).add(callback);
  return () => nodeListeners.get(channel)?.delete(callback);
}

// Node asks the phone (a folder or file to pick, a question with buttons, a file to open with
// another app): the native side shows it and answers Node itself.
nodeOn('native:ask', (ask) => call('answerAsk', ask).catch((err) => console.warn('Could not ask', err)));
nodeOn('native:open-url', (url) => window.open(url, '_blank'));
nodeOn('native:clipboard', (text) => navigator.clipboard?.writeText(text).catch(() => {}));

function mimeOf(name) {
  const ext = /\.([^.]+)$/.exec(name ?? '')?.[1]?.toLowerCase();
  return { json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', md: 'text/markdown', csv: 'text/csv', css: 'text/css', js: 'text/javascript' }[ext] ?? 'text/plain';
}

const isContent = (path) => typeof path === 'string' && path.startsWith('content://');

function foldersBridge() {
  const inv = (channel) => (...args) => nodeInvoke(channel, ...args);
  return {
    pick: inv('folder:pick'),
    roots: inv('folder:roots'),
    allowParent: inv('folder:allow-parent'),
    forget: inv('folder:forget'),
    list: inv('folder:list'),
    properties: inv('folder:properties'),
    size: inv('folder:size'),
    chmod: inv('folder:chmod'),
    find: inv('folder:find'),
    stopFind: inv('folder:find-stop'),
    findNames: inv('folder:find-names'),
    index: inv('folder:index'),
    replace: inv('folder:replace'),
    replaceUndo: inv('folder:replace-undo'),
    onFound(cb) {
      const a = nodeOn('folder:found', (data) => cb({ type: 'found', ...data }));
      const b = nodeOn('folder:find-progress', (data) => cb({ type: 'progress', ...data }));
      return () => (a(), b());
    },
    places: inv('folder:places'),
    newFile: inv('folder:new-file'),
    newFolder: inv('folder:new-folder'),
    rename: inv('folder:rename'),
    move: inv('folder:move'),
    copy: inv('folder:copy'),
    existing: inv('folder:existing'),
    zip: inv('folder:zip'),
    unzip: inv('folder:unzip'),
    // Files pasted from other apps by path: not on a phone.
    copyIn: async () => {
      throw new Error('Files from other apps cannot be pasted here on a phone: share them to Tracker Editor instead.');
    },
    trash: inv('folder:trash'),
    transfers: inv('transfer:list'),
    stopTransfer: inv('transfer:stop'),
    onTransfer: (cb) => nodeOn('transfer:update', cb),
    openExternal: inv('folder:open-external'),
    readImage: inv('folder:read-image'),
    peekBytes: inv('folder:peek-bytes'),
    peekText: inv('folder:peek-text'),
    watch: inv('folder:watch'),
    onChanged: (cb) => nodeOn('folder:changed', cb),
    // The Paste button: what was copied or cut in the folders view (a paste event, as on the desktop).
    paste: async () => {
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true }));
    },
  };
}

function remoteBridge() {
  const inv = (channel) => (...args) => nodeInvoke(channel, ...args);
  return {
    connections: inv('remote:connections'),
    save: inv('remote:save'),
    delete: inv('remote:delete'),
    test: inv('remote:test'),
    connect: inv('remote:connect'),
    disconnect: inv('remote:disconnect'),
    forgetHostKey: inv('remote:forget-host-key'),
    pickKey: inv('remote:pick-key'),
    sshConfig: inv('remote:ssh-config'),
    importSsh: inv('remote:import-ssh'),
    answerHostKey: inv('remote:host-key-answer'),
    answerPrompt: inv('remote:prompt-answer'),
    onPrompt: (cb) => nodeOn('remote:prompt', cb),
    onPromptGone: (cb) => nodeOn('remote:prompt-gone', cb),
    onStatus: (cb) => nodeOn('remote:status', cb),
    onHostKey: (cb) => nodeOn('remote:host-key', cb),
  };
}

function install() {
  watchPage();
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
    // Model and speech servers: asked by Node, as by the desktop's main process, so a server
    // on this network needs no CORS settings.
    llm: {
      request: (id, url, init) => nodeInvoke('llm:request', id, url, init),
      abort: (id) => nodeSend('llm:abort', id),
      onChunk: (id, callback) => nodeOn('llm:chunk', (chunkId, chunk, done, error) => chunkId === id && callback(chunk, done, error)),
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
      // Files from other apps (content://) through the native side; files in the folders
      // view and on servers through Node, as on the desktop.
      read: (path) => (isContent(path) ? readFile(path) : nodeInvoke('disk:read', path)),
      readBytes: (path) => (isContent(path) ? readBytes(path) : nodeInvoke('disk:read-bytes', path)),
      editorConfig: (path) => (isContent(path) ? Promise.resolve(null) : nodeInvoke('disk:editorconfig', path)),
      readAppended: (path, offset, opts) => (isContent(path) ? readAppended(path, offset, opts) : nodeInvoke('disk:read-appended', path, offset, opts)),
      write: (path, text, opts) => (isContent(path) ? writeFile(path, text, opts) : nodeInvoke('disk:write', path, text, opts)),
      async stat(path) {
        if (!isContent(path)) return nodeInvoke('disk:stat', path);
        try {
          const info = await call('stat', { uri: path });
          return { mtimeMs: info.mtimeMs, size: info.size };
        } catch {
          return null;
        }
      },
      async watch(path, on = true) {
        if (!isContent(path)) return nodeInvoke('disk:watch', path, on);
        if (!on) return void watched.delete(path);
        if (watched.has(path)) return;
        // What it is like now (just read): later looks compare with it.
        watched.set(path, undefined);
        startWatching();
        const now = await call('stat', { uri: path }).catch(() => null);
        if (watched.get(path) === undefined) watched.set(path, now ? { mtimeMs: now.mtimeMs, size: now.size } : null);
      },
      pathOf: () => '',
      // A path typed or pasted: opened once the person confirms it in a native dialog.
      openTyped: (path) => nodeInvoke('disk:open-typed', path),
      onChanged(callback) {
        changeListeners.add(callback);
        const off = nodeOn('disk:changed', callback);
        return () => (changeListeners.delete(callback), off());
      },
      // Open with / Edit with: [{ path }] to open as tabs.
      takeLaunched: async () => take('launched'),
      onLaunched: (callback) => subscribe('launched', callback),
    },
    // The folders view: folders on the phone's storage and on servers (as on the desktop).
    folders: foldersBridge(),
    remote: remoteBridge(),
    mirrors: {
      list: () => nodeInvoke('mirror:list'),
      pickLocal: (suggested) => nodeInvoke('mirror:pick-local', suggested),
      save: (mirror) => nodeInvoke('mirror:save', mirror),
      delete: (id) => nodeInvoke('mirror:delete', id),
      sync: (id, opts) => nodeInvoke('mirror:sync', id, opts),
      onStatus: (cb) => nodeOn('mirror:status', cb),
    },
    // Terminals: on servers over SSH, and a shell on the phone.
    terminal: {
      open: (connId, opts) => nodeInvoke('term:open', connId, opts),
      input: (id, data) => nodeSend('term:input', id, data),
      resize: (id, cols, rows) => nodeInvoke('term:resize', id, cols, rows),
      close: (id) => nodeInvoke('term:close', id),
      ownKeys: async () => {},
      onData: (cb) => nodeOn('term:data', cb),
      onExit: (cb) => nodeOn('term:exit', cb),
    },
    code: {
      declarations: (dirs, word) => nodeInvoke('code:declarations', dirs, word),
      symbols: (dirs, query) => nodeInvoke('code:symbols', dirs, query),
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
      // Send a log: the share sheet with the app's log (as from the icon's menu).
      sendLog: () => (flushLog(), call('sendLog')),
      shareText: (text, title = '') => call('shareText', { text, title }),
      openWith: (uri, mime = '') => call('openWith', { uri, mime }),
      info: () => call('info'),
      node: () => nodeInvoke('app:info'),
      storageAccess: () => call('storageAccess'),
      requestStorageAccess: () => call('requestStorageAccess'),
      // The status and navigation bars' icons follow the page's theme.
      barStyle: (dark) => cap.nativePromise('SystemBars', 'setStyle', { style: dark ? 'DARK' : 'LIGHT' }).catch(() => {}),
      // The status and navigation bars hidden (a document in full screen) or shown again.
      bars: (shown) => cap.nativePromise('SystemBars', shown ? 'show' : 'hide', {}).catch(() => {}),
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
