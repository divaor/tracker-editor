// Electron main process: serves the web app from app:// (a secure, standard
// origin so IndexedDB and ES modules work), keeps the GitHub token encrypted
// with the OS keychain, opens and saves files on disk, forwards requests to a
// local model server (no CORS setup needed), opens tracker-editor:// links
// from the tracker, and lets the app save and sync before the window closes.
const { app, BrowserWindow, Menu, Notification, Tray, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, net, protocol, safeStorage, screen, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startTyping } = require('./typer.cjs');
const disk = require('./diskFiles.cjs');
const clips = require('./clipHistory.cjs');

const APP_DIR = path.join(__dirname, '..', 'app');
const APP_ORIGIN = 'app://editor';
const LINK_SCHEME = 'tracker-editor';
const REPO_URL = 'https://github.com/divaor/tracker-editor';
const SECRET_KEYS = new Set(['github-token', 'llm-api-key', 'llm-webhook-secret']);
const MAX_FILE = 5 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('com.divaor.tracker-editor');

// tracker-editor://file/<id> and tracker-editor://repo/<path> (from the tracker).
if (process.defaultApp && process.argv.length >= 2) app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(LINK_SCHEME);

let mainWindow = null;
let pendingRoute = null;
let closing = false;
let quitting = false;

// ---- Small JSON files in the user data folder ------------------------------

const dataFile = (name) => path.join(app.getPath('userData'), name);

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(dataFile(name), JSON.stringify(value, null, 2));
  } catch (err) {
    console.error(`Could not write ${name}`, err);
  }
}

// ---- Secrets ------------------------------------------------------------

function getSecret(key) {
  const entry = readJson('secrets.json', {})[key];
  if (!entry) return '';
  const buffer = Buffer.from(entry.data, 'base64');
  if (!entry.encrypted) return buffer.toString('utf8');
  try {
    return safeStorage.decryptString(buffer);
  } catch {
    return '';
  }
}

function setSecret(key, value) {
  const secrets = readJson('secrets.json', {});
  if (!value) delete secrets[key];
  else if (safeStorage.isEncryptionAvailable()) secrets[key] = { encrypted: true, data: safeStorage.encryptString(value).toString('base64') };
  else secrets[key] = { encrypted: false, data: Buffer.from(value, 'utf8').toString('base64') };
  writeJson('secrets.json', secrets);
}

const fromApp = (event) => event.senderFrame?.url?.startsWith(`${APP_ORIGIN}/`);
const guard = (handler) => (event, ...args) => {
  if (!fromApp(event)) throw new Error('Not allowed');
  return handler(event, ...args);
};

ipcMain.handle('secret:get', guard((_e, key) => {
  if (!SECRET_KEYS.has(key)) throw new Error('Not allowed');
  return getSecret(key);
}));

ipcMain.handle('secret:set', guard((_e, key, value) => {
  if (!SECRET_KEYS.has(key) || typeof value !== 'string') throw new Error('Not allowed');
  setSecret(key, value);
  return true;
}));

// ---- Files on disk ----------------------------------------------------------

ipcMain.handle('files:open', guard(async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Add files', properties: ['openFile', 'multiSelections'] });
  if (canceled) return [];
  const out = [];
  for (const file of filePaths) {
    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE) {
      dialog.showMessageBox(mainWindow, { type: 'warning', message: `${path.basename(file)} is larger than 5 MB and was skipped.` });
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (text.slice(0, 8000).includes('\u0000')) {
      dialog.showMessageBox(mainWindow, { type: 'warning', message: `${path.basename(file)} is not a text file and was skipped.` });
      continue;
    }
    out.push({ name: path.basename(file), text });
  }
  return out;
}));

ipcMain.handle('files:save', guard(async (_e, name, text) => {
  if (typeof name !== 'string' || typeof text !== 'string') throw new Error('Not allowed');
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { title: 'Save a copy', defaultPath: path.join(app.getPath('documents'), path.basename(name)) });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
}));

// ---- Files on disk, edited in place -------------------------------------------
// The page may read and write only files the user picked in the open dialog
// (remembered across restarts), and is told when a watched one changes.

const allowedFiles = new Set(readJson('disk-files.json', []));
const allowFile = (file) => {
  allowedFiles.add(file);
  writeJson('disk-files.json', [...allowedFiles].slice(-500));
};
const checkFile = (file) => {
  if (typeof file !== 'string' || !allowedFiles.has(file)) throw new Error('That file was not opened here.');
  return file;
};
const watched = new Map(); // path → listener

ipcMain.handle('disk:open', guard(async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Open a file to edit in place', properties: ['openFile', 'multiSelections'] });
  if (canceled) return [];
  const out = [];
  for (const file of filePaths) {
    try {
      out.push(disk.readTextFile(file));
      allowFile(file);
    } catch (err) {
      out.push({ path: file, name: path.basename(file), error: err.message });
    }
  }
  return out;
}));

ipcMain.handle('disk:read', guard((_e, file) => disk.readTextFile(checkFile(file))));
ipcMain.handle('disk:read-appended', guard((_e, file, offset, opts) => disk.readAppended(checkFile(file), Number(offset) || 0, opts)));
ipcMain.handle('disk:write', guard((_e, file, text, opts) => {
  if (typeof text !== 'string') throw new Error('Nothing to save');
  return disk.writeTextFile(checkFile(file), text, opts ?? {});
}));
ipcMain.handle('disk:stat', guard((_e, file) => {
  try {
    const stat = fs.statSync(checkFile(file));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}));
ipcMain.handle('disk:watch', guard((event, file, on = true) => {
  checkFile(file);
  if (!on) {
    if (watched.has(file)) fs.unwatchFile(file, watched.get(file));
    watched.delete(file);
    return true;
  }
  if (watched.has(file)) return true;
  const sender = event.sender;
  // Polling works for network shares too, where change events do not arrive.
  const listener = (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (!sender.isDestroyed()) sender.send('disk:changed', { path: file, mtimeMs: curr.mtimeMs, size: curr.size, exists: curr.mtimeMs > 0 });
  };
  fs.watchFile(file, { interval: 1000 }, listener);
  watched.set(file, listener);
  return true;
}));
ipcMain.handle('disk:show', guard((_e, file) => shell.showItemInFolder(checkFile(file))));

// ---- Typing into another window ----------------------------------------------
// For remote desktops that block pasting: key presses into whichever window has
// the focus when the countdown ends (typer.cjs). One at a time.

let typing = null;

ipcMain.handle('type:start', guard(async (event, text, opts = {}) => {
  if (typeof text !== 'string' || !text) throw new Error('Nothing to type');
  if (typing) throw new Error('Already typing');
  const delay = Math.min(200, Math.max(1, Number(opts.delay) || 15));
  const wait = Math.min(30000, Math.max(1000, Number(opts.wait) || 5000));
  // This window's handle, so Windows never types into the editor itself.
  const handle = mainWindow?.getNativeWindowHandle();
  const self = process.platform === 'win32' && handle ? (handle.length >= 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString() : '0';
  const sender = event.sender;
  typing = startTyping(text, { delay, at: Date.now() + wait, self, unicode: Boolean(opts.unicode) }, {
    onProgress: (n) => !sender.isDestroyed() && sender.send('type:progress', n),
    isSelfFocused: () => Boolean(mainWindow?.isFocused()),
  });
  if (opts.minimize) mainWindow?.minimize();
  try {
    return await typing.done;
  } finally {
    typing = null;
  }
}));

ipcMain.on('type:stop', (event) => {
  if (fromApp(event)) typing?.cancel();
});

// ---- Model requests (Ollama, LM Studio, a model service, …) ------------------
// Made here rather than in the page so the server needs no CORS settings.
// The body streams back to the page in chunks.

const requests = new Map(); // id → AbortController

ipcMain.handle('llm:request', guard(async (event, id, url, init) => {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only http and https model servers are supported');
  const controller = new AbortController();
  requests.set(id, controller);
  let res;
  try {
    // Chromium's network stack: the system's certificates and proxy, as at work.
    res = await net.fetch(target.href, { method: init.method, headers: init.headers, body: init.body ?? undefined, signal: controller.signal, bypassCustomProtocolHandlers: true });
  } catch (err) {
    requests.delete(id);
    const refused = err?.cause?.code === 'ECONNREFUSED' || /ERR_CONNECTION_REFUSED/.test(err?.message ?? '');
    throw new Error(refused ? `Nothing is listening at ${target.origin}` : (err?.message ?? 'Request failed'));
  }
  const sender = event.sender;
  (async () => {
    try {
      if (res.body) for await (const chunk of res.body) if (!sender.isDestroyed()) sender.send('llm:chunk', id, chunk, false, null);
      if (!sender.isDestroyed()) sender.send('llm:chunk', id, null, true, null);
    } catch (err) {
      if (!sender.isDestroyed()) sender.send('llm:chunk', id, null, true, err?.name === 'AbortError' ? 'Stopped' : (err?.message ?? 'Stream failed'));
    } finally {
      requests.delete(id);
    }
  })();
  return { status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers) };
}));

ipcMain.on('llm:abort', (event, id) => {
  if (fromApp(event)) requests.get(id)?.abort();
});

// ---- Answers from a model service, by webhook --------------------------------
// For services that answer later (see asyncLlm.js): they POST each task's
// events here. With a webhook secret set, the body must carry its HMAC-SHA256
// (hex, in the profile's signature header); anything else is refused.

let hook = null; // { server, port, path, header, sender }

function onHook(req, res) {
  if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== hook.path) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const secret = getSecret('llm-webhook-secret');
    if (secret) {
      const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
      const got = String(req.headers[hook.header.toLowerCase()] ?? '').trim().replace(/^sha256=/i, '').toLowerCase();
      if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
        res.writeHead(401).end();
        return;
      }
    }
    // Answered at once: services wait only a few seconds.
    res.writeHead(204).end();
    let data;
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch {
      return;
    }
    if (hook && !hook.sender.isDestroyed()) hook.sender.send('webhook:event', data);
  });
}

ipcMain.handle('webhook:listen', guard(async (event, opts = {}) => {
  const port = Number(opts.port);
  const hookPath = String(opts.path || '/llm-webhook');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port between 1024 and 65535.');
  if (!hookPath.startsWith('/')) throw new Error('The webhook path must start with /.');
  const header = String(opts.signatureHeader || 'X-Signature');
  if (hook?.port === port) {
    Object.assign(hook, { path: hookPath, header, sender: event.sender });
    return { port };
  }
  hook?.server.close();
  hook = null;
  const server = http.createServer(onHook);
  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(new Error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use on this computer.` : err.message)));
    server.listen(port, '0.0.0.0', resolve);
  });
  hook = { server, port, path: hookPath, header, sender: event.sender };
  return { port };
}));

ipcMain.handle('webhook:close', guard(() => {
  hook?.server.close();
  hook = null;
  return true;
}));

// ---- Desktop preferences: tray, quick capture, clipboard history ------------
// Kept by the main process (prefs.json), which needs them before the page loads.

const DEFAULT_CAPTURE = 'CommandOrControl+Alt+N';
const DEFAULT_SNIP = 'CommandOrControl+Alt+O';
let prefs = null;
function loadPrefs() {
  const saved = readJson('prefs.json', {});
  prefs = {
    background: Boolean(saved.background),
    capture: { enabled: false, shortcut: DEFAULT_CAPTURE, ...saved.capture },
    snip: { enabled: false, shortcut: DEFAULT_SNIP, ...saved.snip },
    clipboard: { enabled: false, max: clips.DEFAULT_MAX, ...saved.clipboard },
    toldAboutTray: Boolean(saved.toldAboutTray),
  };
}
const prefsState = () => ({
  background: prefs.background,
  capture: { ...prefs.capture, status: shortcutStatus.capture },
  snip: { ...prefs.snip, status: shortcutStatus.snip },
  clipboard: { ...prefs.clipboard, encrypted: safeStorage.isEncryptionAvailable() },
  tray: Boolean(tray),
});

ipcMain.handle('prefs:get', guard(() => prefsState()));
ipcMain.handle('prefs:set', guard((_e, patch = {}) => {
  if ('background' in patch) prefs.background = Boolean(patch.background);
  for (const name of ['capture', 'snip']) {
    if (!patch[name]) continue;
    const { enabled, shortcut } = patch[name];
    if (enabled !== undefined) prefs[name].enabled = Boolean(enabled);
    if (typeof shortcut === 'string' && shortcut.trim()) prefs[name].shortcut = shortcut.trim().slice(0, 60);
  }
  if (patch.clipboard) {
    const { enabled, max } = patch.clipboard;
    if (enabled !== undefined) {
      prefs.clipboard.enabled = Boolean(enabled);
      // Turning it off forgets the history.
      if (!prefs.clipboard.enabled) setClips([]);
    }
    if (max !== undefined) prefs.clipboard.max = Math.min(500, Math.max(5, Math.round(Number(max)) || clips.DEFAULT_MAX));
  }
  writeJson('prefs.json', prefs);
  applyPrefs();
  return prefsState();
}));

function applyPrefs() {
  registerShortcuts();
  watchClipboard();
  updateTray();
}

// ---- Background mode (system tray) --------------------------------------------

let tray = null;
function updateTray() {
  if (!prefs.background) {
    tray?.destroy();
    tray = null;
    return;
  }
  try {
    if (!tray) {
      tray = new Tray(nativeImage.createFromPath(path.join(APP_DIR, 'icons', 'icon-192.png')).resize({ width: 18, height: 18 }));
      tray.setToolTip('Tracker Editor');
      tray.on('click', showWindow);
    }
  } catch (err) {
    console.warn('System tray is not available', err);
    tray = null;
    return;
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Tracker Editor', click: showWindow },
      { label: 'Quick Capture', accelerator: prefs.capture.enabled ? prefs.capture.shortcut : undefined, registerAccelerator: false, click: openCapture },
      { label: 'Text from a Screenshot', accelerator: prefs.snip.enabled ? prefs.snip.shortcut : undefined, registerAccelerator: false, click: snipFromShortcut },
      { label: 'Clipboard History', enabled: prefs.clipboard.enabled, click: () => send('clipboard-history') },
      { type: 'separator' },
      { label: 'Quit Tracker Editor', click: () => app.quit() },
    ]),
  );
}

// ---- Quick capture: a small window from a global shortcut ----------------------
// What is written there goes to the main window (a new note, or the Inbox note),
// through captures.json so nothing is lost if that window is not up yet.

let captureWindow = null;
let captureDraft = '';
const pendingCaptures = [];

// Global shortcuts: quick capture and text from a screenshot. Status per
// shortcut: 'ok' | 'taken' (another app has it) | 'invalid' | 'off'.
const shortcutStatus = { capture: 'off', snip: 'off' };
const registered = {};
function registerShortcuts() {
  const actions = { capture: openCapture, snip: snipFromShortcut };
  for (const name of Object.keys(actions)) {
    if (registered[name]) globalShortcut.unregister(registered[name]);
    registered[name] = null;
    shortcutStatus[name] = 'off';
  }
  for (const [name, run] of Object.entries(actions)) {
    const { enabled, shortcut } = prefs[name];
    if (!enabled) continue;
    try {
      if (Object.values(registered).includes(shortcut)) shortcutStatus[name] = 'taken';
      else if (globalShortcut.register(shortcut, run)) {
        registered[name] = shortcut;
        shortcutStatus[name] = 'ok';
      } else shortcutStatus[name] = 'taken';
    } catch {
      shortcutStatus[name] = 'invalid';
    }
  }
}

function openCapture() {
  if (captureWindow) {
    captureWindow.show();
    captureWindow.focus();
    return;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(560, area.width - 40);
  const height = 300;
  captureWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height * 0.2),
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: 'Quick capture',
    backgroundColor: '#f6f5f1',
    webPreferences: {
      preload: path.join(__dirname, 'capturePreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  captureWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  captureWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  captureWindow.once('ready-to-show', () => {
    captureWindow.show();
    captureWindow.focus();
  });
  captureWindow.on('closed', () => {
    captureWindow = null;
  });
  captureWindow.loadURL(`${APP_ORIGIN}/capture.html`);
}

const fromCapture = (event) => captureWindow && event.sender === captureWindow.webContents;
ipcMain.handle('capture:open', guard(() => openCapture()));
ipcMain.handle('capture:draft', guard(() => captureDraft));
ipcMain.handle('capture:keep-draft', guard((_e, text) => {
  captureDraft = String(text ?? '').slice(0, clips.MAX_TEXT);
  return true;
}));
ipcMain.handle('capture:close', guard((event) => fromCapture(event) && captureWindow.close()));
ipcMain.handle('capture:submit', guard((event, entry) => {
  const text = String(entry?.text ?? '');
  if (!fromCapture(event) || !text.trim()) return false;
  pendingCaptures.push({ text: text.slice(0, 1_000_000), mode: entry.mode === 'inbox' ? 'inbox' : 'new', at: Date.now() });
  writeJson('captures.json', pendingCaptures);
  captureDraft = '';
  captureWindow.close();
  // A window that is still loading takes them when it starts.
  if (!mainWindow) createWindow();
  else if (!mainWindow.webContents.isLoading()) mainWindow.webContents.send('command', 'captures');
  return true;
}));
// The main window takes what was captured.
ipcMain.handle('capture:take', guard((event) => {
  if (event.sender !== mainWindow?.webContents) return [];
  const taken = pendingCaptures.splice(0);
  writeJson('captures.json', []);
  return taken;
}));

// ---- Text from a screenshot: drag around a part of the screen -----------------
// The screen under the pointer is captured (this app's window hidden first) and
// shown full screen in snip.html, where you drag around the text. The page
// gets that part as a PNG and reads the text from it (tesseract, in the page).

let snipWindow = null;
let snipShot = null; // { image: NativeImage, display }
let snipResolve = null;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openSnipWindow(display) {
  snipWindow = new BrowserWindow({
    ...display.bounds,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: 'Text from a screenshot',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'snipPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  snipWindow.setAlwaysOnTop(true, 'screen-saver');
  snipWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  snipWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  snipWindow.once('ready-to-show', () => {
    snipWindow.show();
    snipWindow.focus();
  });
  snipWindow.on('closed', () => {
    snipWindow = null;
    snipResolve?.(null);
    snipResolve = null;
  });
  snipWindow.loadURL(`${APP_ORIGIN}/snip.html`);
}

/** Lets you pick a part of the screen: its PNG, or null when cancelled. */
async function snip() {
  if (snipWindow) return null;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const hidden = mainWindow?.isVisible() && !mainWindow.isMinimized();
  if (hidden) {
    mainWindow.hide();
    await wait(350);
  }
  try {
    const thumbnailSize = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error(process.platform === 'darwin' ? 'The screen could not be captured. Allow Tracker Editor to record the screen in System Settings, Privacy & Security, then try again.' : 'The screen could not be captured.');
    }
    snipShot = { image: source.thumbnail, display };
    const rect = await new Promise((resolve) => {
      snipResolve = resolve;
      openSnipWindow(display);
    });
    if (!rect) return null;
    const scale = snipShot.image.getSize().width / display.bounds.width;
    const px = (n) => Math.max(0, Math.round(n * scale));
    return snipShot.image.crop({ x: px(rect.x), y: px(rect.y), width: Math.max(1, px(rect.width)), height: Math.max(1, px(rect.height)) }).toPNG();
  } finally {
    snipShot = null;
    if (hidden) showWindow();
  }
}

// From the tray or the global shortcut: the page asks for the snip, so the result shows there.
function snipFromShortcut() {
  if (!mainWindow) return createWindow();
  mainWindow.webContents.send('command', 'screenshot-ocr');
}

const fromSnip = (event) => snipWindow && event.sender === snipWindow.webContents;
ipcMain.handle('snip:image', guard((event) => (fromSnip(event) && snipShot ? `data:image/jpeg;base64,${snipShot.image.toJPEG(85).toString('base64')}` : null)));
ipcMain.handle('snip:done', guard((event, rect) => {
  if (!fromSnip(event)) return false;
  const ok = rect && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(rect[k])) && rect.width >= 4 && rect.height >= 4;
  snipResolve?.(ok ? rect : null);
  snipResolve = null;
  snipWindow.close();
  return true;
}));
ipcMain.handle('ocr:snip', guard(async (event) => {
  if (event.sender !== mainWindow?.webContents) return null;
  const png = await snip();
  if (png) showWindow();
  return png;
}));

// ---- Clipboard history (opt-in) -----------------------------------------------
// Texts copied anywhere, polled once a second. Kept on this computer only,
// encrypted with the system keychain (in memory only when there is none).
// Copies that password managers mark as concealed are skipped.

let clipList = [];
let clipTimer = null; // { timer } of the running watch
let clipSaveTimer = null;
let lastClip = null;
const CLIP_FILE = 'clipboard-history.bin';

function loadClips() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return [];
    return JSON.parse(safeStorage.decryptString(fs.readFileSync(dataFile(CLIP_FILE))));
  } catch {
    return [];
  }
}

function saveClips() {
  clearTimeout(clipSaveTimer);
  clipSaveTimer = null;
  try {
    if (!clipList.length) return fs.rmSync(dataFile(CLIP_FILE), { force: true });
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(dataFile(CLIP_FILE), safeStorage.encryptString(JSON.stringify(clipList)));
  } catch (err) {
    console.error('Could not save the clipboard history', err);
  }
}

function setClips(list) {
  if (list === clipList) return;
  clipList = list;
  if (!clipSaveTimer) clipSaveTimer = setTimeout(saveClips, 1000);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('clip:changed');
}

async function concealedNow() {
  try {
    const items = await clipboard.read();
    if (clips.isConcealed(items.flatMap((i) => i.types))) return true;
    // Windows: CanIncludeInClipboardHistory set to 0 means "keep out of histories".
    const allowed = items.flatMap((i) => i.types.filter((t) => clips.formatName(t) === 'CanIncludeInClipboardHistory').map((t) => i.getType(t)));
    for (const blob of await Promise.all(allowed)) {
      const bytes = Buffer.from(await blob.arrayBuffer());
      if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0) return true;
    }
  } catch {
    // formats that cannot be read: not concealed
  }
  return false;
}

async function checkClipboard() {
  let text;
  try {
    text = await clipboard.readText();
  } catch {
    return;
  }
  if (text === lastClip || !prefs.clipboard.enabled) return;
  lastClip = text;
  if (!(await concealedNow())) setClips(clips.addClip(clipList, text, { max: prefs.clipboard.max }));
}

function watchClipboard() {
  clearTimeout(clipTimer?.timer);
  clipTimer = null;
  if (!prefs.clipboard.enabled) return;
  const watching = {};
  clipTimer = watching;
  const step = async () => {
    await checkClipboard();
    if (clipTimer === watching) watching.timer = setTimeout(step, 1000);
  };
  // What is on the clipboard already is not a new copy.
  clipboard.readText().then(
    (text) => {
      lastClip = text;
      if (clipTimer === watching) watching.timer = setTimeout(step, 1000);
    },
    () => {},
  );
}

ipcMain.handle('clip:list', guard(() => (prefs.clipboard.enabled ? clipList : [])));
ipcMain.handle('clip:copy', guard(async (_e, id) => {
  const entry = clipList.find((c) => c.id === id);
  if (!entry) return false;
  lastClip = entry.text;
  await clipboard.writeText(entry.text);
  setClips(clips.addClip(clipList, entry.text, { max: prefs.clipboard.max }));
  return true;
}));
ipcMain.handle('clip:remove', guard((_e, id) => setClips(clips.removeClip(clipList, id))));
ipcMain.handle('clip:pin', guard((_e, id, on) => setClips(clips.pinClip(clipList, id, on))));
ipcMain.handle('clip:clear', guard(() => setClips(clips.clearClips(clipList))));

// ---- Closing: let the app save and sync first --------------------------------

ipcMain.on('app:close-ready', (event) => {
  if (!fromApp(event) || !mainWindow) return;
  closing = true;
  mainWindow.close();
  if (quitting) app.quit();
});

// ---- Window -------------------------------------------------------------

function isSafeExternal(url) {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function routeFromLink(link) {
  try {
    const url = new URL(link);
    if (url.protocol !== `${LINK_SCHEME}:`) return null;
    const rest = `${url.host}${url.pathname}`.replace(/^\/+/, '');
    return rest.startsWith('file/') || rest.startsWith('repo/') ? `#/${rest}` : null;
  } catch {
    return null;
  }
}

function openLink(link) {
  const route = routeFromLink(link);
  if (!route) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) send(`route:${route}`);
  else pendingRoute = route;
}

function restoreBounds() {
  const saved = readJson('window-state.json', null);
  const defaults = { width: 1360, height: 880 };
  if (!saved?.bounds) return defaults;
  const area = screen.getDisplayMatching(saved.bounds).workArea;
  const visible =
    saved.bounds.x < area.x + area.width - 80 &&
    saved.bounds.y < area.y + area.height - 80 &&
    saved.bounds.x + saved.bounds.width > area.x + 80 &&
    saved.bounds.y >= area.y - 20;
  return visible ? { ...saved.bounds, maximized: saved.maximized } : defaults;
}

function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function send(command) {
  if (!mainWindow) return;
  showWindow();
  mainWindow.webContents.send('command', command);
}

function createWindow() {
  const { maximized, ...bounds } = restoreBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: 'Tracker Editor',
    icon: path.join(APP_DIR, 'icons', 'icon-512.png'),
    backgroundColor: '#f6f5f1',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingRoute) {
      mainWindow.webContents.send('command', `route:${pendingRoute}`);
      pendingRoute = null;
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${APP_ORIGIN}/`)) return;
    event.preventDefault();
    if (isSafeExternal(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (event) => {
    writeJson('window-state.json', { bounds: mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() });
    if (closing) return;
    // In the tray: hide, so quick capture and the clipboard history keep working.
    if (!quitting && prefs.background && tray) {
      event.preventDefault();
      mainWindow.hide();
      if (!prefs.toldAboutTray && Notification.isSupported()) {
        new Notification({ title: 'Tracker Editor is still running', body: 'Quick capture and the clipboard history keep working. Quit it from the tray icon.' }).show();
        prefs.toldAboutTray = true;
        writeJson('prefs.json', prefs);
      }
      return;
    }
    // Let the app write what was just typed and sync; it answers with close-ready.
    event.preventDefault();
    mainWindow.webContents.send('command', 'flush');
    setTimeout(() => {
      if (!closing && mainWindow) {
        closing = true;
        mainWindow.close();
      }
    }, 6000);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // Shortcuts the editor itself handles are shown but left to it (registerAccelerator: false).
  const shown = (label, accelerator, command) => ({ label, accelerator, registerAccelerator: false, click: () => send(command) });
  const item = (label, accelerator, command) => ({ label, accelerator, click: () => send(command) });
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        item('New File', 'CmdOrCtrl+N', 'new'),
        item('Open a File…', 'CmdOrCtrl+P', 'quick-open'),
        item('Open File (Edit in Place)…', 'CmdOrCtrl+O', 'disk-open'),
        item('Import Files…', undefined, 'open-disk'),
        item('Save a Copy to Disk…', 'CmdOrCtrl+Shift+S', 'save-copy'),
        item('Trash…', undefined, 'trash'),
        { type: 'separator' },
        item('Close Tab', 'CmdOrCtrl+W', 'close-tab'),
        item('Reopen Closed Tab', 'CmdOrCtrl+Shift+T', 'reopen-tab'),
        { type: 'separator' },
        item('Sync Now', 'CmdOrCtrl+S', 'sync'),
        item('Settings', 'CmdOrCtrl+,', 'settings'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        shown('Find', 'CmdOrCtrl+F', 'find'),
        shown('Replace', 'CmdOrCtrl+H', 'replace'),
        shown('Go to Line', 'CmdOrCtrl+G', 'goto-line'),
        item('Find in Files', 'CmdOrCtrl+Shift+F', 'find-in-files'),
        shown('Filter Lines', 'Alt+L', 'filter-lines'),
        { type: 'separator' },
        shown('Start or Stop Recording a Macro', 'CmdOrCtrl+Shift+R', 'macro-record'),
        shown('Play the Macro', 'CmdOrCtrl+Shift+P', 'macro-play'),
        item('Run the Macro…', undefined, 'macro-run'),
        { type: 'separator' },
        shown('Type into Another Window', 'Alt+T', 'type-out'),
        shown('Insert Snippet…', 'Alt+I', 'snippets'),
        shown('Ask the Model About the Selection…', 'CmdOrCtrl+K', 'ask-selection'),
        { type: 'separator' },
        shown('Clipboard History…', 'CmdOrCtrl+Shift+V', 'clipboard-history'),
        { label: 'Quick Capture', click: () => openCapture() },
        item('Text from a Screenshot…', undefined, 'screenshot-ocr'),
        item('Text from an Image…', undefined, 'image-ocr'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Files', 'CmdOrCtrl+B', 'toggle-sidebar'),
        item('Word Wrap', 'Alt+Z', 'toggle-wrap'),
        item('Read Aloud', 'Alt+R', 'read-aloud'),
        shown('Split View', 'CmdOrCtrl+\\', 'split'),
        item('Local Model', 'CmdOrCtrl+Shift+A', 'assistant'),
        shown('Outline and Links', 'CmdOrCtrl+Shift+O', 'outline'),
        { type: 'separator' },
        item('Next Tab', 'Ctrl+Tab', 'next-tab'),
        item('Previous Tab', 'Ctrl+Shift+Tab', 'prev-tab'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Project on GitHub', click: () => shell.openExternal(REPO_URL) }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', (_event, argv) => {
  showWindow();
  const link = argv.find((a) => a.startsWith(`${LINK_SCHEME}://`));
  if (link) openLink(link);
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  openLink(url);
});

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const filePath = path.normalize(path.join(APP_DIR, relative));
    if (!filePath.startsWith(APP_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
  buildMenu();
  loadPrefs();
  clipList = prefs.clipboard.enabled ? loadClips() : [];
  pendingCaptures.push(...readJson('captures.json', []));
  applyPrefs();
  const link = process.argv.find((a) => a.startsWith(`${LINK_SCHEME}://`));
  if (link) pendingRoute = routeFromLink(link);
  createWindow();
  app.on('activate', showWindow);
});

app.on('before-quit', () => {
  quitting = true;
  captureWindow?.destroy();
  snipWindow?.destroy();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (clipSaveTimer) saveClips();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
