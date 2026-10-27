// What electron/main.cjs gets for require('electron') when it runs in the Android app's own
// Node.js (mobile/node/main.cjs): the parts a phone has. IPC goes over the bridge (HTTP and
// server-sent events); pickers and confirmations are asked of the phone, whose native side
// answers (the page cannot answer for it); windows, menus, the tray, global shortcuts and
// the clipboard are not there. Anything else main.cjs touches is a harmless stand-in.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { config, bridge } = globalThis.__trackerAndroid;

// An object that answers anything with something harmless: a function returning itself.
function inert(name = 'inert') {
  const fn = function () {
    return proxy;
  };
  const proxy = new Proxy(fn, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : key === 'toString' ? () => name : proxy),
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

// ---- The page: one "window" whose webContents sends events over the bridge ----
const webContents = Object.assign(new EventEmitter(), {
  id: 1,
  send: (channel, ...args) => bridge.emit(channel, ...args),
  isLoading: () => false,
  isDestroyed: () => false,
  getURL: () => 'app://editor/index.html',
  setWindowOpenHandler: () => {},
  paste: () => {},
  setIgnoreMenuShortcuts: () => {},
  startDrag: () => {},
  setZoomLevel: () => {},
  getZoomLevel: () => 0,
  openDevTools: () => {},
  session: inert('session'),
});

class BrowserWindow extends EventEmitter {
  static #all = [];
  static fromWebContents() {
    return BrowserWindow.#all[0] ?? null;
  }
  static getAllWindows() {
    return [...BrowserWindow.#all];
  }
  static getFocusedWindow() {
    return BrowserWindow.#all[0] ?? null;
  }
  constructor(options = {}) {
    super();
    // The window with the app's preload is the page; others (quick capture, screenshots)
    // never show here and send nowhere.
    const page = String(options.webPreferences?.preload ?? '').endsWith('preload.cjs');
    this.webContents = page ? webContents : Object.assign(new EventEmitter(), { ...webContents, send() {} });
    if (page) BrowserWindow.#all.unshift(this);
    else BrowserWindow.#all.push(this);
  }
  loadURL() {
    return Promise.resolve();
  }
  loadFile() {
    return Promise.resolve();
  }
  isDestroyed() {
    return false;
  }
  isMinimized() {
    return false;
  }
  isMaximized() {
    return false;
  }
  isVisible() {
    return true;
  }
  isFocused() {
    return true;
  }
  getNormalBounds() {
    return { x: 0, y: 0, width: 400, height: 800 };
  }
  getBounds() {
    return this.getNormalBounds();
  }
  getNativeWindowHandle() {
    return Buffer.alloc(8);
  }
  destroy() {}
}
for (const name of ['show', 'hide', 'focus', 'blur', 'restore', 'maximize', 'minimize', 'close', 'setMenu', 'setMenuBarVisibility', 'setBounds', 'setTitle', 'setAlwaysOnTop', 'setSkipTaskbar', 'center', 'removeMenu', 'setIcon', 'moveTop']) {
  BrowserWindow.prototype[name] = function () {};
}

// ---- app ----
const PATHS = config.paths ?? {};
const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  name: 'Tracker Editor',
  commandLine: inert('commandLine'),
  dock: inert('dock'),
  getPath: (name) => PATHS[name] ?? PATHS.userData,
  setPath: (name, value) => (PATHS[name] = value),
  getAppPath: () => config.projectDir ?? __dirname,
  getVersion: () => config.version ?? '0.0.0',
  getName: () => 'Tracker Editor',
  getLocale: () => 'en-US',
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  requestSingleInstanceLock: () => true,
  setAsDefaultProtocolClient: () => false,
  removeAsDefaultProtocolClient: () => false,
  setAppUserModelId: () => {},
  setLoginItemSettings: () => {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  // The app lives as long as the phone keeps it: quitting is not the page's to do.
  quit: () => {},
  exit: () => {},
  relaunch: () => {},
  focus: () => {},
  hide: () => {},
  show: () => {},
});

// ---- Pickers and confirmations: asked of the phone ----
// The native side shows its own picker (folders on the phone's storage, a file) or dialog and
// sends the answer straight here with its token, so the page cannot pick for the person.
const dialog = {
  async showOpenDialog(_win, options = {}) {
    const opts = options && !options.webContents ? options : _win;
    const answer = await bridge.ask('open', { title: opts?.title ?? '', properties: opts?.properties ?? [], defaultPath: opts?.defaultPath ?? '' });
    const filePaths = Array.isArray(answer?.paths) ? answer.paths.filter((p) => typeof p === 'string') : [];
    return { canceled: !filePaths.length, filePaths };
  },
  async showSaveDialog() {
    return { canceled: true, filePath: undefined };
  },
  async showMessageBox(win, options) {
    const opts = options ?? win ?? {};
    const answer = await bridge.ask('message', {
      type: opts.type ?? 'info',
      title: opts.title ?? '',
      message: opts.message ?? '',
      detail: opts.detail ?? '',
      buttons: opts.buttons ?? ['OK'],
      defaultId: opts.defaultId ?? 0,
      cancelId: opts.cancelId ?? 0,
    });
    const response = Number.isInteger(answer?.response) ? answer.response : (opts.cancelId ?? 0);
    return { response, checkboxChecked: false };
  },
  showMessageBoxSync: (win, options) => (options ?? win)?.cancelId ?? 0,
  showErrorBox: (title, content) => console.error(title, content),
};

// ---- shell ----
const shell = {
  // A phone has no Recycle Bin for files: deleted for good (the page says so before).
  async trashItem(p) {
    await fs.promises.rm(p, { recursive: true, force: false });
  },
  // Another app opens it (the phone asks which).
  async openPath(p) {
    const answer = await bridge.ask('openPath', { path: p });
    return typeof answer?.error === 'string' ? answer.error : '';
  },
  async openExternal(url) {
    bridge.emit('native:open-url', String(url));
  },
  showItemInFolder: () => {},
  beep: () => {},
};

// ---- Secrets (saved server passwords): AES-GCM with a key the app keeps in the Keystore ----
const secretKey = config.secretKey ? Buffer.from(config.secretKey, 'base64') : null;
const safeStorage = {
  isEncryptionAvailable: () => Boolean(secretKey && secretKey.length === 32),
  encryptString(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    const sealed = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
  },
  decryptString(buffer) {
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
  },
  getSelectedStorageBackend: () => 'android_keystore',
};

// ---- What a phone does not have here ----
const clipboard = {
  readText: () => '',
  writeText: (text) => bridge.emit('native:clipboard', String(text ?? '')),
  read: () => '',
  readBuffer: () => Buffer.alloc(0),
  has: () => false,
  write: () => {},
  clear: () => {},
  availableFormats: () => [],
};
class ClipboardItem {}
const ipcMain = {
  handle: (channel, fn) => bridge.handle(channel, fn),
  handleOnce: (channel, fn) => bridge.handle(channel, fn),
  removeHandler: (channel) => bridge.removeHandler(channel),
  on: (channel, fn) => bridge.on(channel, fn),
  once: (channel, fn) => bridge.on(channel, fn),
  removeListener: () => {},
  removeAllListeners: () => {},
};
const display = { id: 0, scaleFactor: 1, bounds: { x: 0, y: 0, width: 400, height: 800 }, workArea: { x: 0, y: 0, width: 400, height: 800 }, size: { width: 400, height: 800 } };
const screen = Object.assign(new EventEmitter(), {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getPrimaryDisplay: () => display,
  getAllDisplays: () => [display],
  getDisplayNearestPoint: () => display,
  getDisplayMatching: () => display,
});
const image = () => ({ isEmpty: () => true, resize() { return this; }, toPNG: () => Buffer.alloc(0), toDataURL: () => '', getSize: () => ({ width: 0, height: 0 }), setTemplateImage() {} });
const nativeImage = { createFromPath: image, createEmpty: image, createFromBuffer: image, createFromDataURL: image };
class Tray extends EventEmitter {
  setToolTip() {}
  setContextMenu() {}
  setImage() {}
  destroy() {}
}
class Notification extends EventEmitter {
  static isSupported() {
    return false;
  }
  show() {}
  close() {}
}
const Menu = {
  buildFromTemplate: (items = []) => ({ items, popup() {}, closePopup() {}, getMenuItemById: () => null }),
  setApplicationMenu: () => {},
  getApplicationMenu: () => null,
};
const globalShortcut = { register: () => false, unregister: () => {}, unregisterAll: () => {}, isRegistered: () => false };
const protocol = { registerSchemesAsPrivileged: () => {}, handle: () => {}, unhandle: () => {}, registerFileProtocol: () => {}, interceptFileProtocol: () => {} };
const net = { fetch: (...args) => globalThis.fetch(...args), isOnline: () => true };
const desktopCapturer = { getSources: async () => [] };
const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleTime: () => 0 });

module.exports = {
  app,
  BrowserWindow,
  ClipboardItem,
  Menu,
  MenuItem: class {},
  Notification,
  Tray,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system' }),
  net,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session: inert('session'),
  shell,
  webContents: { getAllWebContents: () => [webContents], fromId: () => webContents },
  // Handlers get this as their event: from the app's page.
  pageEvent: { sender: webContents, senderFrame: { url: 'app://editor/index.html' }, reply: (channel, ...args) => bridge.emit(channel, ...args) },
  appDir: path.join(__dirname, '..'),
};
