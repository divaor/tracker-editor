// Electron main process: serves the web app from app:// (a secure, standard
// origin so IndexedDB and ES modules work), keeps the GitHub token encrypted
// with the OS keychain, opens and saves files on disk, forwards requests to a
// local model server (no CORS setup needed), opens tracker-editor:// links
// from the tracker, and lets the app save and sync before the window closes.
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, safeStorage, screen, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startTyping } = require('./typer.cjs');

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

// ---- Closing: let the app save and sync first --------------------------------

ipcMain.on('app:close-ready', (event) => {
  if (!fromApp(event) || !mainWindow) return;
  closing = true;
  mainWindow.close();
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
        item('Add Files from Disk…', 'CmdOrCtrl+O', 'open-disk'),
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
        { type: 'separator' },
        shown('Type into Another Window', 'Alt+T', 'type-out'),
        shown('Insert Snippet…', 'Alt+I', 'snippets'),
        shown('Ask the Model About the Selection…', 'CmdOrCtrl+K', 'ask-selection'),
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
  const link = process.argv.find((a) => a.startsWith(`${LINK_SCHEME}://`));
  if (link) pendingRoute = routeFromLink(link);
  createWindow();
  app.on('activate', showWindow);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
