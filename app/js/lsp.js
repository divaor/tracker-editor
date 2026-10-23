// Language servers in the editor (desktop): one CodeMirror LSP client (vendor/cm/lsp.js,
// loaded when the first server starts) per server running in the main process (lsp.cjs),
// talking through the lsp:* IPC. The files are disk tabs on this computer:
// - our Workspace keeps a file open on the server while its tab is open, shown or not (the
//   editor swaps tab states in one view), and sends its text when it changed;
// - problems come pushed (publishDiagnostics) or are asked for after each change (pull,
//   as TypeScript 7 does) and reach the editor's own linter (serverProblems), so the
//   Problems list, F8 and the model's Explain / Fix work the same;
// - completion, hover and signature help are the client's; F12, Shift+F12 and F2 ask here
//   (definition, references, rename) and app.js shows the answers.
import DOMPurify from '../vendor/purify.js';
import { EditorView, keymap, languages, LanguageDescription, StateEffect, StateField, ViewPlugin } from '../vendor/cm/codemirror.js';
import { serverProblems } from './editor.js';
import { fileUri, locations, pathKey, progressText, toProblems } from './lspTools.js';

let lib = null; // the client's module, once loaded
const loadLib = async () => (lib ??= await import('../vendor/cm/lsp.js'));

const IDLE_STOP = 10 * 60 * 1000; // a server with no open file stops after this
const SYNC_WAIT = 400; // ms after typing before the server gets the text

// Code blocks in hovers and docs: highlighted with the language when it is loaded.
const highlightFor = (name) => LanguageDescription.matchLanguageName(languages, name, true)?.support?.language ?? null;

// Escape hides the parameters of the call (signature help) until the text changes, as in VS Code;
// the client has no key for it.
const hideSignature = StateEffect.define();
const signatureHidden = StateField.define({
  create: () => false,
  update: (hidden, tr) => (tr.effects.some((e) => e.is(hideSignature)) ? true : tr.docChanged ? false : hidden),
  provide: (field) => EditorView.editorAttributes.from(field, (hidden) => (hidden ? { class: 'cm-signature-hidden' } : {})),
});
const escapeSignature = [
  signatureHidden,
  keymap.of([
    {
      key: 'Escape',
      run: (view) => {
        if (view.state.field(signatureHidden) || !view.dom.querySelector('.cm-lsp-signature-tooltip')) return false;
        view.dispatch({ effects: hideSignature.of(null) });
        return true;
      },
    },
  ]),
];

// Requests from the server the client does not answer itself.
const ANSWERS = {
  'client/registerCapability': () => null,
  'client/unregisterCapability': () => null,
  'window/workDoneProgress/create': () => null,
  'window/showMessageRequest': () => null,
  'workspace/applyEdit': () => ({ applied: false, failureReason: 'Not supported yet' }),
};

/**
 * The language servers of the open disk tabs. `host`: the editor host; `onChange()`: their
 * state changed (the status bar, the panel); `onMessage(text, kind)`: a server's message
 * worth a toast; `openPath(path)`: shows a file (a definition in another file).
 */
export function createLanguageServers({ host, bridge = window.desktop?.lsp, onChange = () => {}, onMessage = () => {}, openPath }) {
  const servers = new Map(); // id → server
  const connecting = new Map(); // id → Promise<server>
  const tabs = new Map(); // key → { path, id, uri, languageId } | { path, pending } | { path, none } | { path, missing } | { path, stopped }
  if (!bridge) return null;

  bridge.onMessage(({ id, data }) => servers.get(id)?.deliver(data));
  bridge.onStatus((status) => {
    const s = servers.get(status.id);
    if (!s) return;
    s.state = status.state;
    s.message = status.message;
    if (status.state === 'removed') return removed(s, status.message);
    // The process was started again (after a crash, or Restart): initialize it again.
    if (status.generation > s.generation) {
      s.generation = status.generation;
      s.ready = false;
      s.tasks.clear();
      s.client.disconnect();
      s.client.connect(s.transport);
      watchInit(s);
    }
    onChange();
  });

  function removed(s, message) {
    servers.delete(s.id);
    clearTimeout(s.idle);
    s.client.disconnect();
    for (const [key, t] of tabs) {
      if (t.id !== s.id) continue;
      tabs.set(key, { path: t.path, stopped: message || `${s.info.server} stopped.` });
      host.setLanguageServer(key, []);
      host.refreshProblems(key);
    }
    onChange();
  }

  function watchInit(s) {
    const generation = s.generation;
    s.client.initializing.then(
      () => {
        if (s.generation !== generation) return;
        s.ready = true;
        s.failed = '';
        // Problems for the files open now, when the server is asked for them.
        for (const file of s.client.workspace.files) pull(s, file);
        onChange();
      },
      (err) => {
        if (s.generation !== generation) return;
        s.failed = err?.message ?? String(err);
        s.log.push(`[initialize] ${s.failed}`);
        onChange();
      },
    );
  }

  // ---- One server ----

  async function connect(info) {
    const { LSPClient, Workspace, ChangeSet } = await loadLib();
    const s = { id: info.id, info, state: info.state, message: info.message, generation: info.generation, ready: false, failed: '', tasks: new Map(), diags: new Map(), log: [], idle: null };
    const handlers = new Set();
    s.transport = {
      send: (message) => bridge.send(s.id, message),
      subscribe: (h) => handlers.add(h),
      unsubscribe: (h) => handlers.delete(h),
    };
    // From the server: requests the client leaves unanswered are answered here.
    s.deliver = (text) => {
      if (text.includes('"method"')) {
        let msg = null;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        // Settings the server asks for: the catalog's for its sections (lsp.cjs), else none.
        if (msg.id != null && msg.method === 'workspace/configuration') {
          const result = (msg.params?.items ?? []).map((item) => info.settings?.[item.section] ?? null);
          return bridge.send(s.id, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        }
        if (msg.id != null && ANSWERS[msg.method]) return bridge.send(s.id, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: ANSWERS[msg.method](msg.params) }));
      }
      for (const h of handlers) h(text);
    };
    const keyOfUri = (uri) => [...tabs].find(([, t]) => t.id === s.id && t.uri === uri)?.[0] ?? null;
    // A file's text now: its view's, else its tab's stored state.
    const docNow = (file) => {
      const key = keyOfUri(file.uri);
      return file.view ? file.view.state.doc : key ? host.stateOf(key)?.doc : null;
    };

    class TabWorkspace extends Workspace {
      constructor(client) {
        super(client);
        this.files = [];
      }
      // A tab's file stays open on the server while the tab is open; shown or not.
      openFile(uri, languageId, view) {
        const known = this.getFile(uri);
        if (known) {
          known.view = view;
          return;
        }
        const file = { uri, languageId, version: 0, doc: view.state.doc, view, getView: () => file.view };
        this.files.push(file);
        clearTimeout(s.idle);
        this.client.didOpen(file);
        pull(s, file);
      }
      closeFile(uri, view) {
        const file = this.getFile(uri);
        if (file?.view === view) file.view = null;
      }
      // A new server process (after a crash or Restart): the files as they are now.
      connected() {
        s.diags.clear();
        for (const file of this.files) {
          const doc = docNow(file);
          if (doc && doc !== file.doc) {
            file.doc = doc;
            file.version++;
          }
          if (file.view) lib.LSPPlugin.get(file.view)?.clear();
          this.client.didOpen(file);
        }
      }
      /** The tab was closed: the server forgets the file. */
      forget(uri) {
        const file = this.getFile(uri);
        if (!file) return;
        this.files = this.files.filter((f) => f !== file);
        s.diags.delete(uri);
        if (this.client.connected) this.client.didClose(uri);
        if (!this.files.length) {
          clearTimeout(s.idle);
          s.idle = setTimeout(() => bridge.stop(s.id), IDLE_STOP);
        }
      }
      // What changed since the server last got each file: the editor's own record of the
      // changes when it has one, else the whole text.
      syncFiles() {
        const updates = [];
        for (const file of this.files) {
          const doc = docNow(file);
          if (!doc || doc === file.doc) continue;
          const plugin = file.view ? lib.LSPPlugin.get(file.view) : null;
          const own = plugin && plugin.syncedDoc === file.doc && !plugin.unsyncedChanges.empty && plugin.unsyncedChanges.newLength === doc.length;
          const changes = own ? plugin.unsyncedChanges : ChangeSet.of([{ from: 0, to: file.doc.length, insert: doc }], file.doc.length);
          updates.push({ file, prevDoc: file.doc, changes });
          file.doc = doc;
          file.version++;
          plugin?.clear();
        }
        return updates;
      }
      async displayFile(uri) {
        const t = [...tabs.values()].find((x) => x.uri === uri);
        const path = t?.path ?? null;
        if (!path || !openPath) return null;
        await openPath(path);
        return host.viewFor(keyOfUri(uri));
      }
      updateFile(uri, update) {
        const key = keyOfUri(uri);
        if (key) host.applyChanges(key, update);
      }
    }

    s.client = new LSPClient({
      rootUri: fileUri(info.root),
      initializationOptions: info.init ?? undefined,
      workspace: (client) => new TabWorkspace(client),
      timeout: 15000,
      sanitizeHTML: (html) => DOMPurify.sanitize(html),
      highlightLanguage: highlightFor,
      notificationHandlers: {
        'textDocument/publishDiagnostics': (_client, params) => {
          const file = s.client.workspace.getFile(params.uri);
          if (file && params.version != null && params.version !== file.version) return true; // about an older text
          setProblems(s, params.uri, params.diagnostics);
          return true;
        },
        '$/progress': (_client, { token, value }) => {
          if (value?.kind === 'begin') s.tasks.set(token, { title: value.title, message: value.message, percentage: value.percentage });
          else if (value?.kind === 'report' && s.tasks.has(token)) s.tasks.set(token, { ...s.tasks.get(token), ...value });
          else if (value?.kind === 'end') s.tasks.delete(token);
          onChange();
          return true;
        },
        'window/logMessage': (_client, params) => {
          s.log.push(params.message);
          if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
          return true;
        },
        'window/showMessage': (_client, params) => {
          if (params.type <= 2) onMessage(`${info.server}: ${params.message}`, params.type === 1 ? 'error' : 'info');
          return true;
        },
      },
      extensions: [{ clientCapabilities: { window: { workDoneProgress: true }, workspace: { configuration: true }, textDocument: { publishDiagnostics: { versionSupport: true } } } }],
    });
    s.client.connect(s.transport);
    watchInit(s);
    servers.set(s.id, s);
    return s;
  }

  function setProblems(s, uri, items) {
    s.diags.set(uri, items ?? []);
    const key = [...tabs].find(([, t]) => t.id === s.id && t.uri === uri)?.[0];
    if (key) host.refreshProblems(key);
  }

  // Servers that answer only when asked (textDocument/diagnostic): asked after each change.
  async function pull(s, file) {
    if (!s.ready || !s.client.serverCapabilities?.diagnosticProvider) return;
    const ask = (file.asked = (file.asked ?? 0) + 1);
    try {
      const result = await s.client.request('textDocument/diagnostic', { textDocument: { uri: file.uri } });
      if (ask === file.asked && result?.kind === 'full') setProblems(s, file.uri, result.items);
    } catch {
      // cancelled or not supported after all: the push ones (if any) stay
    }
  }

  // In each tab with a server: its text goes to the server a moment after typing stops.
  const autoSync = (s, uri) =>
    ViewPlugin.fromClass(
      class {
        constructor() {
          this.timer = null;
        }
        update(u) {
          if (!u.docChanged) return;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            if (!s.client.connected) return;
            s.client.sync();
            const file = s.client.workspace.getFile(uri);
            if (file) pull(s, file);
          }, SYNC_WAIT);
        }
        destroy() {
          clearTimeout(this.timer);
        }
      },
    );

  const extensionFor = (s, uri, languageId) => [
    s.client.plugin(uri, languageId),
    lib.serverCompletion(),
    lib.hoverTooltips({ hoverTime: 350 }),
    lib.signatureHelp(),
    escapeSignature,
    autoSync(s, uri),
    serverProblems.of((state) => {
      const items = s.diags.get(uri);
      return items ? toProblems(items, state.doc.toString()) : [];
    }),
  ];

  const serverOf = (key) => {
    const t = tabs.get(key);
    return t?.id ? { s: servers.get(t.id), t } : null;
  };

  return {
    /** A disk tab on this computer, shown: its server (started when needed). */
    async attach(key, path) {
      const known = tabs.get(key);
      if (known && known.path === path) return;
      tabs.set(key, { path, pending: true });
      onChange();
      let info;
      try {
        info = await bridge.start(path);
      } catch (err) {
        if (tabs.get(key)?.path === path) tabs.set(key, { path, stopped: String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') });
        return onChange();
      }
      if (tabs.get(key)?.path !== path) return; // closed meanwhile
      if (info.none) return void tabs.set(key, { path, none: true }), onChange();
      if (info.missing) return void tabs.set(key, { path, missing: info.missing }), onChange();
      let s = servers.get(info.id);
      if (!s) {
        if (!connecting.has(info.id)) connecting.set(info.id, connect(info).finally(() => connecting.delete(info.id)));
        s = await connecting.get(info.id);
      }
      if (tabs.get(key)?.path !== path) return;
      const uri = fileUri(path);
      tabs.set(key, { path, id: s.id, uri, languageId: info.languageId });
      clearTimeout(s.idle);
      host.setLanguageServer(key, extensionFor(s, uri, info.languageId));
      onChange();
    },

    /** The tab was closed or its editor state dropped: the server forgets the file. */
    forget(key) {
      const t = tabs.get(key);
      tabs.delete(key);
      if (t?.id) servers.get(t.id)?.client.workspace.forget(t.uri);
      if (t) onChange();
    },

    /** Tries again: a server that stopped after crashes starts again; else (after Set up…) it is looked for again. */
    async retry(key) {
      const t = tabs.get(key);
      if (!t) return;
      if (t.id && servers.has(t.id)) {
        const s = servers.get(t.id);
        s.failed = '';
        await bridge.restart(t.id);
        return onChange();
      }
      tabs.delete(key);
      await this.attach(key, t.path);
    },

    has: (key) => Boolean(serverOf(key)?.s?.ready),

    /** For the status bar: { server, state, progress, message } | { missing } | { stopped } | { pending } | null. */
    statusOf(key) {
      const t = tabs.get(key);
      if (!t || t.none) return null;
      if (t.pending) return { pending: true };
      if (t.missing) return { missing: t.missing };
      if (t.stopped) return { stopped: t.stopped };
      const s = servers.get(t.id);
      if (!s) return null;
      if (s.failed || s.state === 'stopped') return { id: s.id, server: s.info.server, stopped: s.failed || s.message || `${s.info.server} stopped.` };
      const state = s.ready && s.state !== 'restarting' ? 'running' : s.state;
      return { id: s.id, server: s.info.server, language: s.info.language, state, progress: progressText(s.tasks), message: s.failed || s.message };
    },

    /** The running servers, for the panel: lsp.cjs's list with what the page knows. */
    async list() {
      const rows = await bridge.list();
      return rows.map((r) => {
        const s = servers.get(r.id);
        return { ...r, files: s?.client.workspace.files.length ?? 0, ready: Boolean(s?.ready), progress: s ? progressText(s.tasks) : '', log: s?.log.slice(-40) ?? [], failed: s?.failed ?? '' };
      });
    },
    /** Language servers turned off: every tab without one, every server stopped. */
    detachAll() {
      for (const [key] of tabs) host.setLanguageServer(key, []);
      tabs.clear();
      for (const s of [...servers.values()]) bridge.stop(s.id);
      onChange();
    },
    restart: (id) => bridge.restart(id),
    stop: (id) => bridge.stop(id),

    /**
     * Asks the server of a tab (`method` with the position `pos` in it): null when it has no
     * server or cannot do that; throws the server's error.
     */
    async request(key, method, pos, extra = {}, capability = '') {
      const found = serverOf(key);
      const state = host.stateOf(key);
      if (!found?.s?.ready || !state || (capability && !found.s.client.serverCapabilities?.[capability])) return null;
      found.s.client.sync();
      const line = state.doc.lineAt(pos);
      return found.s.client.request(method, { textDocument: { uri: found.t.uri }, position: { line: line.number - 1, character: pos - line.from }, ...extra });
    },
    locations,

    /** The open tab showing a file:// URI, if any. */
    keyOfUri(uri) {
      return [...tabs].find(([, t]) => t.uri === uri)?.[0] ?? null;
    },
    /** The text the server had for an open file when it answered (positions in answers refer to it). */
    syncedText(key) {
      const found = serverOf(key);
      return found?.s?.client.workspace.getFile(found.t.uri)?.doc.toString() ?? null;
    },
    pathKey,
  };
}
