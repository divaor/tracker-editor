// Exposes a small, explicit API to the web app. Runs sandboxed with context
// isolation, so the page never gets direct access to Node or Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  secrets: {
    get: (key) => ipcRenderer.invoke('secret:get', key),
    set: (key, value) => ipcRenderer.invoke('secret:set', key, value),
  },
  openFiles: () => ipcRenderer.invoke('files:open'),
  saveFile: (name, text) => ipcRenderer.invoke('files:save', name, text),
  llm: {
    request: (id, url, init) => ipcRenderer.invoke('llm:request', id, url, init),
    abort: (id) => ipcRenderer.send('llm:abort', id),
    onChunk(id, callback) {
      const listener = (_event, chunkId, chunk, done, error) => chunkId === id && callback(chunk, done, error);
      ipcRenderer.on('llm:chunk', listener);
      return () => ipcRenderer.removeListener('llm:chunk', listener);
    },
  },
  // Files on disk, edited in place: only ones picked in the open dialog.
  disk: {
    open: () => ipcRenderer.invoke('disk:open'),
    read: (path) => ipcRenderer.invoke('disk:read', path),
    readAppended: (path, offset, opts) => ipcRenderer.invoke('disk:read-appended', path, offset, opts),
    write: (path, text, opts) => ipcRenderer.invoke('disk:write', path, text, opts),
    stat: (path) => ipcRenderer.invoke('disk:stat', path),
    watch: (path, on = true) => ipcRenderer.invoke('disk:watch', path, on),
    show: (path) => ipcRenderer.invoke('disk:show', path),
    onChanged(callback) {
      const listener = (_event, change) => callback(change);
      ipcRenderer.on('disk:changed', listener);
      return () => ipcRenderer.removeListener('disk:changed', listener);
    },
  },
  // Receives a model service's answers by webhook (port and path from Settings).
  webhook: {
    listen: (opts) => ipcRenderer.invoke('webhook:listen', opts),
    close: () => ipcRenderer.invoke('webhook:close'),
    onEvent(callback) {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('webhook:event', listener);
      return () => ipcRenderer.removeListener('webhook:event', listener);
    },
  },
  // Types text into the window that has the focus after `wait` ms (remote desktops that block pasting).
  typing: {
    start: (text, opts) => ipcRenderer.invoke('type:start', text, opts),
    stop: () => ipcRenderer.send('type:stop'),
    onProgress(callback) {
      const listener = (_event, typed) => callback(typed);
      ipcRenderer.on('type:progress', listener);
      return () => ipcRenderer.removeListener('type:progress', listener);
    },
  },
  // Tray, quick capture and clipboard history settings (kept by the main process).
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),
    set: (patch) => ipcRenderer.invoke('prefs:set', patch),
  },
  capture: {
    open: () => ipcRenderer.invoke('capture:open'),
    take: () => ipcRenderer.invoke('capture:take'),
  },
  // Text from a screenshot: you drag around part of the screen; resolves to its PNG bytes (or null).
  ocr: {
    snip: () => ipcRenderer.invoke('ocr:snip'),
  },
  clipboardHistory: {
    list: () => ipcRenderer.invoke('clip:list'),
    copy: (id) => ipcRenderer.invoke('clip:copy', id),
    remove: (id) => ipcRenderer.invoke('clip:remove', id),
    pin: (id, on) => ipcRenderer.invoke('clip:pin', id, on),
    clear: () => ipcRenderer.invoke('clip:clear'),
    onChanged(callback) {
      const listener = () => callback();
      ipcRenderer.on('clip:changed', listener);
      return () => ipcRenderer.removeListener('clip:changed', listener);
    },
  },
  closeReady: () => ipcRenderer.send('app:close-ready'),
  onCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('command', listener);
    return () => ipcRenderer.removeListener('command', listener);
  },
});
