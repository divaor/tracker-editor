import { html, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from '../vendor/preact-htm.js';
import { createEditorHost, findLanguage, guessLanguage, PLAIN_TEXT } from './editor.js';
import { onLaunchFiles, takeShared } from './inbox.js';
import { cleanModelName, filingMessages, isUntitled, MIN_NAMING_TEXT, nameFromHeading, namingMessages, parseFiling, uniqueName } from './naming.js';
import { llmClient } from './semantic.js';
import { fileLink, parseRoute, safeName } from './model.js';
import { fileVersions, versionName } from './versions.js';
import { formatDateTime } from './format.js';
import { previewKind } from './previews.js';
import { FORMATTABLE, formatText, formatterFor, guessFormatter } from './formatter.js';
import { getReaderState, onReaderState, setReaderHighlighter, startReading, stopReading, toggleReading } from './reader.js';
import { getSettings, getToken, isSyncConfigured, onSettings, resolvedTheme, saveSettings } from './settings.js';
import { diskKey, fileKey, flush, parseKey, repoKey, store } from './store.js';
import { diskAvailable, openDiskFiles, recheckServerTabs, reloadDiskTab, saveDiskTab, unwatchDisk, watchDiskTabs } from './diskTabs.js';
import { isRemotePath, kindOfKey, remoteAddress, remoteParts, remoteRoot } from './where.js';
import { onServers, server, watchServers } from './servers.js';
import { HostKeyDialog, PromptDialog, ServerDialog, SshImportDialog } from './ui/servers.js';
import { activeTerminal, focusTerminal, openTerminal, retheme, setToggleHandler, terminals, terminalsAvailable } from './terminals.js';
import { TerminalPanel } from './ui/terminal.js';
import { FolderSearchPanel } from './ui/folderSearch.js';
import { PropertiesDialog } from './ui/properties.js';
import { lastSyncText, mirror as mirrorById, onMirrors, watchMirrors as watchMirrorStatus } from './mirrors.js';
import { MirrorDeletesDialog, MirrorDialog, MirrorsDialog } from './ui/mirrors.js';
import { onTransfers, watchTransfers } from './transfers.js';
import { TransfersCard } from './ui/transfers.js';
import { baseName, besideSettings, claudeText, inPlaceSettings, opensInEditor, remapPath, withCurrent } from './folders.js';
import { draggedPaths, draggedTab, dropped, isOwnDrop } from './dragOut.js';
import { getSyncState, onSyncResult, onSyncState, syncClient, syncNow } from './syncManager.js';
import { matchesScope, projectList } from './tracker-model.js';
import { AssistantPanel } from './ui/assistant.js';
import { dismissToast, Toasts, toast } from './ui/components.js';
import { ChecklistDialog, FileDialog, SendDialog } from './ui/dialogs.js';
import { Icon } from './ui/icons.js';
import { QuickOpen, SearchPanel } from './ui/panels.js';
import { Preview } from './ui/preview.js';
import { HelpDialog } from './ui/help.js';
import { CompareView } from './ui/compare.js';
import { HistoryPanel } from './ui/history.js';
import { TrashDialog } from './ui/trash.js';
import { LockedFile } from './ui/encryption.js';
import { TypeOutPanel } from './ui/typeOut.js';
import { SnippetPicker } from './ui/snippets.js';
import { AssistBubble, AssistPanel } from './ui/askSelection.js';
import { resultExtension } from './selectionAsk.js';
import { OutlinePanel } from './ui/outline.js';
import { UsagesPanel } from './ui/usages.js';
import { ProblemsPanel } from './ui/problems.js';
import { DeclarationPicker, SymbolSearch } from './ui/symbols.js';
import { CommandPalette } from './ui/palette.js';
import { SYNTAX_LANGUAGES } from './problems.js';
import { DASHED_LANGUAGES, declarationKind, findDefinition, lineStart, occurrences, wordAt } from './codeNav.js';
import { FilterBar } from './ui/filterBar.js';
import { MacroDialog } from './ui/macro.js';
import { CloseDiskDialog, ReloadDiskDialog } from './ui/diskDialogs.js';
import { ClipboardHistory } from './ui/clipboardHistory.js';
import { OcrDialog } from './ui/ocr.js';
import { DictationBar, dictationSupported } from './ui/dictation.js';
import { joinDictated } from './dictation.js';
import { appendToInbox, findInbox, INBOX_NAME } from './capture.js';
import { snippetNameFrom } from './snippets.js';
import { linkName, resolveLink } from './outline.js';
import { prepareTyping, typingDelay } from './typing.js';
import { isSealed } from './crypto.js';
import { decodeFor, encodeFor, lock, onVault, openText, setUpVault, unlock, vaultState } from './vault.js';
import { ReadAloudBar } from './ui/readAloud.js';
import { ShareDialog } from './ui/share.js';
import { SettingsView } from './ui/settingsView.js';
import { Sidebar } from './ui/sidebar.js';
import { Splitter } from './ui/splitter.js';
import { FileBar, StatusBar, SyncBadge, TabBar } from './ui/tabs.js';

const isNarrow = () => matchMedia('(max-width: 860px)').matches;

// What the model may file a note under: your projects, and the tags in use (most used first).
function filingChoices() {
  const projects = projectList(store.live(), store.projects());
  const counts = new Map();
  for (const f of store.live()) for (const t of f.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return { projects, tags: [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t) };
}

/** Asks the local model to file a text: { name, project, tags } (name only when `name`), or null. */
async function askFiling(text, { ext = '', name = true } = {}) {
  const { llm } = getSettings();
  const choices = filingChoices();
  const reply = await llmClient().chat({ model: llm.chatModel, messages: filingMessages(text, { ext, name, ...choices }), purpose: name ? 'name' : 'file', signal: AbortSignal.timeout?.(60000), temperature: 0.2 });
  return parseFiling(reply, { ...choices, ext: ext || 'txt' });
}

// "Platform · #sql #reports"
const filedAs = ({ project, tags }) => [project, tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join(' · ');
const looksBinary = (text) => text.slice(0, 8000).includes('\u0000');
// "Error invoking remote method 'disk:read': Error: This is not a text file." → "This is not a text file."
const ipcMessage = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

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
// The folders open in Folders, for quick open: [{ dir, label, kind }] (desktop only).
const folderRoots = (settings) =>
  window.desktop?.folders
    ? withCurrent(settings.folderSections, settings.folder).map((dir) =>
        isRemotePath(dir) ? { dir, kind: 'remote', label: server(remoteParts(dir).id)?.name ?? 'Server' } : { dir, kind: 'disk', label: baseName(dir) },
      )
    : [];

function useActions({ hostRef, setView, setPanel, setDialog, setSidebar, setCompare, setUsagesOf, setSearchSeed }) {
  return useMemo(() => {
    const activeFile = () => {
      const key = parseKey(store.session.active);
      return key?.kind === 'file' ? store.get(key.id) : null;
    };
    // The open tab with its latest text: an editor file or a tracker document.
    const activeInfo = () => {
      const key = store.session.active;
      const k = parseKey(key);
      if (!k) return null;
      hostRef.current?.flushAll();
      if (k.kind === 'file') {
        const f = store.get(k.id);
        return f && { key, kind: 'file', id: f.id, name: f.name, language: f.language, project: f.project, tags: f.tags, dirty: f.dirty, text: store.text(f.id) };
      }
      if (k.kind === 'disk') {
        const d = store.diskTab(k.path);
        return d && { key, kind: 'disk', path: k.path, name: d.name, language: '', project: '', tags: [], dirty: d.dirty, text: d.text };
      }
      const tab = store.repoTab(k.path);
      return tab && { key, kind: 'repo', path: k.path, name: tab.name, language: '', project: store.doc(k.path)?.project ?? '', tags: store.doc(k.path)?.tags ?? [], dirty: tab.dirty, text: tab.text };
    };
    const syncedClient = async () => {
      const settings = getSettings();
      const token = await getToken();
      if (!isSyncConfigured(settings) || !token) throw new Error('Set up sync in Settings first: this comes from your GitHub data repo.');
      return { client: syncClient(settings, token), branch: settings.branch || undefined };
    };
    const actions = {
      toast,
      /** A new tab (its id). `focus: false` leaves the keyboard closed on phones (dictation). */
      newFile({ focus = true, ...fields } = {}) {
        const scope = getSettings().projectScope;
        const project = fields.project ?? (scope.length === 1 && scope[0].startsWith('project:') ? (projectList(store.live(), store.projects()).find((p) => `project:${p.key}` === scope[0])?.name ?? '') : '');
        const id = store.create({ ...fields, project });
        setView('editor');
        if (isNarrow()) setSidebar(false);
        if (focus) setTimeout(() => hostRef.current?.focus(), 30);
        return id;
      },
      // Ids starting with "r:" are tracker documents (files elsewhere in the data repo).
      openFile(id, position = {}) {
        if (id.startsWith('r:')) return actions.openRepoFile(id.slice(2), position);
        const { line, column, length } = position;
        if (!store.get(id)) {
          toast('That file is not on this device yet. Sync, then try again.', { kind: 'error' });
          return;
        }
        if (isNarrow()) setSidebar(false);
        // Already in the side view: go there.
        if (fileKey(id) === store.session.side && !isNarrow() && !line && hostRef.current?.focusSide()) return setView('editor');
        store.open(fileKey(id));
        setView('editor');
        if (line) setTimeout(() => hostRef.current?.reveal(line, column, length), 60);
      },
      /** Opens several files at once (Find in files): [{ id, line, column, length }], the first in front at its line. */
      async openFiles(list) {
        if (!list.length) return;
        hostRef.current?.flushAll();
        for (const f of list) {
          if (f.id.startsWith('r:')) await actions.openRepoFile(f.id.slice(2));
          else if (store.get(f.id)) store.open(fileKey(f.id), { silent: true });
        }
        const [first] = list;
        await actions.openFile(first.id, { line: first.line, column: first.column, length: first.length });
        // On a phone the panel covers the file.
        if (isNarrow()) setPanel(null);
        if (list.length > 1) toast(`Opened ${list.length} files`);
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
      /** A click on a tab: the side view's tab is focused there, any other shows in the main pane. */
      activate(key) {
        setView('editor');
        if (key === store.session.side && !isNarrow() && hostRef.current?.focusSide()) return;
        store.open(key);
      },
      /** Shows a tab in the main pane (from the side view too). */
      showInMain(key) {
        store.open(key);
        setView('editor');
      },
      closeSide: () => store.setSide(null),
      closeMany(keys) {
        for (const key of keys) actions.close(key);
      },
      close(key, { discard = false } = {}) {
        const k = parseKey(key);
        const file = k?.kind === 'file' ? store.get(k.id) : null;
        if (k?.kind === 'disk') {
          hostRef.current?.flushAll();
          // Unsaved changes to a file on disk: ask first.
          if (store.diskTab(k.path)?.dirty && !discard) return setDialog({ type: 'closeDisk', key });
          unwatchDisk(k.path);
        }
        hostRef.current?.drop(key);
        if (getReaderState().key === key) stopReading();
        store.close(key);
        // Empty untitled tabs are not worth keeping.
        if (file && /^new \d+$/.test(file.name) && !store.text(file.id).trim() && !file.sha) store.remove(file.id);
      },
      reopenClosed: () => store.reopenClosed() || toast('No closed tabs to reopen'),
      cycleTab(step) {
        const { active, side } = store.session;
        const open = store.session.open.filter((k) => k !== side);
        if (open.length < 2) return;
        store.open(open[(open.indexOf(active) + step + open.length) % open.length]);
      },
      remove(id) {
        const previous = store.remove(id);
        hostRef.current?.drop(fileKey(id));
        if (previous) toast(`Moved “${previous.file.name}” to the trash`, { action: { label: 'Undo', run: () => store.restore(previous) } });
      },
      patch(id, patch) {
        store.patch(id, patch);
        const file = store.get(id);
        if (file && ('name' in patch || 'language' in patch)) hostRef.current?.setLanguage(fileKey(id), file.name, file.language);
      },
      run: (name) => {
        if (name === 'format' || name === 'formatJson') return actions.formatDocument();
        try {
          hostRef.current?.run(name);
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      },
      /**
       * Format document (Shift+Alt+F): the selection, or the whole file, by its kind (formatter.js);
       * an edit Ctrl+Z takes back. Text with no known kind is formatted when it looks like JSON or XML.
       */
      // ---- Code: declarations and usages in the open file ----
      /** The name at the cursor in the pane typed in last: { ctx, word, from, to }, or null (says why). */
      codeWord() {
        const ctx = hostRef.current?.codeContext();
        if (!ctx) return null;
        const w = wordAt(ctx.text, ctx.pos, { dashes: DASHED_LANGUAGES.has(ctx.language) });
        if (!w) toast('Put the cursor on a name first.');
        return w && { ctx, ...w };
      },
      /** Goes to where the name at the cursor is declared (F12); on the declaration, lists its usages. */
      goToDefinition() {
        const w = actions.codeWord();
        if (!w) return;
        const found = findDefinition(w.ctx.text, w.word, w.from);
        if (!found) return actions.declarationElsewhere(w.word, w.ctx.key);
        if (found.from === w.from) return actions.findUsages();
        hostRef.current.selectRanges([found]);
      },
      /** Lists where the name at the cursor is used in this file (Shift+F12). */
      findUsages() {
        const w = actions.codeWord();
        if (!w) return;
        setUsagesOf({ word: w.word });
        setPanel('usages');
      },
      /** Selects every use of the name at the cursor, to retype them all at once (F2). */
      renameSymbol() {
        const w = actions.codeWord();
        if (w) actions.selectOccurrences(w.word, w.from);
      },
      /** Selects every use of `word` in the pane typed in last (the main cursor on the one at or after `near`). */
      selectOccurrences(word, near = null, key = null) {
        const ctx = hostRef.current?.codeContext(key);
        const found = ctx ? occurrences(ctx.text, word) : [];
        if (!found.length) return toast(`“${word}” is not in this file.`);
        const at = near ?? ctx.pos;
        hostRef.current.selectRanges(found, Math.max(0, found.findIndex((o) => o.to >= at)), ctx.key);
        toast(found.length > 1 ? `${found.length} × “${word}” selected: type the new name. Esc leaves one cursor.` : `“${word}” is used only here.`);
      },
      /** Selects `from`–`to` in the pane typed in last, or the one showing `key` (a usage). */
      revealRange: (from, to = from, key = null) => hostRef.current?.selectRanges([{ from, to }], 0, key),
      /** Goes to an outline entry ({ line, title }) in the pane typed in last, its name selected. */
      revealSymbol(entry) {
        const ctx = hostRef.current?.codeContext();
        if (!ctx) return;
        const from = lineStart(ctx.text, entry.line);
        const lineText = ctx.text.slice(from, ctx.text.indexOf('\n', from) === -1 ? undefined : ctx.text.indexOf('\n', from));
        const at = lineText.indexOf(entry.title);
        hostRef.current.selectRanges([at === -1 ? { from, to: from } : { from: from + at, to: from + at + entry.title.length }]);
      },
      /** Lists the classes, functions and sections of this file to jump to (Ctrl+P, then @). */
      gotoSymbol: () => setDialog({ type: 'quickOpen', query: '@' }),
      /** Ctrl+T: a class, function or section in any file (yours, and those in the folders open in Folders). */
      gotoSymbolAll: (query = '') => setDialog({ type: 'symbols', query }),
      /** Opens a place: { id } of your files or { path } on disk or a server, at line and column; `title` is selected there. */
      openAt(place) {
        const position = { line: place.line, column: place.column ?? 1, length: place.title?.length ?? 0 };
        return place.id ? actions.openFile(place.id, position) : actions.openDiskPath(place.path, position);
      },
      /**
       * F12 when the name is not declared in the open file: your other files, then the files in the
       * folders open in Folders (read in the main process). One place opens; several are listed.
       */
      async declarationElsewhere(word, fromKey) {
        const places = [];
        for (const f of store.live()) {
          if (fileKey(f.id) === fromKey) continue;
          const text = store.text(f.id);
          if (!text.includes(word)) continue;
          for (const o of occurrences(text, word, { limit: 500 })) {
            if (declarationKind(o.text, o.column, word) === 'strong') places.push({ id: f.id, fileName: f.name, line: o.line, column: o.column, text: o.text.trim().slice(0, 200) });
          }
        }
        const roots = folderRoots(getSettings());
        if (roots.length && window.desktop?.code) {
          toast(`Looking for “${word}” in your folders…`, { key: 'declarations', timeout: 4000 });
          const found = await window.desktop.code.declarations(roots.map((r) => r.dir), word).catch(() => ({ found: [] }));
          dismissToast('declarations');
          const here = fromKey?.startsWith('d:') ? fromKey.slice(2) : '';
          // The nearest to the open file first (the most of its path in common).
          const near = (p) => {
            let n = 0;
            while (n < p.length && p[n] === here[n]) n++;
            return n;
          };
          places.push(...found.found.filter((f) => f.path !== here).sort((a, b) => near(b.path) - near(a.path)));
        }
        if (!places.length) {
          return toast(`No declaration of “${word}” found in this file, your files${roots.length ? ' or your folders' : ''}.`, { key: 'declarations', action: { label: 'Find in all files', run: () => actions.findEverywhere(word) }, timeout: 8000 });
        }
        if (places.length === 1) return actions.openAt({ ...places[0], title: word });
        setDialog({ type: 'declarations', word, places: places.slice(0, 60) });
      },
      /** Find in files with `word` as a whole word. */
      findEverywhere(word) {
        setSearchSeed({ query: word, wholeWord: true, at: Date.now() });
        setPanel('search');
      },

      async formatDocument() {
        const now = activeInfo();
        if (!now) return;
        const disk = now.kind === 'disk' ? store.diskTab(now.path) : null;
        if (disk?.follow || disk?.truncated) return toast('This tab is read-only (followed, or the end of a large file).');
        if (now.kind === 'file' && store.isSealed(now.id)) return;
        const sel = hostRef.current?.selectionInfo();
        const part = sel && sel.key === now.key && sel.from !== sel.to ? sel : null;
        const source = part ? part.text : now.text;
        if (!source.trim()) return;
        const formatter = formatterFor(now.name, findLanguage(now.name, now.language)?.name ?? '') ?? guessFormatter(source);
        if (!formatter) return toast(`No formatter for this kind of file. Pick its language in the status bar; these can be formatted: ${FORMATTABLE}.`, { timeout: 8000 });
        if (source.length > 5 * 1024 * 1024 && !['json', 'xml'].includes(formatter.kind)) return toast('This is too large to format here.');
        const { tabSize = 4 } = getSettings();
        let out;
        try {
          out = await formatText(source, formatter, { tabSize });
        } catch (err) {
          toast(`Not formatted as ${formatter.label}: ${err.message}`, { kind: 'error', timeout: 9000 });
          if (!part && err.line) hostRef.current?.reveal(err.line, err.column ?? 1, 1);
          return;
        }
        if (part) out = out.replace(/\n$/, '');
        if (out === source) return toast(`Already formatted (${formatter.label})`);
        const done = part ? hostRef.current?.replaceRange(now.key, part.from, part.to, part.text, out) : hostRef.current?.setTextAsEdit(now.key, out);
        if (!done) return toast('The text changed meanwhile; format it again.');
        toast(`Formatted ${part ? 'the selection ' : ''}as ${formatter.label}`, { action: { label: 'Undo', run: () => hostRef.current?.run('undo') } });
      },
      reveal: (line, column, length) => hostRef.current?.reveal(line, column, length),
      selectionText: () => hostRef.current?.selectionText() ?? '',
      sync: () => syncNow(),
      async importFiles(fileList) {
        let added = 0;
        // Images: their text is read instead.
        const images = fileList.filter((f) => f.type?.startsWith('image/'));
        if (images.length) actions.readImages(images.map((blob) => ({ blob, name: blob.name || 'Image' })));
        for (const f of fileList.filter((x) => !images.includes(x))) {
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
        return added;
      },
      // Text or files shared from another app: each becomes a new file that syncs like the rest.
      async importShared({ title = '', text = '', url = '', files = [] }) {
        const added = files.length ? await actions.importFiles(files) : 0;
        const body = [text.trim(), url && !text.includes(url) ? url : ''].filter(Boolean).join('\n\n');
        if (body) {
          const name = title.trim() ? safeName(title.trim().slice(0, 80)) : undefined;
          actions.newFile({ name, text: body, language: (name && findLanguage(name)) ? '' : (guessLanguage(body) ?? '') });
        }
        if (added + (body ? 1 : 0) === 1) toast('Saved what you shared as a new file. It syncs like your other files.');
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
      activeInfo,

      /** The local model suggests a project and tags for the active file (Undo puts back what it had). */
      async suggestFiling() {
        const now = activeInfo();
        if (now?.kind !== 'file') return;
        const { llm } = getSettings();
        if (!llm.enabled || !llm.chatModel) return toast('Turn on the local model in Settings first.', { kind: 'error' });
        if (!now.text.trim()) return toast('Write something first: the model files a note by what it says.');
        toast('Asking the local model…', { timeout: 2500 });
        let filing;
        try {
          filing = await askFiling(now.text, { ext: findLanguage(now.name, now.language)?.extensions?.[0] ?? '', name: false });
        } catch (err) {
          return toast(err.message, { kind: 'error' });
        }
        const file = store.get(now.id);
        if (!file || (!filing?.project && !filing?.tags.length)) return toast('The model had no project or tags to suggest.');
        const before = { project: file.project, tags: file.tags };
        const next = { project: filing.project || file.project, tags: filing.tags.length ? filing.tags : file.tags };
        actions.patch(file.id, next);
        toast(`Filed under ${filedAs(next)}`, { action: { label: 'Undo', run: () => actions.patch(file.id, before) } });
      },

      // ---- Asking the model about the selection (Ctrl+K) ----

      /** What the model panel asks about: the selection of the pane typed in last, or its whole file. */
      assistContext() {
        const host = hostRef.current;
        host?.flushAll();
        const sel = host?.selectionInfo();
        if (!sel) return toast('Open a file first.'), null;
        const k = parseKey(sel.key);
        const file = k.kind === 'file' ? store.get(k.id) : null;
        const name = file?.name ?? (k.kind === 'disk' ? store.diskTab(k.path) : store.repoTab(k.path))?.name ?? '';
        const language = findLanguage(name, file?.language)?.name ?? '';
        const whole = sel.from === sel.to;
        const text = whole ? sel.doc() : sel.text;
        if (!text.trim()) return toast('There is nothing to ask about yet.'), null;
        return { key: sel.key, from: whole ? 0 : sel.from, to: whole ? sel.docLength : sel.to, text, whole, name, language };
      },
      /** The model's new version of the text (for `action`), as a comparison to accept, keep as a new file, or copy. */
      proposeReplacement(context, text, action) {
        const label = action.label;
        if (store.session.active !== context.key) store.open(context.key);
        const asNewFile = () => {
          setCompare(null);
          const base = context.name.replace(/\.[^.]+$/, '') || 'Untitled';
          const ext = resultExtension(action) || /\.([^.]+)$/.exec(context.name)?.[1] || 'txt';
          actions.newFile({ name: uniqueName(safeName(`${base} - ${label}.${ext}`), store.live().map((f) => f.name)), text });
        };
        const accept = () => {
          setCompare(null);
          setTimeout(() => {
            if (!hostRef.current?.replaceRange(context.key, context.from, context.to, context.text, text)) {
              toast('The text changed meanwhile, so it was left as it is. Ask again, or copy the new version.', { kind: 'error' });
              return;
            }
            toast(`${label}: done`, { action: { label: 'Undo', run: () => hostRef.current?.run('undo') } });
          }, 0);
        };
        setCompare({
          key: context.key,
          name: context.name,
          language: context.language,
          left: { label: context.whole ? 'Now' : 'The selection now', text: context.text },
          right: { label, text },
          actions: [
            { label: 'Accept', icon: 'check', primary: true, run: accept },
            { label: 'As a new file', icon: 'filePlus', run: asNewFile },
            { label: 'Copy', icon: 'copy', run: () => navigator.clipboard.writeText(text).then(() => toast('Copied')) },
          ],
        });
      },
      /** An answer put below the text it is about. */
      insertAfter(context, answer) {
        if (store.session.active !== context.key) store.open(context.key);
        setTimeout(() => {
          if (!hostRef.current?.insertBelow(context.key, context.to, answer)) return toast('The file is not open any more. Copy the answer instead.', { kind: 'error' });
          toast('Added below', { action: { label: 'Undo', run: () => hostRef.current?.run('undo') } });
        }, 0);
      },
      /** An answer from the model panel kept as a Markdown note. */
      answerAsNote(context, label, answer) {
        const quote = context.text.length > 600 ? `${context.text.slice(0, 600)}…` : context.text;
        const name = uniqueName(safeName(`${label} - ${context.name.replace(/\.[^.]+$/, '')}.md`), store.live().map((f) => f.name));
        actions.newFile({ name, text: `# ${label}: ${context.name}\n\n\`\`\`\n${quote}\n\`\`\`\n\n${answer}\n` });
      },

      // ---- Files on disk (desktop) ----

      async openDiskFiles() {
        if (!diskAvailable()) return toast('Editing files on disk works in the desktop app.', { kind: 'error' });
        const problems = await openDiskFiles();
        setView('editor');
        for (const p of problems) toast(p, { kind: 'error' });
      },
      /** Ctrl+S: saves a file on disk, or syncs. */
      async saveOrSync() {
        hostRef.current?.flushAll();
        const k = parseKey(store.session.active);
        if (k?.kind !== 'disk') return syncNow();
        await actions.saveDisk(k.path);
      },
      async saveDisk(path, { force = false } = {}) {
        hostRef.current?.flushAll();
        try {
          const result = await saveDiskTab(path, { force });
          if (result === 'conflict') toast(`The file changed ${isRemotePath(path) ? 'on the server' : 'on disk'} since you opened it, so it was not saved. Reload it, or keep yours and save over it.`, { kind: 'error', timeout: 10000 });
          return result;
        } catch (err) {
          // A server that cannot be reached: the file bar says so, with Reconnect.
          if (!store.diskTab(path)?.offline) toast(ipcMessage(err), { kind: 'error', timeout: 8000 });
          return 'error';
        }
      },
      async reloadDisk(path) {
        try {
          hostRef.current?.replaceText(diskKey(path), await reloadDiskTab(path));
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      },
      /** Follow mode (tail -f): new lines appear as they are written; the tab is read-only meanwhile. */
      followDisk(path, on) {
        const tab = store.diskTab(path);
        if (!tab) return;
        if (on && tab.dirty) return toast('Save or reload the file first: following shows the file as it is on disk.');
        store.diskPatch(path, { follow: on });
        hostRef.current?.setReadOnly(diskKey(path), on || tab.truncated);
        if (on) actions.reloadDisk(path).then(() => hostRef.current?.appendText(diskKey(path), '', { follow: true }));
      },
      /** A file that changed on disk while edited here: what is on disk (left) against your edits. */
      async compareDisk(path) {
        hostRef.current?.flushAll();
        const tab = store.diskTab(path);
        if (!tab) return;
        let onDisk;
        try {
          onDisk = (await window.desktop.disk.read(path)).text;
        } catch (err) {
          return toast(err.message, { kind: 'error' });
        }
        if (store.session.active !== diskKey(path)) store.open(diskKey(path));
        setCompare({
          key: diskKey(path),
          name: tab.name,
          language: '',
          left: { label: isRemotePath(path) ? 'On the server now' : 'On disk now', text: onDisk },
          right: { label: 'Your edits', text: tab.text },
          actions: [
            { label: 'Use the disk version', icon: 'rotate', run: () => (setCompare(null), actions.reloadDisk(path)) },
            { label: 'Keep mine and save', icon: 'save', primary: true, run: () => (setCompare(null), actions.saveDisk(path, { force: true })) },
          ],
        });
      },
      /** Shows a file in the file explorer; one on a server, in the folders view at its folder. */
      showOnDisk(path) {
        if (!isRemotePath(path)) return window.desktop?.disk?.show(path);
        actions.showInFolders(path.slice(0, path.lastIndexOf('/')) || remoteRoot(remoteParts(path).id));
      },
      /** Connects to a server again (its tabs are looked at again when it is back). */
      async reconnectServer(id) {
        try {
          await window.desktop.remote.connect(id);
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error', timeout: 8000 });
        }
      },
      /** Adds a server ({}), or edits one. */
      editServer: (conn = {}) => setDialog({ type: 'server', conn }),
      /** Servers from ~/.ssh/config. */
      importSshConfig: () => setDialog({ type: 'sshImport' }),
      /** Properties (and permissions) of a file or folder here or on a server. */
      showProperties: (path) => setDialog({ type: 'properties', path }),

      // ---- Mirrors: a server folder kept the same as one here ----
      newMirror: (draft) => setDialog({ type: 'mirror', draft }),
      editMirror: (m) => setDialog({ type: 'mirror', draft: m }),
      showMirrors: () => setDialog({ type: 'mirrors' }),
      reviewMirror: (id) => setDialog({ type: 'mirrorDeletes', id }),
      /** Syncs a mirror now (connecting), and says what it did. */
      async syncMirror(id, opts = {}) {
        try {
          const summary = await window.desktop.mirrors.sync(id, opts);
          const done = lastSyncText({ uploaded: summary.uploaded, downloaded: summary.downloaded, deletedLocal: summary.deletedLocal, deletedRemote: summary.deletedRemote, conflicts: summary.conflicts.length });
          if (summary.errors.length) toast(`Synced, but not everything: ${summary.errors[0]}${summary.errors.length > 1 ? ` (and ${summary.errors.length - 1} more)` : ''}`, { kind: 'error', timeout: 12000 });
          else if (summary.waiting.length) setDialog({ type: 'mirrorDeletes', id });
          else toast(done ? `Synced: ${done}.` : 'Synced: nothing to change.', { timeout: summary.conflicts.length ? 12000 : 4000 });
          if (summary.conflicts.length) toast(`${summary.conflicts[0].rel.split('/').pop()} changed on both sides: yours kept its name, the server’s is next to it as “${summary.conflicts[0].copy.split('/').pop()}”.`, { timeout: 15000 });
          window.dispatchEvent(new CustomEvent('folders:reload'));
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error', timeout: 10000 });
        }
      },
      /** A folder here or on a server in the folders view (connecting to the server first). */
      async showFolder(path) {
        try {
          if (isRemotePath(path)) await window.desktop.remote.connect(remoteParts(path).id);
          actions.showInFolders(path);
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error', timeout: 8000 });
        }
      },
      /** Opens a server in the folders view. */
      async openServer(id, { beside = false } = {}) {
        try {
          const { root } = await window.desktop.remote.connect(id);
          actions.showInFolders(root, { beside });
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error', timeout: 8000 });
        }
      },
      /** A copy of a disk file as one of the editor's files (synced); the file on disk stays as it is. */
      async copyToFiles(path) {
        const tab = store.diskTab(path);
        try {
          const { name, text } = tab ?? (await window.desktop.disk.read(path));
          actions.newFile({ name, text });
          toast(`${name} is now also in your files, and syncs. The file on disk is not changed.`);
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error' });
        }
      },
      /** A file in a folder of the folders view, opened as a tab on disk (the tab is activated when it is open already). */
      /** Returns null when it opened, otherwise the reason (shown unless `report` is false). */
      async openDiskPath(path, { report = true, line, column, length } = {}) {
        hostRef.current?.flushAll();
        try {
          if (!store.diskTab(path)) {
            store.openDiskFile(await window.desktop.disk.read(path));
            await window.desktop.disk.watch(path);
          } else store.open(diskKey(path));
          setView('editor');
          if (isNarrow()) setSidebar(false);
          // At a line (Find in a folder).
          if (line) setTimeout(() => hostRef.current?.reveal(line, column, length), 60);
          return null;
        } catch (err) {
          if (report) toast(`${path.split(/[\\/]/).pop()}: ${ipcMessage(err)}`, { kind: 'error' });
          return ipcMessage(err);
        }
      },
      /** Two files on disk side by side: the second opens in a tab, compared with the first. */
      async compareDiskFiles(a, b) {
        let left;
        try {
          left = await window.desktop.disk.read(a);
        } catch (err) {
          return toast(`${a.split(/[\\/]/).pop()}: ${ipcMessage(err)}`, { kind: 'error' });
        }
        if (await actions.openDiskPath(b)) return;
        const tab = store.diskTab(b);
        setCompare({ key: diskKey(b), name: tab.name, language: '', left: { label: left.name, text: left.text }, right: { label: tab.name, text: tab.text }, actions: [] });
      },
      /** Open tabs follow files and folders renamed or moved in the folders view ([{ from, to }]). */
      followDiskMoves(moves) {
        hostRef.current?.flushAll();
        for (const tab of store.diskTabs()) {
          const to = moves.map((m) => remapPath(tab.path, m.from, m.to)).find(Boolean);
          if (!to || !store.renameDiskTab(tab.path, to)) continue;
          // The tab's editor state is made again under its new path (its unsaved text is kept).
          hostRef.current?.drop(diskKey(tab.path));
          unwatchDisk(tab.path);
          window.desktop.disk.watch(to).catch(() => {});
        }
      },
      /** Files deleted in the folders view: their tabs close, unless they have unsaved edits (those stay, as not on disk). */
      closeDiskPaths(paths) {
        hostRef.current?.flushAll();
        for (const tab of store.diskTabs()) {
          if (!paths.some((p) => remapPath(tab.path, p, p) !== null)) continue;
          if (tab.dirty) store.diskPatch(tab.path, { missing: true });
          else actions.close(diskKey(tab.path), { discard: true });
        }
      },
      /** Images in a folder: their text is read, to keep next to them or elsewhere. */
      async readImageFiles(paths, dir) {
        try {
          const images = [];
          for (const path of paths) images.push({ blob: new Blob([await window.desktop.folders.readImage(path)]), name: path.split(/[\\/]/).pop() });
          if (images.length) setDialog({ type: 'ocr', images, saveTo: dir });
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error' });
        }
      },
      /** Text kept as a new file in a folder (a free name), opened as a file on disk. */
      async saveTextInFolder(dir, name, text) {
        try {
          const file = await window.desktop.folders.newFile(dir, name, { text, unique: true });
          await actions.openDiskPath(file);
          toast(`Saved as ${file.split(/[\\/]/).pop()}`);
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error' });
        }
      },
      /** Picks a folder in the system dialog (starting at `defaultPath`) and shows it in the folders view. */
      /** Picks a folder in the system dialog and shows it (`beside`: next to the folders open in the tree). */
      async openFolder(defaultPath, { beside = false } = {}) {
        if (!window.desktop?.folders) return toast('Folders work in the desktop app.', { kind: 'error' });
        const picked = await window.desktop.folders.pick(defaultPath);
        if (!picked) return null;
        actions.showInFolders(picked, { beside });
        return picked;
      },
      /** A folder in the folders view: in place of the one shown, or beside the others (`beside`). */
      showInFolders(path, { beside = false } = {}) {
        const patch = beside ? besideSettings(getSettings(), path) : inPlaceSettings(getSettings(), path);
        if (patch.already) toast(`${path === patch.already ? 'That folder is' : 'It is inside a folder that is'} open in the tree already.`);
        delete patch.already;
        saveSettings({ sidebarMode: 'folders', ...patch });
        setSidebar(true);
      },
      /** Ctrl+Shift+E: the folders view (a folder is picked first when there is none yet). */
      async showFolders() {
        if (!window.desktop?.folders) return;
        if (!(await window.desktop.folders.roots()).length) return actions.openFolder();
        saveSettings({ sidebarMode: 'folders' });
        setSidebar(true);
      },

      // ---- Tabs to other apps (and Claude) ----

      /** A tab's name and text ({ name, text, path } with `path` for a file on disk), or null. */
      tabContent(key) {
        hostRef.current?.flushAll();
        const k = parseKey(key);
        if (k?.kind === 'file') {
          const f = store.get(k.id);
          return f && !store.isSealed(k.id) ? { name: f.name, text: store.text(k.id), encrypted: f.encrypted } : null;
        }
        if (k?.kind === 'disk') {
          const d = store.diskTab(k.path);
          // A file on a server goes as a copy (other apps cannot reach it there).
          return d && { name: d.name, text: d.text, path: d.missing || isRemotePath(d.path) ? '' : d.path, dirty: d.dirty };
        }
        const t = k && store.repoTab(k.path);
        return t && { name: t.name, text: t.text };
      },
      tabText: (key) => actions.tabContent(key)?.text ?? '',
      /**
       * What a tab dragged out of the window carries: a file on disk as itself
       * ({ path }), the others as a copy ({ name, text }). Encrypted files are
       * not written out (null: the tab only moves within the bar).
       */
      dragOutItem(key) {
        const c = actions.tabContent(key);
        if (!c || c.encrypted) return null;
        if (c.path) {
          if (c.dirty) toast('Not saved: the file on disk does not have your latest edits.', { timeout: 6000 });
          return { path: c.path };
        }
        return { name: c.name, text: c.text };
      },
      /** The path of a file on disk for Claude Code, or the name and text of the others. */
      async copyForClaude(key) {
        const c = actions.tabContent(key);
        if (!c) return;
        try {
          await navigator.clipboard.writeText(claudeText(c));
          toast(c.path ? 'The path is on the clipboard: paste it into Claude' : `${c.name} is on the clipboard, name and text: paste it into Claude`);
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      },
      /** A path on the clipboard; `claude`: quoted when needed, as a terminal takes it. A file on a server: user@host:/path. */
      async copyPath(path, { claude = false } = {}) {
        if (isRemotePath(path)) path = remoteAddress(path, server(remoteParts(path).id));
        await navigator.clipboard.writeText(claude ? claudeText({ path }) : path).catch(() => {});
        toast(claude ? 'The path is on the clipboard: paste it into Claude' : 'Path copied');
      },

      // ---- Text from images (OCR) ----

      /** Reads the text in images ([{ blob, name }]) on this device, to insert or keep. */
      readImages(images) {
        if (!images.length) return;
        hostRef.current?.flushAll();
        setDialog({ type: 'ocr', images });
      },
      /** Picks images (on a phone: the camera or the gallery). */
      imageToText() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.onchange = () => actions.readImages([...input.files].map((blob) => ({ blob, name: blob.name })));
        input.click();
      },
      /** Desktop: drag around part of the screen, then read its text. */
      async screenshotToText() {
        if (!window.desktop?.ocr) return actions.imageToText();
        try {
          const png = await window.desktop.ocr.snip();
          if (png) actions.readImages([{ blob: new Blob([png], { type: 'image/png' }), name: 'Screenshot' }]);
        } catch (err) {
          toast(err.message, { kind: 'error', timeout: 10000 });
        }
      },

      // ---- Quick capture and the clipboard history (desktop) ----

      openClipboardHistory() {
        if (!window.desktop?.clipboardHistory) return toast('The clipboard history works in the desktop app.', { kind: 'error' });
        setDialog({ type: 'clipboard' });
      },
      /** Notes from the quick capture window, waiting in the main process. */
      async takeCaptures() {
        const taken = (await window.desktop?.capture?.take().catch(() => [])) ?? [];
        for (const capture of taken) actions.saveCapture(capture);
      },
      /** A captured note: a new file (not opened, so what you are doing is not interrupted), or added to the Inbox. */
      saveCapture({ text, mode, at }) {
        const when = new Date(at || Date.now());
        if (mode === 'inbox') {
          hostRef.current?.flushAll();
          const inbox = findInbox(store.live());
          if (inbox && !store.isSealed(inbox.id)) {
            const next = appendToInbox(store.text(inbox.id), text, when);
            store.setText(inbox.id, next, { urgent: true });
            hostRef.current?.replaceText(fileKey(inbox.id), next);
            return toast(`Added to ${inbox.name}`, { action: { label: 'Open', run: () => actions.openFile(inbox.id) } });
          }
          if (!inbox) {
            const id = store.create({ name: INBOX_NAME, text: appendToInbox('', text, when), open: false });
            return toast(`Added to a new ${INBOX_NAME}`, { action: { label: 'Open', run: () => actions.openFile(id) } });
          }
          // An Inbox locked on this device: kept as a note of its own instead.
        }
        const id = store.create({ text: `${text.replace(/\s+$/, '')}\n`, open: false });
        toast('Captured as a new note', { action: { label: 'Open', run: () => actions.openFile(id) } });
      },

      // ---- [[Links]] and the outline ----

      /** Opens the file a [[link]] names, or offers to create it. */
      openLink(target) {
        const file = resolveLink(target, store.live());
        if (file) return actions.openFile(file.id);
        const name = safeName(/\.[a-z0-9]{1,8}$/i.test(target) ? target : `${target}.md`);
        toast(`No file is called “${target}” yet.`, { action: { label: 'Create it', run: () => actions.newFile({ name, text: `# ${target}\n\n` }) } });
      },
      toggleOutline: () => setPanel((p) => (p === 'outline' ? null : 'outline')),

      // ---- Snippets ----

      /** The snippet picker; what is selected now fills {{selection}}. */
      openSnippets() {
        const host = hostRef.current;
        host?.flushAll();
        setDialog({ type: 'snippets', selection: host?.snapshot() ? host.selectionText() : '' });
      },
      /** Text at the cursor of the open file, or a new file when none is open. */
      insertText(text, cursor = text.length) {
        setView('editor');
        if (!hostRef.current?.insertAtCursor(text, cursor)) actions.newFile({ text });
      },
      /** The selection (or the file) as a new snippet. */
      saveSnippet() {
        const now = activeInfo();
        if (!now) return;
        const text = hostRef.current?.selectionText() || now.text;
        if (!text.trim()) return toast('Select the text to keep as a snippet first.');
        const name = uniqueName(snippetNameFrom(text), store.live().map((f) => f.name));
        actions.newFile({ name, text, project: now.project, snippet: true });
        toast('Saved as a snippet (Alt+I to use it). Write {{name}} where a value changes.', { timeout: 9000 });
      },
      toggleSnippet(id) {
        const file = store.get(id);
        if (!file) return;
        actions.patch(id, { snippet: !file.snippet });
        toast(file.snippet ? `“${file.name}” is a normal file again.` : `“${file.name}” is a snippet now: Alt+I inserts it.`);
      },

      // ---- Encryption ----

      /** Sets the passphrase for this data repo (the first device), or unlocks this one. */
      async setUpEncryption(passphrase) {
        const { client, branch } = await syncedClient();
        await setUpVault(client, branch, passphrase, getSettings().device || 'unknown device');
        toast('Encryption is ready. Choose Encrypt in a file’s menu to protect it.');
      },
      async unlockEncryption(passphrase) {
        await unlock(passphrase);
        // The files kept sealed here can be read now.
        for (const id of store.sealedIds()) {
          const text = await decodeFor(store.get(id), store.sealedText(id)).catch(() => null);
          if (text !== null && !isSealed(text)) store.unseal(id, text);
        }
      },
      /** Forgets the passphrase here and keeps only the ciphertext of encrypted files on this device. */
      async lockDevice() {
        hostRef.current?.flushAll();
        const encrypted = () => store.live().filter((f) => f.encrypted && !store.isSealed(f.id));
        if (encrypted().some((f) => f.dirty || f.pending)) await syncNow();
        if (encrypted().some((f) => f.dirty)) throw new Error('Some encrypted files have changes not synced yet. Sync, then lock.');
        for (const file of encrypted()) {
          const cipher = await encodeFor(file, store.text(file.id));
          hostRef.current?.drop(fileKey(file.id));
          store.seal(file.id, cipher);
        }
        await lock();
      },
      /** Turns encryption on or off for a file; its text is uploaded again at the next sync. */
      setEncrypted(id, on) {
        const file = store.get(id);
        if (!file) return;
        const { exists, unlocked } = vaultState();
        if (!unlocked) {
          toast(exists ? 'Unlock encryption with your passphrase first.' : 'Set a passphrase first: Settings, Encryption.', { action: { label: 'Settings', run: () => setView('settings') } });
          return;
        }
        store.patch(id, { encrypted: on });
        store.markDirty(id);
        toast(on ? `“${file.name}” is stored encrypted from the next sync. Earlier versions in your repo’s history stay readable.` : `“${file.name}” is stored as plain text from the next sync.`, { timeout: 9000 });
      },

      /** Brings a file back from the trash, with the text kept here or the one in the data repo. */
      async restoreDeleted(file) {
        let text = await store.trashText(file.id);
        if (text === null && file.sha) {
          try {
            const { client } = await syncedClient();
            text = await client.getBlobText(file.sha);
          } catch (err) {
            toast(err.message, { kind: 'error' });
            return false;
          }
        }
        if (typeof text !== 'string') {
          toast('The text of that file is not on this device or in the data repo.', { kind: 'error' });
          return false;
        }
        // Encrypted: readable when this device is unlocked, else it comes back locked.
        if (isSealed(text) && vaultState().unlocked) text = await openText(text).catch(() => text);
        store.restore({ file, text });
        setView('editor');
        toast(`Restored “${file.name}”`);
        return true;
      },

      // ---- History and comparing ----
      showHistory() {
        hostRef.current?.flushAll();
        setPanel('history');
      },
      async loadVersions({ id, path }) {
        const { client, branch } = await syncedClient();
        return fileVersions(client, { branch, id, path });
      },
      async compareVersion(target, version) {
        let loaded;
        try {
          loaded = await version.load();
        } catch (err) {
          toast(err.message, { kind: 'error' });
          return;
        }
        if (!loaded) return toast('The file was deleted in that version.');
        try {
          loaded = { ...loaded, text: await openText(loaded.text) };
        } catch (err) {
          return toast(err.message, { kind: 'error' });
        }
        const now = activeInfo();
        if (!now || now.key !== target.key) return;
        const text = loaded.text;
        const when = `${formatDateTime(version.date)}${version.who ? ` · ${version.who}` : ''}`;
        // On a phone the panel covers the comparison.
        if (matchMedia('(max-width: 860px)').matches) setPanel(null);
        setCompare({
          key: now.key,
          sha: version.sha,
          name: now.name,
          language: now.language,
          left: { label: when, text },
          right: { label: 'Now', text: now.text },
          actions: [
            { label: 'Restore this version', icon: 'rotate', primary: true, run: () => actions.restoreText(now.key, text, when) },
            { label: 'Copy', icon: 'copy', run: () => navigator.clipboard.writeText(text).then(() => toast('This version is on the clipboard')) },
            {
              label: 'Open as a new file',
              icon: 'filePlus',
              run: () => {
                setCompare(null);
                actions.newFile({ name: versionName(loaded.name || now.name, version.date), text, project: now.project, tags: now.tags, encrypted: Boolean(store.get(now.id)?.encrypted) });
              },
            },
          ],
        });
      },
      compareWith() {
        hostRef.current?.flushAll();
        setDialog({ type: 'quickOpen', pick: 'compare' });
      },
      async compareWithEntry(entry) {
        const now = activeInfo();
        if (!now) return;
        let other = entry.id.startsWith('r:') ? store.docText(entry.id.slice(2)) : store.text(entry.id);
        if (other === null) {
          try {
            const { client, branch } = await syncedClient();
            other = (await client.getFile(entry.id.slice(2), branch))?.text ?? '';
          } catch (err) {
            return toast(err.message, { kind: 'error' });
          }
        }
        setCompare({ key: now.key, name: now.name, language: now.language, left: { label: entry.name, text: other }, right: { label: now.name, text: now.text }, actions: [] });
      },
      /** Puts `text` into a tab as your own edit (saved at once; Undo or Ctrl+Z takes it back). */
      restoreText(key, text, label, message = `Restored the version from ${label}`) {
        setCompare(null);
        if (store.session.active !== key) store.open(key);
        setTimeout(() => {
          if (!hostRef.current?.setTextAsEdit(key, text)) return;
          toast(message, { action: { label: 'Undo', run: () => hostRef.current?.run('undo') } });
        }, 0);
      },
      /** The clipboard compared with the open file; its text can replace the file's. */
      async compareWithClipboard() {
        const now = activeInfo();
        if (!now) return;
        let clip;
        try {
          clip = await navigator.clipboard.readText();
        } catch {
          return toast('The clipboard could not be read here. Allow it, or paste into a new file and use Compare with….', { kind: 'error' });
        }
        if (!clip) return toast('The clipboard has no text.');
        setCompare({
          key: now.key,
          name: now.name,
          language: now.language,
          left: { label: 'Clipboard', text: clip },
          right: { label: now.name, text: now.text },
          actions: [{ label: 'Use the clipboard text', icon: 'rotate', run: () => actions.restoreText(now.key, clip, '', 'Replaced the text with the clipboard') }],
        });
      },
      /** The checklist in the selection (or the file) as tracker tasks. */
      sendChecklist() {
        const now = activeInfo();
        if (now?.kind !== 'file') return;
        const sel = hostRef.current?.selectionInfo();
        const whole = !sel || sel.from === sel.to;
        const text = whole ? now.text : sel.text;
        const firstLine = whole ? 1 : now.text.slice(0, sel.from).split('\n').length;
        setDialog({ type: 'checklist', id: now.id, text, firstLine });
      },

      // Reads the active tab aloud from the cursor (or just the selection); again to pause or resume.
      readAloud() {
        if (getReaderState().status !== 'idle') return toggleReading();
        const host = hostRef.current;
        host?.flushAll();
        const snap = host?.snapshot();
        if (!snap) return;
        const k = parseKey(snap.key);
        const file = k.kind === 'file' ? store.get(k.id) : null;
        const name = file?.name ?? store.repoTab(k.path)?.name ?? '';
        const markdown = findLanguage(name, file?.language)?.name === 'Markdown';
        try {
          startReading({ key: snap.key, name, text: snap.text, markdown, from: snap.from, to: snap.to });
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
      },
      share() {
        hostRef.current?.flushAll();
        setDialog({ type: 'share' });
      },
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
  const [usagesOf, setUsagesOf] = useState(null); // { word }: the Usages panel
  // Problems as you type, per tab: key → { list, language } (only for the languages checked).
  const [problems, setProblems] = useState({});
  const [searchSeed, setSearchSeed] = useState(null); // what Find in files starts with
  const [dialog, setDialog] = useState(null);
  const [sidebar, setSidebar] = useState(() => !isNarrow());
  const [cursor, setCursor] = useState(null);
  // The open tab is in the lighter editor for very large files.
  const [big, setBig] = useState(false);
  const [preview, setPreview] = useState(() => new Set());
  // The preview in the editor's place (Full view) instead of next to the text.
  const [previewFull, setPreviewFull] = useState(false);
  const areaEl = useRef(null);
  const splitDrag = useRef({ width: 1, start: 0, ratio: 0.5 });
  const [compare, setCompare] = useState(null);
  const hostRef = useRef(null);
  const editorEl = useRef(null);
  const actions = useActions({ hostRef, setView, setPanel, setDialog, setSidebar, setCompare, setUsagesOf, setSearchSeed });
  const editorOptions = (s) => ({ ...s, dark: resolvedTheme(s.theme) === 'dark' });

  // Re-render on store changes; typing only updates the unsynced markers, so throttle that.
  useEffect(() => {
    let timer = null;
    return store.subscribe((reason, detail) => {
      if (reason === 'text' || (reason === 'disk' && detail?.text)) {
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
  useEffect(() => onVault(rerender), []);
  // Reading aloud highlights the passage in the editor; problems become a message.
  useEffect(() => {
    setReaderHighlighter((key, range) => hostRef.current?.highlightReading(key, range));
    return onReaderState((s) => s.status === 'idle' && s.error && toast(s.error, { kind: 'error' }));
  }, []);
  useEffect(() => onSyncState(setSync), []);
  // Servers (desktop): their status shows on tabs; when one connects again, its tabs are looked at again.
  useEffect(() => {
    const offStatus = watchServers({ onConnected: recheckServerTabs });
    const offList = onServers(rerender);
    return () => (offStatus(), offList());
  }, []);
  // Mirrors (desktop): their status; an automatic sync waiting on deletions says so once.
  useEffect(() => {
    const off = watchMirrorStatus();
    const seen = new Map();
    const offList = onMirrors((list) => {
      for (const m of list) {
        const key = `mirror-waiting:${m.id}`;
        if (m.state === 'waiting' && seen.get(m.id) !== 'waiting') toast(`${m.waiting.length} file${m.waiting.length === 1 ? ' was' : 's were'} deleted in ${m.local.split(/[\\/]/).pop()}: delete on the server too?`, { key, timeout: 60000, action: { label: 'Review', run: () => actions.reviewMirror(m.id) } });
        if (m.state !== 'waiting' && seen.get(m.id) === 'waiting') dismissToast(key);
        seen.set(m.id, m.state);
      }
      rerender();
    });
    return () => (off(), offList());
  }, []);
  // Transfers (desktop): to and from servers, in the background. A move that got there
  // takes its open tabs along.
  useEffect(() => {
    const off = watchTransfers();
    const offList = onTransfers((_jobs, job) => {
      if (job?.op === 'move' && job.state !== 'running' && job.result?.length) actions.followDiskMoves(job.result.map(({ from, to }) => ({ from, to })));
    });
    return () => (off(), offList());
  }, []);
  const [hostKey, setHostKey] = useState(null);
  useEffect(() => window.desktop?.remote?.onHostKey(setHostKey), []);
  // Questions while signing in (a password not saved, a one-time code), one at a time.
  const [prompts, setPrompts] = useState([]);
  useEffect(() => {
    const remote = window.desktop?.remote;
    if (!remote) return;
    const offAsk = remote.onPrompt((info) => setPrompts((list) => [...list, info]));
    const offGone = remote.onPromptGone?.(({ question }) => setPrompts((list) => list.filter((p) => p.question !== question)));
    return () => (offAsk(), offGone?.());
  }, []);
  const answerPrompt = (info, answer) => {
    window.desktop.remote.answerPrompt(info.question, answer);
    setPrompts((list) => list.filter((p) => p.question !== info.question));
  };
  // Files on servers set to save automatically: a moment after the last edit.
  useEffect(() => {
    const timers = new Map();
    return store.subscribe((reason, detail) => {
      if (reason !== 'disk' || !detail?.text || !isRemotePath(detail.path) || !server(remoteParts(detail.path).id)?.autoSave) return;
      clearTimeout(timers.get(detail.path));
      timers.set(
        detail.path,
        setTimeout(async () => {
          const tab = store.diskTab(detail.path);
          if (!tab?.dirty || tab.conflict || tab.saving || tab.follow) return;
          hostRef.current?.flushAll();
          // Not reached: the tab says so, and the edits wait on this device.
          const result = await saveDiskTab(detail.path).catch(() => null);
          if (result === 'conflict') toast(`${tab.name} changed on the server, so it was not saved. Compare, reload, or keep yours.`, { kind: 'error', timeout: 10000 });
        }, 1500),
      );
    });
  }, []);
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

  // The editor. Layout effects (here and for switching tabs) run in the same
  // render, so keys typed right after opening a tab go to that tab.
  useLayoutEffect(() => {
    hostRef.current = createEditorHost(editorEl.current, {
      settings: editorOptions(getSettings()),
      onOpenLink: (target) => actions.openLink(target),
      // An image pasted or dropped into the text: read its text.
      onImage: (file) => actions.readImages([{ blob: file, name: file.name || 'Pasted image' }]),
      linkTargets: () => store.live().map((f) => linkName(f.name)),
      onChange(key, text, { urgent } = {}) {
        const k = parseKey(key);
        if (k?.kind === 'repo') return store.setRepoText(k.path, text, { urgent });
        if (k?.kind === 'disk') return store.setDiskText(k.path, text, { urgent });
        const file = store.get(k.id);
        if (!file) return;
        const before = store.text(k.id);
        store.setText(k.id, text, { urgent });
        // Pasted into a new tab: guess the language.
        if (!before.trim() && text.length > 20 && !file.language && !findLanguage(file.name)) {
          const guess = guessLanguage(text);
          if (guess) actions.patch(k.id, { language: guess });
        }
      },
      onCursor: setCursor,
      onProblems(key, list, language) {
        const checked = language === 'JSON' || SYNTAX_LANGUAGES.has(language);
        setProblems((all) => {
          const was = all[key];
          if (!checked) return was ? (({ [key]: _gone, ...rest }) => rest)(all) : all;
          if (was && was.language === language && JSON.stringify(was.list) === JSON.stringify(list)) return all;
          return { ...all, [key]: { list, language } };
        });
      },
      onShortcut(name) {
        // Ctrl+S is handled by the window's key handler (saveOrSync), which sees it too.
        if (name === 'toggleWrap') actions.toggleWrap?.();
        if (name === 'format') actions.formatDocument?.();
        if (name === 'definition') actions.goToDefinition();
        if (name === 'usages') actions.findUsages();
        if (name === 'renameSymbol') actions.renameSymbol();
        return true;
      },
    });
  }, []);
  useEffect(
    () => hostRef.current?.applySettings(editorOptions(settings)),
    [settings.theme, settings.wordWrap, settings.showWhitespace, settings.tabSize, settings.lineNumbers, settings.problems, settings.indentGuides, settings.bracketColors, settings.stickyScroll, settings.detectIndent, settings.indentChosen, settings.emmet, settings.linkedTags],
  );
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
  const activeDisk = active?.kind === 'disk' ? store.diskTab(active.path) : null;
  const activeName = activeFile?.name ?? activeRepo?.name ?? activeDisk?.name ?? '';
  // The text of the open tab, whatever its kind.
  const activeText = () => (activeFile ? store.text(activeFile.id) : (activeRepo ?? activeDisk)?.text ?? '');
  const languageName = activeKey ? (findLanguage(activeName, activeFile?.language)?.name ?? PLAIN_TEXT) : '';
  const previewType = activeKey ? previewKind(activeName, languageName) : '';
  // An encrypted file this device cannot read yet shows a lock instead of the editor.
  const activeSealed = Boolean(activeFile && store.isSealed(activeFile.id));
  const showPreview = Boolean(previewType) && preview.has(activeKey) && !compare && !activeSealed;
  // A comparison belongs to its tab.
  useEffect(() => {
    if (compare && compare.key !== activeKey) setCompare(null);
  }, [activeKey]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!activeKey || view !== 'editor' || (!activeFile && !activeRepo && !activeDisk) || activeSealed) {
      host.hide();
      return;
    }
    host.show(activeKey, {
      text: activeText(),
      name: activeName,
      language: activeFile?.language ?? '',
    });
    // A followed file, or the tail of a huge one, is read-only.
    if (activeDisk) host.setReadOnly(activeKey, Boolean(activeDisk.follow || activeDisk.truncated));
    setBig(host.isBig(activeKey));
    if (!isNarrow()) host.focus();
  }, [activeKey, view, Boolean(activeFile || activeRepo || activeDisk), activeSealed]);

  actions.toggleWrap = () => saveSettings({ wordWrap: !getSettings().wordWrap });
  actions.toggleProblems = () => setPanel((p) => (p === 'problems' ? null : 'problems'));
  /** Ctrl+Shift+P: every command by name (as in VS Code). */
  actions.commandPalette = (query = '') => setDialog((d) => (d?.type === 'palette' ? null : { type: 'palette', query }));
  // ---- Indentation of the open tab ----
  const rememberIndent = (key, indent) => {
    const chosen = { ...getSettings().indentChosen };
    delete chosen[key];
    if (indent) chosen[key] = indent;
    // The last 300 picked are kept.
    saveSettings({ indentChosen: Object.fromEntries(Object.entries(chosen).slice(-300)) });
  };
  /** Tabs or spaces, or a width ({ tabs?, size? }) for the open tab; null: from its text again. */
  actions.setIndent = (patch) => {
    const key = store.session.active;
    const host = hostRef.current;
    if (!key || !host) return;
    if (patch === null) {
      rememberIndent(key, null);
      host.setIndentation(key, null);
      editorConfigs.current.delete(key);
      lookUpEditorConfig(key);
      return;
    }
    const now = host.indentation(key);
    const next = { tabs: patch.tabs ?? now.tabs, size: patch.size ?? now.size };
    rememberIndent(key, next);
    host.setIndentation(key, { ...next, source: 'chosen' });
  };
  /** Changes the open tab's indentation to tabs or spaces (an edit Ctrl+Z takes back). */
  actions.convertIndent = (toTabs) => {
    const key = store.session.active;
    const host = hostRef.current;
    if (!key || !host) return;
    const changed = host.convertIndentation(key, toTabs);
    rememberIndent(key, { tabs: toTabs, size: host.indentation(key).size });
    toast(changed ? `${changed.toLocaleString()} line${changed === 1 ? '' : 's'} now indented with ${toTabs ? 'tabs' : 'spaces'}` : `It is indented with ${toTabs ? 'tabs' : 'spaces'} already`);
  };
  // Files on disk and on servers: the indentation their .editorconfig gives them (looked up
  // once per file; given again to a tab opened anew).
  const editorConfigs = useRef(new Map()); // key → Promise of { tabs, size } or null
  const lookUpEditorConfig = (key) => {
    if (!key?.startsWith('d:') || !window.desktop?.disk?.editorConfig) return;
    if (!editorConfigs.current.has(key)) editorConfigs.current.set(key, window.desktop.disk.editorConfig(key.slice(2)).catch(() => null));
    editorConfigs.current.get(key).then((found) => {
      const host = hostRef.current;
      const now = host?.indentation(key);
      if (!found || !now || now.source === 'chosen' || now.source === 'editorconfig') return;
      host.setIndentation(key, { tabs: found.tabs ?? now.tabs, size: found.size ?? now.size, source: 'editorconfig' });
    });
  };
  useEffect(() => lookUpEditorConfig(activeKey), [activeKey]);
  // ---- Git: files on this computer in a repository ----
  // The text at the last commit gives the editor its bar of changed lines; the branch goes
  // to the status bar. Asked when a tab shows and when the window comes back (a commit
  // made elsewhere).
  const [gitHeads, setGitHeads] = useState({}); // key → { branch, root, tracked } or null
  const lookUpGit = (key) => {
    if (!key?.startsWith('d:') || isRemotePath(key.slice(2)) || !window.desktop?.git) return;
    window.desktop.git.head(key.slice(2)).then(
      (head) => {
        hostRef.current?.setGitBase(key, head?.text ?? null);
        const next = head ? { branch: head.branch, root: head.root, tracked: head.text !== null } : null;
        setGitHeads((all) => (JSON.stringify(all[key]) === JSON.stringify(next) ? all : { ...all, [key]: next }));
      },
      () => {},
    );
  };
  useEffect(() => lookUpGit(activeKey), [activeKey]);
  useEffect(() => {
    const onFocus = () => lookUpGit(store.session.active);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  /** The open file next to its text at the last commit (Git). */
  actions.compareWithHead = async (path = null) => {
    const key = path ? diskKey(path) : store.session.active;
    if (!key?.startsWith('d:') || !window.desktop?.git) return;
    if (path && store.session.active !== key && (await actions.openDiskPath(path))) return;
    const head = await window.desktop.git.head(key.slice(2)).catch(() => null);
    if (!head) return toast('This file is not in a Git repository.');
    if (head.text === null) return toast('This file is new: it is not in the last commit yet.');
    hostRef.current?.flushAll();
    const tab = store.diskTab(key.slice(2));
    if (!tab) return;
    setCompare({ key, name: tab.name, language: '', left: { label: `Last commit (${head.branch || 'Git'})`, text: head.text }, right: { label: `${tab.name} now`, text: tab.text }, actions: [] });
  };
  actions.togglePreview = () => {
    hostRef.current?.flushAll();
    // The preview takes the side view's place.
    if (!preview.has(activeKey)) store.setSide(null);
    else setPreviewFull(false);
    setPreview((p) => {
      const next = new Set(p);
      next.has(activeKey) ? next.delete(activeKey) : next.add(activeKey);
      return next;
    });
  };
  /** Splits the editor: `key` in a second pane next to the main one (Ctrl+\ toggles it). */
  actions.openSide = (key) => {
    hostRef.current?.flushAll();
    const { open, active } = store.session;
    // Ctrl+\: the tab next to the active one.
    const target = key ?? open[open.indexOf(active) + 1] ?? open[open.indexOf(active) - 1];
    if (!target || !store.setSide(target)) return toast('Open another file to see two side by side.');
    setPreview((p) => {
      const next = new Set(p);
      next.delete(store.session.active);
      return next;
    });
  };
  actions.toggleSplit = () => (store.session.side ? actions.closeSide() : actions.openSide());

  // The model panel (the bubble, or Ctrl+K): about the selection, or the whole file.
  const [assist, setAssist] = useState(false);
  actions.askSelection = () => {
    if (assist) return setAssist(false);
    if (!activeKey || view !== 'editor') return toast('Open a file first.');
    setAssist(true);
  };
  const modelReady = Boolean(settings.llm.enabled && settings.llm.chatModel);
  const assistScope = cursor?.selected ? `Selection · ${cursor.selected.toLocaleString()} character${cursor.selected === 1 ? '' : 's'}` : `Whole file · ${activeName}`;

  // Dictation (voice notes): the tab being dictated into; switching tabs stops it.
  const [dictating, setDictating] = useState(null);
  useEffect(() => {
    if (dictating && dictating !== activeKey) setDictating(null);
  }, [activeKey]);
  actions.startDictation = () => {
    if (!dictationSupported()) return toast('Dictation works in a browser with a speech service: Chrome or Edge, or Safari, for example on your phone.', { kind: 'error' });
    hostRef.current?.flushAll();
    // Into the open tab when it can be edited, else a new note.
    const k = parseKey(store.session.active);
    const disk = k?.kind === 'disk' ? store.diskTab(k.path) : null;
    const editable = k && view === 'editor' && !(k.kind === 'file' && store.isSealed(k.id)) && !(disk && (disk.follow || disk.truncated));
    setDictating(editable ? store.session.active : fileKey(actions.newFile({ focus: false })));
  };
  actions.voiceNote = () => setDictating(fileKey(actions.newFile({ focus: false })));
  actions.stopDictation = () => setDictating(null);
  /** A dictated phrase, at the cursor, fitted to the text before it. */
  actions.dictate = (phrase, lang) => {
    const host = hostRef.current;
    const text = host && joinDictated(host.textBeforeCursor(4), phrase, lang);
    if (text) host.insertAtCursor(text, text.length, { focus: false });
  };

  // Find in a folder (desktop): the folder searched, here or on a server.
  const [folderSearchDir, setFolderSearchDir] = useState(null);
  actions.findInFolder = (dir) => {
    setFolderSearchDir(dir);
    setPanel('folderSearch');
  };

  // Terminals on servers (desktop): the panel under the editor. Hiding it keeps the shells running.
  const [terminalShown, setTerminalShown] = useState(false);
  actions.openTerminal = async (connId, cwd = '') => {
    if (!terminalsAvailable()) return toast('Terminals work in the desktop app.', { kind: 'error' });
    const conn = server(connId);
    if (conn && conn.protocol !== 'sftp') return toast(`${conn.name} is an FTP server; terminals need SSH (SFTP).`, { kind: 'error' });
    setTerminalShown(true);
    try {
      await openTerminal(connId, { cwd });
    } catch (err) {
      toast(ipcMessage(err), { kind: 'error', timeout: 8000 });
    }
  };
  /** Ctrl+`: shows or hides the terminal; the first time, one on the server you are looking at. */
  actions.toggleTerminal = () => {
    if (!terminalsAvailable()) return;
    if (terminalShown) {
      setTerminalShown(false);
      hostRef.current?.focus();
      return;
    }
    if (!terminals().length) {
      const folder = getSettings().sidebarMode === 'folders' ? getSettings().folder : '';
      const k = parseKey(store.session.active);
      const near = isRemotePath(folder) ? folder : k?.kind === 'disk' && isRemotePath(k.path) ? k.path.slice(0, k.path.lastIndexOf('/')) : '';
      if (near && server(remoteParts(near).id)?.protocol === 'sftp') return actions.openTerminal(remoteParts(near).id, remoteParts(near).path);
    }
    setTerminalShown(true);
    requestAnimationFrame(() => focusTerminal(activeTerminal()));
  };
  /** A folder: on a server, a terminal here in the editor; on this computer, the system's terminal app. */
  actions.terminalHere = (dir) => {
    if (isRemotePath(dir)) return actions.openTerminal(remoteParts(dir).id, remoteParts(dir).path);
    window.desktop?.folders?.terminal(dir).catch((err) => toast(ipcMessage(err), { kind: 'error' }));
  };
  useEffect(() => {
    setToggleHandler(() => actions.toggleTerminal());
  }, []);
  useEffect(() => retheme(), [settings.theme]);

  // Filtering lines (Alt+L): the tabs whose filter bar is open.
  const [filterKeys, setFilterKeys] = useState(() => new Set());
  actions.toggleFilter = () => {
    if (!activeKey) return;
    const open = filterKeys.has(activeKey);
    if (open) hostRef.current?.setLineFilter(activeKey, null);
    setFilterKeys((keys) => {
      const next = new Set(keys);
      open ? next.delete(activeKey) : next.add(activeKey);
      return next;
    });
  };
  actions.setLineFilter = (key, filter) => hostRef.current?.setLineFilter(key, filter) ?? { shown: 0, total: 0 };
  actions.lineFilter = (key) => hostRef.current?.lineFilter(key) ?? { filter: null, shown: 0, total: 0 };
  actions.shownLines = (key) => hostRef.current?.shownLines(key) ?? '';

  // Macros (Ctrl+Shift+R records, Alt+Shift+P plays). The last one is kept on this device.
  const [recording, setRecording] = useState(false);
  const MACRO_KEY = 'tracker-editor:macro';
  const savedMacro = () => {
    try {
      return JSON.parse(localStorage.getItem(MACRO_KEY) ?? 'null');
    } catch {
      return null;
    }
  };
  actions.toggleRecording = () => {
    const host = hostRef.current;
    if (!host) return;
    if (host.recording) {
      const steps = host.stopRecording();
      setRecording(false);
      if (!steps.length) return toast('Nothing was recorded.');
      try {
        localStorage.setItem(MACRO_KEY, JSON.stringify(steps));
      } catch {
        // kept for this session only
      }
      toast(`Macro recorded (${steps.length} step${steps.length === 1 ? '' : 's'}). Alt+Shift+P plays it.`);
      return;
    }
    if (!activeKey) return toast('Open a file first.');
    host.startRecording();
    setRecording(true);
  };
  actions.playMacro = (times = 1) => {
    const steps = savedMacro();
    if (!steps?.length) return toast('Record a macro first: Ctrl+Shift+R, do the edit, Ctrl+Shift+R again.');
    const runs = hostRef.current?.playMacro(steps, times) ?? 0;
    if (times !== 1) toast(`Ran the macro ${runs.toLocaleString()} time${runs === 1 ? '' : 's'}.`);
  };
  actions.runMacro = () => {
    const steps = savedMacro();
    if (!steps?.length) return actions.playMacro();
    setDialog({ type: 'macro', steps: steps.length });
  };

  // Typing into another window (desktop app): the selection, or the whole file.
  const [typingJob, setTypingJob] = useState(null);
  useEffect(() => window.desktop?.typing?.onProgress((typed) => setTypingJob((job) => job && { ...job, typed })), []);
  // `text` types that text (a snippet, a clipboard entry); otherwise the selection, or the file.
  actions.typeOut = async ({ whole = false, text: given = null, what = '' } = {}) => {
    const typer = window.desktop?.typing;
    if (!typer) return toast('Typing into other windows works in the desktop app.', { kind: 'error' });
    if (typingJob) return;
    const host = hostRef.current;
    host?.flushAll();
    const snap = given === null ? host?.snapshot() : null;
    if (given === null && !snap) return toast('Open a file first.');
    const selected = given !== null || whole ? '' : host.selectionText();
    const options = getSettings().typing;
    const text = prepareTyping(given ?? (selected || snap.text));
    if (!text) return toast('Nothing to type: the file is empty.');
    const delay = typingDelay(options.speed);
    const wait = options.countdown * 1000;
    setTypingJob({ total: text.length, at: Date.now() + wait, delay, typed: 0, what: what || (selected ? 'selection' : 'file') });
    try {
      const { typed, stopped } = await typer.start(text, { delay, wait, minimize: options.minimize, unicode: options.unicode, lineStart: options.autoIndent });
      const done = `${typed.toLocaleString()} character${typed === 1 ? '' : 's'}`;
      if (!stopped) toast(`Typed ${done}.`);
      else if (stopped === 'self') toast(`Nothing typed: Tracker Editor still had the focus. Start again, then click into the other window within ${options.countdown} seconds.`, { timeout: 9000 });
      else if (stopped === 'focus') toast(`Stopped after ${done}: another window got the focus.`, { timeout: 9000 });
      else if (stopped === 'escape') toast(`Stopped after ${done} (Escape).`);
      else toast(typed ? `Stopped after ${done}.` : 'Typing cancelled.');
    } catch (err) {
      toast(err.message, { kind: 'error', timeout: 12000 });
    } finally {
      setTypingJob(null);
    }
  };

  // The split view's second pane, after the main one so a tab moving between them hands over its state.
  const sideEl = useRef(null);
  const sideKey = store.session.side;
  const sideParsed = parseKey(sideKey);
  const sideFile = sideParsed?.kind === 'file' ? store.get(sideParsed.id) : null;
  const sideRepo = sideParsed?.kind === 'repo' ? store.repoTab(sideParsed.path) : sideParsed?.kind === 'disk' ? store.diskTab(sideParsed.path) : null;
  const showSide = Boolean((sideFile || sideRepo) && !(sideFile && store.isSealed(sideFile.id)) && view === 'editor' && !compare && !showPreview && !isNarrow());
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!showSide) return host.closeSide();
    host.openSide(sideKey, sideEl.current, {
      text: sideFile ? store.text(sideFile.id) : sideRepo.text,
      name: sideFile?.name ?? sideRepo.name,
      language: sideFile?.language ?? '',
    });
    if (sideParsed.kind === 'disk') host.setReadOnly(sideKey, Boolean(sideRepo.follow || sideRepo.truncated));
  }, [sideKey, showSide, activeKey]);

  // Notes captured while the window was closed or loading.
  useEffect(() => {
    actions.takeCaptures();
  }, []);

  // Files on disk: changes made elsewhere come in; followed files grow.
  useEffect(
    () =>
      watchDiskTabs({
        onReplace: (key, text) => hostRef.current?.replaceText(key, text),
        onAppend: (key, text) => hostRef.current?.appendText(key, text, { follow: true }),
      }),
    [],
  );

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
        // The home screen shortcuts of the installed app.
        if (location.hash === '#/new' || location.hash === '#/voice') {
          const voice = location.hash === '#/voice';
          history.replaceState(null, '', location.pathname + location.search);
          if (voice && dictationSupported()) actions.voiceNote();
          else actions.newFile();
        }
        return;
      }
      history.replaceState(null, '', location.pathname + location.search);
      if (route.kind === 'file') {
        if (store.get(route.id)) actions.openFile(route.id);
        else syncNow().then(() => actions.openFile(route.id));
      } else if (route.kind === 'link') actions.openLink(route.name);
      else actions.openRepoFile(route.path);
    };
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, []);

  // New notes are named and filed from what is in them, once per tab, with Undo:
  // an untitled tab ("new 3") gets a name (by the local model when it is on,
  // else from a heading on the first line), and the model also picks one of
  // your projects and a few tags for a file created here that has none.
  useEffect(() => {
    const timers = new Map();
    const done = new Set();
    const created = new Set();
    const nameIt = async (id) => {
      const file = store.get(id);
      const settings = getSettings();
      if (!file || done.has(id)) return;
      const model = settings.llm.enabled && settings.llm.chatModel;
      const wantName = settings.autoName && isUntitled(file.name);
      const wantFiling = Boolean(model && settings.autoFile && created.has(id) && !file.project && !file.tags.length);
      if (!wantName && !wantFiling) return;
      const text = store.text(id);
      if (text.trim().length < MIN_NAMING_TEXT) return;
      let suggestion = { name: '', project: '', tags: [] };
      if (model) {
        done.add(id);
        const ext = findLanguage('', file.language)?.extensions?.[0] ?? '';
        suggestion = (await askFiling(text, { ext, name: wantName }).catch(() => null)) ?? suggestion;
        // A model that does not answer in JSON can still name it.
        if (wantName && !suggestion.name) suggestion.name = await llmClient().chat({ model: settings.llm.chatModel, messages: namingMessages(text, ext), purpose: 'name', signal: AbortSignal.timeout?.(60000), temperature: 0.2 }).then((r) => cleanModelName(r, ext || 'txt'), () => '');
      }
      if (wantName) suggestion.name ||= nameFromHeading(text);
      // Only what is still empty, in case you set it meanwhile.
      const now = store.get(id);
      if (!now) return;
      const patch = {};
      if (wantName && suggestion.name && isUntitled(now.name)) patch.name = uniqueName(suggestion.name, store.live().filter((f) => f.id !== id).map((f) => f.name));
      if (wantFiling && suggestion.project && !now.project) patch.project = suggestion.project;
      if (wantFiling && suggestion.tags.length && !now.tags.length) patch.tags = suggestion.tags;
      if (!Object.keys(patch).length) return;
      done.add(id);
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, now[k]]));
      actions.patch(id, patch);
      const filed = filedAs({ project: patch.project ?? '', tags: patch.tags ?? [] });
      const message = patch.name ? `Named “${patch.name}” from its content${filed ? ` · filed under ${filed}` : ''}` : `Filed under ${filed}`;
      toast(message, { timeout: 8000, action: { label: 'Undo', run: () => actions.patch(id, before) } });
    };
    const later = (id, ms) => {
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => nameIt(id), ms));
    };
    return store.subscribe((reason, detail) => {
      if (reason === 'text' && detail?.id) later(detail.id, detail.urgent ? 1200 : 4000);
      if (reason === 'local' && detail?.created) {
        created.add(detail.created);
        later(detail.created, 1200);
      }
    });
  }, []);

  // Shared from other apps (Android's Share menu) or opened with the installed app.
  useEffect(() => {
    const takeInbox = async () => {
      if (location.hash === '#/inbox') history.replaceState(null, '', location.pathname + location.search);
      for (const shared of await takeShared().catch(() => [])) await actions.importShared(shared);
    };
    takeInbox();
    const onHash = () => location.hash === '#/inbox' && takeInbox();
    window.addEventListener('hashchange', onHash);
    onLaunchFiles((files) => actions.importFiles(files));
    // Desktop: files and folders opened with the app ("Open with", "Edit with Tracker Editor",
    // the command line): files as tabs on disk, folders in the folders view.
    const takeLaunched = async () => {
      for (const item of (await window.desktop?.disk?.takeLaunched?.().catch(() => [])) ?? []) {
        if (item.dir) await actions.showFolder(item.path);
        else await actions.openDiskPath(item.path);
      }
    };
    takeLaunched();
    const offLaunched = window.desktop?.disk?.onLaunched?.(takeLaunched);
    return () => {
      window.removeEventListener('hashchange', onHash);
      offLaunched?.();
    };
  }, []);

  // Keyboard shortcuts that work in the browser too (the desktop menu adds Ctrl+N, Ctrl+W, …).
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.key === 'F1' && !mod && !e.altKey) {
        e.preventDefault();
        actions.command('help');
      } else if (mod && !e.shiftKey && k === 'p') {
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
      } else if (e.altKey && !mod && k === 'r') {
        e.preventDefault();
        actions.readAloud();
      } else if (e.altKey && !mod && k === 'w') {
        e.preventDefault();
        if (store.session.active) actions.close(store.session.active);
      } else if (mod && e.shiftKey && k === 'r') {
        e.preventDefault();
        actions.toggleRecording();
      } else if (mod && e.shiftKey && !e.altKey && k === 'p') {
        e.preventDefault();
        actions.commandPalette();
      } else if (e.altKey && e.shiftKey && !mod && e.code === 'KeyP') {
        e.preventDefault();
        actions.playMacro();
      } else if (mod && e.shiftKey && k === 'o') {
        e.preventDefault();
        actions.toggleOutline();
      } else if (mod && !e.shiftKey && !e.altKey && k === 't') {
        e.preventDefault();
        actions.gotoSymbolAll();
      } else if (mod && e.shiftKey && k === 'm') {
        e.preventDefault();
        actions.toggleProblems();
      } else if (mod && !e.shiftKey && !e.altKey && k === 'k') {
        e.preventDefault();
        actions.askSelection();
      } else if (e.altKey && !mod && !e.shiftKey && k === 'l') {
        e.preventDefault();
        actions.toggleFilter();
      } else if (e.altKey && !mod && !e.shiftKey && k === 'i') {
        e.preventDefault();
        actions.openSnippets();
      } else if (e.altKey && !mod && !e.shiftKey && k === 't' && window.desktop?.typing) {
        e.preventDefault();
        actions.typeOut();
      } else if (mod && e.shiftKey && k === 'v' && window.desktop?.clipboardHistory) {
        e.preventDefault();
        actions.openClipboardHistory();
      } else if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        actions.toggleTerminal();
      } else if (mod && e.key === '\\') {
        e.preventDefault();
        actions.toggleSplit();
      } else if (mod && k === 's') {
        e.preventDefault();
        // A file on disk is saved; otherwise what was just typed is synced.
        actions.saveOrSync();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Commands by name: the desktop menu's, and Help's (commands.js), so both run the same.
  actions.command = (command) => {
    const run = {
      new: () => actions.newFile(),
      'open-disk': () => actions.openFromDisk(),
      'save-copy': () => actions.saveCopy(),
      'close-tab': () => store.session.active && actions.close(store.session.active),
      'reopen-tab': () => actions.reopenClosed(),
      'next-tab': () => actions.cycleTab(1),
      'prev-tab': () => actions.cycleTab(-1),
      'quick-open': () => setDialog({ type: 'quickOpen' }),
      'reveal-tab': () => window.dispatchEvent(new CustomEvent('tabs:reveal')),
      'tab-list': () => window.dispatchEvent(new CustomEvent('tabs:list')),
      trash: () => setDialog({ type: 'trash' }),
      split: () => actions.toggleSplit(),
      'type-out': () => actions.typeOut(),
      'disk-open': () => actions.openDiskFiles(),
      'folder-open': () => actions.openFolder(),
      'folder-beside': () => actions.openFolder(undefined, { beside: true }),
      'server-add': () => actions.editServer(),
      'servers-ssh': () => actions.importSshConfig(),
      terminal: () => actions.toggleTerminal(),
      folders: () => actions.showFolders(),
      'clipboard-history': () => actions.openClipboardHistory(),
      captures: () => actions.takeCaptures(),
      'screenshot-ocr': () => actions.screenshotToText(),
      'image-ocr': () => actions.imageToText(),
      snippets: () => actions.openSnippets(),
      'ask-selection': () => actions.askSelection(),
      outline: () => actions.toggleOutline(),
      'filter-lines': () => actions.toggleFilter(),
      'macro-record': () => actions.toggleRecording(),
      'macro-play': () => actions.playMacro(),
      'macro-run': () => actions.runMacro(),
      find: () => actions.run('find'),
      replace: () => actions.run('replace'),
      'goto-line': () => actions.run('gotoLine'),
      'find-in-files': () => setPanel('search'),
      'goto-definition': () => actions.goToDefinition(),
      'find-usages': () => actions.findUsages(),
      'rename-symbol': () => actions.renameSymbol(),
      'goto-symbol': () => actions.gotoSymbol(),
      'goto-symbol-all': () => actions.gotoSymbolAll(),
      'command-palette': () => actions.commandPalette(),
      'git-compare': () => actions.compareWithHead(),
      problems: () => actions.toggleProblems(),
      'indent-spaces': () => actions.setIndent({ tabs: false }),
      'indent-tabs': () => actions.setIndent({ tabs: true }),
      'indent-to-spaces': () => actions.convertIndent(false),
      'indent-to-tabs': () => actions.convertIndent(true),
      'indent-detect': () => actions.setIndent(null),
      'indent-guides': () => saveSettings({ indentGuides: getSettings().indentGuides === false }),
      'bracket-colors': () => saveSettings({ bracketColors: getSettings().bracketColors === false }),
      'sticky-scroll': () => saveSettings({ stickyScroll: getSettings().stickyScroll === false }),
      assistant: () => setPanel((p) => (p === 'assistant' ? null : 'assistant')),
      sync: () => {
        hostRef.current?.flushAll();
        syncNow();
      },
      settings: () => setView('settings'),
      'toggle-sidebar': () => setSidebar((s) => !s),
      'toggle-wrap': () => actions.toggleWrap(),
      'read-aloud': () => actions.readAloud(),
      flush: async () => {
        hostRef.current?.flushAll();
        await flush();
        if (store.pendingCount()) await Promise.race([syncNow(), new Promise((r) => setTimeout(r, 5000))]);
        window.desktop.closeReady?.();
      },
      format: () => actions.formatDocument(),
      preview: () => actions.togglePreview(),
      help: () => setDialog((d) => (d?.type === 'help' ? null : { type: 'help' })),
      'help-guide': () => setDialog({ type: 'help', tab: 'guide' }),
      'compare-clipboard': () => actions.compareWithClipboard(),
    };
    if (run[command]) return run[command]();
    // Editing commands (editor.js COMMANDS): upper case, sort lines, duplicate line…
    actions.run(command);
  };

  // Desktop menu commands.
  useEffect(() => {
    if (!window.desktop?.onCommand) return;
    return window.desktop.onCommand(async (command) => {
      if (command.startsWith('route:')) {
        location.hash = command.slice(6);
        return;
      }
      actions.command(command);
    });
  }, []);

  // Drop files onto the window to add them.
  useEffect(() => {
    const over = (e) => e.dataTransfer?.types?.includes('Files') && e.preventDefault();
    const drop = (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      // A tab dragged out and dropped back here is not added again; files from the folders view open.
      if (isOwnDrop(e.dataTransfer)) {
        const paths = draggedTab() ? [] : draggedPaths();
        dropped();
        for (const path of paths.filter((p) => opensInEditor(p))) actions.openDiskPath(path, { report: paths.length === 1 });
        return;
      }
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
  // The handle between the text and the preview or side view: the editor's share of the width.
  const splitHandle = (label) => html`<${Splitter} className="pane-resize" label=${label}
    onStart=${() => {
      const area = areaEl.current;
      splitDrag.current = { width: area.clientWidth || 1, start: area.querySelector(':scope > .editor-host').offsetWidth, ratio: settings.splitRatio };
    }}
    onMove=${(delta) => {
      const { width, start } = splitDrag.current;
      splitDrag.current.ratio = Math.max(0.15, Math.min(0.85, (start + delta) / width));
      areaEl.current.style.setProperty('--split', `${(splitDrag.current.ratio * 100).toFixed(2)}%`);
    }}
    onEnd=${() => saveSettings({ splitRatio: Math.round(splitDrag.current.ratio * 1000) / 1000 })}
    onReset=${() => saveSettings({ splitRatio: 0.5 })} />`;

  return html`<div class="app ${sidebar ? 'with-sidebar' : ''} ${panel ? 'with-panel' : ''} view-${view}" style=${settings.sidebarWidth ? { '--sidebar': `${settings.sidebarWidth}px` } : {}}>
    <header class="topbar">
      <button type="button" class="icon-btn" aria-label="Files" title="Files (Ctrl+B)" aria-pressed=${sidebar} onClick=${() => setSidebar(!sidebar)}><${Icon} name="sidebar" /></button>
      <span class="brand"><span class="brand-mark"><${Icon} name="code" size=${16} /></span><span class="brand-name">Tracker Editor</span></span>
      <button type="button" class="quick-open-btn" onClick=${() => setDialog({ type: 'quickOpen' })}>
        <${Icon} name="search" size=${16} /><span>Open a file…</span><kbd>Ctrl P</kbd>
      </button>
      <span class="spacer" />
      <button type="button" class="icon-btn" aria-label="New file" title="New file (Alt+N)" onClick=${() => actions.newFile()}><${Icon} name="plus" /></button>
      ${dictationSupported() && html`<button type="button" class="icon-btn ${dictating ? 'on' : ''}" aria-label="Voice note" title=${dictating ? 'Stop dictating' : 'Dictate: into this file, or a new note'} aria-pressed=${Boolean(dictating)}
        onClick=${() => (dictating ? actions.stopDictation() : actions.startDictation())}><${Icon} name="mic" /></button>`}
      <button type="button" class="icon-btn" aria-label="Find in files" title="Find in files (Ctrl+Shift+F)" aria-pressed=${panel === 'search'} onClick=${() => actions.togglePanel('search')}><${Icon} name="search" /></button>
      ${settings.llm.enabled && html`<button type="button" class="icon-btn" aria-label="Assistant" title="Local model (Ctrl+Shift+A)" aria-pressed=${panel === 'assistant'} onClick=${() => actions.togglePanel('assistant')}><${Icon} name="sparkle" /></button>`}
      <${SyncBadge} sync=${sync} compact=${narrow} />
      <button type="button" class="icon-btn help-btn" aria-label="Help" title="Help: commands, shortcuts and the guide (F1)" onClick=${() => actions.command('help')}><${Icon} name="help" /></button>
      <button type="button" class="icon-btn" aria-label="Settings" title="Settings" aria-pressed=${view === 'settings'} onClick=${() => setView(view === 'settings' ? 'editor' : 'settings')}><${Icon} name="settings" /></button>
    </header>

    ${sidebar && html`<${Sidebar} files=${scoped} docs=${scopedDocs} allFiles=${store.live()} projects=${projects} settings=${settings} activeKey=${activeKey} openKeys=${store.session.open} actions=${actions} />`}
    ${sidebar && narrow && html`<div class="scrim" onClick=${() => setSidebar(false)} />`}

    <main class="main">
      ${view === 'settings' && html`<${SettingsView} settings=${settings} sync=${sync} actions=${actions} />`}
      <div class="editor-view" hidden=${view === 'settings'}>
        <${TabBar} session=${store.session} projects=${projects} settings=${settings} actions=${actions} />
        ${activeKey && html`<${FileBar} file=${activeFile} repo=${activeRepo} disk=${activeDisk} sealed=${activeSealed} projects=${projects} language=${languageName} sync=${sync}
          canPreview=${Boolean(previewType)} preview=${showPreview} settings=${settings} actions=${actions} />`}
        ${activeKey && filterKeys.has(activeKey) && !compare && !activeSealed &&
        html`<${FilterBar} key=${activeKey} tabKey=${activeKey} actions=${actions} onClose=${actions.toggleFilter} />`}
        ${dictating && dictating === activeKey && html`<${DictationBar} lang=${settings.dictationLang} onPhrase=${actions.dictate} onStop=${actions.stopDictation} />`}
        ${typingJob && html`<${TypeOutPanel} job=${typingJob} onStop=${() => window.desktop?.typing?.stop()} />`}
        <div class="editor-area ${showPreview ? 'split' : ''} ${showPreview && previewFull ? 'preview-full' : ''} ${showSide ? 'side-split' : ''} ${compare ? 'comparing' : ''} ${settings.whereFrame && activeKey ? 'framed' : ''}"
          data-kind=${kindOfKey(activeKey) ?? undefined} ref=${areaEl} style=${{ '--split': `${((settings.splitRatio || 0.5) * 100).toFixed(2)}%` }}>
          <div class="editor-host" ref=${editorEl} />
          ${assist && activeKey && view === 'editor' && !compare && !activeSealed && html`<${AssistPanel} key=${activeKey} scope=${assistScope} actions=${actions} onClose=${() => (setAssist(false), hostRef.current?.focus())} />`}
          ${!assist && modelReady && settings.assistBubble && activeKey && !compare && !activeSealed && !typingJob && html`<${AssistBubble} onOpen=${() => setAssist(true)} />`}
          ${showSide && splitHandle('Resize the side view')}
          ${showSide &&
          html`<div class="side-pane" aria-label=${`Side view: ${sideFile?.name ?? sideRepo.name}`}>
            <div class="side-head">
              <${Icon} name=${sideRepo ? 'paperclip' : 'file'} size=${14} />
              <span class="side-name">${sideFile?.name ?? sideRepo.name}</span>
              ${(sideFile?.dirty || sideFile?.pending || sideRepo?.dirty) && html`<span class="tab-dot" title="Not synced yet" />`}
              <span class="spacer" />
              <button type="button" class="icon-btn sm" aria-label="Swap the panes" title="Swap the panes" onClick=${() => store.swapSides()}><${Icon} name="rotate" size=${15} /></button>
              <button type="button" class="icon-btn sm" aria-label="Close the side view" title="Close the side view (Ctrl+\\)" onClick=${actions.closeSide}><${Icon} name="x" size=${15} /></button>
            </div>
            <div class="side-host" ref=${sideEl} />
          </div>`}
          ${compare && html`<${CompareView} key=${compare.sha ?? compare.left.label} compare=${compare} settings=${settings} onClose=${() => setCompare(null)} />`}
          ${showPreview && !previewFull && splitHandle('Resize the preview')}
          ${showPreview && html`<${Preview} key=${activeKey} kind=${previewType} name=${activeName} text=${activeText()}
            full=${previewFull} onFull=${isNarrow() ? undefined : () => setPreviewFull(!previewFull)} onClose=${actions.togglePreview}
            onToggle=${(next) => {
              if (activeFile) store.setText(activeFile.id, next);
              else if (activeDisk) store.setDiskText(activeDisk.path, next, { urgent: true });
              else store.setRepoText(activeRepo.path, next);
              hostRef.current?.replaceText(activeKey, next);
            }}
            onGoTo=${(line, column) => {
              actions.togglePreview();
              setTimeout(() => hostRef.current?.reveal(line, column, 1), 60);
            }} />`}
          ${activeSealed && html`<${LockedFile} file=${activeFile} actions=${actions} />`}
          ${!activeKey && html`<${Welcome} actions=${actions} desktop=${diskAvailable()} hasFiles=${store.live().length + docs.length > 0} configured=${isSyncConfigured(settings)} />`}
        </div>
        ${terminalShown && html`<${TerminalPanel} settings=${settings} actions=${actions} onHide=${() => (setTerminalShown(false), hostRef.current?.focus())} />`}
        <${ReadAloudBar} />
        <${StatusBar} recording=${recording} big=${big && Boolean(activeKey)} cursor=${activeKey ? cursor : null} language=${languageName} file=${activeFile} repo=${activeRepo} disk=${activeDisk} settings=${settings} sync=${sync} actions=${actions}
          problems=${settings.problems !== false && activeKey ? problems[activeKey] : null} problemsOpen=${panel === 'problems'}
          git=${activeKey && gitHeads[activeKey] ? { ...gitHeads[activeKey], changes: hostRef.current?.gitChanges(activeKey)?.changes ?? null } : null} />
      </div>
    </main>

    ${panel === 'folderSearch' && folderSearchDir && window.desktop?.folders && html`<${FolderSearchPanel} key=${folderSearchDir} dir=${folderSearchDir} actions=${actions} onClose=${() => setPanel(null)} />`}
    ${panel === 'usages' && usagesOf && activeKey && !activeSealed && html`<${UsagesPanel} word=${usagesOf.word} name=${activeName} fileKey=${activeKey} text=${activeText()} actions=${actions} onClose=${() => setPanel(null)} />`}
    ${panel === 'problems' && activeKey && !activeSealed && html`<${ProblemsPanel} name=${activeName} fileKey=${activeKey} problems=${settings.problems !== false ? problems[activeKey] : null} actions=${actions} onClose=${() => setPanel(null)} />`}
    ${panel === 'search' && html`<${SearchPanel} key=${searchSeed?.at ?? 0} seed=${searchSeed} files=${scoped} docs=${scopedDocs} allFiles=${store.live()} allDocs=${docs} openKeys=${store.session.open} settings=${settings} actions=${actions} onClose=${() => setPanel(null)} />`}
    ${panel === 'history' && activeKey && (activeFile || activeRepo) && html`<${HistoryPanel} key=${activeKey} selected=${compare?.sha}
      target=${{ key: activeKey, kind: activeFile ? 'file' : 'repo', id: activeFile?.id, path: activeRepo?.path, name: activeName, dirty: activeFile?.dirty || activeRepo?.dirty }}
      actions=${actions} onClose=${() => setPanel(null)} />`}
    ${panel === 'outline' && activeKey && (activeFile || activeRepo || activeDisk) && !activeSealed &&
    html`<${OutlinePanel} name=${activeName} text=${activeText()} language=${languageName} fileId=${activeFile?.id}
      cursorLine=${cursor?.line} actions=${actions} onClose=${() => setPanel(null)} />`}
    ${panel === 'assistant' && html`<${AssistantPanel} files=${scoped} docs=${scopedDocs} activeFile=${activeFile} activeRepo=${activeRepo} settings=${settings} actions=${actions} onClose=${() => setPanel(null)} />`}

    ${dialog?.type === 'quickOpen' &&
    (dialog.pick === 'compare'
      ? html`<${QuickOpen} files=${store.live()} docs=${docs} actions=${actions} title=${`Compare ${activeName} with…`} exclude=${activeFile ? activeFile.id : activeRepo ? `r:${activeRepo.path}` : ''}
          onPick=${(entry) => actions.compareWithEntry(entry)} onClose=${() => setDialog(null)} />`
      : html`<${QuickOpen} files=${store.live()} docs=${docs} actions=${actions} initial=${dialog.query ?? ''} symbols=${() => (activeKey ? (hostRef.current?.codeContext()?.symbols ?? []) : [])}
          roots=${folderRoots(settings)} hidden=${Boolean(settings.showHidden)} onSymbol=${(entry) => actions.revealSymbol(entry)} onClose=${() => setDialog(null)} />`)}
    ${dialog?.type === 'palette' && html`<${CommandPalette} initial=${dialog.query ?? ''} onRun=${(c) => setTimeout(() => actions.command(c.id), 0)} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'symbols' && html`<${SymbolSearch} files=${store.live()} roots=${folderRoots(settings)} initial=${dialog.query ?? ''} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'declarations' && html`<${DeclarationPicker} word=${dialog.word} places=${dialog.places} roots=${folderRoots(settings)} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'ocr' && html`<${OcrDialog} images=${dialog.images} saveTo=${dialog.saveTo} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'server' && html`<${ServerDialog} conn=${dialog.conn} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'sshImport' && html`<${SshImportDialog} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'mirror' && html`<${MirrorDialog} draft=${dialog.draft} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'mirrors' && html`<${MirrorsDialog} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'mirrorDeletes' && mirrorById(dialog.id) && html`<${MirrorDeletesDialog} mirror=${mirrorById(dialog.id)} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'properties' && html`<${PropertiesDialog} key=${dialog.path} path=${dialog.path} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${hostKey && html`<${HostKeyDialog} info=${hostKey} onAnswer=${(ok) => (window.desktop.remote.answerHostKey(hostKey.question, ok), setHostKey(null))} />`}
    ${prompts[0] && !hostKey && html`<${PromptDialog} key=${prompts[0].question} info=${prompts[0]} onAnswer=${(answer) => answerPrompt(prompts[0], answer)} />`}
    ${dialog?.type === 'clipboard' && html`<${ClipboardHistory} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'macro' && html`<${MacroDialog} steps=${dialog.steps} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'trash' && html`<${TrashDialog} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'help' && html`<${HelpDialog} tab=${dialog.tab} query=${dialog.query} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'checklist' && store.get(dialog.id) && html`<${ChecklistDialog} file=${store.get(dialog.id)} text=${dialog.text} firstLine=${dialog.firstLine} projects=${projects} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'snippets' && html`<${SnippetPicker} selection=${dialog.selection} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'file' && store.get(dialog.id) && html`<${FileDialog} file=${store.get(dialog.id)} projects=${projects} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'share' && activeKey && html`<${ShareDialog} name=${activeName} text=${activeText()}
      link=${activeFile ? fileLink(settings.appUrl, activeFile.id) : activeRepo ? `${settings.appUrl.replace(/\/?$/, '/')}#/repo/${activeRepo.path.split('/').map(encodeURIComponent).join('/')}` : ''}
      actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'send' && store.get(dialog.id) && html`<${SendDialog} file=${store.get(dialog.id)} projects=${projects} settings=${settings} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'closeDisk' && store.diskTab(parseKey(dialog.key).path) &&
    html`<${CloseDiskDialog} tab=${store.diskTab(parseKey(dialog.key).path)} onClose=${() => setDialog(null)}
      onDiscard=${() => (setDialog(null), actions.close(dialog.key, { discard: true }))}
      onSave=${async () => {
        setDialog(null);
        if ((await actions.saveDisk(parseKey(dialog.key).path)) === 'saved') actions.close(dialog.key, { discard: true });
      }} />`}
    ${dialog?.type === 'reloadDisk' && store.diskTab(dialog.path) &&
    html`<${ReloadDiskDialog} tab=${store.diskTab(dialog.path)} onClose=${() => setDialog(null)} onReload=${() => (setDialog(null), actions.reloadDisk(dialog.path))} />`}
    ${diskAvailable() && html`<${TransfersCard} onShow=${actions.showFolder} />`}
    <${Toasts} />
  </div>`;
}

function Welcome({ actions, hasFiles, configured, desktop }) {
  return html`<div class="welcome">
    <div class="welcome-card">
      <h1>No file open</h1>
      <p class="muted">Every tab is saved on this device as you type and synced to your GitHub data repo, so you can read it on your phone and other computers.</p>
      <div class="welcome-actions">
        <button type="button" class="btn primary" onClick=${() => actions.newFile()}><${Icon} name="plus" size=${16} />New file</button>
        ${hasFiles && html`<button type="button" class="btn" onClick=${() => actions.openDialog({ type: 'quickOpen' })}><${Icon} name="search" size=${16} />Open a file</button>`}
        <button type="button" class="btn" onClick=${() => actions.openFromDisk()}><${Icon} name="upload" size=${16} />Import files</button>
        ${desktop && html`<button type="button" class="btn" title="Edit a file where it is (a log, a config file); it is not synced" onClick=${() => actions.openDiskFiles()}><${Icon} name="disk" size=${16} />Open from disk</button>`}
        ${window.desktop?.folders && html`<button type="button" class="btn" title="Browse a folder and open its files where they are; they are not synced (Ctrl+Shift+E)" onClick=${() => actions.showFolders()}><${Icon} name="folderOpen" size=${16} />Open a folder</button>`}
      </div>
      ${!configured && html`<p class="notice"><${Icon} name="cloudOff" size=${16} />Not syncing yet. <button type="button" class="btn link" onClick=${actions.showSettings}>Set up sync</button> with the same repo and token as the tracker (or paste its setup code).</p>`}
      <dl class="shortcuts">
        <div><dt><kbd>Alt</kbd> <kbd>N</kbd></dt><dd>New file</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>P</kbd></dt><dd>Open a file by name</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>F</kbd></dt><dd>Find in all files</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>F</kbd> / <kbd>H</kbd></dt><dd>Find / replace in this file</dd></div>
        <div><dt><kbd>Ctrl</kbd> <kbd>S</kbd></dt><dd>Sync now (saves a file opened from disk)</dd></div>
      </dl>
    </div>
  </div>`;
}
