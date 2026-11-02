// Git's conflicts, the app's side (0.49): the commands and bars of the editor's conflict blocks
// (conflictView.js: next, accept, compare), the model's merge of one block, the merge view
// (ui/mergeView.js: a comparison tab of mode 'merge'), and what the Git panel's Conflicts section
// (ui/conflicts.js) checks before Git changes a file: a whole side taken, a file deleted, Mark
// resolved (asking first when markers are still in it; unsaved edits saved first). app.js makes it
// on each render with what it shares, and puts its functions on `actions`.
import { findLanguage } from './editor.js';
import { conflictLabels } from './conflictView.js';
import { findConflicts, mergedFromReply, mergeMessages } from './gitConflicts.js';
import { diskKey, parseKey, store } from './store.js';
import { isContentPath } from './where.js';
import { dismissToast } from './ui/components.js';

const NOT_HERE = 'Put the cursor in a conflict block first: the lines from <<<<<<< to >>>>>>>.';
const baseName = (p) => String(p).split(/[\\/]/).pop();
const parentDir = (p) => p.replace(/[\\/][^\\/]*$/, '') || p;
const CONTINUE = { merge: 'Finish the merge (commit)', rebase: 'Continue the rebase', 'cherry-pick': 'Continue the cherry-pick', revert: 'Continue the revert' };
// Each tab's number of conflict blocks as last reported, to tell when the last one goes.
const counts = new Map();

/** A path's place in its repository: { dir, root, rel, status }, or null when it is not in one. */
async function repoPlace(path) {
  const dir = parentDir(path);
  const status = await window.desktop?.git?.status(dir).catch(() => null);
  if (!status?.root) return null;
  const norm = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const low = /^[a-z]:/i.test(status.root) ? (x) => x.toLowerCase() : (x) => x;
  const root = norm(status.root);
  if (!low(norm(path)).startsWith(`${low(root)}/`)) return null;
  return { dir, root: status.root, rel: norm(path).slice(root.length + 1), status };
}

export function createConflictActions({ host, actions, toast, setCompare, setView, gitWorksAt, askReady, getSettings, llmClient, encryptedNotSent }) {
  const h = () => host() ?? null;
  // The tab a command means: the one given, else the pane typed in last.
  const keyNow = (key) => key ?? h()?.selectionInfo()?.key ?? store.session.active ?? null;
  const tabInfo = (key) => {
    const k = parseKey(key ?? '');
    if (k?.kind === 'file') {
      const f = store.get(k.id);
      return f ? { name: f.name, language: findLanguage(f.name, f.language)?.name ?? '', encrypted: Boolean(f.encrypted) || store.isSealed(k.id), path: null } : null;
    }
    if (k?.kind === 'disk') {
      const t = store.diskTab(k.path);
      const name = t?.name ?? baseName(k.path);
      return { name, language: findLanguage(name)?.name ?? '', encrypted: false, path: k.path, doc: Boolean(t?.doc) };
    }
    if (k?.kind === 'repo') {
      const name = store.repoTab(k.path)?.name ?? baseName(k.path);
      return { name, language: findLanguage(name)?.name ?? '', encrypted: false, path: null };
    }
    return null;
  };
  /** Whether a tab's file can have the merge view: a file in a Git repository where Git works. */
  const canMergeView = (key) => {
    const k = parseKey(key ?? '');
    return k?.kind === 'disk' && !isContentPath(k.path) && Boolean(window.desktop?.git?.act) && gitWorksAt(k.path) && !store.diskTab(k.path)?.doc;
  };
  /** Whether the model may merge a tab's blocks: one that answers at once, and never an encrypted file. */
  const canModel = (key) => askReady() && !tabInfo(key)?.encrypted;

  /** The next (1) or previous (-1) conflict block in the pane typed in last. */
  const nextConflict = (step) => {
    if (!h()?.gotoConflict(step)) toast('No Git conflicts in this file.');
  };
  /** The conflict block at the cursor (of `key`'s pane) resolved as `how`: one edit, Ctrl+Z brings it back. */
  const resolveConflictHere = (how, { key = null } = {}) => {
    if (!h()?.resolveConflict(how, { key })) toast(NOT_HERE);
  };
  /** The right-click menu's conflict items for a tab, when its cursor is in a block: { mergeView, model }, else null. */
  const conflictMenuInfo = (key) => (h()?.conflictAt(key) ? { mergeView: canMergeView(key), model: canModel(key) } : null);

  /**
   * A tab with conflict blocks shows: its bars get their buttons (the merge view, the model) and,
   * for a file in a Git repository, the words of what stopped (a rebase swaps the sides).
   */
  const lookUpConflicts = async (key) => {
    if (!key || !h()?.conflicts(key).length) return;
    h().setConflictInfo(key, { mergeView: canMergeView(key), model: canModel(key) });
    const k = parseKey(key);
    if (!canMergeView(key)) return;
    const r = await window.desktop.git.act(parentDir(k.path), { op: 'in-progress' }).catch(() => null);
    if (r?.ok) h()?.setConflictInfo(key, { op: r.result ?? null });
  };

  /** A tab reported its number of blocks: when the last one goes from a file in Git, offer to mark it resolved. */
  const conflictsCounted = (key, n) => {
    const before = counts.get(key);
    counts.set(key, n);
    if (!(before > 0) || n > 0) return;
    const k = parseKey(key);
    if (k?.kind !== 'disk' || !canMergeView(key)) return;
    toast(`No conflict blocks left in ${baseName(k.path)}. Save it and mark it resolved?`, { key: 'conflicts-left', timeout: 15000, action: { label: 'Save and mark resolved', run: () => markResolved(k.path) } });
  };

  /** The two sides of the block at the cursor (or block `index` of `key`) side by side, with Accept current / incoming / both. */
  const compareConflict = (key = null, index = null) => {
    const k = keyNow(key);
    const c = k && h()?.conflictAt(k, index);
    if (!c) return toast(NOT_HERE);
    const info = tabInfo(k);
    const words = conflictLabels(c.op, c.labels);
    if (store.session.active !== k) store.open(k);
    // After the comparison closes; only while the block is still as it was.
    const take = (how) => () => {
      setCompare(null);
      setTimeout(() => {
        if (h()?.conflictAt(k, c.index)?.block !== c.block || !h()?.resolveConflict(how, { key: k, index: c.index })) toast('The block changed meanwhile, so it was left as it is.', { kind: 'error' });
      }, 0);
    };
    setCompare({
      key: k,
      name: info?.name ?? '',
      language: info?.language ?? '',
      left: { label: 'Current change', text: c.ours, detail: words.current.replace(/^Current change · /, '') },
      right: { label: 'Incoming change', text: c.theirs, detail: words.incoming.replace(/^Incoming change · /, '') },
      actions: [
        { label: 'Accept current', icon: 'arrowUp', run: take('ours') },
        { label: 'Accept incoming', icon: 'arrowDown', run: take('theirs') },
        { label: 'Accept both', icon: 'check', primary: true, run: take('both') },
      ],
    });
  };

  /**
   * The model's merge of one block (`texts`: conflictTexts' form, with `labels` and `op`) for tab
   * `key`: { text, note }, or null (said in a toast). Never for an encrypted file.
   */
  const mergeTextsWithModel = async (key, texts) => {
    const info = tabInfo(key);
    if (info?.encrypted) return toast(encryptedNotSent), null;
    if (!askReady()) return toast('Connect a model that answers at once in Settings → Model to have it merge conflicts.', { action: { label: 'Settings', run: () => actions.showSettings() } }), null;
    const { llm } = getSettings();
    toast('The model is merging the two changes…', { key: 'conflict-model', timeout: 120000 });
    let out = '';
    let reply = '';
    try {
      reply = await llmClient().chat({
        model: llm.chatModel,
        purpose: 'merge',
        messages: mergeMessages({ name: info?.name ?? '', op: texts.op ?? null, labels: texts.labels, before: texts.before, after: texts.after, ours: texts.ours, base: texts.base, theirs: texts.theirs, language: info?.language ?? '' }),
        onToken: (t) => (out += t),
      });
    } catch (err) {
      toast(`The model did not merge it: ${err.message}`, { key: 'conflict-model', kind: 'error', timeout: 10000 });
      return null;
    }
    dismissToast('conflict-model');
    const merged = mergedFromReply(reply || out, { finalNewline: texts.block.endsWith('\n') });
    if (!merged) toast('The model’s answer had no merged lines in it. Ask again, or merge it by hand.', { kind: 'error', timeout: 10000 });
    return merged;
  };
  /**
   * The model merges the block at the cursor (or block `index` of `key`): the two sides, the base,
   * the lines around and the file's name go to it (never for an encrypted file); its merge comes
   * back as a proposal to accept (one edit) or copy.
   */
  const mergeConflictWithModel = async (key = null, index = null) => {
    const k = keyNow(key);
    if (tabInfo(k)?.encrypted) return toast(encryptedNotSent);
    const c = k && h()?.conflictAt(k, index);
    if (!c) return toast(askReady() ? NOT_HERE : 'Connect a model that answers at once in Settings → Model to have it merge conflicts.');
    const merged = await mergeTextsWithModel(k, c);
    if (!merged) return;
    const info = tabInfo(k);
    if (store.session.active !== k) store.open(k);
    const accept = () => {
      setCompare(null);
      setTimeout(() => {
        if (!h()?.replaceRange(k, c.from, c.to, c.block, merged.text)) return toast('The text changed meanwhile, so it was left as it is. Ask again.', { kind: 'error' });
        toast('Merged by the model', { action: { label: 'Undo', run: () => h()?.run('undo') } });
      }, 0);
    };
    setCompare({
      key: k,
      name: info?.name ?? '',
      language: info?.language ?? '',
      left: { label: `Conflict ${c.index + 1} of ${c.count} now`, text: c.block },
      right: { label: '✦ Merged by the model', text: merged.text, detail: merged.note || undefined },
      actions: [
        { label: 'Accept', icon: 'check', primary: true, run: accept },
        { label: 'Copy', icon: 'copy', run: () => navigator.clipboard.writeText(merged.text).then(() => toast('Copied')) },
      ],
    });
  };

  /** The merge view of a file in conflict (the current side, the result, the incoming side), at the block at its cursor. */
  const openMergeView = (key = null, index = null) => {
    const k = keyNow(key);
    if (!canMergeView(k)) return toast('The merge view is for a file in a Git repository (on this computer, on an SSH server, in a container or WSL): it reads both sides from Git.');
    h()?.flushAll();
    const at = index ?? h()?.conflictAt(k)?.index ?? 0;
    const open = store.session.open
      .filter((t) => t.startsWith('c:'))
      .map((t) => store.compare(t.slice(2)))
      .find((c) => c?.mode === 'merge' && c.left?.key === k);
    if (open) {
      store.updateCompare(open.id, { at, seq: Date.now() });
      store.open(`c:${open.id}`);
    } else store.openCompare({ mode: 'merge', left: { key: k }, right: { key: k }, name: `Merge ${baseName(parseKey(k).path)}`, at, seq: Date.now() });
    setView('editor');
  };

  /**
   * A file's sides while it is in conflict (the merge view): { base, ours, theirs } (each { text,
   * eol, bom, encoding } or null where that side has none), the operation (`op`) and its place.
   */
  const mergeSides = async (path) => {
    const place = await repoPlace(path);
    if (!place) throw new Error(`${baseName(path)} is not in a Git repository.`);
    const r = await window.desktop.git.act(place.dir, { op: 'conflict-sides', path: place.rel });
    if (!r?.ok) throw new Error(r?.message || 'Git could not read the two sides.');
    const ip = await window.desktop.git.act(place.dir, { op: 'in-progress' }).catch(() => null);
    return { ...r.result, op: ip?.ok ? ip.result : null, place, conflicted: Boolean(place.status.conflicts?.[place.rel]) };
  };

  /**
   * Before Git changes a file in conflict: 'take' (one whole side) and 'remove' ask when its tab
   * has unsaved edits (they go); 'resolve' asks when conflict blocks are still in it (the tab's
   * text as it is, else the file's) and saves a tab's unsaved edits first. True to go on.
   */
  const conflictReady = async (path, what) => {
    h()?.flushAll();
    const tab = store.diskTab(path);
    const name = baseName(path);
    if (what !== 'resolve') return !tab?.dirty || confirm(`${name} has edits that are not saved. ${what === 'take' ? 'Taking one side replaces the file' : 'Deleting it removes the file'}, and your edits go. Go on?`);
    let text = tab && !tab.doc ? (h()?.stateOf(diskKey(path))?.doc.toString() ?? tab.text) : null;
    if (text == null) text = (await window.desktop.disk.read(path).catch(() => null))?.text ?? '';
    const { conflicts, broken } = findConflicts(text);
    const left = conflicts.length + broken.length;
    if (left && !confirm(`${name} still has ${left} conflict block${left === 1 ? '' : 's'} (<<<<<<< … >>>>>>>). Mark it resolved anyway? Git takes the file as it is, markers and all.`)) return false;
    if (tab?.dirty && (await actions.saveDisk(path)) !== 'saved') return false;
    return true;
  };
  /** After Git changed a file in conflict: its open tab reads it again ('take'), or closes ('remove'). */
  const conflictDone = async (path, what) => {
    if (!store.diskTab(path)) return;
    if (what === 'remove') return actions.close(diskKey(path), { discard: true });
    if (what === 'take') await actions.reloadDisk(path);
  };

  /** What is left after a file was marked resolved: other files in conflict, or the operation to finish. */
  const afterResolved = async (dir, name) => {
    const status = await window.desktop.git.status(dir).catch(() => null);
    const left = Object.keys(status?.conflicts ?? {}).length;
    if (left) return toast(`Marked ${name} resolved. ${left} file${left === 1 ? '' : 's'} still in conflict: the Git panel lists them.`, { action: { label: 'Git panel', run: () => actions.toggleGit(dir) } });
    const ip = await window.desktop.git.act(dir, { op: 'in-progress' }).catch(() => null);
    const op = ip?.ok ? ip.result : null;
    if (!op) return toast(`Marked ${name} resolved: it is staged.`);
    toast(`Marked ${name} resolved. No conflicts left: ${CONTINUE[op].toLowerCase()}?`, { timeout: 20000, action: { label: CONTINUE[op], run: () => continueAfterConflicts(dir, op) } });
  };
  /** Marks a file resolved (staged as it is, after conflictReady's questions): true when it was. */
  const markResolved = async (path) => {
    if (!window.desktop?.git || !gitWorksAt(path)) return false;
    if (!(await conflictReady(path, 'resolve'))) return false;
    const place = await repoPlace(path);
    if (!place) return toast(`${baseName(path)} is not in a Git repository.`), false;
    const r = await actions.gitRun(place.dir, { op: 'stage', paths: [place.rel] });
    if (!r.ok) return toast(r.error.message, { kind: 'error', timeout: 10000 }), false;
    await afterResolved(place.dir, baseName(path));
    return true;
  };
  /** The merge, rebase, cherry-pick or revert finished once no conflicts are left (git.cjs `continue`). */
  const continueAfterConflicts = async (dir, op) => {
    const r = await actions.gitRun(dir, { op: 'continue', what: op });
    if (r.ok) return toast(op === 'merge' ? 'Merged: the merge commit is made.' : `The ${op} went on.`);
    toast(r.error.message, { kind: 'error', timeout: 12000, action: { label: 'Git panel', run: () => actions.toggleGit(dir) } });
  };

  return {
    nextConflict,
    resolveConflictHere,
    conflictMenuInfo,
    lookUpConflicts,
    conflictsCounted,
    compareConflict,
    mergeConflictWithModel,
    mergeTextsWithModel,
    openMergeView,
    mergeSides,
    conflictReady,
    conflictDone,
    markResolved,
    continueAfterConflicts,
    conflictCanModel: canModel,
  };
}
