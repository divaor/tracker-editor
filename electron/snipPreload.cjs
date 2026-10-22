// The screenshot overlay's bridge: the captured screen, and the part picked.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snip', {
  image: () => ipcRenderer.invoke('snip:image'),
  done: (rect) => ipcRenderer.invoke('snip:done', rect),
});
