// The quick capture window's bridge: only what that small page needs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  platform: process.platform,
  draft: () => ipcRenderer.invoke('capture:draft'),
  keepDraft: (text) => ipcRenderer.invoke('capture:keep-draft', text),
  submit: (entry) => ipcRenderer.invoke('capture:submit', entry),
  close: () => ipcRenderer.invoke('capture:close'),
});
