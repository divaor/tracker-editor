// The files the model works on (the page; fileSteps.js is its pure part): a base folder on this
// computer or on a server, or the project of a synced note. It makes the picture the model is
// given, runs its looks (list, read, search) and makes its changes through what the editor
// already has: actions.applyWorkspaceEdit for texts (open tabs, files on disk, new files),
// folders.newFolder / rename / move / trash, store.create / setText for synced notes. Every write
// to disk goes through the main process, which allows only the folders the person picked.
import { childPath } from './folderCompare.js';
import { isWithin, withCurrent } from './folders.js';
import { applyEdits, diffRows, isSecretName, LIST_ENTRIES, numbered, READ_CHARS, SEARCH_LINES, searchText, SKIP_DIRS, toLspEdits, treeText, workspaceText } from './fileSteps.js';
import { isAndroidApp } from './platform.js';
import { server } from './servers.js';
import { getSettings } from './settings.js';
import { diskKey, fileKey, parseKey, store } from './store.js';
import { isRemotePath, remoteParts } from './where.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);
const parentOf = (p) => {
  if (isRemotePath(p)) {
    const { id, path } = remoteParts(p);
    const inner = path.replace(/\/+$/, '');
    return `remote://${id}${inner.slice(0, inner.lastIndexOf('/')) || '/'}`;
  }
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dir = cut > 0 ? p.slice(0, cut) : p.slice(0, cut + 1);
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir;
};
const relDir = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const relName = (rel) => rel.slice(rel.lastIndexOf('/') + 1);
let searches = 0;

/**
 * What the model works on: `key` (a tab: a file on disk or on a server, or a synced note) or
 * `folder` (a folder from Folders). `host` gives the editor (states, applying changes),
 * `actions` the app's (applyWorkspaceEdit, saveDisk, followDiskMoves, closeDiskPaths,
 * typeInTerminal). Returns the work, or { unavailable } saying why not.
 */
export function createFilesWork({ key = null, folder = null, host, actions }) {
  const k = key ? parseKey(key) : null;
  if (k?.kind === 'file') return notesWork(k.id, { host, actions });
  if (k?.kind === 'repo') return { unavailable: 'Tracker documents are read-only here: ask about them in Answer mode.' };
  if (k && k.kind !== 'disk') return { unavailable: 'The model changes files in folders, and synced notes.' };
  const file = k?.kind === 'disk' ? k.path : null;
  if (!folder && !file) return { unavailable: 'Open a file, or pick a folder in Folders, first.' };
  const settings = getSettings();
  const shown = withCurrent(settings.folderSections ?? [], settings.folder ?? '');
  // The base folder: the folder in Folders that holds the file (the deepest), else its own folder.
  const base = folder ?? shown.filter((s) => s && isWithin(file, s)).sort((a, b) => b.length - a.length)[0] ?? parentOf(file);
  return folderWork(base, { file, host, actions });
}

// ---- A folder (here or on a server) ----

function folderWork(base, { file, host, actions }) {
  const remote = isRemotePath(base);
  const conn = remote ? server(remoteParts(base).id) : null;
  const name = baseName(remote ? remoteParts(base).path || conn?.name || base : base) || base;
  const where = remote ? `on the server ${conn?.name ?? remoteParts(base).id}: ${remoteParts(base).path || '/'}` : `on this computer: ${base}`;
  const forGood = remote || isAndroidApp();
  const full = (rel) => (rel ? childPath(base, rel) : base);
  const relOf = (path) => {
    const b = remote ? remoteParts(base).path.replace(/\/+$/, '') : base.replace(/[\\/]+$/, '');
    const p = remote ? remoteParts(path).path : path;
    return p.length > b.length ? p.slice(b.length + 1).replace(/\\/g, '/') : '';
  };
  const uriOf = (path) => `te-files:${encodeURIComponent(path)}`;
  const placeOf = (uri) => {
    const path = decodeURIComponent(String(uri).replace(/^te-files:/, ''));
    return { key: diskKey(path), path };
  };
  const listing = async (dir) => (await window.desktop.folders.list(dir)).entries ?? [];
  const exists = async (path) => {
    try {
      return (await listing(parentOf(path))).find((e) => e.name === baseName(path)) ?? null;
    } catch {
      return null;
    }
  };

  /** The text the editor has for a file: an open tab's (unsaved edits too), else the disk's. */
  const currentText = async (path) => {
    const tabKey = diskKey(path);
    const state = host()?.stateOf(tabKey);
    const tab = store.diskTab(path);
    if (state) return { text: state.doc.toString(), from: 'tab', dirty: Boolean(tab?.dirty) };
    if (tab && !tab.stale && !tab.doc) return { text: tab.text, from: 'stored', dirty: Boolean(tab.dirty) };
    const info = await window.desktop.disk.read(path);
    if (info.doc || info.binary) throw new Error('it is not a text file');
    if (info.truncated) throw new Error('it is too large to change here');
    return { text: info.text, from: 'disk', dirty: false };
  };

  /** The folders on the way to `rel` (a folder) made where missing: their paths, outermost first. */
  const ensureFolders = async (rel) => {
    const made = [];
    if (!rel) return made;
    let at = '';
    for (const part of rel.split('/')) {
      const next = at ? `${at}/${part}` : part;
      const hit = await exists(full(next));
      if (hit && !hit.dir) throw new Error(`${next} is a file, not a folder`);
      if (!hit) made.push(await window.desktop.folders.newFolder(full(at), part));
      at = next;
    }
    return made;
  };
  const removeEmpty = async (paths) => {
    const left = [];
    for (const p of [...paths].reverse()) {
      try {
        if ((await listing(p)).length) left.push(p);
        else await window.desktop.folders.trash([p]);
      } catch {
        left.push(p);
      }
    }
    return left;
  };

  const tree = async () => {
    try {
      const r = await window.desktop.folders.index(base, { hidden: true });
      if (r.offline) return '(the server is not connected: connect it in Folders, then ask again)';
      const files = (r.files ?? []).map((f) => ({ rel: (f.rel ?? relOf(f.path)).replace(/\\/g, '/'), size: f.size })).filter((f) => f.rel);
      return treeText(files, { truncated: r.truncated });
    } catch (err) {
      return `(this folder cannot be listed: ${message(err)})`;
    }
  };

  const tabsHere = (except) =>
    store
      .diskTabs()
      .map((t) => t.path)
      .filter((p) => p !== except && isWithin(p, base))
      .map(relOf)
      .filter(Boolean);

  /** The open file (when it is the one the panel was opened from) as the picture shows it. */
  const fileNow = () => {
    if (!file) return null;
    const tabKey = diskKey(file);
    const state = host()?.stateOf(tabKey);
    const text = state ? state.doc.toString() : (store.diskTab(file)?.text ?? '');
    if (isSecretName(file)) return null;
    const sel = host()?.selectionInfo?.();
    let selection = null;
    if (sel && sel.key === tabKey && sel.from !== sel.to && state) selection = { from: state.doc.lineAt(sel.from).number, to: state.doc.lineAt(sel.to).number };
    return { rel: relOf(file) || baseName(file), text, selection };
  };

  return {
    kind: 'folder',
    base: { name, where, path: base },
    label: name,
    canTerminal: Boolean(window.desktop?.terminal) && (!remote || conn?.protocol === 'sftp'),
    async picture({ withFile = true } = {}) {
      return workspaceText({ base: { name, where }, tree: await tree(), file: withFile ? fileNow() : null, tabs: tabsHere(file) });
    },
    async tree() {
      return tree();
    },

    async look(step) {
      const s = step;
      if (s.op === 'list') {
        const top = full(s.path ?? '');
        const depth = s.depth ?? 2;
        const out = [];
        let truncated = false;
        const walk = async (dir, level) => {
          let entries;
          try {
            entries = await listing(dir);
          } catch (err) {
            if (dir === top) throw err;
            return;
          }
          for (const e of entries) {
            if (out.length >= LIST_ENTRIES) {
              truncated = true;
              return;
            }
            if (e.dir && SKIP_DIRS.has(e.name)) continue;
            const rel = relOf(e.path);
            out.push({ rel, dir: e.dir, size: e.dir ? undefined : e.size });
            if (e.dir && level < depth && !e.link) await walk(e.path, level + 1);
          }
        };
        await walk(top, 1);
        const prefix = s.path ? `${s.path}/` : '';
        return treeText(out.map((e) => ({ ...e, rel: prefix && e.rel.startsWith(prefix) ? e.rel.slice(prefix.length) : e.rel })), { truncated });
      }
      if (s.op === 'read') {
        const got = await currentText(full(s.path));
        const n = numbered(got.text, { from: s.from ?? 1, to: s.to ?? Infinity, cap: READ_CHARS });
        return `${s.path} (${n.lines} lines${got.from !== 'disk' && got.dirty ? ', open in a tab with edits not saved yet: this is the tab’s text' : ''}):\n${n.text}`;
      }
      if (s.op === 'search') {
        const id = `files-${Date.now()}-${++searches}`;
        const found = [];
        const off = window.desktop.folders.onFound((m) => {
          if (m.searchId === id && m.type === 'found' && m.file && !isSecretName(m.file.path)) found.push({ rel: relOf(m.file.path), matches: m.file.matches });
        });
        try {
          await window.desktop.folders.find(id, full(s.path ?? ''), s.text, { regex: Boolean(s.regex), hidden: true });
        } finally {
          off();
        }
        return searchText(found, { cap: SEARCH_LINES });
      }
      throw new Error(`${s.op} is not a look`);
    },

    /** What a change will do, for its card (and whether it can be done now): { preview } or { error }. */
    async prepare(step) {
      const s = step;
      if (s.op === 'create-folder') {
        const hit = await exists(full(s.path));
        if (hit && !hit.dir) return { error: `${s.path} is a file` };
        return { preview: { kind: 'folder', exists: Boolean(hit) } };
      }
      if (s.op === 'create-file') {
        if (await exists(full(s.path))) return { error: `${s.path} is there already: change it with edit-file` };
        return { preview: { kind: 'new', text: s.text } };
      }
      if (s.op === 'edit-file') {
        let got;
        try {
          got = await currentText(full(s.path));
        } catch (err) {
          return { error: `${s.path}: ${message(err)}` };
        }
        const r = applyEdits(got.text, s.edits ?? [], s.text ?? null);
        if (r.error) return { error: `${s.path}: ${r.error}` };
        if (!r.changes.length) return { error: `${s.path}: nothing would change` };
        return { preview: { kind: 'edit', rows: diffRows(got.text, r.changes), from: got.from, dirty: got.dirty } };
      }
      if (s.op === 'rename') {
        const from = await exists(full(s.from));
        if (!from) return { error: `${s.from} is not there` };
        if (await exists(full(s.to))) return { error: `${s.to} is there already` };
        return { preview: { kind: 'rename', dir: from.dir } };
      }
      if (s.op === 'delete') {
        const hit = await exists(full(s.path));
        if (!hit) return { error: `${s.path} is not there` };
        let inside = 0;
        if (hit.dir) inside = (await listing(full(s.path)).catch(() => [])).length;
        return { preview: { kind: 'delete', dir: hit.dir, inside, forGood } };
      }
      if (s.op === 'terminal') return this.canTerminal ? { preview: { kind: 'terminal' } } : { error: remote ? 'this server has no terminal here' : 'terminals work in the desktop app' };
      return { error: `${s.op} cannot be done here` };
    },

    /** Makes a change: { ok, output, undo? } (undo: () => '' when done, else why not). */
    async apply(step) {
      const s = step;
      if (s.op === 'create-folder') {
        const made = await ensureFolders(s.path);
        return { ok: true, output: made.length ? `Made ${s.path}` : `${s.path} was there already`, undo: made.length ? async () => ((await removeEmpty(made)).length ? 'it has files in it now' : '') : null };
      }
      if (s.op === 'create-file') {
        const path = full(s.path);
        if (await exists(path)) throw new Error(`${s.path} is there already`);
        const folders = await ensureFolders(relDir(s.path));
        const uri = uriOf(path);
        const r = await actions.applyWorkspaceEdit(
          { documentChanges: [{ kind: 'create', uri }, { textDocument: { uri, version: null }, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: s.text }] }] },
          { title: `Make ${s.path}`, preview: 'never', quiet: true, serverText: false, placeOf },
        );
        if (!r.done) throw new Error(r.skippedReason || r.failureReason || 'it could not be made');
        return {
          ok: true,
          output: `Made ${s.path} (${s.text.split('\n').length} lines)${folders.length ? `, and the folder${folders.length === 1 ? '' : 's'} on the way` : ''}`,
          undo: async () => {
            const why = await r.undo?.();
            if (why) return why;
            await removeEmpty(folders);
            return '';
          },
        };
      }
      if (s.op === 'edit-file') {
        const path = full(s.path);
        const got = await currentText(path);
        const edit = applyEdits(got.text, s.edits ?? [], s.text ?? null);
        if (edit.error) throw new Error(edit.error);
        const wasClean = got.from !== 'disk' && !got.dirty;
        const r = await actions.applyWorkspaceEdit({ changes: { [uriOf(path)]: toLspEdits(got.text.replace(/\r\n?/g, '\n'), edit.changes) } }, { title: `Change ${s.path}`, preview: 'never', quiet: true, serverText: false, userEvent: 'input.model', placeOf });
        if (!r.done) throw new Error(r.skippedReason || r.failureReason || 'it could not be changed');
        // An open tab without edits of its own: saved, so the file on disk is the same.
        if (wasClean) await actions.saveDisk(path);
        const places = edit.changes.length;
        return {
          ok: true,
          output: `Changed ${s.path} (${places} place${places === 1 ? '' : 's'})${got.from !== 'disk' && got.dirty ? ' in its tab, which has edits not saved yet: it is not saved to disk' : ''}`,
          undo: async () => {
            const why = await r.undo?.();
            if (why) return why;
            if (wasClean) await actions.saveDisk(path);
            return '';
          },
        };
      }
      if (s.op === 'rename') {
        const from = full(s.from);
        const to = full(s.to);
        const folders = await ensureFolders(relDir(s.to));
        let now = from;
        if (parentOf(from) !== parentOf(to)) {
          const moved = await window.desktop.folders.move([from], parentOf(to), { onExists: 'skip' });
          if (!Array.isArray(moved) || !moved.length) throw new Error('it could not be moved there');
          now = moved[0].to;
        }
        if (baseName(now) !== baseName(to)) now = await window.desktop.folders.rename(now, baseName(to));
        actions.followDiskMoves([{ from, to: now }]);
        return {
          ok: true,
          output: `Renamed ${s.from} → ${s.to}`,
          undo: async () => {
            if (await exists(from)) return `${s.from} is there again`;
            let back = now;
            if (parentOf(now) !== parentOf(from)) back = (await window.desktop.folders.move([now], parentOf(from), { onExists: 'skip' }))[0]?.to ?? now;
            if (baseName(back) !== baseName(from)) back = await window.desktop.folders.rename(back, baseName(from));
            actions.followDiskMoves([{ from: now, to: back }]);
            await removeEmpty(folders);
            return '';
          },
        };
      }
      if (s.op === 'delete') {
        const path = full(s.path);
        const hit = await exists(path);
        if (!hit) throw new Error(`${s.path} is not there`);
        // A text file's words are kept, so Undo can make it again.
        let kept = null;
        if (!hit.dir && (hit.size ?? 0) <= 1_000_000) kept = await currentText(path).then((g) => g.text, () => null);
        await window.desktop.folders.trash([path]);
        actions.closeDiskPaths([path]);
        return {
          ok: true,
          output: `Deleted ${s.path}${forGood ? ' (for good)' : ' (to the Recycle Bin)'}`,
          undo:
            kept == null
              ? null
              : async () => {
                  if (await exists(path)) return `${s.path} is there again`;
                  await ensureFolders(relDir(s.path));
                  await window.desktop.folders.newFile(parentOf(path), baseName(path), { text: kept });
                  return '';
                },
        };
      }
      if (s.op === 'terminal') {
        const cwd = remote ? remoteParts(base).path || '/' : base;
        await actions.typeInTerminal(s.command, cwd, remote ? remoteParts(base).id : 'local', { then: '' });
        return { ok: true, typed: true, output: `Typed in a terminal in ${name}: “${s.command}”. The person runs it.` };
      }
      throw new Error(`${s.op} cannot be done here`);
    },
  };
}

// ---- Synced notes (My files): the note open and the others of its project ----

function notesWork(id, { host, actions }) {
  const note = store.get(id);
  if (!note || note.deleted) return { unavailable: 'That file is not here any more.' };
  if (note.encrypted || store.isSealed?.(id)) return { unavailable: 'The model never reads or changes encrypted files.' };
  const project = note.project ?? '';
  const name = project ? `My files · ${project}` : 'My files';
  const usable = (f) => f && !f.deleted && !f.encrypted && !store.isSealed?.(f.id) && (f.project ?? '') === project;
  const files = () => store.live().filter(usable);
  // Two notes may share a name: the one the panel is about first, else the one changed last.
  const byName = (rel) => {
    const same = files().filter((f) => f.name === rel);
    return same.find((f) => f.id === id) ?? same.sort((a, b) => String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')))[0] ?? null;
  };
  const textOf = (f) => {
    const state = host()?.stateOf(fileKey(f.id));
    return state ? state.doc.toString() : store.text(f.id);
  };
  const tree = () => treeText(files().map((f) => ({ rel: f.name, size: (store.text(f.id) ?? '').length })));
  const refuse = (op) => `${op} does not apply to synced notes (they have names, no folders)`;

  return {
    kind: 'notes',
    base: { name, where: 'synced notes in My files', project },
    label: name,
    canTerminal: false,
    async picture({ withFile = true } = {}) {
      const state = host()?.stateOf(fileKey(id));
      const sel = host()?.selectionInfo?.();
      const selection = state && sel && sel.key === fileKey(id) && sel.from !== sel.to ? { from: state.doc.lineAt(sel.from).number, to: state.doc.lineAt(sel.to).number } : null;
      const now = store.get(id);
      return workspaceText({ base: { name, where: 'synced notes in My files' }, kind: 'notes', tree: tree(), file: withFile && now && !now.deleted ? { rel: now.name, text: textOf(now), selection } : null });
    },
    async tree() {
      return tree();
    },
    async look(s) {
      if (s.op === 'list') return tree();
      if (s.op === 'read') {
        const f = byName(s.path);
        if (!f) throw new Error(`no note named ${s.path} in ${name}`);
        const n = numbered(textOf(f), { from: s.from ?? 1, to: s.to ?? Infinity });
        return `${f.name} (${n.lines} lines):\n${n.text}`;
      }
      if (s.op === 'search') {
        let re;
        try {
          re = new RegExp(s.regex ? s.text : s.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        } catch (err) {
          throw new Error(err.message);
        }
        const found = files().map((f) => ({ rel: f.name, matches: textOf(f).split('\n').flatMap((line, i) => (re.test(line) ? [{ line: i + 1, preview: line.slice(0, 160) }] : [])) }));
        return searchText(found.filter((f) => f.matches.length));
      }
      throw new Error(`${s.op} is not a look`);
    },
    async prepare(s) {
      if (s.op === 'create-file') return byName(s.path) ? { error: `a note named ${s.path} is there already: change it with edit-file` } : { preview: { kind: 'new', text: s.text } };
      if (s.op === 'edit-file') {
        const f = byName(s.path);
        if (!f) return { error: `no note named ${s.path} in ${name}` };
        const text = textOf(f);
        const r = applyEdits(text, s.edits ?? [], s.text ?? null);
        if (r.error) return { error: `${s.path}: ${r.error}` };
        if (!r.changes.length) return { error: `${s.path}: nothing would change` };
        return { preview: { kind: 'edit', rows: diffRows(text, r.changes), from: 'note' } };
      }
      return { error: refuse(s.op) };
    },
    async apply(s) {
      if (s.op === 'create-file') {
        if (byName(s.path)) throw new Error(`a note named ${s.path} is there already`);
        const newId = store.create({ name: s.path, text: s.text, project, open: false });
        return {
          ok: true,
          output: `Made the note ${s.path}${project ? ` in ${project}` : ''}`,
          undo: async () => {
            if (store.text(newId) !== s.text) return 'it was changed since';
            store.remove(newId);
            return '';
          },
        };
      }
      if (s.op === 'edit-file') {
        const f = byName(s.path);
        if (!f) throw new Error(`no note named ${s.path}`);
        const key = fileKey(f.id);
        const before = textOf(f);
        const r = applyEdits(before, s.edits ?? [], s.text ?? null);
        if (r.error) throw new Error(r.error);
        if (host()?.stateOf(key)) host().applyChanges(key, { changes: r.changes, userEvent: 'input.model' });
        else store.setText(f.id, r.text, { urgent: true });
        return {
          ok: true,
          output: `Changed ${s.path} (${r.changes.length} place${r.changes.length === 1 ? '' : 's'})`,
          undo: async () => {
            if (textOf(f) !== r.text) return 'it was changed since';
            if (host()?.stateOf(key)) host().restoreText(key, r.text, before);
            else store.setText(f.id, before, { urgent: true });
            return '';
          },
        };
      }
      throw new Error(refuse(s.op));
    },
  };
}
