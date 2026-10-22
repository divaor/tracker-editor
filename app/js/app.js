import { html, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from '../vendor/preact-htm.js';
import { createEditorHost, findLanguage, guessLanguage, PLAIN_TEXT } from './editor.js';
import { onLaunchFiles, takeShared } from './inbox.js';
import { cleanModelName, filingMessages, isUntitled, MIN_NAMING_TEXT, nameFromHeading, namingMessages, parseFiling, uniqueName } from './naming.js';
import { llmClient } from './semantic.js';
import { fileLink, parseRoute, safeName } from './model.js';
import { fileVersions, versionName } from './versions.js';
import { formatDateTime } from './format.js';
import { previewKind } from './previews.js';
import { getReaderState, onReaderState, setReaderHighlighter, startReading, stopReading, toggleReading } from './reader.js';
import { getSettings, getToken, isSyncConfigured, onSettings, resolvedTheme, saveSettings } from './settings.js';
import { diskKey, fileKey, flush, parseKey, repoKey, store } from './store.js';
import { diskAvailable, openDiskFiles, reloadDiskTab, saveDiskTab, unwatchDisk, watchDiskTabs } from './diskTabs.js';
import { getSyncState, onSyncResult, onSyncState, syncClient, syncNow } from './syncManager.js';
import { matchesScope, projectList } from './tracker-model.js';
import { AssistantPanel } from './ui/assistant.js';
import { Toasts, toast } from './ui/components.js';
import { ChecklistDialog, FileDialog, SendDialog } from './ui/dialogs.js';
import { Icon } from './ui/icons.js';
import { QuickOpen, SearchPanel } from './ui/panels.js';
import { Preview } from './ui/preview.js';
import { CompareView } from './ui/compare.js';
import { HistoryPanel } from './ui/history.js';
import { TrashDialog } from './ui/trash.js';
import { LockedFile } from './ui/encryption.js';
import { TypeOutPanel } from './ui/typeOut.js';
import { SnippetPicker } from './ui/snippets.js';
import { AskSelectionDialog } from './ui/askSelection.js';
import { OutlinePanel } from './ui/outline.js';
import { FilterBar } from './ui/filterBar.js';
import { MacroDialog } from './ui/macro.js';
import { CloseDiskDialog, ReloadDiskDialog } from './ui/diskDialogs.js';
import { snippetNameFrom } from './snippets.js';
import { linkName, resolveLink } from './outline.js';
import { prepareTyping, typingDelay } from './typing.js';
import { isSealed } from './crypto.js';
import { decodeFor, encodeFor, lock, onVault, openText, setUpVault, unlock, vaultState } from './vault.js';
import { ReadAloudBar } from './ui/readAloud.js';
import { ShareDialog } from './ui/share.js';
import { SettingsView } from './ui/settingsView.js';
import { Sidebar } from './ui/sidebar.js';
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
function useActions({ hostRef, setView, setPanel, setDialog, setSidebar, setCompare }) {
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
        if (isNarrow()) setSidebar(false);
        // Already in the side view: go there.
        if (fileKey(id) === store.session.side && !isNarrow() && !line && hostRef.current?.focusSide()) return setView('editor');
        store.open(fileKey(id));
        setView('editor');
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

      askSelection() {
        const host = hostRef.current;
        host?.flushAll();
        const sel = host?.selectionInfo();
        if (!sel) return toast('Open a file first.');
        const k = parseKey(sel.key);
        const file = k.kind === 'file' ? store.get(k.id) : null;
        const name = file?.name ?? store.repoTab(k.path)?.name ?? '';
        const language = findLanguage(name, file?.language)?.name ?? '';
        const whole = sel.from === sel.to;
        const text = whole ? sel.doc() : sel.text;
        if (!text.trim()) return toast('There is nothing to ask about yet.');
        setDialog({ type: 'ask', context: { key: sel.key, from: whole ? 0 : sel.from, to: whole ? sel.docLength : sel.to, text, whole, name, language } });
      },
      /** The model's new version of the text, as a comparison to accept or not. */
      proposeReplacement(context, text, label) {
        if (store.session.active !== context.key) store.open(context.key);
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
            { label: 'Copy', icon: 'copy', run: () => navigator.clipboard.writeText(text).then(() => toast('Copied')) },
          ],
        });
      },
      /** An answer from Ctrl+K kept as a Markdown note. */
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
          if (result === 'conflict') toast('The file changed on disk since you opened it, so it was not saved. Reload it, or keep yours and save over it.', { kind: 'error', timeout: 10000 });
          return result;
        } catch (err) {
          toast(err.message, { kind: 'error' });
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
          left: { label: 'On disk now', text: onDisk },
          right: { label: 'Your edits', text: tab.text },
          actions: [
            { label: 'Use the disk version', icon: 'rotate', run: () => (setCompare(null), actions.reloadDisk(path)) },
            { label: 'Keep mine and save', icon: 'save', primary: true, run: () => (setCompare(null), actions.saveDisk(path, { force: true })) },
          ],
        });
      },
      showOnDisk: (path) => window.desktop?.disk?.show(path),
      /** A copy of a disk file as one of the editor's files (synced). */
      copyToFiles(path) {
        const tab = store.diskTab(path);
        if (tab) actions.newFile({ name: tab.name, text: tab.text });
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
  const [dialog, setDialog] = useState(null);
  const [sidebar, setSidebar] = useState(() => !isNarrow());
  const [cursor, setCursor] = useState(null);
  // The open tab is in the lighter editor for very large files.
  const [big, setBig] = useState(false);
  const [preview, setPreview] = useState(() => new Set());
  const [compare, setCompare] = useState(null);
  const hostRef = useRef(null);
  const editorEl = useRef(null);
  const actions = useActions({ hostRef, setView, setPanel, setDialog, setSidebar, setCompare });
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
      onShortcut(name) {
        // Ctrl+S is handled by the window's key handler (saveOrSync), which sees it too.
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
  actions.togglePreview = () => {
    hostRef.current?.flushAll();
    // The preview takes the side view's place.
    if (!preview.has(activeKey)) store.setSide(null);
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

  // Macros (Ctrl+Shift+R records, Ctrl+Shift+P plays). The last one is kept on this device.
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
      toast(`Macro recorded (${steps.length} step${steps.length === 1 ? '' : 's'}). Ctrl+Shift+P plays it.`);
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
    const text = prepareTyping(given ?? (selected || snap.text), { autoIndent: options.autoIndent });
    if (!text) return toast('Nothing to type: the file is empty.');
    const delay = typingDelay(options.speed);
    const wait = options.countdown * 1000;
    setTypingJob({ total: text.length, at: Date.now() + wait, delay, typed: 0, what: what || (selected ? 'selection' : 'file') });
    try {
      const { typed, stopped } = await typer.start(text, { delay, wait, minimize: options.minimize, unicode: options.unicode });
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
    return () => window.removeEventListener('hashchange', onHash);
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
      } else if (e.altKey && !mod && k === 'r') {
        e.preventDefault();
        actions.readAloud();
      } else if (e.altKey && !mod && k === 'w') {
        e.preventDefault();
        if (store.session.active) actions.close(store.session.active);
      } else if (mod && e.shiftKey && k === 'r') {
        e.preventDefault();
        actions.toggleRecording();
      } else if (mod && e.shiftKey && k === 'p') {
        e.preventDefault();
        actions.playMacro();
      } else if (mod && e.shiftKey && k === 'o') {
        e.preventDefault();
        actions.toggleOutline();
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
        trash: () => setDialog({ type: 'trash' }),
        split: () => actions.toggleSplit(),
        'type-out': () => actions.typeOut(),
        'disk-open': () => actions.openDiskFiles(),
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
        <${TabBar} session=${store.session} projects=${projects} settings=${settings} actions=${actions} />
        ${activeKey && html`<${FileBar} file=${activeFile} repo=${activeRepo} disk=${activeDisk} sealed=${activeSealed} projects=${projects} language=${languageName}
          canPreview=${Boolean(previewType)} preview=${showPreview} settings=${settings} actions=${actions} />`}
        ${activeKey && filterKeys.has(activeKey) && !compare && !activeSealed &&
        html`<${FilterBar} key=${activeKey} tabKey=${activeKey} actions=${actions} onClose=${actions.toggleFilter} />`}
        ${typingJob && html`<${TypeOutPanel} job=${typingJob} onStop=${() => window.desktop?.typing?.stop()} />`}
        <div class="editor-area ${showPreview ? 'split' : ''} ${showSide ? 'side-split' : ''} ${compare ? 'comparing' : ''}">
          <div class="editor-host" ref=${editorEl} />
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
          ${showPreview && html`<${Preview} key=${activeKey} kind=${previewType} name=${activeName} text=${activeText()}
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
        <${ReadAloudBar} />
        <${StatusBar} recording=${recording} big=${big && Boolean(activeKey)} cursor=${activeKey ? cursor : null} language=${languageName} file=${activeFile} repo=${activeRepo} disk=${activeDisk} settings=${settings} sync=${sync} actions=${actions} />
      </div>
    </main>

    ${panel === 'search' && html`<${SearchPanel} files=${scoped} docs=${scopedDocs} allFiles=${store.live()} allDocs=${docs} openKeys=${store.session.open} settings=${settings} actions=${actions} onClose=${() => setPanel(null)} />`}
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
      : html`<${QuickOpen} files=${store.live()} docs=${docs} actions=${actions} onClose=${() => setDialog(null)} />`)}
    ${dialog?.type === 'macro' && html`<${MacroDialog} steps=${dialog.steps} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'trash' && html`<${TrashDialog} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'checklist' && store.get(dialog.id) && html`<${ChecklistDialog} file=${store.get(dialog.id)} text=${dialog.text} firstLine=${dialog.firstLine} projects=${projects} actions=${actions} onClose=${() => setDialog(null)} />`}
    ${dialog?.type === 'ask' && html`<${AskSelectionDialog} context=${dialog.context} actions=${actions} onClose=${() => setDialog(null)} />`}
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
