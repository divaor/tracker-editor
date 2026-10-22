// Electron main process: serves the web app from app:// (a secure, standard
// origin so IndexedDB and ES modules work), keeps the GitHub token encrypted
// with the OS keychain, opens and saves files on disk, forwards requests to a
// local model server (no CORS setup needed), opens tracker-editor:// links
// from the tracker, and lets the app save and sync before the window closes.
const { app, BrowserWindow, ClipboardItem, Menu, Notification, Tray, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, net, protocol, safeStorage, screen, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startTyping } = require('./typer.cjs');
const disk = require('./diskFiles.cjs');
const folders = require('./folders.cjs');
const os = require('node:os');
const clips = require('./clipHistory.cjs');
const zipFiles = require('./zip.cjs');

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
// The page may read and write only files the user picked in the open dialog,
// or files inside a folder picked there (both remembered across restarts),
// and is told when a watched one changes.

const allowedFiles = new Set(readJson('disk-files.json', []));
const allowFile = (file) => {
  allowedFiles.add(file);
  writeJson('disk-files.json', [...allowedFiles].slice(-500));
};
const allowedFolders = readJson('disk-folders.json', []).filter((f) => typeof f === 'string');
const saveFolders = () => writeJson('disk-folders.json', allowedFolders);
const checkFile = (file) => {
  if (typeof file !== 'string' || !(allowedFiles.has(file) || folders.allowedBy(allowedFolders, file))) throw new Error('That file was not opened here.');
  return file;
};
const watched = new Map(); // path → listener

// ---- Files on servers (SFTP, FTP, FTPS) -----------------------------------------
// remote.cjs; files there are remote://<id>/<path>, and the disk:* and folder:*
// handlers below send those to it. Passwords stay here (secrets.json, through the
// keychain); an unknown or changed SSH host key is asked about in the window.

const remoteFiles = require('./remote.cjs');
const isRemote = remoteFiles.isRemote;
const hostKeyQuestions = new Map(); // question id → answer(ok)
const promptQuestions = new Map(); // question id → answer({ answers, remember } | null)
// Asks the window and waits (at most `ms`) for the answer; no window, no answer.
function askWindow(channel, questions, info, ms, fallback, noWindow = fallback) {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(noWindow);
    const question = crypto.randomBytes(6).toString('hex');
    const timer = setTimeout(() => {
      answer(fallback);
      // Not answered in time: the window's question goes away too.
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(`${channel}-gone`, { question });
    }, ms);
    const answer = (value) => {
      clearTimeout(timer);
      questions.delete(question);
      resolve(value);
    };
    questions.set(question, answer);
    showWindow();
    mainWindow.webContents.send(channel, { ...info, question });
  });
}
const remote = remoteFiles.createRemote({
  store: { read: () => readJson('remote.json', {}), write: (data) => writeJson('remote.json', data) },
  secrets: { get: (id, kind) => getSecret(`remote:${id}:${kind}`), set: (id, kind, value) => setSecret(`remote:${id}:${kind}`, value) },
  askHostKey: (info) => askWindow('remote:host-key', hostKeyQuestions, info, 180000, false).then(Boolean),
  // A password that is not saved, a key passphrase, or the server's own questions (a one-time code).
  // No window: undefined (no one to ask, the server's answer stands); no answer in time: null (cancelled).
  askPrompt: (info) => askWindow('remote:prompt', promptQuestions, info, 180000, null, undefined),
  onStatus: (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('remote:status', status);
    mirrorsOnStatus(status);
  },
});

ipcMain.handle('remote:connections', guard(() => remote.connections()));
ipcMain.handle('remote:save', guard((_e, conn, secrets) => remote.saveConnection(conn ?? {}, secrets ?? {})));
ipcMain.handle('remote:delete', guard((_e, id) => remote.deleteConnection(id)));
ipcMain.handle('remote:test', guard((_e, conn, secrets) => remote.test(conn ?? {}, secrets ?? {})));
ipcMain.handle('remote:connect', guard((_e, id) => remote.connect(id)));
ipcMain.handle('remote:disconnect', guard((_e, id) => remote.disconnect(id)));
ipcMain.handle('remote:forget-host-key', guard((_e, id) => remote.forgetHostKey(id)));
ipcMain.handle('remote:host-key-answer', guard((_e, question, ok) => {
  hostKeyQuestions.get(question)?.(Boolean(ok));
  return true;
}));
ipcMain.handle('remote:prompt-answer', guard((_e, question, answer) => {
  const ok = answer && Array.isArray(answer.answers) && answer.answers.every((a) => typeof a === 'string');
  promptQuestions.get(question)?.(ok ? { answers: answer.answers.slice(0, 20), remember: Boolean(answer.remember) } : null);
  return true;
}));
// Servers from the SSH config (~/.ssh/config): the page sees the hosts and picks
// which to set up by name; the key files they name are found here, not by the page.
const sshConfig = require('./sshConfig.cjs');
function readSshConfig() {
  const home = os.homedir();
  const file = path.join(home, '.ssh', 'config');
  if (!fs.existsSync(file)) return { file, hosts: [], missing: true };
  const readInclude = (pattern) => {
    const full = pattern.startsWith('~') ? path.join(home, pattern.slice(1)) : path.isAbsolute(pattern) ? pattern : path.join(home, '.ssh', pattern);
    const dir = path.dirname(full);
    const name = path.basename(full);
    let names = [name];
    try {
      if (/[*?]/.test(name)) names = fs.readdirSync(dir).filter((n) => sshConfig.globToRegExp(name).test(n)).sort();
    } catch {
      return [];
    }
    return names.slice(0, 50).flatMap((n) => {
      try {
        const st = fs.statSync(path.join(dir, n));
        return st.isFile() && st.size < 1024 * 1024 ? [fs.readFileSync(path.join(dir, n), 'utf8')] : [];
      } catch {
        return [];
      }
    });
  };
  const hosts = sshConfig.parseSshConfig(fs.readFileSync(file, 'utf8'), { readInclude, home, localUser: os.userInfo().username });
  return { file, hosts };
}
ipcMain.handle('remote:ssh-config', guard(() => {
  const { file, hosts, missing } = readSshConfig();
  const known = remote.connections();
  return {
    file,
    missing: Boolean(missing),
    hosts: hosts.map((h) => ({
      alias: h.alias,
      host: h.host,
      port: h.port,
      user: h.user,
      key: h.identityFiles.find((f) => fs.existsSync(f)) ? path.basename(h.identityFiles.find((f) => fs.existsSync(f))) : '',
      proxyJump: h.proxyJump,
      proxyCommand: h.proxyCommand,
      known: known.some((c) => c.protocol === 'sftp' && c.host.toLowerCase() === h.host.toLowerCase() && c.port === h.port && c.user === h.user),
    })),
  };
}));
ipcMain.handle('remote:import-ssh', guard((_e, aliases) => {
  if (!Array.isArray(aliases) || !aliases.length) throw new Error('Pick the hosts to set up.');
  const { hosts } = readSshConfig();
  return remote.importSsh(hosts, aliases.filter((a) => typeof a === 'string').slice(0, 200));
}));
// A private key file for SSH, picked in the dialog (only picked files can be used).
ipcMain.handle('remote:pick-key', guard(async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { title: 'Choose your private key', defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile', 'showHiddenFiles'] });
  if (canceled || !filePaths[0]) return null;
  remote.allowKey(filePaths[0]);
  return filePaths[0];
}));

// ---- Mirrors: a folder on a server kept the same as one on this computer --------
// mirror.cjs plans and runs a sync; here are the settings (mirrors.json), each
// mirror's state (mirrors/<id>.json), and the automatic syncs: while its server is
// connected, every minute and a few seconds after a change here. The folder here
// is picked in the dialog (and so shown in Folders); deletions on the server wait
// for the person (mirror:sync with confirmDeletes).
const mirrorLib = require('./mirror.cjs');
let mirrors = readJson('mirrors.json', []).filter((m) => m && typeof m.id === 'string');
const saveMirrors = () => writeJson('mirrors.json', mirrors);
const mirrorLive = new Map(); // id → { state, progress, error, last, waiting, running }
const mirrorStatePath = (id) => path.join(app.getPath('userData'), 'mirrors', `${id}.json`);
const publicMirror = (m) => {
  const l = mirrorLive.get(m.id) ?? {};
  return { ...m, state: l.state ?? 'idle', progress: l.progress ?? null, error: l.error ?? '', waiting: l.waiting ?? [], conflicts: l.conflicts ?? [] };
};
const sendMirror = (m) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('mirror:status', publicMirror(m));
const setMirror = (m, patch) => {
  mirrorLive.set(m.id, { ...mirrorLive.get(m.id), ...patch });
  sendMirror(m);
};

const mirrorIo = (m) =>
  mirrorLib.createMirrorIo(m, { remote, toUri: remoteFiles.toUri, statePath: mirrorStatePath(m.id), trash: (p) => shell.trashItem(p), connected: () => remote.isConnected(m.conn) });

/** One sync of a mirror at a time; `auto` ones do not connect, and say nothing when there was nothing to do. */
async function syncMirror(id, { confirmDeletes = false, restore = [], auto = false } = {}) {
  const m = mirrors.find((x) => x.id === id);
  if (!m) throw new Error('That mirror is not set up here any more.');
  const asked = (Array.isArray(confirmDeletes) ? confirmDeletes.length : confirmDeletes) || restore.length;
  const live = mirrorLive.get(id);
  if (live?.running) {
    // A sync is running: an answer about deletions waits for it, then runs its own.
    if (!asked) return live.running;
    await live.running.catch(() => {});
    return syncMirror(id, { confirmDeletes, restore, auto });
  }
  if (auto && !remote.isConnected(m.conn)) return null;
  const running = (async () => {
    setMirror(m, { state: 'syncing', progress: { done: 0, total: 0, current: '' }, error: '' });
    try {
      const summary = await mirrorLib.runMirror(m, mirrorIo(m), { confirmDeletes, restore: Array.isArray(restore) ? restore : [], onProgress: (progress) => setMirror(m, { progress }) });
      m.last = { at: Date.now(), uploaded: summary.uploaded, downloaded: summary.downloaded, deletedLocal: summary.deletedLocal, deletedRemote: summary.deletedRemote, conflicts: summary.conflicts.length, errors: summary.errors.length };
      saveMirrors();
      setMirror(m, { state: summary.waiting.length ? 'waiting' : summary.errors.length ? 'error' : 'idle', progress: null, waiting: summary.waiting, conflicts: summary.conflicts, error: summary.errors.join('\n') });
      return summary;
    } catch (err) {
      const message = remoteFiles.friendlyError(err).message;
      setMirror(m, { state: 'error', progress: null, error: message });
      throw new Error(message);
    } finally {
      mirrorLive.set(id, { ...mirrorLive.get(id), running: null });
      const watch = mirrorWatchers.get(id);
      if (watch?.again) {
        watch.again = false;
        watch.soon();
      }
    }
  })();
  mirrorLive.set(id, { ...mirrorLive.get(id), running });
  return running;
}

// Automatic syncs: every minute while connected, and soon after a change here.
const mirrorWatchers = new Map(); // id → { watcher, timer }
function unwatchMirror(id) {
  const w = mirrorWatchers.get(id);
  w?.watcher?.close();
  clearTimeout(w?.timer);
  mirrorWatchers.delete(id);
}
function watchMirrors() {
  for (const [id, w] of mirrorWatchers) {
    if (!mirrors.some((m) => m.id === id && m.auto)) {
      w.watcher?.close();
      clearTimeout(w.timer);
      mirrorWatchers.delete(id);
    }
  }
  for (const m of mirrors.filter((x) => x.auto && !mirrorWatchers.has(x.id))) {
    const entry = { watcher: null, timer: null, again: false, soon: null };
    const soon = () => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => syncMirror(m.id, { auto: true }).catch(() => {}), 3000);
    };
    entry.soon = soon;
    try {
      entry.watcher = fs.watch(m.local, { recursive: true, persistent: false }, (_type, name) => {
        // Its own downloads (the .part files) are not changes to send.
        if (name && /\.part-[0-9a-f]{6}$/.test(String(name))) return;
        // During a sync: once more after it (a change may have come after its listing).
        if (mirrorLive.get(m.id)?.running) entry.again = true;
        else soon();
      });
      entry.watcher.on('error', () => entry.watcher?.close());
    } catch {
      // a folder that cannot be watched: the minute timer still syncs it
    }
    mirrorWatchers.set(m.id, entry);
  }
}
setInterval(() => {
  for (const m of mirrors.filter((x) => x.auto)) syncMirror(m.id, { auto: true }).catch(() => {});
}, 60000).unref?.();
// A server that connects: its automatic mirrors sync.
function mirrorsOnStatus({ id, state }) {
  if (state !== 'connected') return;
  for (const m of mirrors.filter((x) => x.auto && x.conn === id)) syncMirror(m.id, { auto: true }).catch(() => {});
}

ipcMain.handle('mirror:list', guard(() => mirrors.map(publicMirror)));
// The folder here: picked in the dialog (it becomes one of the folders in Folders).
ipcMain.handle('mirror:pick-local', guard(async (_e, suggested) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'The folder on this computer to keep the same',
    defaultPath: path.join(app.getPath('documents'), typeof suggested === 'string' ? folders.exportName(suggested).replace(/\.txt$/, '') : ''),
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  });
  if (canceled || !filePaths[0]) return null;
  const picked = filePaths[0];
  fs.mkdirSync(picked, { recursive: true });
  if (!allowedFolders.includes(picked)) {
    allowedFolders.push(picked);
    saveFolders();
  }
  return picked;
}));
const mirrorBusy = (id) => {
  if (mirrorLive.get(id)?.running) throw new Error('That mirror is syncing. Try again when it is done.');
};
ipcMain.handle('mirror:save', guard((_e, input = {}) => {
  if (input.id) mirrorBusy(input.id);
  const existing = mirrors.find((m) => m.id === input.id);
  const conn = remote.connections().find((c) => c.id === input.conn);
  if (!conn) throw new Error('Choose the server.');
  const remotePath = path.posix.normalize(String(input.remote ?? '').trim() || '/');
  if (!remotePath.startsWith('/')) throw new Error('The folder on the server starts with /.');
  const local = String(input.local ?? '');
  if (!local || !folders.allowedBy(allowedFolders, local) || !fs.existsSync(local)) throw new Error('Choose the folder on this computer with “Choose…”.');
  const inside = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  const insideRemote = (a, b) => a === b || a.startsWith(b === '/' ? '/' : `${b}/`);
  for (const other of mirrors.filter((m) => m.id !== input.id)) {
    if (inside(path.resolve(local), path.resolve(other.local)) || inside(path.resolve(other.local), path.resolve(local))) throw new Error(`${other.local} is mirrored already; a mirror cannot be inside another.`);
    if (other.conn === conn.id && (insideRemote(remotePath, other.remote) || insideRemote(other.remote, remotePath))) throw new Error(`${other.remote} on ${conn.name} is mirrored already; a mirror cannot be inside another.`);
  }
  const mirror = {
    id: existing?.id ?? crypto.randomBytes(5).toString('hex'),
    conn: conn.id,
    remote: remotePath,
    local,
    mode: mirrorLib.MODES.includes(input.mode) ? input.mode : 'both',
    auto: Boolean(input.auto),
    exclude: String(input.exclude ?? mirrorLib.DEFAULT_EXCLUDE).slice(0, 1000),
    last: existing && existing.local === local && existing.remote === remotePath && existing.conn === conn.id ? existing.last : null,
  };
  // Another pair of folders: the old state does not apply.
  if (existing && !mirror.last) fs.rmSync(mirrorStatePath(mirror.id), { force: true });
  mirrors = existing ? mirrors.map((m) => (m.id === mirror.id ? mirror : m)) : [...mirrors, mirror];
  saveMirrors();
  // Its folder here may have changed: watched again.
  unwatchMirror(mirror.id);
  watchMirrors();
  return publicMirror(mirror);
}));
ipcMain.handle('mirror:delete', guard((_e, id) => {
  mirrorBusy(id);
  mirrors = mirrors.filter((m) => m.id !== id);
  saveMirrors();
  fs.rmSync(mirrorStatePath(id), { force: true });
  mirrorLive.delete(id);
  watchMirrors();
  return true;
}));
// `confirmDeletes`: the files deleted here the person agreed to delete on the server too.
ipcMain.handle('mirror:sync', guard((_e, id, opts = {}) =>
  syncMirror(id, {
    confirmDeletes: Array.isArray(opts.confirmDeletes) ? opts.confirmDeletes.filter((r) => typeof r === 'string') : false,
    restore: Array.isArray(opts.restore) ? opts.restore.filter((r) => typeof r === 'string') : [],
  }),
));
app.whenReady().then(watchMirrors);

// ---- Terminals on servers (SSH) ------------------------------------------------
// A shell on the server, over the same connection as its files. The output goes to
// the page in small batches (term:data); keys come back with term:input.
const { StringDecoder } = require('node:string_decoder');
const terminals = new Map(); // id → { stream }
const clampInt = (n, min, max, fallback) => (Number.isFinite(Number(n)) ? Math.min(max, Math.max(min, Math.round(Number(n)))) : fallback);
ipcMain.handle('term:open', guard(async (event, connId, opts = {}) => {
  const cols = clampInt(opts.cols, 20, 500, 100);
  const rows = clampInt(opts.rows, 5, 200, 24);
  const stream = await remote.openShell(String(connId), { cols, rows, cwd: typeof opts.cwd === 'string' ? opts.cwd : '' });
  const id = crypto.randomBytes(6).toString('hex');
  const sender = event.sender;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let timer = null;
  let code = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (pending && !sender.isDestroyed()) sender.send('term:data', { id, data: pending });
    pending = '';
  };
  const push = (chunk) => {
    pending += decoder.write(chunk);
    if (pending.length > 65536) flush();
    else timer ??= setTimeout(flush, 8);
  };
  stream.on('data', push);
  stream.stderr?.on('data', push);
  stream.on('exit', (exitCode) => (code = exitCode));
  stream.on('close', () => {
    pending += decoder.end();
    flush();
    terminals.delete(id);
    if (!sender.isDestroyed()) sender.send('term:exit', { id, code });
  });
  terminals.set(id, { stream, sender });
  watchTerminalPage(sender);
  return { id };
}));
// A page reloaded or closed: its shells end (once per page, not once per shell).
const terminalPages = new WeakSet();
function watchTerminalPage(sender) {
  if (terminalPages.has(sender)) return;
  terminalPages.add(sender);
  const closeAll = () => {
    for (const t of terminals.values()) if (t.sender === sender) t.stream.close();
  };
  sender.on('did-navigate', closeAll);
  sender.once('destroyed', closeAll);
}
ipcMain.on('term:input', (event, id, data) => {
  if (fromApp(event) && typeof data === 'string') terminals.get(id)?.stream.write(data);
});
ipcMain.handle('term:resize', guard((_e, id, cols, rows) => {
  terminals.get(id)?.stream.setWindow(clampInt(rows, 5, 200, 24), clampInt(cols, 20, 500, 100), 0, 0);
  return true;
}));
ipcMain.handle('term:close', guard((_e, id) => {
  terminals.get(id)?.stream.close();
  return true;
}));
// While a terminal has the keys, the menu's shortcuts (Ctrl+W, Ctrl+N…) go to the shell.
ipcMain.handle('term:keys', guard((event, own) => {
  event.sender.setIgnoreMenuShortcuts(Boolean(own));
  return true;
}));

// A file on a server is checked now and then while the server is connected (never
// connecting by itself), and 'disk:changed' says when it changed there.
const remoteWatches = new Map(); // remote:// path → { timer, last, busy }
function watchRemote(sender, uri, on) {
  const existing = remoteWatches.get(uri);
  if (!on) {
    if (existing) clearInterval(existing.timer);
    remoteWatches.delete(uri);
    return true;
  }
  if (existing) return true;
  const { id } = remoteFiles.parseUri(uri);
  const entry = { last: null, busy: false };
  entry.timer = setInterval(async () => {
    if (entry.busy || sender.isDestroyed() || !remote.isConnected(id)) return;
    entry.busy = true;
    try {
      const st = await remote.stat(uri);
      const now = st ? `${st.mtimeMs}:${st.size}` : 'gone';
      // The first look is reported too: the page compares it with what it read (a change may have come in between).
      if (now !== entry.last) sender.send('disk:changed', { path: uri, mtimeMs: st?.mtimeMs ?? 0, size: st?.size ?? 0, exists: Boolean(st) });
      entry.last = now;
    } catch {
      // unreachable for now: tried again on the next round
    } finally {
      entry.busy = false;
    }
  }, 3000);
  remoteWatches.set(uri, entry);
  sender.once('destroyed', () => clearInterval(entry.timer));
  return true;
}

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

ipcMain.handle('disk:read', guard((_e, file) => (isRemote(file) ? remote.read(file) : disk.readTextFile(checkFile(file)))));
ipcMain.handle('disk:read-appended', guard((_e, file, offset, opts) =>
  isRemote(file) ? remote.readAppended(file, Number(offset) || 0, opts) : disk.readAppended(checkFile(file), Number(offset) || 0, opts),
));
ipcMain.handle('disk:write', guard((_e, file, text, opts) => {
  if (typeof text !== 'string') throw new Error('Nothing to save');
  return isRemote(file) ? remote.write(file, text, opts ?? {}) : disk.writeTextFile(checkFile(file), text, opts ?? {});
}));
ipcMain.handle('disk:stat', guard((_e, file) => {
  // A server that cannot be reached throws, so the page can tell it from a missing file.
  if (isRemote(file)) return remote.stat(file);
  try {
    const stat = fs.statSync(checkFile(file));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}));
ipcMain.handle('disk:watch', guard((event, file, on = true) => {
  if (isRemote(file)) return watchRemote(event.sender, file, on);
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
ipcMain.handle('disk:show', guard((_e, file) => {
  if (isRemote(file)) throw new Error('That file is on a server.');
  shell.showItemInFolder(checkFile(file));
}));

// ---- Folders: browse and open files inside folders picked in the dialog ------

ipcMain.handle('folder:pick', guard(async (_e, defaultPath) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a folder',
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  const picked = filePaths[0];
  if (!allowedFolders.includes(picked)) {
    allowedFolders.push(picked);
    saveFolders();
  }
  return picked;
}));
ipcMain.handle('folder:roots', guard(() => allowedFolders.filter((f) => fs.existsSync(f))));
ipcMain.handle('folder:forget', guard((_e, folder) => {
  const at = allowedFolders.indexOf(folder);
  if (at !== -1) allowedFolders.splice(at, 1);
  saveFolders();
  return allowedFolders;
}));
ipcMain.handle('folder:list', guard((_e, dir) => (isRemote(dir) ? remote.list(dir) : folders.listFolder(checkFile(dir)))));
// Where the open dialog starts: the usual folders.
ipcMain.handle('folder:places', guard(() => Object.fromEntries(['home', 'desktop', 'documents', 'downloads'].map((name) => [name, app.getPath(name)]))));
// New files and folders, renaming, moving, copying and deleting, like a file
// explorer, always inside the picked folders. A picked folder itself is never
// renamed, moved or deleted from here.
const isRoot = (p) => allowedFolders.some((root) => path.resolve(root) === path.resolve(p));
const checkEntry = (p) => {
  checkFile(p);
  if (isRoot(p)) throw new Error('A folder you picked cannot be changed here; use your file explorer.');
  if (!fs.existsSync(p)) throw new Error(`${path.basename(p)} is not there any more.`);
  return p;
};
const checkDir = (dir) => {
  checkFile(dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${path.basename(dir)} is not a folder.`);
  return dir;
};
const checkList = (paths) => {
  if (!Array.isArray(paths) || !paths.length || paths.length > 5000) throw new Error('Nothing to do.');
  return paths;
};
// `text` fills the new file; `unique` picks a free name ("name (2).txt") instead of refusing one that exists.
ipcMain.handle('folder:new-file', guard((_e, dir, name, { text = '', unique = false } = {}) => {
  if (isRemote(dir)) return remote.newFile(dir, name, { text: typeof text === 'string' ? text : '', unique });
  const clean = folders.checkName(name);
  checkDir(dir);
  const file = unique ? folders.freePath(dir, clean) : path.join(dir, clean);
  checkFile(file);
  if (fs.existsSync(file)) throw new Error(`${clean} already exists here.`);
  fs.writeFileSync(file, typeof text === 'string' ? text : '', { flag: 'wx' });
  return file;
}));
ipcMain.handle('folder:new-folder', guard((_e, dir, name) => {
  if (isRemote(dir)) return remote.newFolder(dir, name);
  const clean = folders.checkName(name);
  const folder = path.join(checkDir(dir), clean);
  checkFile(folder);
  if (fs.existsSync(folder)) throw new Error(`${clean} already exists here.`);
  fs.mkdirSync(folder);
  return folder;
}));
ipcMain.handle('folder:rename', guard((_e, from, name) => {
  if (isRemote(from)) return remote.rename(from, name);
  const to = folders.renameEntry(checkEntry(from), name);
  checkFile(to);
  return to;
}));
// Copies between this computer and servers (or two servers): uploads and downloads.
async function copyAcross(paths, dir) {
  if (isRemote(dir)) return remote.copyInto(paths.map((p) => (isRemote(p) ? p : checkFile(p))), dir);
  checkDir(dir);
  const local = paths.filter((p) => !isRemote(p)).map(checkFile);
  return [...(local.length ? folders.copyInto(local, dir) : []), ...(await remote.downloadInto(paths.filter(isRemote), dir, folders.freePath))];
}
const sameServer = (paths, dir) => isRemote(dir) && paths.every((p) => isRemote(p) && remoteFiles.parseUri(p).id === remoteFiles.parseUri(dir).id);
// Names already in a folder: asked about before a copy or move ('folder:existing'), then
// with `onExists` 'skip' those are left out and with 'replace' the ones there go first
// (to the Recycle Bin here; deleted on a server). 'keep' (the default) keeps both ("name (2)").
const nameOf = (p) => (isRemote(p) ? path.posix.basename(remoteFiles.parseUri(p).path) : path.basename(p));
async function takenNames(dir) {
  if (isRemote(dir)) return new Set((await remote.list(dir)).entries.map((e) => e.name));
  checkDir(dir);
  return { has: (name) => fs.existsSync(path.join(dir, name)) };
}
const inFolder = (p, dir) => {
  if (isRemote(p) !== isRemote(dir)) return false;
  if (!isRemote(p)) return path.resolve(path.dirname(p)) === path.resolve(dir);
  const a = remoteFiles.parseUri(p);
  const b = remoteFiles.parseUri(dir);
  return a.id === b.id && path.posix.dirname(a.path) === b.path;
};
async function resolveExisting(paths, dir, onExists) {
  if (onExists !== 'skip' && onExists !== 'replace') return paths;
  const taken = await takenNames(dir);
  const out = [];
  for (const p of paths) {
    const name = nameOf(p);
    if (inFolder(p, dir) || !taken.has(name)) {
      out.push(p);
      continue;
    }
    if (onExists === 'skip') continue;
    if (isRemote(dir)) {
      const { id, path: d } = remoteFiles.parseUri(dir);
      const target = remoteFiles.toUri(id, path.posix.join(d, name));
      const from = isRemote(p) ? remoteFiles.parseUri(p) : null;
      if (from?.id === id && (from.path === path.posix.join(d, name) || from.path.startsWith(`${path.posix.join(d, name)}/`))) throw new Error(`${name} cannot replace the folder it is in.`);
      await remote.remove([target]);
    } else {
      const target = path.join(dir, name);
      if (!isRemote(p) && (path.resolve(p) === path.resolve(target) || folders.isInside(path.resolve(target), path.resolve(p)))) throw new Error(`${name} cannot replace the folder it is in.`);
      await shell.trashItem(checkEntry(target));
    }
    out.push(p);
  }
  return out;
}
ipcMain.handle('folder:existing', guard(async (_e, dir, names) => {
  if (!Array.isArray(names) || names.length > 5000) throw new Error('Nothing to check.');
  const taken = await takenNames(dir);
  return names.filter((n) => typeof n === 'string' && n && !/[\\/]/.test(n) && taken.has(n));
}));
ipcMain.handle('folder:move', guard(async (_e, paths, dir, opts = {}) => {
  checkList(paths);
  paths = await resolveExisting(paths, dir, opts?.onExists);
  if (!paths.length) return [];
  if (!isRemote(dir) && !paths.some(isRemote)) return folders.moveInto(paths.map(checkEntry), checkDir(dir));
  if (sameServer(paths, dir)) return remote.moveWithin(paths, dir);
  // Between this computer and a server: copied, then the originals removed (from here, to the Recycle Bin).
  for (const p of paths) if (!isRemote(p)) checkEntry(p);
  const copies = await copyAcross(paths, dir);
  for (const c of copies) await (isRemote(c.from) ? remote.remove([c.from]) : shell.trashItem(c.from));
  return copies;
}));
ipcMain.handle('folder:copy', guard(async (_e, paths, dir, opts = {}) => {
  checkList(paths);
  paths = await resolveExisting(paths, dir, opts?.onExists);
  if (!paths.length) return [];
  if (!isRemote(dir) && !paths.some(isRemote)) return folders.copyInto(paths.map((p) => (checkFile(p), p)), checkDir(dir));
  return copyAcross(paths, dir);
}));
// Files pasted or dropped from another app: the preload takes their paths from the
// File objects (webUtils), so the page cannot name other files. They are copied in;
// they do not become reachable themselves.
ipcMain.handle('folder:copy-in', guard(async (_e, paths, dir, opts = {}) => {
  let sources = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p));
  if (!sources.length) throw new Error('Those files are not on disk.');
  sources = await resolveExisting(sources, dir, opts?.onExists);
  if (!sources.length) return [];
  if (isRemote(dir)) return remote.copyInto(checkList(sources), dir);
  return folders.copyInto(checkList(sources), checkDir(dir));
}));
// Zip archives (folders on this computer): the selection compressed next to it, or an
// archive extracted into a new folder beside it (zip.cjs: never outside it).
ipcMain.handle('folder:zip', guard(async (_e, paths, dir) => {
  checkList(paths);
  if (isRemote(dir) || paths.some(isRemote)) throw new Error('Zip works with folders on this computer.');
  checkDir(dir);
  const sources = paths.map(checkEntry);
  const first = path.basename(sources[0]);
  const stem = sources.length > 1 ? 'Archive' : fs.statSync(sources[0]).isDirectory() ? first : first.replace(/\.[^.]+$/, '') || first;
  const out = folders.freePath(dir, `${stem}.zip`);
  checkFile(out);
  await zipFiles.zipPaths(sources, out);
  return out;
}));
ipcMain.handle('folder:unzip', guard(async (_e, file) => {
  if (isRemote(file)) throw new Error('Extracting works with folders on this computer.');
  checkEntry(file);
  const dest = folders.freePath(path.dirname(file), path.basename(file).replace(/\.zip$/i, '') || 'Archive');
  checkFile(dest);
  return { ...(await zipFiles.unzipFile(file, dest)), folder: dest };
}));
// Copied or cut files on the system clipboard, so the file explorer (Explorer, Finder,
// Files) can paste them, with their paths as text; `clipStamp` recognizes them when they
// are pasted back here.
let clipStamp = null;
const rawFormat = (format) => `electron application/osclipboard;format="${format}"`;
const fileClipboardScript = (files, cut, stamp) => `
Add-Type -AssemblyName System.Windows.Forms
$paths = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(files)).toString('base64')}')) | ConvertFrom-Json
$list = New-Object System.Collections.Specialized.StringCollection
foreach ($p in $paths) { [void]$list.Add($p) }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($list)
$data.SetText(($paths -join [Environment]::NewLine))
$data.SetData('Preferred DropEffect', (New-Object System.IO.MemoryStream(,[byte[]](${cut ? 2 : 5},0,0,0))))
$data.SetData('TrackerEditorClip', (New-Object System.IO.MemoryStream(,[System.Text.Encoding]::ASCII.GetBytes('${stamp}'))))
[System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
`;
const escapeXml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The text of a raw format on the clipboard ('' when it is not there).
async function clipboardFormat(format) {
  try {
    if (!(await clipboard.has(rawFormat(format)))) return '';
    for (const item of await clipboard.read()) {
      if (item.types.includes(rawFormat(format))) return Buffer.from(await (await item.getType(rawFormat(format))).arrayBuffer()).toString('latin1');
    }
  } catch {
    // not readable: not ours
  }
  return '';
}
ipcMain.handle('folder:clip-files', guard(async (_e, paths, op) => {
  checkList(paths);
  if (paths.some(isRemote)) return false;
  const files = paths.map(checkEntry);
  const cut = op === 'cut';
  const stamp = crypto.randomBytes(8).toString('hex');
  clipStamp = null;
  if (process.platform === 'win32') {
    // Explorer reads CF_HDROP, which only the system's own data object writes.
    const script = Buffer.from(fileClipboardScript(files, cut, stamp), 'utf16le').toString('base64');
    await new Promise((resolve, reject) =>
      require('node:child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', script], { windowsHide: true, timeout: 15000 }, (err) => (err ? reject(err) : resolve())),
    );
  } else {
    const urls = files.map((f) => pathToFileURL(f).href);
    const formats = {
      'text/plain': files.join('\n'),
      [rawFormat('TrackerEditorClip')]: new Blob([stamp]),
    };
    if (process.platform === 'darwin') {
      formats[rawFormat('NSFilenamesPboardType')] = new Blob([
        `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array>${files.map((f) => `<string>${escapeXml(f)}</string>`).join('')}</array></plist>`,
      ]);
      formats[rawFormat('public.file-url')] = new Blob([urls[0]]);
    } else {
      // GNOME Files and most others (the first line says copy or cut), KDE, and the rest by their URLs.
      formats[rawFormat('x-special/gnome-copied-files')] = new Blob([`${cut ? 'cut' : 'copy'}\n${urls.join('\n')}`]);
      formats[rawFormat('text/uri-list')] = new Blob([`${urls.join('\r\n')}\r\n`]);
      if (cut) formats[rawFormat('application/x-kde-cutselection')] = new Blob(['1']);
    }
    await clipboard.write([new ClipboardItem(formats)]);
  }
  clipStamp = stamp;
  return true;
}));
ipcMain.handle('folder:clip-ours', guard(async () => Boolean(clipStamp) && (await clipboardFormat('TrackerEditorClip')).includes(clipStamp)));
// To the Recycle Bin (macOS: the Trash), from where they can be restored.
// Files on a server are deleted for good (servers have no Recycle Bin; the page asks first and says so).
ipcMain.handle('folder:trash', guard(async (_e, paths) => {
  checkList(paths);
  const done = paths.some(isRemote) ? await remote.remove(paths.filter(isRemote)) : [];
  for (const p of paths.filter((x) => !isRemote(x)).map(checkEntry)) {
    await shell.trashItem(p);
    done.push(p);
  }
  return done;
}));
// A file the editor cannot show, with its default program; a folder in the file explorer.
// Programs, scripts and shortcuts are never started (folders.canOpenExternally).
ipcMain.handle('folder:open-external', guard(async (_e, file) => {
  if (isRemote(file)) {
    // A copy, downloaded to open with its program (changes there are not sent back).
    const name = path.posix.basename(remoteFiles.parseUri(file).path);
    if (!folders.canOpenExternally(name)) throw new Error(`${name} is a program or a script; the editor does not start those.`);
    const copy = remoteFiles.tempCopyPath(file);
    fs.writeFileSync(copy, await remote.readBytes(file, 200 * 1024 * 1024));
    const failed = await shell.openPath(copy);
    if (failed) throw new Error(failed);
    return true;
  }
  checkFile(file);
  const isDir = fs.statSync(file).isDirectory();
  if (!isDir && !folders.canOpenExternally(path.basename(file))) throw new Error(`${path.basename(file)} is a program or a script; the editor does not start those. Use Show in the file explorer.`);
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
  return true;
}));
// Properties: sizes, dates, owner and permissions; permissions can be changed
// (on Windows only "read-only" means something here).
ipcMain.handle('folder:properties', guard((_e, p) => (isRemote(p) ? remote.properties(p) : { ...folders.properties(checkFile(p)), platform: process.platform })));
ipcMain.handle('folder:size', guard((_e, p) => (isRemote(p) ? remote.folderSize(p) : folders.folderSize(checkDir(p)))));
ipcMain.handle('folder:chmod', guard((_e, paths, mode, opts = {}) => {
  checkList(paths);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error('Those permissions are not valid.');
  const recursive = Boolean(opts.recursive);
  if (paths.some(isRemote)) return remote.chmod(paths.filter(isRemote), mode, { recursive });
  return folders.chmodEntries(paths.map(checkFile), mode, { recursive });
}));
// An image's bytes, for reading its text.
ipcMain.handle('folder:read-image', guard((_e, file) => {
  if (isRemote(file)) {
    if (!folders.isImage(path.posix.basename(file))) throw new Error('That is not an image.');
    return remote.readBytes(file, 40 * 1024 * 1024);
  }
  checkFile(file);
  if (!folders.isImage(path.basename(file))) throw new Error(`${path.basename(file)} is not an image.`);
  if (fs.statSync(file).size > 40 * 1024 * 1024) throw new Error(`${path.basename(file)} is larger than 40 MB.`);
  return fs.readFileSync(file);
}));
// The folder shown is watched, so the list follows changes made elsewhere ('folder:changed').
const folderWatches = new Map(); // webContents id → fs.FSWatcher
ipcMain.handle('folder:watch', guard((event, dir) => {
  const sender = event.sender;
  folderWatches.get(sender.id)?.close();
  folderWatches.delete(sender.id);
  if (!dir) return false;
  if (isRemote(dir)) {
    // A folder on a server: listed again now and then while connected.
    const { id } = remoteFiles.parseUri(dir);
    let last = null;
    let busy = false;
    const poll = setInterval(async () => {
      if (busy || sender.isDestroyed() || !remote.isConnected(id)) return;
      busy = true;
      try {
        const now = JSON.stringify((await remote.list(dir)).entries.map((e) => [e.name, e.size, e.mtimeMs]));
        if (last !== null && now !== last) sender.send('folder:changed', { dir });
        last = now;
      } catch {
        // tried again on the next round
      } finally {
        busy = false;
      }
    }, 4000);
    folderWatches.set(sender.id, { close: () => clearInterval(poll) });
    sender.once('destroyed', () => clearInterval(poll));
    return true;
  }
  checkDir(dir);
  let timer = null;
  try {
    const watcher = fs.watch(dir, { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => !sender.isDestroyed() && sender.send('folder:changed', { dir }), 250);
    });
    watcher.on('error', () => watcher.close());
    folderWatches.set(sender.id, watcher);
    sender.once('destroyed', () => watcher.close());
  } catch {
    return false; // some network folders cannot be watched; Refresh still works
  }
  return true;
}));
// Find in a folder (and the folders inside it), here or on a server: each file
// with matches goes to the page as soon as it is read ('folder:found').
const { findInFolder } = require('./findInFolder.cjs');
const folderSearches = new Map(); // search id → AbortController
let appModules = null;
const loadAppModules = async () =>
  (appModules ??= {
    search: await import(pathToFileURL(path.join(APP_DIR, 'js', 'search.js')).href),
    folders: await import(pathToFileURL(path.join(APP_DIR, 'js', 'folders.js')).href),
  });
// The matching runs in a worker thread, so a pattern that takes very long (or a huge
// minified file) never freezes the window; Stop, or 15 s on one file, ends the worker.
const MATCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const ready = import('data:text/javascript,' + encodeURIComponent(workerData.source));
parentPort.on('message', async ({ id, name, text }) => {
  try {
    const { findInFiles } = await ready;
    const hit = findInFiles([{ id: name, name, text }], workerData.query, { ...workerData.options, maxPerFile: 200, maxLines: 200 }).files[0] ?? null;
    parentPort.postMessage({ id, hit });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err && err.message || err) });
  }
});`;
function matchWorker(query, options, signal) {
  const { Worker } = require('node:worker_threads');
  const source = fs.readFileSync(path.join(APP_DIR, 'js', 'search.js'), 'utf8');
  const worker = new Worker(MATCH_WORKER, { eval: true, workerData: { source, query, options } });
  const pending = new Map();
  let n = 0;
  let dead = null;
  const end = (reason) => {
    if (dead) return;
    dead = reason;
    worker.terminate();
    for (const p of pending.values()) p.reject(reason);
    pending.clear();
  };
  worker.on('message', ({ id, hit, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    error ? p.reject(new Error(error)) : p.resolve(hit);
  });
  worker.on('error', (err) => end(err));
  signal.addEventListener('abort', () => end(new Error('Stopped.')));
  return {
    match: (name, text) =>
      new Promise((resolve, reject) => {
        if (dead) return reject(dead);
        const id = ++n;
        const timer = setTimeout(() => end(Object.assign(new Error(`Searching ${name} takes too long with this pattern, so the search stopped.`), { fatal: true })), 15000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, name, text });
      }),
    close: () => end(new Error('Done.')),
  };
}
ipcMain.handle('folder:find', guard(async (event, searchId, dir, query, opts = {}) => {
  if (typeof query !== 'string' || !query) throw new Error('Type what to find.');
  const { search, folders: names } = await loadAppModules();
  const options = { caseSensitive: Boolean(opts.caseSensitive), wholeWord: Boolean(opts.wholeWord), regex: Boolean(opts.regex) };
  search.buildMatcher(query, options); // a bad pattern says so before anything is read
  const onServer = isRemote(dir);
  if (!onServer) checkDir(dir);
  const controller = new AbortController();
  folderSearches.get(searchId)?.abort();
  folderSearches.set(searchId, controller);
  const sender = event.sender;
  const send = (channel, data) => !sender.isDestroyed() && sender.send(channel, { searchId, ...data });
  const root = onServer ? remoteFiles.parseUri(dir).path : dir;
  const matcher = matchWorker(query, options, controller.signal);
  try {
    const stats = await findInFolder({
      root: dir,
      // Links are not followed on this computer, so the search stays inside the folder.
      list: onServer
        ? async (d) => (await remote.list(d)).entries
        : async (d) =>
            (await fs.promises.readdir(d, { withFileTypes: true }))
              .filter((e) => !e.isSymbolicLink() && (e.isDirectory() || e.isFile()))
              .map((e) => ({ name: e.name, path: path.join(d, e.name), dir: e.isDirectory(), size: e.isFile() ? fs.statSync(path.join(d, e.name)).size : 0 })),
      read: onServer ? (p) => remote.readBytes(p, 2 * 1024 * 1024) : (p) => fs.promises.readFile(p),
      decode: (bytes) => disk.decode(bytes).text,
      match: matcher.match,
      isText: names.opensInEditor,
      relative: (p) => (onServer ? path.posix.relative(root, remoteFiles.parseUri(p).path) : path.relative(dir, p)),
      onFound: (file) => send('folder:found', { file }),
      onProgress: (stats) => send('folder:find-progress', { stats }),
      signal: controller.signal,
      hidden: Boolean(opts.hidden),
      files: typeof opts.files === 'string' ? opts.files : '',
      maxFiles: onServer ? 2000 : 20000,
      maxSize: onServer ? 2 * 1024 * 1024 : 5 * 1024 * 1024,
      concurrency: onServer ? (remote.isFtp(dir) ? 1 : 4) : 8,
    });
    if (stats.error) throw new Error(stats.error);
    return stats;
  } finally {
    matcher.close();
    if (folderSearches.get(searchId) === controller) folderSearches.delete(searchId);
  }
}));
ipcMain.handle('folder:find-stop', guard((_e, searchId) => {
  folderSearches.get(searchId)?.abort();
  return true;
}));

// A folder on this computer in the system's terminal app (Windows Terminal or
// PowerShell, Terminal on macOS, the desktop's terminal on Linux).
function openSystemTerminal(dir) {
  const { spawn } = require('node:child_process');
  const candidates =
    process.platform === 'win32'
      ? // Windows Terminal reads ; in its arguments as a new command: the folder is its working folder, not an argument.
        [['wt.exe', ['-d', '.']], [process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoExit']]]
      : process.platform === 'darwin'
        ? [['open', ['-a', 'Terminal', dir]]]
        : [['x-terminal-emulator', []], ['gnome-terminal', [`--working-directory=${dir}`]], ['konsole', ['--workdir', dir]], ['xfce4-terminal', [`--working-directory=${dir}`]], ['kitty', ['--directory', dir]], ['alacritty', ['--working-directory', dir]], ['xterm', []]];
  const tryOne = ([cmd, args]) =>
    new Promise((resolve) => {
      try {
        const child = spawn(cmd, args, { cwd: dir, detached: true, stdio: 'ignore' });
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  return (async () => {
    for (const candidate of candidates) if (await tryOne(candidate)) return true;
    throw new Error('No terminal app was found on this computer.');
  })();
}
ipcMain.handle('folder:terminal', guard((_e, dir) => {
  if (isRemote(dir)) throw new Error('Terminals on servers open in the editor.');
  return openSystemTerminal(checkDir(dir));
}));
// Paste in the page as Ctrl+V does, so the Paste button gets the files copied in other apps.
ipcMain.handle('edit:paste', guard((event) => event.sender.paste()));

// ---- Dragging a tab out to other apps ------------------------------------------
// A real file drag: a file on disk is dragged as itself, an editor file as a
// copy written to a temporary folder. The other app decides what a drop does:
// the desktop or a folder keeps a copy, a terminal (Claude Code) pastes the
// path, the Claude app attaches the file.

const DRAG_DIR = path.join(os.tmpdir(), 'Tracker Editor drag');
let dragIcon = null;
const iconForDrag = () => (dragIcon ??= nativeImage.createFromPath(path.join(APP_DIR, 'icons', 'icon-192.png')).resize({ width: 32, height: 32 }));

ipcMain.on('drag:start', (event, item = {}) => {
  if (!fromApp(event)) return;
  let files;
  try {
    // { paths } several files and folders on disk, { path } one, or { name, text } for a copy.
    if (Array.isArray(item.paths) && item.paths.length) files = item.paths.slice(0, 1000).map(checkFile);
    else files = [item.path ? checkFile(item.path) : folders.writeExport(DRAG_DIR, item.name, String(item.text ?? ''))];
  } catch (err) {
    event.sender.send('drag:end', { error: err.message });
    return;
  }
  event.sender.startDrag({ file: files[0], files, icon: iconForDrag() });
  // Windows and Linux return when the drop is done; the page also clears it on its own.
  if (!event.sender.isDestroyed()) event.sender.send('drag:end', { files });
});

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
        item('Open Folder…', undefined, 'folder-open'),
        item('Connect to a Server…', undefined, 'server-add'),
        item('Servers from the SSH Config…', undefined, 'servers-ssh'),
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
        item('Folders', 'CmdOrCtrl+Shift+E', 'folders'),
        item('Word Wrap', 'Alt+Z', 'toggle-wrap'),
        item('Read Aloud', 'Alt+R', 'read-aloud'),
        shown('Split View', 'CmdOrCtrl+\\', 'split'),
        item('Local Model', 'CmdOrCtrl+Shift+A', 'assistant'),
        shown('Outline and Links', 'CmdOrCtrl+Shift+O', 'outline'),
        shown('Terminal', 'Ctrl+`', 'terminal'),
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
  folders.cleanExports(DRAG_DIR);
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
  remote.disconnectAll();
  if (clipSaveTimer) saveClips();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
