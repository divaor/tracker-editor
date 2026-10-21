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
  closeReady: () => ipcRenderer.send('app:close-ready'),
  onCommand(callback) {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('command', listener);
    return () => ipcRenderer.removeListener('command', listener);
  },
});
