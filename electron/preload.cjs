// Exposes a small, explicit API to the web app. Runs sandboxed with context
// isolation, so the page never gets direct access to Node or Electron.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
    // The path of a file dropped on the page ('' for one that is not on disk).
    pathOf: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    onChanged(callback) {
      const listener = (_event, change) => callback(change);
      ipcRenderer.on('disk:changed', listener);
      return () => ipcRenderer.removeListener('disk:changed', listener);
    },
  },
  // Folders picked in the open dialog: their files can be listed and opened.
  folders: {
    pick: (defaultPath) => ipcRenderer.invoke('folder:pick', defaultPath),
    roots: () => ipcRenderer.invoke('folder:roots'),
    forget: (folder) => ipcRenderer.invoke('folder:forget', folder),
    list: (dir) => ipcRenderer.invoke('folder:list', dir),
    places: () => ipcRenderer.invoke('folder:places'),
    newFile: (dir, name, opts) => ipcRenderer.invoke('folder:new-file', dir, name, opts),
    newFolder: (dir, name) => ipcRenderer.invoke('folder:new-folder', dir, name),
    rename: (from, name) => ipcRenderer.invoke('folder:rename', from, name),
    move: (paths, dir) => ipcRenderer.invoke('folder:move', paths, dir),
    copy: (paths, dir) => ipcRenderer.invoke('folder:copy', paths, dir),
    // Files pasted or dropped from other apps (File objects): copied into `dir`.
    copyIn(files, dir) {
      const paths = [...files].map((file) => {
        try {
          return webUtils.getPathForFile(file);
        } catch {
          return '';
        }
      });
      return ipcRenderer.invoke('folder:copy-in', paths.filter(Boolean), dir);
    },
    trash: (paths) => ipcRenderer.invoke('folder:trash', paths),
    openExternal: (file) => ipcRenderer.invoke('folder:open-external', file),
    readImage: (file) => ipcRenderer.invoke('folder:read-image', file),
    watch: (dir) => ipcRenderer.invoke('folder:watch', dir),
    onChanged(callback) {
      const listener = (_event, change) => callback(change);
      ipcRenderer.on('folder:changed', listener);
      return () => ipcRenderer.removeListener('folder:changed', listener);
    },
    // Ctrl+V in the page: a paste event with the files copied in other apps.
    paste: () => ipcRenderer.invoke('edit:paste'),
  },
  // Servers (SFTP, FTP, FTPS): files there are remote://<id>/<path> and go through disk and folders above.
  remote: {
    connections: () => ipcRenderer.invoke('remote:connections'),
    // `secrets`: { password, passphrase } to keep (sent once; never read back).
    save: (conn, secrets) => ipcRenderer.invoke('remote:save', conn, secrets),
    delete: (id) => ipcRenderer.invoke('remote:delete', id),
    test: (conn, secrets) => ipcRenderer.invoke('remote:test', conn, secrets),
    connect: (id) => ipcRenderer.invoke('remote:connect', id),
    disconnect: (id) => ipcRenderer.invoke('remote:disconnect', id),
    forgetHostKey: (id) => ipcRenderer.invoke('remote:forget-host-key', id),
    pickKey: () => ipcRenderer.invoke('remote:pick-key'),
    answerHostKey: (question, ok) => ipcRenderer.invoke('remote:host-key-answer', question, ok),
    onStatus(callback) {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('remote:status', listener);
      return () => ipcRenderer.removeListener('remote:status', listener);
    },
    onHostKey(callback) {
      const listener = (_event, info) => callback(info);
      ipcRenderer.on('remote:host-key', listener);
      return () => ipcRenderer.removeListener('remote:host-key', listener);
    },
  },
  // Dragging tabs or files out to other apps: { path } or { paths } on disk, or { name, text } for a copy.
  drag: {
    start: (item) => ipcRenderer.send('drag:start', item),
    onEnd(callback) {
      const listener = (_event, info) => callback(info);
      ipcRenderer.on('drag:end', listener);
      return () => ipcRenderer.removeListener('drag:end', listener);
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
