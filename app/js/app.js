import { html, useEffect, useMemo, useReducer, useRef, useState } from '../vendor/preact-htm.js';
import { createEditorHost, findLanguage, guessLanguage, PLAIN_TEXT } from './editor.js';
import { parseRoute, safeName } from './model.js';
import { getSettings, getToken, isSyncConfigured, onSettings, resolvedTheme, saveSettings } from './settings.js';
import { fileKey, flush, parseKey, repoKey, store } from './store.js';
import { getSyncState, onSyncResult, onSyncState, syncClient, syncNow } from './syncManager.js';
import { matchesScope, projectList } from './tracker-model.js';
import { AssistantPanel } from './ui/assistant.js';
import { Toasts, toast } from './ui/components.js';
import { FileDialog, SendDialog } from './ui/dialogs.js';
import { Icon } from './ui/icons.js';
import { QuickOpen, SearchPanel } from './ui/panels.js';
import { MarkdownPreview } from './ui/preview.js';
import { SettingsView } from './ui/settingsView.js';
import { Sidebar } from './ui/sidebar.js';
import { FileBar, StatusBar, SyncBadge, TabBar } from './ui/tabs.js';

const isNarrow = () => matchMedia('(max-width: 860px)').matches;
const looksBinary = (text) => text.slice(0, 8000).includes('\u0000');

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Everything the components need, in one place. */
function useActions({ hostRef, setView, setPanel, setDialog, setSidebar }) {
  return useMemo(() => {
    const activeFile = () => {
      const key = parseKey(store.session.active);
      return key?.kind === 'file' ? store.get(key.id) : null;
    };
    const actions = {
      toast,
      newFile(fields = {}) {
        const scope = getSettings().projectScope;
        const project = fields.project ?? (scope.length === 1 && scope[0].startsWith('project:') ? (projectList(store.live(), store.projects()).find((p) => `project:${p.key}` === scope[0])?.name ?? '') : '');
        store.create({ ...fields, project });
        setView('editor');
        if (isNarrow()) setSidebar(false);
        setTimeout(() => hostRef.current?.focus(), 30);
      },
      // Ids starting with "r:" are tracker documents (files elsewhere in the data repo).
      openFile(id, position = {}) {
        if (id.startsWith('r:')) return actions.openRepoFile(id.slice(2), position);
        const { line, column, length } = position;
        if (!store.get(id)) {
          toast('That file is not on this device yet. Sync, then try again.', { kind: 'error' });
          return;
        }
        store.open(fileKey(id));
        setView('editor');
        if (isNarrow()) setSidebar(false);
        if (line) setTimeout(() => hostRef.current?.reveal(line, column, length), 60);
      },
      async openRepoFile(path, { line, column, length } = {}) {
        const doc = store.doc(path);
        const tab = store.repoTab(path);
        if (tab && (tab.dirty || (doc && tab.baseSha === doc.sha))) store.open(repoKey(path));
        else {
          // The downloaded copy when there is one (works offline), else from GitHub.
          let file = doc && store.hasDocText(doc.sha) ? { text: store.cachedDocText(doc.sha), sha: doc.sha } : null;
          if (!file) {
            const settings = getSettings();
            const token = await getToken();
            if (!isSyncConfigured(settings) || !token) {
              toast('Set up sync in Settings to open files from the tracker.', { kind: 'error' });
              return;
            }
            try {
              file = await syncClient(settings, token).getFile(path, settings.branch || undefined);
              if (!file) throw new Error(`${path} is not in ${settings.owner}/${settings.repo}.`);
            } catch (err) {
              toast(err.message, { kind: 'error' });
              return;
            }
          }
          store.openRepoFile({ path, text: file.text, sha: file.sha });
          if (tab) hostRef.current?.replaceText(repoKey(path), file.text);
        }
        setView('editor');
        if (isNarrow()) setSidebar(false);
        if (line) setTimeout(() => hostRef.current?.reveal(line, column, length), 60);
      },
      activate(key) {
        store.open(key);
        setView('editor');
      },
      close(key) {
        const k = parseKey(key);
        const file = k?.kind === 'file' ? store.get(k.id) : null;
        hostRef.current?.drop(key);
        store.close(key);
        // Empty untitled tabs are not worth keeping.
        if (file && /^new \d+$/.test(file.name) && !store.text(file.id).trim() && !file.sha) store.remove(file.id);
      },
      reopenClosed: () => store.reopenClosed() || toast('No closed tabs to reopen'),
      cycleTab(step) {
        const { open, active } = store.session;
        if (open.length < 2) return;
        store.open(open[(open.indexOf(active) + step + open.length) % open.length]);
      },
      remove(id) {
        const previous = store.remove(id);
        hostRef.current?.drop(fileKey(id));
        if (previous) toast(`Deleted “${previous.file.name}”`, { action: { label: 'Undo', run: () => store.restore(previous) } });
      },
      patch(id, patch) {
        store.patch(id, patch);
        const file = store.get(id);
        if (file && ('name' in patch || 'language' in patch)) hostRef.current?.setLanguage(fileKey(id), file.name, file.language);
      },
      run: (name) => {
        try {
          hostRef.current?.run(name);
        } catch (err) {
          toast(name === 'formatJson' ? `Not valid JSON: ${err.message}` : err.message, { kind: 'error' });
        }
      },
      reveal: (line, column, length) => hostRef.current?.reveal(line, column, length),
      selectionText: () => hostRef.current?.selectionText() ?? '',
      sync: () => syncNow(),
      async importFiles(fileList) {
        let added = 0;
        for (const f of fileList) {
          if (f.size > 5 * 1024 * 1024) {
            toast(`${f.name} is larger than 5 MB`, { kind: 'error' });
            continue;
          }
          const text = await f.text();
          if (looksBinary(text)) {
            toast(`${f.name} is not a text file`, { kind: 'error' });
            continue;
          }
          actions.newFile({ name: safeName(f.name), text: text.replace(/\r\n?/g, '\n') });
          added++;
        }
        if (added > 1) toast(`Added ${added} files`);
      },
      async openFromDisk() {
        if (window.desktop?.openFiles) {
          const files = await window.desktop.openFiles();
          for (const f of files) actions.newFile({ name: safeName(f.name), text: f.text.replace(/\r\n?/g, '\n') });
          return;
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = () => actions.importFiles([...input.files]);
        input.click();
      },
      async saveCopy() {
        const key = parseKey(store.session.active);
        if (!key) return;
        const name = key.kind === 'file' ? store.get(key.id)?.name : store.repoTab(key.path)?.name;
        const text = key.kind === 'file' ? store.text(key.id) : store.repoTab(key.path)?.text;
        if (window.desktop?.saveFile) {
          const saved = await window.desktop.saveFile(name, text);
          if (saved) toast(`Saved a copy to ${saved}`);
        } else download(name, text);
      },
      activeFile,
      // Opens the local model panel and summarizes the active file.
      summarize() {
        setPanel('assistant');
        setTimeout(() => window.dispatchEvent(new CustomEvent('assistant', { detail: { action: 'summarize' } })), 50);
      },
      showSettings: () => setView('settings'),
      showEditor: () => setView('editor'),
      togglePanel: (name) => setPanel((p) => (p === name ? null : name)),
      setPanel,
      openDialog: setDialog,
      closeDialog: () => setDialog(null),
      toggleSidebar: () => setSidebar((s) => !s),
      setSidebar,
    };
    return actions;
  }, []);
}

export function App() {
  const [, rerender] = useReducer((x) => x + 1, 0);
  const [settings, setSettings] = useState(getSettings);
  const [sync, setSync] = useState(getSyncState);
  const [view, setView] = useState('editor');
  const [panel, setPanel] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [sidebar, setSidebar] = useState(() => !isNarrow());
  const [cursor, setCursor] = useState(null);
  const [preview, setPreview] = useState(() => new Set());
  const hostRef = useRef(null);
  const editorEl = useRef(null);
  const actions = useActions({ hostRef, setView, setPanel, setDialog, setSidebar });
  const editorOptions = (s) => ({ ...s, dark: resolvedTheme(s.theme) === 'dark' });

  // Re-render on store changes; typing only updates the unsynced markers, so throttle that.
  useEffect(() => {
    let timer = null;
    return store.subscribe((reason, detail) => {
      if (reason === 'text') {
        if (!timer) timer = setTimeout(() => ((timer = null), rerender()), 400);
        return;
      }
      if (reason === 'remote') {
        for (const id of detail.texts) hostRef.current?.replaceText(fileKey(id), store.text(id));
        for (const r of detail.repo) if (r.conflict) hostRef.current?.replaceText(repoKey(r.path), r.text);
      }
      if (reason === 'docs') for (const r of detail.refreshed) hostRef.current?.replaceText(repoKey(r.path), r.text);
      rerender();
    });
  }, []);
  useEffect(() => onSettings(setSettings), []);
  useEffect(() => onSyncState(setSync), []);
  useEffect(
    () =>
      onSyncResult((result) => {
        for (const c of result.conflicts) {
          const message =
            c.reason === 'edited' ? `“${c.name}” was edited on two devices; the other version is kept as this copy.`
            : c.reason === 'deleted' ? `A file you were editing was deleted on another device; your edits are kept as “${c.name}”.`
            : `${c.path.split('/').pop()} changed elsewhere; your edits are kept as “${c.name}”.`;
          toast(message, { timeout: 12000, action: { label: 'Open', run: () => actions.openFile(c.id) } });
        }
      }),
    [],
  );

  // The editor.
  useEffect(() => {
    hostRef.current = createEditorHost(editorEl.current, {
      settings: editorOptions(getSettings()),
      onChange(key, text) {
        const k = parseKey(key);
        if (k?.kind === 'repo') return store.setRepoText(k.path, text);
        const file = store.get(k.id);
        if (!file) return;
        const before = store.text(k.id);
        store.setText(k.id, text);
        // Pasted into a new tab: guess the language.
        if (!before.trim() && text.length > 20 && !file.language && !findLanguage(file.name)) {
          const guess = guessLanguage(text);
          if (guess) actions.patch(k.id, { language: guess });
        }
      },
      onCursor: setCursor,
      onShortcut(name) {
        if (name === 'sync') syncNow();
        if (name === 'toggleWrap') actions.toggleWrap?.();
        return true;
      },
    });
  }, []);
  useEffect(() => hostRef.current?.applySettings(editorOptions(settings)), [settings.theme, settings.wordWrap, settings.showWhitespace, settings.tabSize, settings.lineNumbers]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => hostRef.current?.applySettings(editorOptions(getSettings()));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const activeKey = store.session.active;
  const active = parseKey(activeKey);
  const activeFile = active?.kind === 'file' ? store.get(active.id) : null;
  const activeRepo = active?.kind === 'repo' ? store.repoTab(active.path) : null;
  const activeName = activeFile?.name ?? activeRepo?.name ?? '';
  const languageName = activeKey ? (findLanguage(activeName, activeFile?.language)?.name ?? PLAIN_TEXT) : '';
  const isMarkdown = languageName === 'Markdown';
  const showPreview = isMarkdown && preview.has(activeKey);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!activeKey || view !== 'editor' || (!activeFile && !activeRepo)) {
      host.hide();
      return;
    }
    host.show(activeKey, {
      text: activeFile ? store.text(activeFile.id) : activeRepo.text,
      name: activeName,
      language: activeFile?.language ?? '',
    });
    if (!isNarrow()) host.focus();
  }, [activeKey, view, Boolean(activeFile || activeRepo)]);

  actions.toggleWrap = () => saveSettings({ wordWrap: !getSettings().wordWrap });
  actions.togglePreview = () => {
    hostRef.current?.flushAll();
    setPreview((p) => {
      const next = new Set(p);
      next.has(activeKey) ? next.delete(activeKey) : next.add(activeKey);
      return next;
    });
  };

  // Another tab is taking over: hand it the text still waiting in the editor.
  useEffect(() => {
    const onFlush = () => hostRef.current?.flushAll();
    window.addEventListener('editor:flush', onFlush);
    return () => window.removeEventListener('editor:flush', onFlush);
  }, []);

  // Links: #/file/<id> opens a file, #/repo/<path> a file from the data repo.
  useEffect(() => {
    const take = () => {
      const route = parseRoute(location.hash);
      if (route.kind === 'none') {
        if (location.hash === '#/settings') setView('settings');
        return;
      }
      history.replaceState(null, '', location.pathname + location.search);
      if (route.kind === 'file') {
        if (store.get(route.id)) actions.openFile(route.id);
        else syncNow().then(() => actions.openFile(route.id));
      } else actions.openRepoFile(route.path);
    };
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, []);

  // Keyboard shortcuts that work in the browser too (the desktop menu adds Ctrl+N, Ctrl+W, …).
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && k === 'p') {
        e.preventDefault();
        setDialog({ type: 'quickOpen' });
      } else if (mod && e.shiftKey && k === 'f') {
        e.preventDefault();
        setPanel('search');
      } else if (mod && e.shiftKey && k === 'a') {
        e.preventDefault();
        setPanel((p) => (p === 'assistant' ? null : 'assistant'));
      } else if (mod && !e.shiftKey && k === 'b') {
        e.preventDefault();
        setSidebar((s) => !s);
      } else if (e.altKey && !mod && k === 'n') {
        e.preventDefault();
        actions.newFile();
      } else if (e.altKey && !mod && k === 'w') {
        e.preventDefault();
        if (store.session.active) actions.close(store.session.active);
      } else if (mod && k === 's') {
        e.preventDefault();
        syncNow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Desktop menu commands.
  useEffect(() => {
    if (!window.desktop?.onCommand) return;
    return window.desktop.onCommand(async (command) => {
      const run = {
        new: () => actions.newFile(),
        'open-disk': () => actions.openFromDisk(),
        'save-copy': () => actions.saveCopy(),
        'close-tab': () => store.session.active && actions.close(store.session.active),
        'reopen-tab': () => actions.reopenClosed(),
        'next-tab': () => actions.cycleTab(1),
        'prev-tab': () => actions.cycleTab(-1),
        'quick-open': () => setDialog({ type: 'quickOpen' }),
        find: () => actions.run('find'),
        replace: () => actions.run('replace'),
        'goto-line': () => actions.run('gotoLine'),
        'find-in-files': () => setPanel('search'),
        assistant: () => setPanel((p) => (p === 'assistant' ? null : 'assistant')),
        sync: () => syncNow(),
        settings: () => setView('settings'),
        'toggle-sidebar': () => setSidebar((s) => !s),
        'toggle-wrap': () => actions.toggleWrap(),
        flush: async () => {
          hostRef.current?.flushAll();
          await flush();
          if (store.pendingCount()) await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 5000))]);
          window.desktop.closeReady?.();
        },
      };
      if (command.startsWith('route:')) {
        location.hash = command.slice(6);
        return;
      }
      run[command]?.();
    });
  }, []);

  // Drop files onto the window to add them.
  useEffect(() => {
    const over = (e) => e.dataTransfer?.types?.includes('Files') && e.preventDefault();
    const drop = (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      actions.importFiles([...e.dataTransfer.files]);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const projects = projectList(store.live(), store.projects());
  const projectsByKey = new Map(projects.map((p) => [p.key, p]));
  const scoped = store.live().filter((f) => matchesScope(f, settings.projectScope, projectsByKey));
  const docs = store.docs();
  const scopedDocs = docs.filter((d) => matchesScope(d, settings.projectScope, projectsByKey));
  const narrow = isNarrow();

  // The editor view stays mounted (CodeMirror lives in it) and is only hidden while Settings is open.
  return html`<div class="app ${sidebar ? 'with-sidebar' : ''} ${panel ? 'with-panel' : ''} view-${view}">
    <header class="topbar">
      <button type="button" class="icon-btn" aria-label="Files" title="Files (Ctrl+B)" aria-pressed=${sidebar} onClick=${() => setSidebar(!sidebar)}><${Icon} name="sidebar" /></button>
      <span class="brand"><span class="brand-mark"><${Icon} name="code" size=${16} /></span><span class="brand-name">Tracker Editor</span></span>
      <button type="button" class="quick-open-btn" onClick=${() => setDialog({ type: 'quickOpen' })}>
        <${Icon} name="search" size=${16} /><span>Open a file…</span><kbd>Ctrl P</kbd>
      </button>
      <span class="spacer" />
      <button type="button" class="icon-btn" aria-label="New file" title="New file (Alt+N)" onClick=${() => actions.newFile()}><${Icon} name="plus" /></button>
      <button type="button" class="icon-btn" aria-label="Find in files" title="Find in files (Ctrl+Shift+F)" aria-pressed=${panel === 'search'} onClick=${() => actions.togglePanel('search')}><${Icon} name="search" /></button>
      ${settings.llm.enabled && html`<button type="button" class="icon-btn" aria-label="Assistant" title="Local model (Ctrl+Shift+A)" aria-pressed=${panel === 'assistant'} onClick=${() => actions.togglePanel('assistant')}><${Icon} name="sparkle" /></button>`}
      <${SyncBadge} sync=${sync} compact=${narrow} />
      <button type="button" class="icon-btn" aria-label="Settings" title="Settings" aria-pressed=${view === 'settings'} onClick=${() => setView(view === 'settings' ? 'editor' : 'settings')}><${Icon} name="settings" /></button>
    </header>

    ${sidebar && html`<${Sidebar} files=${scoped} docs=${scopedDocs} allFiles=${store.live()} projects=${projects} settings=${settings} activeKey=${activeKey} actions=${actions} />`}
    ${sidebar && narrow && html`<div class="scrim" onClick=${() => setSidebar(false)} />`}

    <main class="main">
      ${view === 'settings' && html`<${SettingsView} settings=${settings} sync=${sync} actions=${actions} />`}
      <div class="editor-view" hidden=${view === 'settings'}>
        <${TabBar} session=${store.session} actions=${actions} />
        ${activeKey && html`<${FileBar} file=${activeFile} repo=${activeRepo} projects=${projects} language=${languageName}
          isMarkdown=${isMarkdown} preview=${showPreview} settings=${settings} actions=${actions} />`}
        <div class="editor-area ${showPreview ? 'split' : ''}">
          <div class="editor-host" ref=${editorEl} />
          ${showPreview && html`<${MarkdownPreview} key=${activeKey} text=${activeFile ? store.text(activeFile.id) : activeRepo?.text}
            onToggle=${(next) => {
              if (activeFile) store.setText(activeFile.id, next);
              else store.setRepoText(activeRepo.path, next);
              hostRef.current?.replaceText(activeKey, next);
            }} />`}
          ${!activeKey && html`<${Welcome} actions=${actions} hasFiles=${store.live().length + docs.length > 0} configured=${isSyncConfigured(settings)} />`}
        </div>
        <${StatusBar} cursor=${activeKey ? cursor : null} language=${languageName} file=${activeFile} repo=${activeRepo} settings=${settings} sync=${sync} actions=${actions} />
      </div>
    </main>

    ${panel === 'search' && html`<${SearchPanel} files=${scoped} docs=${scopedDocs} allFiles=${store.live()} allDocs=${docs} openKeys=${store.session.open} settings=${settings} actions=${actions} onClose=${() => setPanel(null)} />`}
    ${panel === 'assistant' && html`<${AssistantPanel} files=${scoped} docs=${scopedDocs} activeFile=${activeFile} activeRepo=${activeRepo} settings=${settings} actions=${actions} onClose=${() => setPanel(null)} />`}

    ${dialog?.type === 'quickOpen' && html`<${QuickOpen} files=${store.live()} docs=${docs} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'file' && store.get(dialog.id) && html`<${FileDialog} file=${store.get(dialog.id)} projects=${projects} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'send' && store.get(dialog.id) && html`<${SendDialog} file=${store.get(dialog.id)} projects=${projects} settings=${settings} actions=${actions} onClose=${() => setDialog(null)} />`}
    <${Toasts} />
  </div>`;
}

function Welcome({ actions, hasFiles, configured }) {
  return html`<div class="welcome">
    <div class="welcome-card">
      <h1>No file open</h1>
      <p class="muted">Every tab is saved on this device as you type and synced to your GitHub data repo, so you can read it on your phone and other computers.</p>
      <div class="welcome-actions">
        <button type="button" class="btn primary" onClick=${() => actions.newFile()}><${Icon} name="plus" size=${16} />New file</button>
        ${hasFiles && html`<button type="button" class="btn" onClick=${() => actions.openDialog({ type: 'quickOpen' })}><${Icon} name="search" size=${16} />Open a file</button>`}
        <button type="button" class="btn" onClick=${() => actions.openFromDisk()}><${Icon} name="upload" size=${16} />Import files</button>
      </div>
      ${!configured && html`<p class="notice"><${Icon} name="cloudOff" size=${16} />Not syncing yet. <button type="button" class="btn link" onClick=${actions.showSettings}>Set up sync</button> with the same repo and token as the tracker (or paste its setup code).</p>`}
      <dl class="shortcuts">
        <div><dt><kbd>Alt</kbd> <kbd>N</kbd></dt><dd>New file</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>P</kbd></dt><dd>Open a file by name</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>F</kbd></dt><dd>Find in all files</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>F</kbd> / <kbd>H</kbd></dt><dd>Find / replace in this file</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>S</kbd></dt><dd>Sync now</dd></div>
      </dl>
    </div>
  </div>`;
}
