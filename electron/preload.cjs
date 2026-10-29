// Exposes a small, explicit API to the web app. Runs sandboxed with context
// isolation, so the page never gets direct access to Node or Electron.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Alt held for the mouse (Alt+drag selects a column) must not show the menu bar when it is let go.
if (process.platform !== 'darwin') {
  for (const type of ['mousedown', 'wheel']) {
    window.addEventListener(type, (e) => e.altKey && ipcRenderer.send('menu:alt-used'), { capture: true, passive: true });
  }
}

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
    // { title, single }: the dialog's title, one file only (Compare with… Browse).
    open: (opts) => ipcRenderer.invoke('disk:open', opts),
    read: (path) => ipcRenderer.invoke('disk:read', path),
    readBytes: (path) => ipcRenderer.invoke('disk:read-bytes', path),
    editorConfig: (path) => ipcRenderer.invoke('disk:editorconfig', path),
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
    // Files and folders pasted from another app: their paths come from the File objects here,
    // never from the page; the main process opens them as if opened with the app.
    openPasted: (files) =>
      ipcRenderer.invoke(
        'disk:take-pasted',
        [...files]
          .map((file) => {
            try {
              return webUtils.getPathForFile(file);
            } catch {
              return '';
            }
          })
          .filter(Boolean),
      ),
    // A path pasted as text: opened after the person confirms it in a native dialog (unless reachable already).
    openTyped: (path) => ipcRenderer.invoke('disk:open-typed', path),
    onChanged(callback) {
      const listener = (_event, change) => callback(change);
      ipcRenderer.on('disk:changed', listener);
      return () => ipcRenderer.removeListener('disk:changed', listener);
    },
    // Files and folders the system gave the app ("Open with", the command line): [{ path, dir }].
    takeLaunched: () => ipcRenderer.invoke('disk:take-launched'),
    onLaunched(callback) {
      const listener = () => callback();
      ipcRenderer.on('disk:launched', listener);
      return () => ipcRenderer.removeListener('disk:launched', listener);
    },
  },
  // Folders picked in the open dialog: their files can be listed and opened.
  folders: {
    pick: (defaultPath) => ipcRenderer.invoke('folder:pick', defaultPath),
    roots: () => ipcRenderer.invoke('folder:roots'),
    // The folder of a file open here, for the folders view (asked about in a native dialog when new).
    allowParent: (file) => ipcRenderer.invoke('folder:allow-parent', file),
    forget: (folder) => ipcRenderer.invoke('folder:forget', folder),
    list: (dir) => ipcRenderer.invoke('folder:list', dir),
    // A folder on this computer in the system's terminal app.
    terminal: (dir) => ipcRenderer.invoke('folder:terminal', dir),
    // Properties: { name, path, dir, size, mtimeMs, mode, owner, group, … }; a folder's size; permissions.
    properties: (p) => ipcRenderer.invoke('folder:properties', p),
    size: (p) => ipcRenderer.invoke('folder:size', p),
    chmod: (paths, mode, opts) => ipcRenderer.invoke('folder:chmod', paths, mode, opts),
    // Find in a folder and the ones inside it: files with matches come through onFound.
    find: (searchId, dir, query, opts) => ipcRenderer.invoke('folder:find', searchId, dir, query, opts),
    stopFind: (searchId) => ipcRenderer.invoke('folder:find-stop', searchId),
    // The filter in the folders inside `dir`: { found: [{ entry, parent }], folders, truncated, stopped }.
    findNames: (searchId, dir, query, opts) => ipcRenderer.invoke('folder:find-names', searchId, dir, query, opts),
    index: (dir, opts) => ipcRenderer.invoke('folder:index', dir, opts),
    replace: (dir, query, opts, replacement, paths) => ipcRenderer.invoke('folder:replace', dir, query, opts, replacement, paths),
    replaceUndo: (id) => ipcRenderer.invoke('folder:replace-undo', id),
    onFound(callback) {
      const found = (_event, data) => callback({ type: 'found', ...data });
      const progress = (_event, data) => callback({ type: 'progress', ...data });
      ipcRenderer.on('folder:found', found);
      ipcRenderer.on('folder:find-progress', progress);
      return () => {
        ipcRenderer.removeListener('folder:found', found);
        ipcRenderer.removeListener('folder:find-progress', progress);
      };
    },
    places: () => ipcRenderer.invoke('folder:places'),
    newFile: (dir, name, opts) => ipcRenderer.invoke('folder:new-file', dir, name, opts),
    newFolder: (dir, name) => ipcRenderer.invoke('folder:new-folder', dir, name),
    rename: (from, name) => ipcRenderer.invoke('folder:rename', from, name),
    // `opts.onExists`: 'keep' (both, "name (2)"), 'replace' or 'skip' for names already in `dir`.
    // To, from or between servers they return { transfer: id } at once and go on in the
    // background (see `transfers`); otherwise [{ from, to }].
    move: (paths, dir, opts) => ipcRenderer.invoke('folder:move', paths, dir, opts),
    copy: (paths, dir, opts) => ipcRenderer.invoke('folder:copy', paths, dir, opts),
    // Which of these names are in `dir` already.
    existing: (dir, names) => ipcRenderer.invoke('folder:existing', dir, names),
    // Zip archives: the paths compressed into a .zip in `dir` (returns its path); one extracted into a new folder.
    zip: (paths, dir) => ipcRenderer.invoke('folder:zip', paths, dir),
    unzip: (file) => ipcRenderer.invoke('folder:unzip', file),
    // Copied or cut files on the system clipboard for the file explorer; whether they are still there.
    clipFiles: (paths, op) => ipcRenderer.invoke('folder:clip-files', paths, op),
    clipOurs: () => ipcRenderer.invoke('folder:clip-ours'),
    // Files pasted or dropped from other apps (File objects): copied into `dir`.
    copyIn(files, dir, opts) {
      const paths = [...files].map((file) => {
        try {
          return webUtils.getPathForFile(file);
        } catch {
          return '';
        }
      });
      return ipcRenderer.invoke('folder:copy-in', paths.filter(Boolean), dir, opts);
    },
    trash: (paths) => ipcRenderer.invoke('folder:trash', paths),
    // Copies to, from and between servers running in the background: their state now, a
    // stop, and every change (throttled while bytes move).
    transfers: () => ipcRenderer.invoke('transfer:list'),
    stopTransfer: (id) => ipcRenderer.invoke('transfer:stop', id),
    onTransfer(callback) {
      const listener = (_event, job) => callback(job);
      ipcRenderer.on('transfer:update', listener);
      return () => ipcRenderer.removeListener('transfer:update', listener);
    },
    openExternal: (file) => ipcRenderer.invoke('folder:open-external', file),
    readImage: (file) => ipcRenderer.invoke('folder:read-image', file),
    // For the preview: a picture's or PDF's bytes; the start of a text file ({ text, more }).
    peekBytes: (file) => ipcRenderer.invoke('folder:peek-bytes', file),
    peekText: (file) => ipcRenderer.invoke('folder:peek-text', file),
    // The folders shown (a path, or several side by side; null stops): 'folder:changed' tells.
    watch: (dirs) => ipcRenderer.invoke('folder:watch', dirs),
    onChanged(callback) {
      const listener = (_event, change) => callback(change);
      ipcRenderer.on('folder:changed', listener);
      return () => ipcRenderer.removeListener('folder:changed', listener);
    },
    // Ctrl+V in the page: a paste event with the files copied in other apps.
    paste: () => ipcRenderer.invoke('edit:paste'),
  },
  // The data on this computer in local mode: the folder Tracker shares (localStore.cjs), for localRepo.js.
  data: {
    get: (key) => ipcRenderer.invoke('data:get', key),
    put: (key, value) => ipcRenderer.invoke('data:put', key, value),
    cas: (key, expected, value) => ipcRenderer.invoke('data:cas', key, expected, value),
    del: (key) => ipcRenderer.invoke('data:del', key),
    list: (prefix) => ipcRenderer.invoke('data:list', prefix),
    info: () => ipcRenderer.invoke('data:info'),
    show: () => ipcRenderer.invoke('data:show'),
    onChanged(callback) {
      const listener = () => callback();
      ipcRenderer.on('data:changed', listener);
      ipcRenderer.send('data:watch');
      return () => ipcRenderer.removeListener('data:changed', listener);
    },
  },
  // Servers (SFTP, FTP, FTPS): files there are remote://<id>/<path> and go through disk and folders above.
  // Code across the folders shown: where a name is declared, symbols by name (Ctrl+T).
  code: {
    declarations: (dirs, word) => ipcRenderer.invoke('code:declarations', dirs, word),
    symbols: (dirs, query) => ipcRenderer.invoke('code:symbols', dirs, query),
  },
  // Git for folders on this computer: status, a file at the last commit.
  git: {
    status: (dir) => ipcRenderer.invoke('git:status', dir),
    head: (file) => ipcRenderer.invoke('git:head', file),
  },
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
    // The hosts in ~/.ssh/config, and setting some of them up (by their Host names).
    sshConfig: () => ipcRenderer.invoke('remote:ssh-config'),
    importSsh: (aliases) => ipcRenderer.invoke('remote:import-ssh', aliases),
    answerHostKey: (question, ok) => ipcRenderer.invoke('remote:host-key-answer', question, ok),
    // `answer`: { answers: [text], remember } or null to cancel.
    answerPrompt: (question, answer) => ipcRenderer.invoke('remote:prompt-answer', question, answer),
    onPrompt(callback) {
      const listener = (_event, info) => callback(info);
      ipcRenderer.on('remote:prompt', listener);
      return () => ipcRenderer.removeListener('remote:prompt', listener);
    },
    // A question not answered in time (the sign-in gave up): { question }.
    onPromptGone(callback) {
      const listener = (_event, info) => callback(info);
      ipcRenderer.on('remote:prompt-gone', listener);
      return () => ipcRenderer.removeListener('remote:prompt-gone', listener);
    },
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
  // Mirrors: a folder on a server kept the same as one here.
  mirrors: {
    list: () => ipcRenderer.invoke('mirror:list'),
    pickLocal: (suggested) => ipcRenderer.invoke('mirror:pick-local', suggested),
    save: (mirror) => ipcRenderer.invoke('mirror:save', mirror),
    delete: (id) => ipcRenderer.invoke('mirror:delete', id),
    // { confirmDeletes: [rel] } deletes those (deleted here) on the server too; { restore: [rel] } brings them back instead.
    sync: (id, opts) => ipcRenderer.invoke('mirror:sync', id, opts),
    onStatus(callback) {
      const listener = (_event, mirror) => callback(mirror);
      ipcRenderer.on('mirror:status', listener);
      return () => ipcRenderer.removeListener('mirror:status', listener);
    },
  },
  // Terminals on servers (SSH): a shell over the server's connection.
  terminal: {
    open: (connId, opts) => ipcRenderer.invoke('term:open', connId, opts),
    input: (id, data) => ipcRenderer.send('term:input', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('term:resize', id, cols, rows),
    close: (id) => ipcRenderer.invoke('term:close', id),
    // true while a terminal has the keys: the menu's shortcuts go to it.
    ownKeys: (own) => ipcRenderer.invoke('term:keys', own),
    onData(callback) {
      const listener = (_event, chunk) => callback(chunk);
      ipcRenderer.on('term:data', listener);
      return () => ipcRenderer.removeListener('term:data', listener);
    },
    onExit(callback) {
      const listener = (_event, info) => callback(info);
      ipcRenderer.on('term:exit', listener);
      return () => ipcRenderer.removeListener('term:exit', listener);
    },
  },
  // Language servers (lsp.cjs) for files here, on SSH servers and synced: the page names a file, never a program.
  lsp: {
    start: (path, opts) => ipcRenderer.invoke('lsp:start', path, opts),
    startNote: (key, name) => ipcRenderer.invoke('lsp:start-note', key, name),
    send: (id, message) => ipcRenderer.send('lsp:send', id, message),
    stop: (id) => ipcRenderer.invoke('lsp:stop', id),
    restart: (id) => ipcRenderer.invoke('lsp:restart', id),
    list: () => ipcRenderer.invoke('lsp:list'),
    // Servers the person adds: saving one asks in a native dialog (the page cannot add one alone).
    customList: () => ipcRenderer.invoke('lsp:custom-list'),
    customSave: (def) => ipcRenderer.invoke('lsp:custom-save', def),
    customRemove: (id) => ipcRenderer.invoke('lsp:custom-remove', id),
    onMessage(callback) {
      const listener = (_event, message) => callback(message);
      ipcRenderer.on('lsp:message', listener);
      return () => ipcRenderer.removeListener('lsp:message', listener);
    },
    onStatus(callback) {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('lsp:status', listener);
      return () => ipcRenderer.removeListener('lsp:status', listener);
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
