import { html, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from '../vendor/preact-htm.js';
import { createEditorHost, findLanguage, guessLanguage, PLAIN_TEXT } from './editor.js';
import { documentKind } from './docTypes.js';
import { onLaunchFiles, takeShared } from './inbox.js';
import { cleanModelName, filingMessages, isUntitled, MIN_NAMING_TEXT, nameFromHeading, namingMessages, parseFiling, uniqueName } from './naming.js';
import { llmClient } from './semantic.js';
import { completionMessages } from './completion.js';
import { fileLink, parseRoute, safeName } from './model.js';
import { fileVersions, versionName } from './versions.js';
import { formatDateTime } from './format.js';
import { previewKind } from './previews.js';
import { FORMATTABLE, formatText, formatterFor, guessFormatter } from './formatter.js';
import { getReaderState, onReaderState, setReaderHighlighter, startReading, stopReading, toggleReading } from './reader.js';
import { getSettings, isLocal, isSyncConfigured, onSettings, resolvedTheme, saveSettings } from './settings.js';
import { diskKey, fileKey, flush, parseKey, repoKey, store } from './store.js';
import { diskAvailable, diskReadOnly, openDiskFiles, recheckServerTabs, reloadDiskTab, saveDiskTab, unwatchDisk, watchDiskTabs } from './diskTabs.js';
import { isContentPath, isRemotePath, kindOfKey, remoteAddress, remoteParts, remoteRoot, toRemoteUri } from './where.js';
import { onServers, server, watchServers } from './servers.js';
import { HostKeyDialog, PromptDialog, ServerDialog, SshImportDialog } from './ui/servers.js';
import { activeTerminal, focusTerminal, openTerminal, retheme, runInTerminal, setActiveTerminal, setRefHandler, setToggleHandler, showTerminalOn, splitTerminals, terminals, terminalsAvailable, terminalText, unsplitTerminals } from './terminals.js';
import { parseRunCommands, runCommandFor, runLine } from './runFile.js';
import { findFileRefs, pastedPath, resolveRef } from './fileRefs.js';
import { claudeAppPrompt, claudeAppUrl, codeAround, errorContextText, EXPLAIN_ERROR, explainProblemAction, fixForErrorAction, fixProblemsAction } from './errorHelp.js';
import { TerminalPanel } from './ui/terminal.js';
import { createLanguageServers } from './lsp.js';
import { applyTextEdits, changedLanguages, changedLines, codeActionRows, editPlan, formatFirst, languageOptions, lineOf, textChanges, uriPath } from './lspTools.js';
import { Menu } from './ui/menu.js';
import { LanguageServersPanel, ReferencesPanel, RenameSymbolDialog, SetupServerDialog, WorkspaceEditDialog } from './ui/languageServers.js';
import { BranchDialog, GitPanel } from './ui/gitPanel.js';
import { gitError, stageBlock } from './gitStatus.js';
import { refreshAllGit } from './gitState.js';
import { FolderSearchPanel } from './ui/folderSearch.js';
import { PropertiesDialog } from './ui/properties.js';
import { lastSyncText, mirror as mirrorById, onMirrors, watchMirrors as watchMirrorStatus } from './mirrors.js';
import { MirrorDeletesDialog, MirrorDialog, MirrorsDialog } from './ui/mirrors.js';
import { onTransfers, watchTransfers } from './transfers.js';
import { TransfersCard } from './ui/transfers.js';
import { baseName, besideSettings, claudeText, folderLabel, inPlaceSettings, isImageName, opensHere, remapPath, withCurrent } from './folders.js';
import { folderOfPath, nearestTabs } from './comparePick.js';
import { clampFont, DEFAULT_FONT, pinchFont, stepFont, textSizeKey } from './textSize.js';
import { keyboardState } from './editKeys.js';
import { draggedPaths, draggedTab, dropped, isOwnDrop } from './dragOut.js';
import { dataClient, getSyncState, movedTo, onSyncResult, onSyncState, syncNow } from './syncManager.js';
import { isTextAttachment, matchesScope, projectKey, projectList } from './tracker-model.js';
import { AssistantPanel } from './ui/assistant.js';
import { dismissToast, Toasts, toast } from './ui/components.js';
import { ChecklistDialog, FileDialog, SendDialog } from './ui/dialogs.js';
import { Icon } from './ui/icons.js';
import { QuickOpen, SearchPanel } from './ui/panels.js';
import { Preview } from './ui/preview.js';
import { HelpDialog } from './ui/help.js';
import { CompareView } from './ui/compare.js';
import { CompareTab } from './ui/compareTab.js';
import { CompareFolderDialog } from './ui/compareFolderPick.js';
import { SaveCompareDialog, SavedComparesDialog } from './ui/savedCompares.js';
import { canSave, sameSides } from './compares.js';
import { ComparePicker } from './ui/comparePicker.js';
import { revealInFolders } from './ui/folders.js';
import { HistoryPanel } from './ui/history.js';
import { TrashDialog } from './ui/trash.js';
import { LockedFile } from './ui/encryption.js';
import { DocumentView } from './ui/documentView.js';
import { movedBookmarks } from './docBookmarks.js';
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
import { EditBar, LineMenu } from './ui/editBar.js';
import { ShareDialog } from './ui/share.js';
import { SettingsView } from './ui/settingsView.js';
import { Sidebar } from './ui/sidebar.js';
import { Splitter } from './ui/splitter.js';
import { FileBar, StatusBar, SyncBadge, TabBar } from './ui/tabs.js';
import { FolderGroupDialog } from './ui/tabViews.js';
import { SideBySideDialog } from './ui/sideBySide.js';
import { activeFor, folderGroupOf, loadRoots, rememberFolders, sectionFolders, tabViewState } from './tabViews.js';
import { stepView, suggestedProject, viewKey } from './tabGroups.js';
import { isAndroidApp, isDesktopApp } from './platform.js';

const isNarrow = () => matchMedia('(max-width: 860px)').matches;

// What the model may file a note under: your projects, and the tags in use (most used first).
function filingChoices() {
  const projects = projectList(store.live(), store.projects());
  const counts = new Map();
  for (const f of store.live()) for (const t of f.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return { projects, tags: [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t) };
}

/** Asks the model to file a text: { name, project, tags } (name only when `name`), or null. */
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

/** The bytes of a file in the data repo (a PDF or other document attached in the tracker). */
async function repoBytes(path) {
  const { client, branch, local } = await dataClient();
  const got = await client.getFileBytes(path, branch || undefined);
  if (!got) throw new Error(local ? `${path} is not in the data on this computer (yet).` : `${path} is not in ${getSettings().owner}/${getSettings().repo} (yet). Try syncing.`);
  return got.bytes;
}

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
        isRemotePath(dir) ? { dir, kind: 'remote', label: server(remoteParts(dir).id)?.name ?? 'Server' } : { dir, kind: 'disk', label: folderLabel(dir) },
      )
    : [];
/** The name a tab shows: a synced file's, a tracker document's, a file's on disk. */
const tabName = (key) => {
  const k = parseKey(key);
  if (k?.kind === 'file') return store.get(k.id)?.name ?? 'file';
  if (k?.kind === 'repo') return store.repoTab(k.path)?.name ?? k.path.split('/').pop();
  if (k?.kind === 'disk') return k.path.split(/[\\/]/).pop();
  return String(key);
};
// A path as "folder/inside/it" when it is in one of the folders open in Folders, else as it is.
const relInFolders = (path, settings) => {
  const root = folderRoots(settings).find((r) => path.startsWith(`${r.dir.replace(/[\\/]+$/, '')}/`) || path.startsWith(`${r.dir.replace(/[\\/]+$/, '')}\\`));
  return root ? `${root.label}/${path.slice(root.dir.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/')}` : path;
};
// Where a file is, under its name in Compare with… and the comparison: its folder (on a
// server, with the server's name), "My files · project", "Tracker · item".
const placeOfPath = (path) => {
  if (!isRemotePath(path)) return folderOfPath(path);
  const { id, path: inside } = remoteParts(path);
  return `${server(id)?.name ?? 'Server'}: ${folderOfPath(inside)}`;
};
const placeOfKey = (key) => {
  const k = parseKey(key);
  if (k?.kind === 'disk') return placeOfPath(k.path);
  if (k?.kind === 'file') return ['My files', store.get(k.id)?.project].filter(Boolean).join(' · ');
  if (k?.kind === 'repo') return ['Tracker', store.doc(k.path)?.item.title].filter(Boolean).join(' · ');
  return '';
};

// The document shown as it looks in the open tab, when it reads aloud: { listen } (ui/documentView.js).
let docReader = null;
// The Markdown preview's reading (ui/preview.js), used by Alt+R while the preview hides the text.
let previewReader = null;

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
    // Where the data is: on this device (local mode) or GitHub's repo.
    const syncedClient = async () => {
      const { client, branch } = await dataClient();
      return { client, branch: branch || undefined };
    };
    const actions = {
      toast,
      /** A new tab (its id). `focus: false` leaves the keyboard closed on phones (dictation). */
      newFile({ focus = true, ...fields } = {}) {
        const scope = getSettings().projectScope;
        // In the view of one group, the new file belongs to it: filed under its project, or put in it.
        const vs = tabViewState();
        const only = vs.view?.length === 1 && vs.view[0] !== 'pinned' ? vs.view[0] : null;
        const viewProject = only?.startsWith('p:') ? vs.nameOf(only) : '';
        const project = fields.project ?? (viewProject || (scope.length === 1 && scope[0].startsWith('project:') ? (projectList(store.live(), store.projects()).find((p) => `project:${p.key}` === scope[0])?.name ?? '') : ''));
        const id = store.create({ ...fields, project });
        if (only && !only.startsWith('p:') && only !== 'notes') store.assignGroup(fileKey(id), only);
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
        // A PDF, Word or other document attached in the tracker: shown as it looks (its bytes read when shown).
        const docKind = documentKind(path.split('/').pop());
        if (!docKind && !isTextAttachment({ path })) {
          toast(`${path.split('/').pop()} is not text: open it in the tracker.`, { kind: 'error' });
          return;
        }
        if (docKind) {
          store.openRepoFile({ path, text: '', sha: '', doc: docKind });
          setView('editor');
          if (isNarrow()) setSidebar(false);
          return;
        }
        const doc = store.doc(path);
        const tab = store.repoTab(path);
        if (tab && (tab.dirty || (doc && tab.baseSha === doc.sha))) store.open(repoKey(path));
        else {
          // The downloaded copy when there is one (works offline), else from GitHub.
          let file = doc && store.hasDocText(doc.sha) ? { text: store.cachedDocText(doc.sha), sha: doc.sha } : null;
          if (!file) {
            try {
              const { client, branch, local } = await dataClient();
              file = await client.getFile(path, branch || undefined);
              if (!file) throw new Error(local ? `${path} is not in the tracker's files on this computer.` : `${path} is not in ${getSettings().owner}/${getSettings().repo}.`);
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
        // The open tab closed in a view: its neighbor in the view comes next, not one from elsewhere.
        const vs = store.session.active === key && store.session.view ? tabViewState() : null;
        const shown = vs ? [...vs.keys, ...vs.guests].filter((x) => x !== store.session.side) : [];
        const file = k?.kind === 'file' ? store.get(k.id) : null;
        if (k?.kind === 'compare' && store.compare(k.id)?.dirty && !discard && !confirm('Close the comparison? Your edits in it that are not saved go.')) return;
        if (k?.kind === 'disk') {
          hostRef.current?.flushAll();
          // Unsaved changes to a file on disk: ask first.
          if (store.diskTab(k.path)?.dirty && !discard) return setDialog({ type: 'closeDisk', key });
          unwatchDisk(k.path);
        }
        hostRef.current?.drop(key);
        if (getReaderState().key === key) stopReading();
        store.close(key);
        if (vs) {
          const rest = shown.filter((x) => x !== key && store.session.open.includes(x));
          const next = rest[Math.min(Math.max(shown.indexOf(key), 0), rest.length - 1)] ?? null;
          if (store.session.active !== next) store.setTabView(store.session.view, next, viewKey);
        }
        // Empty untitled tabs are not worth keeping.
        if (file && /^new \d+$/.test(file.name) && !store.text(file.id).trim() && !file.sha) store.remove(file.id);
      },
      reopenClosed: () => store.reopenClosed() || toast('No closed tabs to reopen'),
      // Ctrl+Tab: through the tabs the bar shows.
      cycleTab(step) {
        const { active, side } = store.session;
        const vs = tabViewState();
        const open = [...vs.keys, ...vs.guests].filter((k) => k !== side);
        if (!open.length || (open.length === 1 && open[0] === active)) return;
        const at = open.indexOf(active);
        store.open(open[at === -1 ? 0 : (at + step + open.length) % open.length]);
      },
      // ---- Tab views: which groups of tabs the bar shows ----
      /** Shows these groups (null: all tabs), with the tab last open in that view. */
      setTabView(view) {
        const vs = tabViewState();
        store.setTabView(view, activeFor(view, vs), viewKey);
        setView('editor');
      },
      stepTabView(step) {
        const vs = tabViewState();
        actions.setTabView(stepView(vs.view, vs.groups, step));
      },
      /** Only the open tab's group. */
      onlyActiveGroup() {
        const key = store.session.active;
        if (key) actions.setTabView([tabViewState().groupOfKey(key)]);
      },
      moveToGroup(key, group) {
        store.assignGroup(key, group);
        const name = group ? tabViewState().nameOf(group) : '';
        toast(group ? `Moved to ${name}` : 'Back in its own group', { timeout: 2500 });
      },
      tabViews: () => window.dispatchEvent(new CustomEvent('tabs:views')),
      moveActiveToGroup: () => store.session.active && window.dispatchEvent(new CustomEvent('tabs:move', { detail: { key: store.session.active } })),
      /** A folder as a tab group: linked to a project, its color. */
      folderGroup: (path) => setDialog({ type: 'folderGroup', path }),
      /** Folders: only the tabs of a folder shown there (its picked folder's group). */
      showFolderTabs: (section) => actions.setTabView([folderGroupOf(section).id]),
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
        if (diskReadOnly(disk)) return toast(disk.readOnly ? 'This file is read-only here: the app it came from does not let it be saved.' : 'This tab is read-only (followed, or the end of a large file).');
        if (now.kind === 'file' && store.isSealed(now.id)) return;
        const sel = hostRef.current?.selectionInfo();
        const part = sel && sel.key === now.key && sel.from !== sel.to ? sel : null;
        const source = part ? part.text : now.text;
        if (!source.trim()) return;
        const formatter = formatterFor(now.name, findLanguage(now.name, now.language)?.name ?? '') ?? guessFormatter(source);
        // A language server that formats: first, unless the editor's own are chosen (Settings), or alone.
        // Per language when Settings says so (the tab's server's language).
        if ((formatFirst(getSettings(), lspRef.current?.entryOf(now.key)) !== 'builtin' || !formatter) && (await actions.formatWithServer?.(now.key, part))) return;
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

      /** The model suggests a project and tags for the active file (Undo puts back what it had). */
      async suggestFiling() {
        const now = activeInfo();
        if (now?.kind !== 'file') return;
        const { llm } = getSettings();
        if (!llm.enabled || !llm.chatModel) return toast('Turn on the model in Settings first.', { kind: 'error' });
        if (!now.text.trim()) return toast('Write something first: the model files a note by what it says.');
        toast('Asking the model…', { timeout: 2500 });
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
      /** The open file's name and language, for questions about the editor (nothing of its text), or null. */
      openFileInfo() {
        const k = parseKey(store.session.active ?? '');
        if (!k) return null;
        const file = k.kind === 'file' ? store.get(k.id) : null;
        const name = file?.name ?? (k.kind === 'disk' ? store.diskTab(k.path) : store.repoTab(k.path))?.name ?? '';
        return name ? { name, language: findLanguage(name, file?.language)?.name ?? '' } : null;
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
          // A document: its view reads it again too.
          const tab = store.diskTab(path);
          if (tab?.doc) store.diskPatch(path, { reloads: (tab.reloads ?? 0) + 1 });
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
        hostRef.current?.setReadOnly(diskKey(path), on || tab.truncated || tab.readOnly);
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
        if (!isRemotePath(path)) return window.desktop?.disk?.show?.(path);
        actions.showInFolders(path.slice(0, path.lastIndexOf('/')) || remoteRoot(remoteParts(path).id));
      },
      /** A file on disk or a server with its own program (on the phone: an app of the person's choice). */
      async openOutside(path) {
        if (isContentPath(path)) return actions.openWithApp(path);
        try {
          await window.desktop.folders.openExternal(path);
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error' });
        }
      },
      /** A document's text, as its view read it: the tab's text (search, the model, "As text"). */
      documentText(path, text) {
        const tab = store.diskTab(path);
        if (!tab?.doc || tab.text === text) return;
        store.diskPatch(path, { text });
        hostRef.current?.replaceText(diskKey(path), text);
      },
      /** A document shown as text in the editor (to select, search, copy), or as it looks again. */
      documentAsText(path, on) {
        if (!store.diskTab(path)?.doc) return;
        store.diskPatch(path, { asText: on });
      },
      /** Android: a file from another app, opened with an app of the person's choice. */
      async openWithApp(path) {
        try {
          await window.desktop.android.openWith(path, '');
        } catch (err) {
          toast(err.message, { kind: 'error' });
        }
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
      /**
       * Files copied in another app (Explorer, Finder) and pasted here (desktop): opened where
       * they are, as tabs (folders in the folders view; pictures are left to `onImage`).
       * True when they were taken.
       */
      openPastedFiles(files) {
        const disk = window.desktop?.disk;
        if (!disk?.openPasted) return false;
        const given = files.filter((f) => disk.pathOf(f) && !isImageName(f.name));
        if (!given.length) return false;
        disk
          .openPasted(given)
          .then((n) => !n && toast('Nothing to open: the files pasted are not on this computer any more.', { kind: 'error' }))
          .catch((err) => toast(ipcMessage(err), { kind: 'error' }));
        return true;
      },
      /** A path pasted into the text (desktop): it stays pasted, and opening it is offered. */
      offerPastedPath(path) {
        if (!window.desktop?.disk?.openTyped) return;
        toast(`You pasted a path. Open ${baseName(path)}?`, { action: { label: 'Open', run: () => actions.openTypedPath(path) }, timeout: 8000 });
      },
      /** A path pasted or typed: the file as a tab, a folder in the folders view (asked first when new here). */
      async openTypedPath(path) {
        try {
          const result = await window.desktop.disk.openTyped(path);
          if (result?.missing) toast(`Not found: ${path}`, { kind: 'error' });
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error' });
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
          const read = tab ?? (await window.desktop.disk.read(path));
          // A document: its text, as a text file.
          if (read.doc && !read.text) return toast('Its text is not read yet: open it first.');
          const name = read.doc ? `${read.name.replace(/\.[^.]+$/, '')}.txt` : read.name;
          actions.newFile({ name, text: read.text });
          toast(read.doc ? `Its text is now in your files as ${name}, and syncs. The document is not changed.` : `${name} is now also in your files, and syncs. The file on disk is not changed.`);
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
      compareDiskFiles(a, b) {
        actions.compareFiles({ key: diskKey(a) }, { key: diskKey(b) });
      },
      /** Open tabs follow files and folders renamed or moved in the folders view ([{ from, to }]). */
      followDiskMoves(moves) {
        hostRef.current?.flushAll();
        const marks = getSettings().docBookmarks;
        const moved = movedBookmarks(marks, moves);
        if (moved !== marks) saveSettings({ docBookmarks: moved });
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
        let picked;
        try {
          picked = await window.desktop.folders.pick(defaultPath);
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error', timeout: 12000 });
          return null;
        }
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
      /**
       * The folder of a file open on disk or a server in the folders view, beside the others
       * (or the folder shown that holds it), with the file picked in the tree. A folder on this
       * computer that was not picked yet is asked about first (a native dialog).
       */
      async showFolderOf(path) {
        if (!window.desktop?.folders) return;
        let dir;
        try {
          if (isRemotePath(path)) {
            const { id, path: inside } = remoteParts(path);
            const parent = inside.slice(0, inside.lastIndexOf('/'));
            dir = parent ? toRemoteUri(id, parent) : remoteRoot(id);
            await window.desktop.remote.connect(id);
          } else {
            const allowed = await window.desktop.folders.allowParent(path);
            if (!allowed?.dir) return;
            dir = allowed.dir;
          }
        } catch (err) {
          return toast(ipcMessage(err), { kind: 'error', timeout: 8000 });
        }
        const { already, ...patch } = besideSettings(getSettings(), dir);
        saveSettings({ sidebarMode: 'folders', ...patch });
        setSidebar(true);
        revealInFolders(path);
      },
      /** The folders shown side by side: their order, and adding or closing some (a dialog). */
      sideBySide() {
        if (!window.desktop?.folders) return toast('Folders work in the desktop app.', { kind: 'error' });
        setDialog({ type: 'sideBySide' });
      },
      /** Shows `list` side by side in the folders view, `current` (else the current one, if still shown) worked in. */
      showSections(list, current) {
        const s = getSettings();
        const folder = current ?? (list.includes(s.folder) ? s.folder : list[0]);
        saveSettings({ sidebarMode: 'folders', folderSections: list, folder, folderCollapsed: (s.folderCollapsed ?? []).filter((p) => list.includes(p)) });
        setSidebar(true);
      },
      /** Ctrl+Shift+E: the folders view (a folder is picked first when there is none yet). */
      async showFolders() {
        if (!window.desktop?.folders) return;
        if (!(await window.desktop.folders.roots().catch(() => [])).length) return actions.openFolder();
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
          // A file on a server, or from another Android app, goes as a copy (its address is no path others can use).
          return d && { name: d.name, text: d.text, path: d.missing || isRemotePath(d.path) || isContentPath(d.path) ? '' : d.path, dirty: d.dirty };
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
      // ---- Comparisons in tabs of their own (c:<id>; ui/compareTab.js) ----
      /** Two files compared in a tab: sides { key } (a file) or { text, label, detail }. */
      compareFiles(left, right) {
        hostRef.current?.flushAll();
        store.openCompare({ mode: 'files', left, right });
        setView('editor');
      },
      /** Two folders compared in a tab; without `right`, a dialog asks for it. */
      compareFolders(left, right = null) {
        if (!window.desktop?.compare) return toast('Folders are compared in the desktop and Android apps.', { kind: 'error' });
        if (!right) return setDialog({ type: 'compareFolder', other: left, side: 'right', onPick: (p) => actions.compareFolders(left, p) });
        store.openCompare({ mode: 'folders', left: { path: left }, right: { path: right }, show: 'diff' });
        setView('editor');
      },
      /** Two folders side by side in a tab (two panes, like WinSCP); without `right`, a dialog asks for it. */
      twoPanes(left, right = null) {
        if (!window.desktop?.compare) return toast('Two panes are in the desktop and Android apps.', { kind: 'error' });
        if (!right) return setDialog({ type: 'compareFolder', other: left, side: 'right', panes: true, onPick: (p) => actions.twoPanes(left, p) });
        store.openCompare({ mode: 'panes', left: { path: left }, right: { path: right } });
        setView('editor');
      },
      /** Another folder on one side of a folder comparison or of two panes. */
      pickCompareFolder({ id, side }) {
        const c = store.compare(id);
        if (!c) return;
        const other = c[side === 'left' ? 'right' : 'left'].path;
        setDialog({ type: 'compareFolder', other, side, panes: c.mode === 'panes', onPick: (p) => store.updateCompare(id, { [side]: { path: p }, expanded: [] }) });
      },
      updateCompare: (id, patch, opts) => store.updateCompare(id, patch, opts),
      /** Unsaved edits in a files comparison: the tab's dot. */
      compareDirty(id, dirty) {
        if (Boolean(store.compare(id)?.dirty) !== dirty) store.updateCompare(id, { dirty });
      },
      compareScan: (left, right, opts) => window.desktop.compare.scan(left, right, opts),
      compareSame: (left, right, rels) => window.desktop.compare.same(left, right, rels),
      async compareCopy(from, to, rels) {
        const r = await window.desktop.compare.copy(from, to, rels);
        window.dispatchEvent(new CustomEvent('folders:reload'));
        return r;
      },
      async compareRemove(root, rels) {
        const r = await window.desktop.compare.remove(root, rels);
        window.dispatchEvent(new CustomEvent('folders:reload'));
        return r;
      },
      /**
       * A side of a files comparison, read: { text, info, readOnly, savable, saveLabel }. A file
       * open in a tab gives its text there (unsaved edits too); a file on disk or a server not
       * open is read (its format kept in `info` for saving back).
       */
      async readCompareSide(side) {
        if (side.text != null) return { text: side.text, readOnly: false, savable: false };
        const k = parseKey(side.key);
        if (k?.kind === 'file') {
          const f = store.get(k.id);
          if (!f || f.deleted) throw new Error('That file is not in my files any more.');
          if (store.isSealed(k.id)) throw new Error(`${f.name} is encrypted and locked on this device: unlock it first.`);
          return { text: hostRef.current?.stateOf(side.key)?.doc.toString() ?? store.text(k.id), readOnly: false, savable: true, saveLabel: 'in my files' };
        }
        if (k?.kind === 'repo') {
          let text = store.repoTab(k.path)?.text ?? store.docText(k.path);
          if (text == null) {
            const { client, branch } = await syncedClient();
            text = (await client.getFile(k.path, branch))?.text ?? '';
          }
          return { text, readOnly: false, savable: true, saveLabel: 'to the tracker' };
        }
        if (k?.kind === 'disk') {
          const tab = store.diskTab(k.path);
          if (tab && !tab.stale && !tab.doc) return { text: hostRef.current?.stateOf(side.key)?.doc.toString() ?? tab.text, readOnly: diskReadOnly(tab), savable: true, info: { open: true }, saveLabel: isRemotePath(k.path) ? 'to the server' : 'to disk' };
          const info = await window.desktop.disk.read(k.path);
          if (info.doc) throw new Error(`${k.path.split(/[\\/]/).pop()} is a document (shown as it looks), not text to compare.`);
          return { text: info.text, readOnly: Boolean(info.truncated), savable: !info.truncated, info, saveLabel: isRemotePath(k.path) ? 'to the server' : 'to disk' };
        }
        throw new Error('That file cannot be read here.');
      },
      /**
       * Saves a side's text where it came from: my files and tracker documents as an edit (open
       * tabs follow), a file on disk or a server written back (an open tab through its own save,
       * which refuses when the file changed meanwhile). Returns the side's new `info`, or null.
       */
      async saveCompareSide(side, text, info) {
        const k = parseKey(side.key);
        try {
          if (k?.kind === 'file') {
            store.setText(k.id, text, { urgent: true });
            hostRef.current?.replaceText(side.key, text);
            toast(`Saved ${store.get(k.id)?.name ?? 'the file'}.`);
            return info ?? {};
          }
          if (k?.kind === 'repo') {
            store.setRepoText(k.path, text, { urgent: true });
            hostRef.current?.replaceText(side.key, text);
            toast('Saved the tracker document.');
            return info ?? {};
          }
          if (k?.kind === 'disk') {
            const name = k.path.split(/[\\/]/).pop();
            if (store.diskTab(k.path)) {
              store.setDiskText(k.path, text, { urgent: true });
              hostRef.current?.replaceText(side.key, text);
              const done = await saveDiskTab(k.path);
              if (done === 'conflict') {
                toast(`${name} changed ${isRemotePath(k.path) ? 'on the server' : 'on disk'} meanwhile: your text is in its tab, not saved. Open it there to choose.`, { kind: 'error', timeout: 10000 });
                return null;
              }
              toast(`Saved ${name}.`);
              return { open: true };
            }
            const format = { eol: info?.eol, bom: info?.bom, encoding: info?.encoding };
            const w = await window.desktop.disk.write(k.path, text, { ...format, expectedMtime: info?.mtimeMs, expectedSize: info?.size });
            if (w.conflict) {
              toast(`${name} changed ${isRemotePath(k.path) ? 'on the server' : 'on disk'} since it was read: read both again (⋯) and copy your changes over.`, { kind: 'error', timeout: 10000 });
              return null;
            }
            toast(`Saved ${name}.`);
            return { ...info, ...w };
          }
        } catch (err) {
          toast(ipcMessage(err), { kind: 'error' });
          return null;
        }
        return null;
      },
      /** The saved comparison a comparison is (by its id, or the same two places), or null. */
      savedCompareOf(record) {
        const list = getSettings().savedCompares ?? [];
        return (record && (list.find((x) => x.id === record.savedId) ?? list.find((x) => sameSides(x, record)))) || null;
      },
      canSaveCompare: (key) => canSave(store.compare(parseKey(key)?.id)),
      /** ☆: names a comparison to keep it (or renames or removes the saved one). */
      saveCompare(key) {
        const id = parseKey(key)?.id;
        if (!store.compare(id)) return;
        if (!canSave(store.compare(id)) && !actions.savedCompareOf(store.compare(id))) return toast('A comparison with text taken once (the clipboard, a file picked from this device) cannot be saved.');
        setDialog({ type: 'saveCompare', id });
      },
      /** A saved comparison opened again (its tab, when it is open already), read fresh. */
      openSavedCompare(saved) {
        const open = store.session.open.find((k) => k.startsWith('c:') && actions.savedCompareOf(store.compare(k.slice(2)))?.id === saved.id);
        if (open) store.open(open);
        else store.openCompare({ mode: saved.mode, left: saved.left, right: saved.right, show: saved.show ?? 'diff', all: Boolean(saved.all), savedId: saved.id, name: saved.name });
        setView('editor');
      },
      showSavedCompares() {
        if (!(getSettings().savedCompares ?? []).length) return toast('No saved comparisons yet: open one (a folder’s menu → Compare with another folder…, or Compare with…) and click its ☆.');
        setDialog({ type: 'savedCompares' });
      },
      /** A side of a comparison opened in its own tab. */
      openCompareSide(side) {
        const k = parseKey(side?.key);
        if (k?.kind === 'disk') return store.diskTab(k.path) ? store.open(side.key) : actions.openDiskPath(k.path);
        if (k?.kind === 'repo') return actions.openRepoFile(k.path);
        if (k?.kind === 'file') return actions.openFile(k.id);
      },
      compareWith() {
        if (!store.session.active) return;
        hostRef.current?.flushAll();
        setDialog({ type: 'compare' });
      },
      /**
       * The open file compared with `entry`: a picker row (`id` a tab key: my files, a
       * tracker document, a file on disk or a server, open or not) or a file picked with
       * Browse… ({ browsed: true, name, text, detail }).
       */
      async compareWithEntry(entry) {
        const now = activeInfo();
        if (!now) return;
        // The open file on the left, the other one on the right, in a comparison tab.
        actions.compareFiles({ key: now.key }, entry.browsed ? { text: entry.text, label: entry.name, detail: entry.detail ?? '' } : { key: entry.id });
      },
      /** Compare with… any file: the open dialog (desktop), else the browser's file picker. */
      async compareBrowse() {
        if (!store.session.active) return;
        if (window.desktop?.disk) {
          const [file] = await window.desktop.disk.open({ title: 'Compare with…', single: true });
          if (!file) return;
          if (file.error) return toast(`${file.name}: ${file.error}`, { kind: 'error' });
          return actions.compareWithEntry({ browsed: true, name: file.name, text: file.text, detail: placeOfPath(file.path) });
        }
        const input = document.createElement('input');
        input.type = 'file';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          try {
            actions.compareWithEntry({ browsed: true, name: file.name, text: (await file.text()).replace(/\r\n?/g, '\n'), detail: 'Picked from this device' });
          } catch (err) {
            toast(err.message, { kind: 'error' });
          }
        };
        input.click();
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
        actions.compareFiles({ key: now.key }, { text: clip.replace(/\r\n?/g, '\n'), label: 'Clipboard', detail: 'Copied text' });
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
        if (docReader) return docReader.listen();
        if (previewReader?.hidesText()) return previewReader.listen();
        const host = hostRef.current;
        host?.flushAll();
        const snap = host?.snapshot();
        if (!snap) return;
        const k = parseKey(snap.key);
        const file = k.kind === 'file' ? store.get(k.id) : null;
        const name = file?.name ?? (k.kind === 'disk' ? store.diskTab(k.path)?.name : store.repoTab(k.path)?.name) ?? '';
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

// Suggestions as you type: "server|model" → whether its /completions works (fill in the middle).
const fillsMiddle = new Map();

/** The folder a path is in: "/w/a.py" → "/w", "/a.py" → "/", "C:\\a.py" → "C:\\". */
function parentDir(p) {
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (at === -1) return p;
  const dir = p.slice(0, at);
  return !dir || /^[A-Za-z]:$/.test(dir) || /:\/\/[^/]*$/.test(dir) ? p.slice(0, at + 1) : dir;
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
  // Touch screens: typing with the keyboard up (the edit bar instead of the status bar), and the
  // menu a tap on a line number opens ({ key, x, top, bottom }).
  const [editing, setEditing] = useState(false);
  const [lineMenu, setLineMenu] = useState(null);
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
  const lspRef = useRef(null); // language servers (lsp.js), desktop
  const [lspTick, setLspTick] = useState(0);
  const [refs, setRefs] = useState(null); // { word, list, server }: the References panel
  const [codeMenu, setCodeMenu] = useState(null); // { key, rows, at }: a language server's quick fixes
  const [gitMenu, setGitMenu] = useState(null); // { key, line, x, y }: a changed line's mark clicked
  const [gitDir, setGitDir] = useState(null); // the folder whose repository the Git panel shows
  const [gitTick, setGitTick] = useState(0); // Git's state may have changed: the panel reads it again
  const actions = useActions({ hostRef, setView, setPanel, setDialog, setSidebar, setCompare, setUsagesOf, setSearchSeed });
  const editorOptions = (s) => ({ ...s, dark: resolvedTheme(s.theme) === 'dark', inlineSuggest: Boolean(s.inlineSuggest && s.llm.enabled && s.llm.provider !== 'async') });

  /**
   * Suggestions as you type (inlineSuggest.js asks): the model's /completions with the text
   * after the cursor (fill in the middle), or, for servers and models without it, a chat.
   * Never for encrypted files.
   */
  actions.suggestText = async ({ prefix, suffix, language, name, signal, key }) => {
    const s = getSettings();
    const model = s.llm.completeModel || s.llm.chatModel;
    if (!s.inlineSuggest || !s.llm.enabled || s.llm.provider === 'async' || !model) return '';
    const k = parseKey(key);
    if (k?.kind === 'file' && store.get(k.id)?.encrypted) return '';
    const client = llmClient(s);
    const where = `${s.llm.baseUrl}|${model}`;
    if (fillsMiddle.get(where) !== false) {
      try {
        const text = await client.complete({ model, prompt: prefix, suffix, maxTokens: 96, temperature: 0.1, signal });
        fillsMiddle.set(where, true);
        return text;
      } catch (err) {
        if (err?.name === 'AbortError' || ![400, 404, 405, 422, 501].includes(err?.status) || fillsMiddle.get(where)) throw err;
        fillsMiddle.set(where, false);
      }
    }
    return client.chat({ model, messages: completionMessages({ prefix, suffix, language, name }), purpose: 'complete', signal, temperature: 0.1 });
  };

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
  // Local mode, and the tracker moved the data on this device to GitHub: offer to follow it.
  useEffect(() => {
    movedTo().then(
      (to) =>
        to &&
        toast(`Your data moved to GitHub (${to.owner}/${to.repo}). Connect here too, with the same token, to keep working on it.`, {
          timeout: 30000,
          key: 'moved',
          action: {
            label: 'Connect',
            run: () => {
              saveSettings({ owner: to.owner, repo: to.repo, branch: to.branch ?? '' });
              actions.showSettings();
            },
          },
        }),
    );
  }, []);
  // Servers (desktop): their status shows on tabs; when one connects again, its tabs are looked at again.
  useEffect(() => {
    const offStatus = watchServers({
      onConnected: (id) => {
        recheckServerTabs(id);
        // Language servers that stopped with the connection start again.
        lspRef.current?.reconnected(id);
      },
    });
    const offList = onServers(rerender);
    return () => (offStatus(), offList());
  }, []);
  // Tab views (desktop): the folders that make tab groups follow Folders (the picked folder
  // behind each one shown); a folder named like a project is offered to link to it, once.
  const sectionsKey = withCurrent(settings.folderSections, settings.folder).join('\n');
  useEffect(() => {
    if (!window.desktop?.folders) return;
    let live = true;
    loadRoots().then((changed) => {
      if (!live) return;
      rememberFolders();
      if (changed) rerender();
      const s = getSettings();
      const projects = projectList(store.live(), store.projects());
      for (const folder of sectionFolders(s)) {
        if (folder in (s.folderProjects ?? {})) continue;
        const project = suggestedProject(folder, projects);
        if (!project) continue;
        saveSettings({ folderProjects: { ...s.folderProjects, [folder]: '' } });
        toast(`Show the tabs of the folder “${baseName(folder)}” together with the project ${project.name} (its notes and tracker documents)?`, {
          timeout: 15000,
          action: { label: 'Link them', run: () => saveSettings({ folderProjects: { ...getSettings().folderProjects, [folder]: project.name } }) },
        });
        break;
      }
    });
    return () => {
      live = false;
    };
  }, [sectionsKey]);
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
      // "file:line" Ctrl+clicked: from the file's folder when it has one.
      onOpenRef: (ref, key) => {
        const k = parseKey(key);
        const base = k?.kind === 'disk' ? parentDir(k.path) : '';
        actions.openRef(ref, base);
      },
      onSuggest: (request) => actions.suggestText(request),
      // A problem's tooltip: the model explains it, or fixes the file's problems.
      onProblemAction: (kind, key, problem) => (kind === 'quickfix' ? actions.quickFix({ key, from: problem.from, to: problem.to }) : kind === 'fix' ? actions.fixProblems(key) : actions.explainProblem(problem, key)),
      // An image pasted or dropped into the text: read its text.
      onImage: (file) => actions.readImages([{ blob: file, name: file.name || 'Pasted image' }]),
      onPasteFiles: (files) => actions.openPastedFiles(files),
      onPastePath: (path) => actions.offerPastedPath(path),
      onLineMenu: (at) => setLineMenu(at),
      onGitMark: (at) => setGitMenu(at),
      linkTargets: () => store.live().map((f) => linkName(f.name)),
      // A tab's editor state is gone (closed, or made again under a new path): its server forgets it.
      onDrop: (key) => lspRef.current?.forget(key),
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
      onProblems(key, list, language, { server = false } = {}) {
        const checked = server || language === 'JSON' || SYNTAX_LANGUAGES.has(language);
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
        if (name === 'quickFix') actions.quickFix();
        if (name === 'organizeImports') actions.organizeImports();
        return true;
      },
    });
    lspRef.current = createLanguageServers({
      host: hostRef.current,
      onChange: () => setLspTick((n) => n + 1),
      onMessage: (text, kind) => toast(text, { kind, timeout: 8000 }),
      openPath: (path) => actions.openDiskPath(path),
      // A synced file or tracker document (its tab key).
      openKey: (key) => actions.openFile(key.startsWith('f:') ? key.slice(2) : key),
      // Edits a server asks for (after a command): shown first when they reach files not open.
      applyEdit: (edit, { label, server, placeOf }) => actions.applyWorkspaceEdit(edit, { title: label || `Changes from ${server}`, userEvent: 'input.codeaction', placeOf }),
      onQuickFix: () => actions.quickFix(),
      // Settings → Language servers, per language: off, and which server.
      languages: () => languageOptions(getSettings().lspLanguages),
    });
  }, []);
  // Turned off in Settings: the tabs lose their servers (turned on again: when shown next).
  useEffect(() => {
    if (settings.languageServers === false) lspRef.current?.detachAll();
  }, [settings.languageServers]);
  // A language turned on or off, or another server chosen for it (Settings): its servers stop and
  // the tabs look again (the open one at once).
  const lspLanguagesWere = useRef(settings.lspLanguages);
  useEffect(() => {
    const changed = changedLanguages(lspLanguagesWere.current, settings.lspLanguages);
    lspLanguagesWere.current = settings.lspLanguages;
    if (!changed.length || !lspRef.current) return;
    lspRef.current.languagesChanged(changed).then(() => attachLanguageServer(store.session.active));
  }, [settings.lspLanguages]);
  // A server of your own added or removed (Settings): the tabs without one look again.
  useEffect(() => {
    const onChanged = () => lspRef.current?.refresh(getSettings().languageServers !== false ? store.session.active : null);
    window.addEventListener('lsp:servers-changed', onChanged);
    return () => window.removeEventListener('lsp:servers-changed', onChanged);
  }, []);
  useEffect(
    () => hostRef.current?.applySettings(editorOptions(settings)),
    [settings.theme, settings.wordWrap, settings.showWhitespace, settings.tabSize, settings.lineNumbers, settings.problems, settings.indentGuides, settings.bracketColors, settings.stickyScroll, settings.detectIndent, settings.indentChosen, settings.emmet, settings.linkedTags, settings.inlineSuggest, settings.llm],
  );
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => hostRef.current?.applySettings(editorOptions(getSettings()));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const activeKey = store.session.active;
  // The open tab's group (a project or a folder), for the status bar.
  const viewNow = tabViewState(settings);
  const activeGroup = activeKey && viewNow.groups.length > 1 ? (viewNow.groups.find((g) => g.id === viewNow.groupOfKey(activeKey) && (g.kind === 'project' || g.kind === 'folder')) ?? null) : null;
  // Tabs on disk and on servers, for Ctrl+P (their folders may not be open in Folders).
  const openDiskTabs = () =>
    store.session.open
      .filter((k) => k.startsWith('d:'))
      .map((key) => {
        const d = store.diskTab(key.slice(2));
        const g = viewNow.groups.find((x) => x.id === viewNow.groupOfKey(key));
        return d && { id: key, name: d.name, path: d.path, rel: d.name, kind: kindOfKey(key), where: g?.name ?? '' };
      })
      .filter(Boolean);
  // Compare with…: the open tabs nearest the open one first, my files and tracker documents,
  // each with where it is and the color of its project or folder group.
  const compareSources = () => {
    const projects = projectList(store.live(), store.projects());
    const projectGroup = (name) => {
      const p = name && projects.find((x) => x.key === projectKey(name));
      return p ? { name: p.name, color: p.color } : null;
    };
    const tabGroup = (key) => {
      const g = viewNow.groups.find((x) => x.id === viewNow.groupOfKey(key));
      return g && (g.kind === 'project' || g.kind === 'folder') ? { name: g.name, color: g.color } : null;
    };
    const tabRow = ({ key, near }) => {
      const k = parseKey(key);
      const kind = kindOfKey(key);
      if (k.kind === 'file') {
        const f = store.get(k.id);
        return f && { id: key, name: f.name, kind, project: f.project, language: f.language, near, detail: placeOfKey(key), group: tabGroup(key) };
      }
      if (k.kind === 'disk') {
        const d = store.diskTab(k.path);
        return d && { id: key, name: d.name, kind, path: k.path, rel: relInFolders(k.path, settings), near, detail: placeOfPath(k.path), group: tabGroup(key) };
      }
      const doc = store.doc(k.path);
      const name = store.repoTab(k.path)?.name ?? doc?.name;
      return name && { id: key, name, kind, project: doc?.project ?? '', item: doc?.item.title, near, detail: placeOfKey(key), group: tabGroup(key) };
    };
    const nameOfKey = (key) => {
      const k = parseKey(key);
      return k?.kind === 'file' ? store.get(k.id)?.name : k?.kind === 'disk' ? store.diskTab(k.path)?.name : store.repoTab(k?.path)?.name;
    };
    const tabs = nearestTabs([...viewNow.keys, ...viewNow.guests], activeKey, nameOfKey, store.session.open).map(tabRow).filter(Boolean);
    const files = store
      .live()
      .filter((f) => fileKey(f.id) !== activeKey)
      .sort((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1))
      .map((f) => ({ id: fileKey(f.id), name: f.name, kind: 'synced', project: f.project, language: f.language, modifiedAt: f.modifiedAt, detail: ['My files', f.project].filter(Boolean).join(' · '), group: projectGroup(f.project) }));
    const docRows = docs
      .filter((d) => repoKey(d.path) !== activeKey)
      .sort((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1))
      .map((d) => ({ id: repoKey(d.path), name: d.name, kind: 'doc', project: d.project, item: d.item.title, modifiedAt: d.modifiedAt, detail: `Tracker · ${d.item.title}`, group: projectGroup(d.project) }));
    const rootGroups = new Map();
    const groupOfRoot = (dir) => {
      if (!rootGroups.has(dir)) {
        const g = folderGroupOf(dir, settings);
        rootGroups.set(dir, g && (g.kind === 'project' || g.kind === 'folder') ? { name: g.name, color: g.color } : null);
      }
      return rootGroups.get(dir);
    };
    return { current: { name: activeName, detail: placeOfKey(activeKey) }, tabs, files, docs: docRows, groupOfRoot };
  };
  const active = parseKey(activeKey);
  const activeFile = active?.kind === 'file' ? store.get(active.id) : null;
  const activeRepo = active?.kind === 'repo' ? store.repoTab(active.path) : null;
  const activeDisk = active?.kind === 'disk' ? store.diskTab(active.path) : null;
  // A comparison in its tab (two files or two folders) takes the editor's place.
  const activeCompare = active?.kind === 'compare' ? store.compare(active.id) : null;
  const activeName = activeFile?.name ?? activeRepo?.name ?? activeDisk?.name ?? '';
  // The text of the open tab, whatever its kind.
  const activeText = () => (activeFile ? store.text(activeFile.id) : (activeRepo ?? activeDisk)?.text ?? '');
  const languageName = activeKey && !activeCompare ? (findLanguage(activeName, activeFile?.language)?.name ?? PLAIN_TEXT) : '';
  const previewType = activeKey ? previewKind(activeName, languageName) : '';
  // An encrypted file this device cannot read yet shows a lock instead of the editor.
  const activeSealed = Boolean(activeFile && store.isSealed(activeFile.id));
  const showPreview = Boolean(previewType) && preview.has(activeKey) && !compare && !activeSealed;
  // A document (PDF, e-book, Word…) shows as it looks, in the editor's place, unless "As text".
  const docShown = Boolean(((activeDisk?.doc && !activeDisk.asText) || activeRepo?.doc) && view === 'editor' && !compare);
  // A comparison belongs to its tab.
  useEffect(() => {
    if (compare && compare.key !== activeKey) setCompare(null);
  }, [activeKey]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!activeKey || view !== 'editor' || (!activeFile && !activeRepo && !activeDisk) || activeSealed || docShown) {
      host.hide();
      return;
    }
    host.show(activeKey, {
      text: activeText(),
      name: activeName,
      language: activeFile?.language ?? '',
    });
    // A followed file, or the tail of a huge one, is read-only.
    if (activeDisk) host.setReadOnly(activeKey, diskReadOnly(activeDisk));
    setBig(host.isBig(activeKey));
    // Code gets its language server (started when needed).
    attachLanguageServer(activeKey);
    if (!isNarrow()) host.focus();
  }, [activeKey, view, Boolean(activeFile || activeRepo || activeDisk), activeSealed, docShown]);

  /**
   * The language server of a tab shown: a disk tab's on this computer, or on its SSH server
   * (where it runs; its project is looked for up to the home folder there), or for a synced file
   * or tracker document alone (on this computer; never an encrypted one). Settings can leave the
   * last two out.
   */
  function attachLanguageServer(key) {
    const lsp = lspRef.current;
    const s = getSettings();
    if (!lsp || !key || s.languageServers === false || hostRef.current?.isBig(key)) return;
    const k = parseKey(key);
    if (k?.kind === 'disk') {
      const disk = store.diskTab(k.path);
      if (!disk || disk.doc) return;
      if (!isRemotePath(disk.path)) return lsp.attach(key, disk.path);
      if (s.languageServersRemote === false || server(remoteParts(disk.path).id)?.protocol !== 'sftp') return;
      return lsp.attach(key, disk.path);
    }
    if (s.languageServersNotes === false) return;
    if (k?.kind === 'file') {
      const f = store.get(k.id);
      // Encrypted text never goes to a server (one it had is let go).
      if (!f || f.encrypted || store.isSealed(f.id)) return lsp.detach(key);
      return lsp.attachNote(key, f.name);
    }
    if (k?.kind === 'repo') {
      const r = store.repoTab(k.path);
      if (r) return lsp.attachNote(key, r.name);
    }
  }
  // Renamed (another kind of file), encrypted, or a kind of file turned on or off in Settings.
  const lspPlaces = useRef(null);
  useEffect(() => {
    const now = `${settings.languageServersRemote !== false}/${settings.languageServersNotes !== false}`;
    if (lspPlaces.current && lspPlaces.current !== now) lspRef.current?.detachAll();
    lspPlaces.current = now;
    if (activeKey) attachLanguageServer(activeKey);
  }, [activeName, Boolean(activeFile?.encrypted), settings.languageServersRemote, settings.languageServersNotes]);

  // ---- Language servers (desktop): F12, Shift+F12 and F2 ask the file's server first ----
  // The editor's own ways (codeNav.js: the declarations it recognizes) when there is none.
  const ownWays = useRef(null);
  ownWays.current ??= { goToDefinition: actions.goToDefinition, findUsages: actions.findUsages, renameSymbol: actions.renameSymbol };
  const serverOf = (key) => (lspRef.current?.has(key) ? lspRef.current : null);
  /**
   * Places the server of tab `key` answered with ([{ uri, range }]) as { path, line, column,
   * length, text } (the line, when it can be read); a synced file's also carry its `id`.
   */
  actions.serverPlaces = async (locs, key) => {
    const texts = new Map();
    const textOf = async (path) => {
      if (!texts.has(path)) {
        let text = hostRef.current?.stateOf(diskKey(path))?.doc.toString() ?? store.diskTab(path)?.text ?? null;
        // Files not open are read (only those inside the folders you opened; 40 at most).
        if (text == null && texts.size < 40) text = await window.desktop.disk.read(path).then((r) => r.text, () => null);
        texts.set(path, text);
      }
      return texts.get(path);
    };
    const out = [];
    for (const l of locs.slice(0, 500)) {
      const place = lspRef.current?.placeOf(key, l.uri);
      if (!place) continue;
      const { start, end } = l.range;
      const at = { line: start.line + 1, column: start.character + 1, length: end.line === start.line ? end.character - start.character : 0 };
      if (!place.path) {
        // A synced file (open in its tab): shown by its name.
        const text = hostRef.current?.stateOf(place.key)?.doc.toString() ?? null;
        out.push({ ...at, id: place.key.startsWith('f:') ? place.key.slice(2) : place.key, path: tabName(place.key), text: text == null ? null : lineOf(text, start.line) });
        continue;
      }
      const text = await textOf(place.path);
      out.push({ ...at, path: place.path, text: text == null ? null : lineOf(text, start.line) });
    }
    return out;
  };
  actions.openPlace = (p) => (p.id ? actions.openFile(p.id, { line: p.line, column: p.column, length: p.length }) : actions.openDiskPath(p.path, { line: p.line, column: p.column, length: p.length }));
  actions.goToDefinition = async () => {
    const w = actions.codeWord();
    if (!w) return;
    const lsp = serverOf(w.ctx.key);
    if (lsp) {
      try {
        const places = await actions.serverPlaces(lsp.locations(await lsp.request(w.ctx.key, 'textDocument/definition', w.from, {}, 'definitionProvider')), w.ctx.key);
        if (places.length === 1) return actions.openPlace(places[0]);
        if (places.length > 1) return setDialog({ type: 'declarations', word: w.word, places: places.map((p) => ({ ...p, text: p.text?.trim() ?? '' })) });
      } catch {
        // the server could not say: the editor's own way
      }
    }
    return ownWays.current.goToDefinition();
  };
  actions.findUsages = async () => {
    const w = actions.codeWord();
    if (!w) return;
    const lsp = serverOf(w.ctx.key);
    if (lsp) {
      try {
        const result = await lsp.request(w.ctx.key, 'textDocument/references', w.from, { context: { includeDeclaration: true } }, 'referencesProvider');
        const here = parseKey(w.ctx.key)?.path ?? tabName(w.ctx.key);
        // This file first, then the others by name; each by line.
        const list = (await actions.serverPlaces(lsp.locations(result), w.ctx.key)).sort((a, b) => (b.path === here) - (a.path === here) || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
        if (list.length) {
          setRefs({ word: w.word, list, server: lsp.statusOf(w.ctx.key)?.server ?? 'the language server' });
          return setPanel('references');
        }
      } catch {
        // the editor's own way
      }
    }
    return ownWays.current.findUsages();
  };
  actions.renameSymbol = async () => {
    const w = actions.codeWord();
    if (!w) return;
    const lsp = serverOf(w.ctx.key);
    const provider = lsp?.capability(w.ctx.key, 'renameProvider');
    if (!provider) return ownWays.current.renameSymbol();
    let word = w.word;
    // The server says first whether (and what) can be renamed here.
    if (provider.prepareProvider) {
      try {
        const r = await lsp.request(w.ctx.key, 'textDocument/prepareRename', w.from);
        if (!r) return toast(`“${w.word}” cannot be renamed here.`);
        if (r.placeholder) word = r.placeholder;
      } catch (err) {
        return toast(`“${w.word}” cannot be renamed: ${err?.message ?? err}`, { kind: 'error', timeout: 8000 });
      }
    }
    setDialog({ type: 'renameSymbol', word, key: w.ctx.key, pos: w.from });
  };
  /** F2 with a server: its rename, everywhere it finds the name (other files: shown first). */
  actions.renameWithServer = async ({ key, pos, word }, newName) => {
    let edit;
    try {
      edit = await lspRef.current?.request(key, 'textDocument/rename', pos, { newName }, 'renameProvider');
    } catch (err) {
      return toast(`Could not rename “${word}”: ${err?.message ?? err}`, { kind: 'error', timeout: 8000 });
    }
    if (!edit || !editPlan(edit).files.length) return toast(`The language server has nothing to rename for “${word}”.`);
    return actions.applyWorkspaceEdit(edit, { title: `Rename “${word}” to “${newName}”`, preview: 'always', userEvent: 'input.rename', placeOf: (uri) => lspRef.current?.placeOf(key, uri) });
  };

  /**
   * Makes the edits a language server asks for (a rename, a quick fix, workspace/applyEdit):
   * - a tab with an editor changes as an edit Ctrl+Z takes back; an open tab not shown yet gets
   *   the change in its text; neither is saved (like typing);
   * - files not open are written to disk, each only if it did not change since it was read;
   *   new files are made inside the folders you opened (renaming or deleting files: not done);
   * - `preview` 'always' shows the changes first when they reach other files, 'auto' when they
   *   reach files not open, 'never' does not;
   * - `placeOf(uri)` says where a file is ({ key, path }: on a server, or a synced file's tab).
   * Undo (in the message) takes it all back where nothing changed since. Returns
   * { applied, failureReason }, the answer to workspace/applyEdit.
   */
  actions.applyWorkspaceEdit = async (edit, { title = 'Changes', preview = 'auto', userEvent = 'input', placeOf = null } = {}) => {
    const plan = editPlan(edit);
    if (plan.unsupported.length) {
      toast(`${title}: this would ${plan.unsupported.join(' and ')} files, which the editor does not do. Nothing was changed.`, { kind: 'error', timeout: 9000 });
      return { applied: false, failureReason: `The editor does not ${plan.unsupported.join(' or ')} files.` };
    }
    if (!plan.files.length && !plan.creates.length) return { applied: true };
    const host = hostRef.current;
    const lsp = lspRef.current;
    host.flushAll();
    // Line breaks as the editor keeps them (files with \r\n are written back with theirs).
    const clean = (edits) => edits.map((e) => ({ ...e, newText: String(e.newText ?? '').replace(/\r\n?/g, '\n') }));
    const where = (uri) => {
      if (placeOf) return placeOf(uri);
      const path = uriPath(uri);
      return path ? { key: diskKey(path), path } : null;
    };
    const entries = [];
    for (const c of plan.creates) {
      const path = where(c.uri)?.path;
      if (path) entries.push({ path, kind: 'new', create: c, base: '', edits: [] });
    }
    for (const f of plan.files) {
      const place = where(f.uri);
      const path = place?.path;
      const edits = clean(f.edits);
      if (place && !path) {
        // A synced file: only while its tab is open (the server knows no other).
        const state = host.stateOf(place.key);
        const text = state?.doc.toString();
        const synced = lsp?.syncedText(place.key);
        entries.push(state ? { path: place.key, name: tabName(place.key), key: place.key, kind: 'tab', base: text, edits, ...(synced != null && synced !== text ? { error: 'changed since the server looked: try again' } : {}) } : { path: place.key, name: tabName(place.key), error: 'not open', edits });
        continue;
      }
      if (!path) {
        entries.push({ path: f.uri, error: 'not a file the editor can reach', edits });
        continue;
      }
      const made = entries.find((e) => e.kind === 'new' && e.path === path);
      if (made) {
        made.edits.push(...edits);
        continue;
      }
      const key = diskKey(path);
      const state = host.stateOf(key);
      if (state) {
        // An open tab: the edits are for the text the server had, which is the text now (just sent).
        const text = state.doc.toString();
        const synced = lsp?.syncedText(key);
        entries.push({ path, key, kind: 'tab', base: text, edits, ...(synced != null && synced !== text ? { error: 'changed since the server looked: try again' } : {}) });
        continue;
      }
      const tab = store.diskTab(path);
      if (tab && !tab.stale) {
        entries.push({ path, key, kind: 'stored', base: tab.text, edits });
        continue;
      }
      // Not open (or open but not read since the app started): on disk.
      try {
        const info = await window.desktop.disk.read(path);
        entries.push(info.truncated ? { path, error: 'too large', edits } : { path, kind: 'disk', base: info.text, info, edits });
      } catch (err) {
        entries.push({ path, error: ipcMessage(err), edits });
      }
    }
    for (const e of entries) {
      if (e.error) continue;
      e.next = applyTextEdits(e.base, e.edits);
      e.rows = changedLines(e.base, e.edits) ?? [];
      if (e.next === null) e.error = 'the change does not fit the file as it is now';
    }
    const elsewhere = entries.some((e) => e.kind === 'disk' || e.kind === 'new');
    const show = preview === 'always' ? entries.length > 1 || elsewhere : preview === 'auto' && elsewhere;
    let chosen = entries.filter((e) => !e.error);
    if (show) {
      const picked = await new Promise((resolve) => setDialog({ type: 'workspaceEdit', title, entries, onDone: resolve }));
      setDialog((d) => (d?.type === 'workspaceEdit' ? null : d));
      if (!picked) return { applied: false, failureReason: 'Cancelled.' };
      chosen = chosen.filter((e) => picked.includes(e.path));
    }
    const skipped = entries.filter((e) => e.error).map((e) => ({ path: e.path, reason: e.error }));
    const undo = [];
    const written = [];
    const made = [];
    let places = 0;
    for (const e of chosen) {
      try {
        if (e.kind === 'tab') {
          if (host.stateOf(e.key)?.doc.toString() !== e.base) throw new Error('it changed meanwhile');
          host.applyChanges(e.key, { changes: textChanges(e.base, e.edits), userEvent });
          undo.push({ kind: 'tab', key: e.key, before: e.base, after: e.next });
        } else if (e.kind === 'stored') {
          if (store.diskTab(e.path)?.text !== e.base) throw new Error('it changed meanwhile');
          store.setDiskText(e.path, e.next, { urgent: true });
          undo.push({ kind: 'stored', path: e.path, before: e.base, after: e.next });
        } else if (e.kind === 'new') {
          const dir = e.path.replace(/[\\/][^\\/]*$/, '');
          await window.desktop.folders.newFile(dir, e.path.slice(dir.length + 1), { text: e.next });
          made.push(e.path);
          undo.push({ kind: 'new', path: e.path, text: e.next });
        } else {
          const format = { eol: e.info.eol, bom: e.info.bom, encoding: e.info.encoding };
          const w = await window.desktop.disk.write(e.path, e.next, { ...format, expectedMtime: e.info.mtimeMs });
          if (w.conflict) throw new Error('it changed on disk meanwhile');
          written.push(e.path);
          undo.push({ kind: 'disk', path: e.path, before: e.base, format, mtimeMs: w.mtimeMs });
        }
        places += e.edits.length;
      } catch (err) {
        skipped.push({ path: e.path, reason: ipcMessage(err) });
      }
    }
    if (written.length || made.length) lsp?.filesChanged(written, { created: made });
    const nameOf = (p) => (/^[fr]:/.test(p) ? tabName(p) : String(p).split(/[\\/]/).pop());
    const undoAll = async () => {
      const failed = [];
      const back = [];
      for (const u of [...undo].reverse()) {
        try {
          if (u.kind === 'tab') {
            if (!host.restoreText(u.key, u.after, u.before)) failed.push(u.key.slice(2));
          } else if (u.kind === 'stored') {
            if (store.diskTab(u.path)?.text === u.after) store.setDiskText(u.path, u.before, { urgent: true });
            else failed.push(u.path);
          } else if (u.kind === 'new') {
            const now = await window.desktop.disk.read(u.path);
            if (now.text === u.text) await window.desktop.folders.trash([u.path]);
            else failed.push(u.path);
          } else {
            const w = await window.desktop.disk.write(u.path, u.before, { ...u.format, expectedMtime: u.mtimeMs });
            if (w.conflict) failed.push(u.path);
            else back.push(u.path);
          }
        } catch {
          failed.push(u.path ?? u.key);
        }
      }
      if (back.length) lsp?.filesChanged(back);
      toast(failed.length ? `Undone, except in ${failed.map(nameOf).join(', ')} (changed since).` : 'Undone.', { kind: failed.length ? 'error' : 'info', timeout: 8000 });
    };
    const files = undo.length;
    // A quick fix in the open file speaks for itself; anything wider (or that failed) is told.
    if (files > 1 || written.length || made.length || skipped.length || preview === 'always') {
      toast(
        `${title}: ${places} change${places === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}${written.length + made.length ? ` (${written.length + made.length} saved to disk)` : ''}.${skipped.length ? ` Not changed: ${skipped.map((x) => `${nameOf(x.path)} (${x.reason})`).join(', ')}.` : ''}`,
        { kind: skipped.length ? 'error' : 'info', timeout: 12000, ...(undo.length ? { action: { label: 'Undo', run: undoAll } } : {}) },
      );
    }
    return undo.length || !chosen.length ? { applied: true } : { applied: false, failureReason: skipped.map((x) => `${nameOf(x.path)}: ${x.reason}`).join('; ') };
  };

  /**
   * Format document with the tab's language server (the selection, or all): true when it did (or
   * found nothing to change); false when it has none that formats, or it failed.
   */
  actions.formatWithServer = async (key, part) => {
    const lsp = lspRef.current?.has(key) ? lspRef.current : null;
    if (!lsp?.capability(key, part ? 'documentRangeFormattingProvider' : 'documentFormattingProvider')) return false;
    const host = hostRef.current;
    const name = lsp.serverName(key);
    const state = host.stateOf(key);
    const before = state.doc.toString();
    const { tabs, size } = host.indentation(key);
    const options = { tabSize: size, insertSpaces: !tabs, ...(part ? {} : { trimTrailingWhitespace: true, insertFinalNewline: true, trimFinalNewlines: true }) };
    const at = (pos) => {
      const line = state.doc.lineAt(pos);
      return { line: line.number - 1, character: pos - line.from };
    };
    let edits;
    try {
      edits = part
        ? await lsp.requestFile(key, 'textDocument/rangeFormatting', { range: { start: at(part.from), end: at(part.to) }, options }, 'documentRangeFormattingProvider')
        : await lsp.requestFile(key, 'textDocument/formatting', { options }, 'documentFormattingProvider');
    } catch (err) {
      toast(`${name} could not format it: ${err?.message ?? err}`, { kind: 'error', timeout: 8000 });
      return false;
    }
    const changes = edits?.length ? textChanges(before, edits.map((e) => ({ ...e, newText: String(e.newText).replace(/\r\n?/g, '\n') }))) : [];
    if (changes === null) return false;
    if (host.stateOf(key)?.doc.toString() !== before) {
      toast('The text changed meanwhile; format it again.');
      return true;
    }
    if (changes.length) host.applyChanges(key, { changes, userEvent: 'input.format' });
    if (!changes.length || host.stateOf(key)?.doc.toString() === before) {
      toast(`Already formatted (${name})`);
      return true;
    }
    toast(`Formatted ${part ? 'the selection ' : ''}by ${name}`, { action: { label: 'Undo', run: () => hostRef.current?.run('undo') } });
    return true;
  };

  /**
   * Ctrl+. (or the 💡, or Quick fix… on a problem): the server's quick fixes and refactorings
   * for the selection or the cursor (or `at`: { key, from, to }), in a menu by the cursor.
   */
  actions.quickFix = async (at = null) => {
    const host = hostRef.current;
    const sel = host?.selectionInfo();
    const key = at?.key ?? sel?.key;
    const lsp = lspRef.current;
    if (!key || !lsp?.has(key)) return toast('Quick fixes come from a language server: open a code file from Folders (desktop app).', { timeout: 7000 });
    if (!lsp.capability(key, 'codeActionProvider')) return toast(`${lsp.serverName(key)} has no quick fixes.`);
    const from = at?.from ?? sel.from;
    const to = at?.to ?? sel.to;
    let result;
    try {
      result = await lsp.codeActions(key, from, to);
    } catch (err) {
      return toast(`No quick fixes: ${err?.message ?? err}`, { kind: 'error' });
    }
    const rows = codeActionRows(result);
    if (!rows.length) return toast('No quick fixes or refactorings here.');
    const r = host.coordsAt(key, from);
    setCodeMenu({ key, rows, at: r ? { x: r.left, y: r.bottom + 4 } : { x: innerWidth / 2 - 160, y: innerHeight / 3 } });
  };
  /** Carries out a code action (or a server command): its edit (resolved first if need be), then its command. */
  actions.runCodeAction = async (key, item) => {
    const lsp = lspRef.current;
    try {
      if (typeof item.command === 'string') return void (await lsp.executeCommand(key, item));
      const action = await lsp.resolveCodeAction(key, item);
      if (action.edit) {
        const done = await actions.applyWorkspaceEdit(action.edit, { title: action.title, userEvent: 'input.codeaction', placeOf: (uri) => lsp.placeOf(key, uri) });
        if (!done.applied) return;
      }
      if (action.command) await lsp.executeCommand(key, action.command);
    } catch (err) {
      toast(`${item.title}: ${err?.message ?? err}`, { kind: 'error', timeout: 8000 });
    }
  };
  /** Shift+Alt+O: the server sorts the file's imports and drops the unused ones. */
  actions.organizeImports = async () => {
    const key = store.session.active;
    const lsp = lspRef.current;
    if (!key || !lsp?.has(key)) return toast('Organize imports comes from a language server: open a code file from Folders (desktop app).', { timeout: 7000 });
    const state = hostRef.current.stateOf(key);
    let result = null;
    try {
      result = await lsp.codeActions(key, 0, state.doc.length, ['source.organizeImports']);
    } catch {
      // none
    }
    const row = codeActionRows(result).find((r) => r.kind.startsWith('source.organizeImports') && !r.disabled);
    if (!row) return toast(`${lsp.serverName(key)} has no imports to organize here.`);
    return actions.runCodeAction(key, row.item);
  };
  actions.setUpLanguageServer = (missing) => setDialog({ type: 'lspSetup', missing });
  actions.retryLanguageServer = () => lspRef.current?.retry(store.session.active);
  actions.showLanguageServers = () => setPanel((p) => (p === 'servers' ? null : 'servers'));
  actions.restartLanguageServer = async (id) => {
    await lspRef.current?.restart(id).catch((err) => toast(ipcMessage(err), { kind: 'error' }));
    setLspTick((n) => n + 1);
  };
  actions.stopLanguageServer = async (id) => {
    await lspRef.current?.stop(id).catch(() => {});
    setLspTick((n) => n + 1);
  };
  /** Opens a terminal (on this computer, or on the server `connId`) with `command` typed in, for the person to run. */
  actions.typeInTerminal = async (command, cwd = '', connId = 'local') => {
    if (!terminalsAvailable()) return toast('Terminals work in the desktop app.', { kind: 'error' });
    setTerminalShown(true);
    try {
      await runInTerminal(connId, { cwd, line: command, label: 'Set up', enter: false });
      setTimeout(() => focusTerminal(), 100);
      toast('The command is typed in the terminal: press Enter to run it. Then start the server from the status bar.', { timeout: 10000 });
    } catch (err) {
      toast(ipcMessage(err), { kind: 'error' });
    }
  };
  actions.copyText = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied.'), () => toast('Could not copy.', { kind: 'error' }));

  actions.toggleWrap = () => saveSettings({ wordWrap: !getSettings().wordWrap });
  /** The text size on this device: a step larger (1) or smaller (-1), or the usual size (0). */
  actions.textSize = (step, { quiet = false } = {}) => {
    const now = clampFont(getSettings().fontSize);
    const next = step === 0 ? DEFAULT_FONT : stepFont(now, step);
    if (next !== now) saveSettings({ fontSize: next });
    if (!quiet) toast(`Text size: ${next} px${next === DEFAULT_FONT ? ' (the usual size)' : ''}`, { key: 'text-size', timeout: 1600 });
  };
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
    if (!key?.startsWith('d:') || isRemotePath(key.slice(2)) || !window.desktop?.git || store.diskTab(key.slice(2))?.doc) return;
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
    const onFocus = () => {
      lookUpGit(store.session.active);
      setGitTick((n) => n + 1);
    };
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
  // ---- Git that writes: the Git panel, the branch picker, a change staged from the gutter ----
  // Commands that change files on disk wait while a tab in the repository has unsaved edits.
  const WORKING_TREE_OPS = new Set(['pull', 'switch', 'stash', 'stash-apply', 'stash-pop', 'abort']);
  const gitBridge = () => window.desktop?.git ?? null;
  const parentDir = (p) => p.replace(/[\\/][^\\/]*$/, '') || p;
  const insideRoot = (root, p) => {
    const n = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '');
    const low = /^[a-z]:/i.test(root) ? (x) => x.toLowerCase() : (x) => x;
    return low(n(p)).startsWith(`${low(n(root))}/`);
  };
  /** The folder whose repository Git shows: the open file's (on this computer), else the one in Folders. */
  const gitFolderNow = () => {
    const key = store.session.active;
    if (key?.startsWith('d:') && !isRemotePath(key.slice(2))) return parentDir(key.slice(2));
    const f = getSettings().folder;
    return f && !isRemotePath(f) ? f : null;
  };
  /** The Git panel (Ctrl+Shift+G): for `dir`'s repository, or the open file's / the folder's. */
  actions.toggleGit = (dir = null) => {
    if (!gitBridge()) return toast('Git works in the desktop app, for folders on this computer.');
    const at = dir ?? gitFolderNow();
    if (!at) return toast('Open a file or a folder from this computer first: the Git panel shows its repository.');
    setGitDir(at);
    setPanel((p) => (p === 'git' && !dir ? null : 'git'));
  };
  /**
   * Runs a Git command (git.cjs `act`) for the repository `dir` is in: { ok, result } or
   * { ok: false, error } (gitError: Git's message in words, and its own last lines).
   */
  actions.gitRun = async (dir, action) => {
    const bridge = gitBridge();
    if (!bridge) return { ok: false, error: { kind: 'other', message: 'Git works in the desktop app.', detail: '' } };
    hostRef.current?.flushAll();
    if (WORKING_TREE_OPS.has(action.op)) {
      const status = await bridge.status(dir).catch(() => null);
      const unsaved = status ? store.session.open.filter((k) => k.startsWith('d:') && !isRemotePath(k.slice(2)) && store.diskTab(k.slice(2))?.dirty && insideRoot(status.root, k.slice(2))).map((k) => store.diskTab(k.slice(2)).name) : [];
      if (unsaved.length) {
        const what = action.op === 'switch' ? 'Switching branches' : action.op.startsWith('stash') ? 'The stash' : action.op === 'pull' ? 'Pulling' : 'This';
        return { ok: false, error: { kind: 'unsaved', message: `Save ${unsaved.slice(0, 3).join(', ')}${unsaved.length > 3 ? ` and ${unsaved.length - 3} more` : ''} first: ${what} changes files on disk.`, detail: '' } };
      }
    }
    const r = await bridge.act(dir, action).catch((err) => ({ ok: false, message: ipcMessage(err), stdout: '', stderr: '' }));
    actions.gitChanged();
    return r.ok ? { ok: true, result: r.result } : { ok: false, error: gitError(r.stderr, r.stdout || r.message) };
  };
  /** Git's state may have changed (a command here, a commit elsewhere): Folders, the status bar, the bar of changed lines and the panel read it again. */
  actions.gitChanged = () => {
    refreshAllGit();
    lookUpGit(store.session.active);
    setGitTick((n) => n + 1);
  };
  /** The branch picker (the status bar's branch). */
  actions.chooseBranch = (dir = null) => {
    const at = dir ?? gitFolderNow();
    if (at && gitBridge()) setDialog({ type: 'branches', dir: at });
  };
  /** Fetch, pull or push from a command, without the panel: a toast says how it went. */
  actions.gitQuick = async (op) => {
    const dir = gitFolderNow();
    if (!dir || !gitBridge()) return toast('Open a file or a folder from this computer in a Git repository first.');
    const doing = { fetch: 'Fetching', pull: 'Pulling', push: 'Pushing' }[op];
    toast(`${doing}…`, { key: 'git-quick', timeout: 60000 });
    const r = await actions.gitRun(dir, { op });
    if (r.ok) return toast({ fetch: 'Fetched', pull: 'Pulled', push: 'Pushed' }[op], { key: 'git-quick' });
    toast(r.error.message, { key: 'git-quick', kind: 'error', timeout: 12000, action: { label: 'Git panel', run: () => actions.toggleGit(dir) } });
  };
  /**
   * Stages the change of tab `key` at `line` (its mark in the bar of changed lines): that block
   * alone, as it is in the editor, goes into what the next commit takes.
   */
  actions.stageChangeAt = async (key, line) => {
    const bridge = gitBridge();
    if (!bridge || !key?.startsWith('d:') || isRemotePath(key.slice(2))) return;
    const path = key.slice(2);
    const text = hostRef.current?.stateOf(key)?.doc.toString();
    if (text == null) return;
    const index = await bridge.index(path).catch(() => null);
    if (!index) {
      // Not in Git yet: the whole file.
      const status = await bridge.status(parentDir(path)).catch(() => null);
      if (!status || !insideRoot(status.root, path)) return toast('This file is not in a Git repository.');
      const rel = path.slice(status.root.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/');
      const r = await actions.gitRun(parentDir(path), { op: 'stage', paths: [rel] });
      return toast(r.ok ? `Staged ${store.diskTab(path)?.name ?? rel}, a new file` : r.error.message, { kind: r.ok ? 'info' : 'error' });
    }
    const next = stageBlock(index.text, text, line);
    if (next === null) return toast('That change is staged already.');
    try {
      await bridge.stageText(path, next);
    } catch (err) {
      return toast(`Not staged: ${ipcMessage(err)}`, { kind: 'error' });
    }
    actions.gitChanged();
    toast(`Staged the change at line ${line}${store.diskTab(path)?.dirty ? ', as it is here (the file is not saved yet)' : ''}`, { action: { label: 'Git panel', run: () => actions.toggleGit(parentDir(path)) } });
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

  // The model panel (the bubble, or Ctrl+K): about the selection, or the whole file. `assistStart`
  // opens it already asking (a problem, an error from the terminal: errorHelp.js).
  const [assist, setAssist] = useState(false);
  const [assistStart, setAssistStart] = useState(null);
  actions.askSelection = () => {
    if (assist) return setAssist(false);
    // With no file open, it answers questions about the editor.
    if (!activeKey) return actions.openAssist({ mode: 'help' });
    if (view !== 'editor') return toast('Open a file first.');
    setAssistStart(null);
    setAssist(true);
  };
  /** Copy, Cut and Paste from the edit bar and the line-number menu: the selection, or the cursor's line. */
  actions.editClip = async (kind) => {
    const host = hostRef.current;
    if (!host?.active) return;
    if (kind === 'paste') {
      if (!host.canEdit()) return;
      // The desktop app pastes for real into the text (files copied elsewhere open, as with Ctrl+V).
      if (window.desktop?.folders?.paste && document.activeElement?.closest?.('.cm-content')) return void window.desktop.folders.paste();
      let text;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        return toast('The browser did not let the editor read the clipboard. Long-press in the text and choose Paste.', { kind: 'error', key: 'clip', timeout: 6000 });
      }
      if (!host.paste(text)) toast('There is no text on the clipboard.', { key: 'clip', timeout: 2500 });
      return;
    }
    const clip = host.clipText();
    if (!clip?.text) return;
    try {
      await navigator.clipboard.writeText(clip.text);
    } catch {
      return toast('The browser did not let the editor use the clipboard.', { kind: 'error', key: 'clip', timeout: 5000 });
    }
    if (kind === 'cut') host.cut();
    const lines = clip.text.split('\n').length - (clip.text.endsWith('\n') ? 1 : 0);
    toast(`${kind === 'cut' ? 'Cut' : 'Copied'}${lines > 1 ? ` ${lines} lines` : ''}`, { key: 'clip', timeout: 1500 });
  };
  /** The edit bar's Hide keyboard: the text lets go of the focus (the status bar comes back). */
  actions.hideKeyboard = () => document.activeElement?.blur?.();
  actions.openAssist = (start) => {
    setView('editor');
    setAssistStart({ ...start, id: Date.now() });
    setAssist(true);
  };
  /** A tab's whole text as the model panel's context (the file it is about). */
  const wholeFile = (key) => {
    hostRef.current?.flushAll();
    const k = parseKey(key);
    const file = k?.kind === 'file' ? store.get(k.id) : null;
    const tab = k?.kind === 'disk' ? store.diskTab(k.path) : k?.kind === 'repo' ? store.repoTab(k.path) : null;
    const text = file ? store.text(file.id) : (tab?.text ?? '');
    const name = file?.name ?? tab?.name ?? '';
    return { key, from: 0, to: text.length, text, whole: true, name, language: findLanguage(name, file?.language)?.name ?? '' };
  };
  /** The problems the editor found in a tab, fixed by the model (a version to compare and accept). */
  actions.fixProblems = (key = activeKey) => {
    const list = problems[key]?.list ?? [];
    if (!list.length) return toast('No problems found in this file.');
    actions.openAssist({ action: fixProblemsAction(list), context: wholeFile(key) });
  };
  actions.explainProblem = (problem, key = activeKey) => actions.openAssist({ action: explainProblemAction(problem), context: wholeFile(key) });
  /**
   * The terminal's error (its selection, or the last output) explained by the model, with the
   * code around the places it names (files open here, or readable on disk).
   */
  actions.explainTerminalError = async () => {
    const s = activeTerminal();
    const output = terminalText(s);
    if (!output) return toast('Nothing in the terminal to ask about yet.');
    const base = s.connId === 'local' ? s.cwd : toRemoteUri(s.connId, s.cwd || '/');
    const seen = new Set();
    const snippets = [];
    let fixTarget = '';
    for (const ref of output.split('\n').flatMap((line) => findFileRefs(line))) {
      if (snippets.length >= 3) break;
      const target = isRemotePath(base) ? (ref.path.startsWith('/') ? toRemoteUri(remoteParts(base).id, ref.path) : resolveRef(ref.path, base)) : resolveRef(ref.path, base);
      if (!target || seen.has(target) || /node_modules|[\\/]internal[\\/]|^node:/.test(target)) continue;
      seen.add(target);
      hostRef.current?.flushAll();
      const text = store.diskTab(target)?.text ?? (await window.desktop?.disk?.read(target).then((r) => r.text, () => null));
      if (text == null) continue;
      snippets.push({ path: ref.path, line: ref.line, code: codeAround(text, ref.line) });
      fixTarget ||= target;
    }
    actions.openAssist({ action: EXPLAIN_ERROR, context: { label: 'The terminal’s output', name: 'terminal output', text: errorContextText(output, snippets), whole: false, errorText: output, fixTarget } });
  };
  /** Opens the file an error points to and proposes a fixed version (compare, accept). */
  actions.fixForError = async (path, errorText) => {
    if (await actions.openDiskPath(path)) return;
    setTimeout(() => actions.openAssist({ action: fixForErrorAction(errorText), context: wholeFile(diskKey(path)) }), 120);
  };
  /**
   * The question in the Claude app (with the person's Claude subscription): copied, and opened in
   * a new chat with it filled in when it fits in a link. Encrypted files are never sent. `prompt`
   * is a question ready as it is (one about the editor, with the guide's passages).
   */
  actions.openInClaude = async ({ action, context, prompt: ready = '' }) => {
    const k = parseKey(context?.key ?? '');
    const file = k?.kind === 'file' ? store.get(k.id) : null;
    if (file?.encrypted) return toast('Encrypted files are not sent anywhere: copy the part you want to ask about instead.');
    const prompt = ready || claudeAppPrompt({ action, context, editorFile: file?.name ?? '' });
    await navigator.clipboard.writeText(prompt).catch(() => {});
    window.open(claudeAppUrl(prompt), '_blank', 'noopener');
    toast('Opening Claude. The question is on the clipboard too: paste it if it is not there.', { timeout: 8000 });
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
    const editable = k && view === 'editor' && !(k.kind === 'file' && store.isSealed(k.id)) && !diskReadOnly(disk);
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

  // Terminals (desktop): on this computer ('local') and on servers, in the panel under the
  // editor. Hiding it keeps the shells running.
  const [terminalShown, setTerminalShown] = useState(false);
  actions.openTerminal = async (connId, cwd = '') => {
    if (!terminalsAvailable()) return toast('Terminals work in the desktop app.', { kind: 'error' });
    const conn = server(connId);
    if (conn && conn.protocol !== 'sftp') return toast(`${conn.name} is an FTP server; terminals need SSH (SFTP).`, { kind: 'error' });
    setTerminalShown(true);
    try {
      return await openTerminal(connId, { cwd });
    } catch (err) {
      toast(ipcMessage(err), { kind: 'error', timeout: 8000 });
      return null;
    }
  };
  /** Where a terminal on this computer starts: the open file's folder, else the one shown in Folders. */
  actions.localTerminalDir = () => {
    const k = parseKey(store.session.active);
    if (k?.kind === 'disk' && !isRemotePath(k.path) && !isContentPath(k.path)) return parentDir(k.path);
    const folder = getSettings().sidebarMode === 'folders' ? getSettings().folder : '';
    return folder && !isRemotePath(folder) ? folder : '';
  };
  /** Ctrl+`: shows or hides the terminal; the first time, one where you are (a server's, or this computer's). */
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
      const near = k?.kind === 'disk' ? (isRemotePath(k.path) ? parentDir(k.path) : '') : isRemotePath(folder) ? folder : '';
      if (near && server(remoteParts(near).id)?.protocol === 'sftp') return actions.openTerminal(remoteParts(near).id, remoteParts(near).path);
      return actions.openTerminal('local', actions.localTerminalDir());
    }
    setTerminalShown(true);
    requestAnimationFrame(() => focusTerminal(activeTerminal()));
  };
  /**
   * The status bar's Terminal: one in the open file's folder (on its server for a file there),
   * the one open there already when there is one; for other files, where Ctrl+` opens one.
   */
  actions.terminalForFile = () => {
    if (!terminalsAvailable()) return;
    const k = parseKey(store.session.active);
    const dir = k?.kind === 'disk' && !isContentPath(k.path) ? parentDir(k.path) : actions.localTerminalDir();
    const connId = isRemotePath(dir) ? remoteParts(dir).id : 'local';
    const cwd = isRemotePath(dir) ? remoteParts(dir).path : dir;
    const there = terminals().find((s) => !s.exited && !s.runner && s.connId === connId && s.cwd === cwd);
    if (!there) return actions.openTerminal(connId, cwd);
    setActiveTerminal(there);
    setTerminalShown(true);
    requestAnimationFrame(() => focusTerminal(there));
  };
  /**
   * Two terminals side by side, or one again: the one in use and the next; with only one,
   * a second one in the same place on the right.
   */
  actions.splitTerminal = async () => {
    if (!terminalsAvailable()) return;
    if (splitTerminals()) return (unsplitTerminals(), setTerminalShown(true));
    const list = terminals();
    if (!list.length) return actions.toggleTerminal();
    if (matchMedia('(max-width: 640px)').matches) return toast('Two terminals side by side need a wider window.');
    setTerminalShown(true);
    const s = activeTerminal();
    if (list.length > 1) return showTerminalOn(s, 'left');
    const other = await actions.openTerminal(s.connId, s.cwd);
    if (other) showTerminalOn(other, 'right');
  };
  /** Rename the terminal in use (its tab shows a field). */
  actions.renameTerminal = () => {
    if (!terminalsAvailable()) return;
    if (!terminals().length) return toast('No terminal is open: Ctrl+` opens one.');
    setTerminalShown(true);
    requestAnimationFrame(() => window.dispatchEvent(new Event('terminal:rename')));
  };
  /** A folder: a terminal there in the editor (on a server, or this computer). */
  actions.terminalHere = (dir) => (isRemotePath(dir) ? actions.openTerminal(remoteParts(dir).id, remoteParts(dir).path) : actions.openTerminal('local', dir));
  /** A folder on this computer in the system's own terminal app. */
  actions.systemTerminalHere = (dir) => window.desktop?.folders?.terminal(dir).catch((err) => toast(ipcMessage(err), { kind: 'error' }));

  /**
   * "file:line" clicked in a terminal or Ctrl+clicked in the text: opens the file there.
   * `base` is the folder relative paths start from (a remote:// one on servers).
   */
  actions.openRef = async (ref, base = '') => {
    let target = null;
    if (isRemotePath(base)) {
      const { id, path } = remoteParts(base);
      target = ref.path.startsWith('/') ? toRemoteUri(id, ref.path) : resolveRef(ref.path, toRemoteUri(id, path));
    } else target = resolveRef(ref.path, base);
    if (!target) return toast(`Where is ${ref.path}? Open it from Folders, or give the full path.`);
    await actions.openDiskPath(target, { line: ref.line, column: ref.column });
  };
  useEffect(() => {
    setToggleHandler(() => actions.toggleTerminal());
    setRefHandler((ref, s) => actions.openRef(ref, s.connId === 'local' ? s.cwd : toRemoteUri(s.connId, s.cwd || '/')));
  }, []);

  /**
   * F5: runs the open file in a terminal, in its folder (on this computer, or on its server
   * over SSH), saved first. The command comes from its type (runFile.js), or Settings.
   */
  actions.runFile = async () => {
    if (!terminalsAvailable()) return toast('Running files works in the desktop app.', { kind: 'error' });
    const k = parseKey(store.session.active);
    if (k?.kind !== 'disk') return toast('Run works on files in a folder, on this computer or on a server: open one from Folders (or save this one there).');
    const remote = isRemotePath(k.path);
    const conn = remote ? server(remoteParts(k.path).id) : null;
    if (remote && conn?.protocol !== 'sftp') return toast(`${conn?.name ?? 'That server'} has no terminal: running files needs SSH (SFTP).`, { kind: 'error' });
    const path = remote ? remoteParts(k.path).path : k.path;
    const file = { path, dir: parentDir(path), name: path.split(/[\\/]/).pop() };
    if (!remote && /\.html?$/i.test(file.name)) return window.desktop.folders.openExternal(k.path).catch((err) => toast(ipcMessage(err), { kind: 'error' }));
    const platform = remote ? 'linux' : (window.desktop.platform ?? 'linux');
    const kind = platform === 'win32' ? 'powershell' : 'posix';
    const command = runCommandFor(file, { platform, shell: kind === 'powershell' ? 'pwsh' : '', custom: parseRunCommands(getSettings().runCommands) });
    if (!command) return toast(`No run command for ${file.name}. Add one for its type in Settings → Editor → Run commands.`);
    hostRef.current?.flushAll(); // what was typed a moment ago counts
    if (store.diskTab(k.path)?.dirty && (await actions.saveDisk(k.path)) !== 'saved') return;
    setTerminalShown(true);
    try {
      await runInTerminal(remote ? conn.id : 'local', { cwd: file.dir, line: runLine({ command, dir: file.dir, kind }) });
    } catch (err) {
      toast(ipcMessage(err), { kind: 'error', timeout: 8000 });
    }
  };
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
    if (sideParsed.kind === 'disk') host.setReadOnly(sideKey, diskReadOnly(sideRepo));
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
    // The Android app: shared while it runs.
    const offShared = window.desktop?.shared?.onShared?.(takeInbox);
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
      offShared?.();
    };
  }, []);

  // The text size from the pointer: Ctrl+wheel over the text (a touchpad's pinch comes as one
  // too), and two fingers pinching on a touch screen (the page itself does not zoom there).
  useEffect(() => {
    const area = areaEl.current;
    if (!area) return;
    let turned = 0;
    const onWheel = (e) => {
      if (!e.ctrlKey || !e.target.closest?.('.cm-editor, .doc-html')) return;
      e.preventDefault();
      turned += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(turned) < 50) return;
      actions.textSize(turned < 0 ? 1 : -1);
      turned = 0;
    };
    let pinch = null;
    const apart = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e) => {
      if (e.touches.length === 2 && e.target.closest?.('.cm-editor, .doc-html')) pinch = { apart: apart(e.touches), from: clampFont(getSettings().fontSize), size: null };
      else if (e.touches.length > 2) pinch = null;
    };
    const onMove = (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const size = pinchFont(pinch.from, pinch.apart, apart(e.touches));
      if (size === (pinch.size ?? pinch.from)) return;
      pinch.size = size;
      // Shown at once; kept when the fingers lift.
      document.documentElement.style.setProperty('--editor-font-size', `${size}px`);
    };
    const onEnd = (e) => {
      if (!pinch || e.touches.length >= 2) return;
      const { size, from } = pinch;
      pinch = null;
      if (size && size !== from) {
        saveSettings({ fontSize: size });
        toast(`Text size: ${size} px`, { key: 'text-size', timeout: 1600 });
      }
    };
    area.addEventListener('wheel', onWheel, { passive: false });
    area.addEventListener('touchstart', onStart, { passive: true });
    area.addEventListener('touchmove', onMove, { passive: false });
    area.addEventListener('touchend', onEnd);
    area.addEventListener('touchcancel', onEnd);
    return () => {
      area.removeEventListener('wheel', onWheel);
      area.removeEventListener('touchstart', onStart);
      area.removeEventListener('touchmove', onMove);
      area.removeEventListener('touchend', onEnd);
      area.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  // Touch screens: while the text has the focus, the edit bar takes the status bar's place
  // (setting `editBar`). Closing the keyboard (the phone's Back) leaves the focus in the text, so
  // the visible page growing back says it went down: the status bar returns until it is up again.
  useEffect(() => {
    if (settings.editBar === false) return void setEditing(false);
    const touch = matchMedia('(pointer: coarse)');
    const vv = window.visualViewport;
    const size = () => (vv ? { width: vv.width * vv.scale, height: vv.height * vv.scale } : { width: innerWidth, height: innerHeight });
    let keyboard = keyboardState(null, size());
    let down = false; // the keyboard went down while the text kept the focus
    const typing = () => Boolean(document.activeElement?.closest?.('.editor-area .cm-content'));
    const update = () => setEditing(touch.matches && typing() && !down);
    const onFocus = () => {
      down = false;
      setTimeout(update, 0);
    };
    const onResize = () => {
      const was = keyboard.open;
      keyboard = keyboardState(keyboard, size());
      if (was && !keyboard.open) down = true;
      if (keyboard.open) down = false;
      update();
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onFocus);
    vv?.addEventListener('resize', onResize);
    touch.addEventListener('change', update);
    update();
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onFocus);
      vv?.removeEventListener('resize', onResize);
      touch.removeEventListener('change', update);
    };
  }, [settings.editBar]);
  // The line-number menu belongs to the tab it was opened in.
  useEffect(() => setLineMenu(null), [store.session.active, view]);

  // Desktop: a paste outside any text (no tab open, the tab bar…) opens files copied in another
  // app, or a path; the editor and the folders view take their own pastes first.
  useEffect(() => {
    if (!window.desktop?.disk?.openPasted) return;
    const onPaste = (e) => {
      if (e.defaultPrevented || e.target?.closest?.('input, textarea, select, [contenteditable], .cm-editor, .terminal-panel')) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length && actions.openPastedFiles(files)) return e.preventDefault();
      const path = pastedPath(e.clipboardData?.getData('text/plain'));
      if (!path) return;
      e.preventDefault();
      actions.openTypedPath(path);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  // Keyboard shortcuts that work in the browser too (the desktop menu adds Ctrl+N, Ctrl+W, …).
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (e.key === 'F1' && !mod && !e.altKey) {
        e.preventDefault();
        actions.command('help');
      } else if (textSizeKey(e) !== null) {
        // Ctrl+= / Ctrl+- / Ctrl+0: the editor's text, not the whole page.
        e.preventDefault();
        actions.textSize(textSizeKey(e));
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
      } else if (mod && e.shiftKey && !e.altKey && k === 'g') {
        e.preventDefault();
        actions.toggleGit();
      } else if (mod && !e.shiftKey && !e.altKey && k === 'k') {
        e.preventDefault();
        actions.askSelection();
      } else if (e.altKey && !mod && !e.shiftKey && k === 'l') {
        e.preventDefault();
        actions.toggleFilter();
      } else if (e.altKey && !mod && !e.shiftKey && (k === 'v' || e.code === 'KeyV')) {
        e.preventDefault();
        actions.tabViews();
      } else if (mod && e.altKey && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault();
        actions.stepTabView(e.key === 'PageDown' ? 1 : -1);
      } else if (mod && e.altKey && e.key === 'Home') {
        e.preventDefault();
        actions.setTabView(null);
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
      } else if (e.key === 'F5' && !mod && !e.altKey && !e.shiftKey && isDesktopApp()) {
        e.preventDefault();
        actions.runFile();
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
      'tab-view': () => actions.tabViews(),
      'tab-group-next': () => actions.stepTabView(1),
      'tab-group-prev': () => actions.stepTabView(-1),
      'tab-view-all': () => actions.setTabView(null),
      'tab-view-only': () => actions.onlyActiveGroup(),
      'tab-move-group': () => actions.moveActiveToGroup(),
      trash: () => setDialog({ type: 'trash' }),
      split: () => actions.toggleSplit(),
      'type-out': () => actions.typeOut(),
      'disk-open': () => actions.openDiskFiles(),
      'folder-open': () => actions.openFolder(),
      'folder-beside': () => actions.sideBySide(),
      'server-add': () => actions.editServer(),
      'servers-ssh': () => actions.importSshConfig(),
      terminal: () => actions.toggleTerminal(),
      'terminal-split': () => actions.splitTerminal(),
      'terminal-rename': () => actions.renameTerminal(),
      'run-file': () => actions.runFile(),
      'explain-error': () => actions.explainTerminalError(),
      'fix-problems': () => actions.fixProblems(),
      'open-in-claude': () => {
        const context = actions.assistContext();
        if (context) actions.openInClaude({ action: { prompt: 'Help me with this.' }, context });
      },
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
      'quick-fix': () => actions.quickFix(),
      'organize-imports': () => actions.organizeImports(),
      'language-servers': () => actions.showLanguageServers(),
      'goto-symbol': () => actions.gotoSymbol(),
      'goto-symbol-all': () => actions.gotoSymbolAll(),
      'command-palette': () => actions.commandPalette(),
      'git-compare': () => actions.compareWithHead(),
      'git-panel': () => actions.toggleGit(),
      'git-branch': () => actions.chooseBranch(),
      'git-fetch': () => actions.gitQuick('fetch'),
      'git-pull': () => actions.gitQuick('pull'),
      'git-push': () => actions.gitQuick('push'),
      'git-stage-change': () => actions.stageChangeAt(store.session.active, cursor?.line ?? 1),
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
      'text-larger': () => actions.textSize(1),
      'text-smaller': () => actions.textSize(-1),
      'text-reset': () => actions.textSize(0),
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
      'help-ask': () => actions.openAssist({ mode: 'help' }),
      'compare-with': () => actions.compareWith(),
      'compare-clipboard': () => actions.compareWithClipboard(),
      'compare-folders': () => (getSettings().folder ? actions.compareFolders(getSettings().folder) : toast('Open a folder in Folders first (Ctrl+Shift+E), then compare it with another one.')),
      'two-panes': () => (getSettings().folder ? actions.twoPanes(getSettings().folder) : toast('Open a folder in Folders first (Ctrl+Shift+E), then open it in two panes with another one.')),
      'compare-saved': () => actions.showSavedCompares(),
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
        for (const path of paths.filter((p) => opensHere(p))) actions.openDiskPath(path, { report: paths.length === 1 });
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

  // Android's Back: what is open on top closes first; with nothing open, the app goes to the
  // background (as Home). Escape closes most things (menus, dialogs, the find bar); the rest here.
  const backState = useRef({});
  backState.current = { view, dialog, panel, assist, compare, previewFull, sidebar, terminalShown, lineMenu };
  useEffect(
    () =>
      window.desktop?.android?.onBack(() => {
        const focus = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
        const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        focus.dispatchEvent(esc);
        if (esc.defaultPrevented) return true;
        const s = backState.current;
        if (s.lineMenu) setLineMenu(null);
        else if (s.dialog) setDialog(null);
        else if (s.assist) setAssist(false);
        else if (s.compare) setCompare(null);
        else if (s.panel) setPanel(null);
        else if (s.view !== 'editor') setView('editor');
        else if (s.previewFull) setPreviewFull(false);
        else if (s.terminalShown) setTerminalShown(false);
        else if (s.sidebar && isNarrow()) setSidebar(false);
        else return false;
        return true;
      }),
    [],
  );

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
      ${settings.llm.enabled && html`<button type="button" class="icon-btn" aria-label="Assistant" title="The model (Ctrl+Shift+A)" aria-pressed=${panel === 'assistant'} onClick=${() => actions.togglePanel('assistant')}><${Icon} name="sparkle" /></button>`}
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
        ${activeKey && !activeCompare && html`<${FileBar} file=${activeFile} repo=${activeRepo} disk=${activeDisk} sealed=${activeSealed} projects=${projects} language=${languageName} sync=${sync}
          canPreview=${Boolean(previewType)} preview=${showPreview} settings=${settings} actions=${actions} />`}
        ${activeKey && filterKeys.has(activeKey) && !compare && !activeSealed &&
        html`<${FilterBar} key=${activeKey} tabKey=${activeKey} actions=${actions} onClose=${actions.toggleFilter} />`}
        ${dictating && dictating === activeKey && html`<${DictationBar} lang=${settings.dictationLang} onPhrase=${actions.dictate} onStop=${actions.stopDictation} />`}
        ${typingJob && html`<${TypeOutPanel} job=${typingJob} onStop=${() => window.desktop?.typing?.stop()} />`}
        <div class="editor-area ${showPreview ? 'split' : ''} ${showPreview && previewFull ? 'preview-full' : ''} ${showSide ? 'side-split' : ''} ${compare ? 'comparing' : ''} ${settings.whereFrame && activeKey ? 'framed' : ''}"
          data-kind=${kindOfKey(activeKey) ?? undefined} ref=${areaEl} style=${{ '--split': `${((settings.splitRatio || 0.5) * 100).toFixed(2)}%` }}>
          <div class="editor-host" ref=${editorEl} />
          ${assist && ((activeKey && !activeCompare) || assistStart) && view === 'editor' && !compare && !activeSealed && html`<${AssistPanel} key=${`${activeKey}:${assistStart?.id ?? 0}`} scope=${assistScope} start=${assistStart} hasFile=${Boolean(activeKey)} actions=${actions} onClose=${() => (setAssist(false), setAssistStart(null), hostRef.current?.focus())} />`}
          ${!assist && modelReady && settings.assistBubble && activeKey && !activeCompare && !compare && !activeSealed && !docShown && !typingJob && html`<${AssistBubble} onOpen=${() => setAssist(true)} />`}
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
            readKey=${`preview:${activeKey}`} textHidden=${previewFull || isNarrow()} onReader=${(r) => (previewReader = r)}
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
          ${activeCompare && view === 'editor' && html`<${CompareTab} key=${activeKey} id=${active.id} record=${activeCompare} settings=${settings} actions=${actions} />`}
          ${docShown &&
          activeRepo?.doc &&
          html`<${DocumentView} key=${activeKey} name=${activeRepo.name} kind=${activeRepo.doc} load=${() => repoBytes(activeRepo.path)}
            bookmarkKey=${activeKey} readKey=${activeKey} onReader=${(r) => (docReader = r)} />`}
          ${docShown &&
          activeDisk?.doc &&
          html`<${DocumentView} key=${`${activeKey}:${activeDisk.mtimeMs}:${activeDisk.reloads ?? 0}`} name=${activeDisk.name} kind=${activeDisk.doc} version=${activeDisk.mtimeMs}
            load=${() => window.desktop.disk.readBytes(activeDisk.path)} onText=${(text) => actions.documentText(activeDisk.path, text)}
            onOpenOutside=${() => actions.openOutside(activeDisk.path)} bookmarkKey=${activeDisk.path} readKey=${activeKey} onReader=${(r) => (docReader = r)} />`}
          ${!activeKey && html`<${Welcome} actions=${actions} desktop=${diskAvailable()} hasFiles=${store.live().length + docs.length > 0} configured=${isLocal(settings) || isSyncConfigured(settings)} />`}
        </div>
        ${terminalShown && html`<${TerminalPanel} settings=${settings} actions=${actions} onHide=${() => (setTerminalShown(false), hostRef.current?.focus())} />`}
        <${ReadAloudBar} />
        ${editing && activeKey && !activeSealed && !compare && !activeCompare && hostRef.current
          ? html`<${EditBar} host=${hostRef.current} actions=${actions} save=${activeDisk ? 'Save' : isLocal(settings) ? null : 'Sync'} />`
          : html`<${StatusBar} recording=${recording} big=${big && Boolean(activeKey) && !docShown} cursor=${activeKey && !docShown && !activeCompare ? cursor : null} language=${languageName} file=${activeFile} repo=${activeRepo} disk=${activeDisk} settings=${settings} sync=${sync} actions=${actions} group=${activeGroup}
          problems=${settings.problems !== false && activeKey ? problems[activeKey] : null} problemsOpen=${panel === 'problems'}
          lsp=${activeKey && settings.languageServers !== false ? lspRef.current?.statusOf(activeKey) : null} lspOpen=${panel === 'servers'}
          git=${activeKey && gitHeads[activeKey] ? { ...gitHeads[activeKey], changes: hostRef.current?.gitChanges(activeKey)?.changes ?? null } : null} />`}
      </div>
    </main>
    ${lineMenu && hostRef.current && html`<${LineMenu} key=${`${lineMenu.key}:${lineMenu.top}:${lineMenu.x}`} at=${lineMenu} host=${hostRef.current} actions=${actions} onClose=${() => setLineMenu(null)} />`}

    ${panel === 'folderSearch' && folderSearchDir && window.desktop?.folders && html`<${FolderSearchPanel} key=${folderSearchDir} dir=${folderSearchDir} actions=${actions} onClose=${() => setPanel(null)} />`}
    ${panel === 'servers' && lspRef.current && html`<${LanguageServersPanel} lsp=${lspRef.current} tick=${lspTick} actions=${actions} onClose=${() => setPanel(null)} />`}
    ${panel === 'references' && refs && html`<${ReferencesPanel} refs=${refs} actions=${actions} onClose=${() => setPanel(null)} />`}
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
    html`<${QuickOpen} files=${store.live()} docs=${docs} openTabs=${openDiskTabs()} actions=${actions} initial=${dialog.query ?? ''} symbols=${() => (activeKey ? (hostRef.current?.codeContext()?.symbols ?? []) : [])}
      roots=${folderRoots(settings)} hidden=${Boolean(settings.showHidden)} onSymbol=${(entry) => actions.revealSymbol(entry)} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'compareFolder' && html`<${CompareFolderDialog} other=${dialog.other} side=${dialog.side} panes=${dialog.panes} onPick=${dialog.onPick} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'saveCompare' && html`<${SaveCompareDialog} id=${dialog.id} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'savedCompares' && html`<${SavedComparesDialog} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'compare' && activeKey &&
    html`<${ComparePicker} ...${compareSources()} roots=${folderRoots(settings)} hidden=${Boolean(settings.showHidden)} detailOf=${placeOfPath} plainIcons=${settings.fileIcons === false}
      onPick=${(entry) => actions.compareWithEntry(entry)} onBrowse=${() => actions.compareBrowse()} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'palette' && html`<${CommandPalette} initial=${dialog.query ?? ''} onRun=${(c) => setTimeout(() => actions.command(c.id), 0)} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'symbols' && html`<${SymbolSearch} files=${store.live()} roots=${folderRoots(settings)} servers=${settings.languageServers !== false ? lspRef.current : null} initial=${dialog.query ?? ''} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'workspaceEdit' && html`<${WorkspaceEditDialog} title=${dialog.title} entries=${dialog.entries} rel=${(p) => relInFolders(p, settings)} onDone=${dialog.onDone} />`}
    ${panel === 'git' && gitDir && html`<${GitPanel} key=${gitDir} dir=${gitDir} tick=${gitTick} actions=${actions} onClose=${() => setPanel(null)} />`}
    ${dialog?.type === 'branches' && html`<${BranchDialog} dir=${dialog.dir} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${gitMenu &&
    html`<${Menu} label="This change" at=${{ x: gitMenu.x, y: gitMenu.y }} onClose=${() => setGitMenu(null)}
      items=${[
        { key: 'stage', label: 'Stage this change', icon: 'plus', hint: 'Only this block goes into the next commit', run: () => actions.stageChangeAt(gitMenu.key, gitMenu.line) },
        { key: 'compare', label: 'Compare with the last commit', icon: 'compare', run: () => actions.compareWithHead() },
        { key: 'panel', label: 'The Git panel', icon: 'branch', hint: 'Ctrl+Shift+G', run: () => actions.toggleGit(parentDir(gitMenu.key.slice(2))) },
      ]} />`}
    ${codeMenu &&
    html`<${Menu} className="code-actions" label="Quick fixes and refactorings" at=${codeMenu.at} onClose=${() => (setCodeMenu(null), hostRef.current?.focus())}
      items=${codeMenu.rows.flatMap((r, i) => [
        ...(i === 0 || codeMenu.rows[i - 1].group !== r.group ? [{ heading: true, label: r.group, key: `h-${r.group}` }] : []),
        { key: `a${i}`, label: r.title, icon: r.preferred ? 'bulb' : undefined, disabled: Boolean(r.disabled), hint: r.disabled || undefined, run: () => actions.runCodeAction(codeMenu.key, r.item) },
      ])} />`}
    ${dialog?.type === 'folderGroup' && html`<${FolderGroupDialog} path=${dialog.path} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'sideBySide' && html`<${SideBySideDialog} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'lspSetup' && html`<${SetupServerDialog} missing=${dialog.missing} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'renameSymbol' && html`<${RenameSymbolDialog} word=${dialog.word} onClose=${() => (setDialog(null), hostRef.current?.focus())} onRename=${(name) => (setDialog(null), actions.renameWithServer(dialog, name), hostRef.current?.focus())} />`}
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
      <p class="muted">${isLocal() ? (isAndroidApp() ? 'Every tab is saved on this device as you type.' : 'Every tab is saved on this computer as you type, next to your tracker.') : 'Every tab is saved on this device as you type and synced to your GitHub data repo, so you can read it on your phone and other computers.'}</p>
      <div class="welcome-actions">
        <button type="button" class="btn primary" onClick=${() => actions.newFile()}><${Icon} name="plus" size=${16} />New file</button>
        ${hasFiles && html`<button type="button" class="btn" onClick=${() => actions.openDialog({ type: 'quickOpen' })}><${Icon} name="search" size=${16} />Open a file</button>`}
        <button type="button" class="btn" onClick=${() => actions.openFromDisk()}><${Icon} name="upload" size=${16} />Import files</button>
        ${desktop && html`<button type="button" class="btn" title="Edit a file where it is (a log, a config file); it is not synced" onClick=${() => actions.openDiskFiles()}><${Icon} name="disk" size=${16} />Open from disk</button>`}
        ${window.desktop?.folders && html`<button type="button" class="btn" title="Browse a folder and open its files where they are; they are not synced (Ctrl+Shift+E)" onClick=${() => actions.showFolders()}><${Icon} name="folderOpen" size=${16} />Open a folder</button>`}
      </div>
      ${!configured && html`<p class="notice"><${Icon} name="cloudOff" size=${16} /><span>Not syncing yet. <button type="button" class="btn link" onClick=${actions.showSettings}>Set up sync</button> with the same repo and token as the tracker (or paste its setup code).</span></p>`}
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
