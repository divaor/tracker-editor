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
  closeReady: () => ipcRenderer.send('app:close-ready'),
  onCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('command', listener);
    return () => ipcRenderer.removeListener('command', listener);
  },
});
