// Git that writes (desktop: folders on this computer, on SSH servers and in places, Docker
// containers and WSL distributions, with the git there): the Git panel (Ctrl+Shift+G) and the
// branch picker (the status bar's branch). The panel shows the repository the open file or the
// folder in Folders is in: its branch, fetch / pull / push with Git's progress, a commit box
// (amend too), the changes staged and not staged (stage or unstage each, or all), what is in
// the middle of a merge or rebase, and the stash. Files are picked several at a time (their
// boxes, Shift for a range, Ctrl/Cmd+click, Ctrl+A in a list, a right-click) for the bar's and
// the menu's actions: stage or unstage, stash, discard, ignore (in .gitignore, shared, or
// .git/info/exclude, this computer only), keep my changes out (skip-worktree), stop tracking
// (gitFiles.js). "Kept out on this computer" lists what only this computer leaves out.
// Every command goes through
// actions.gitRun (the main process's git:act), which also says when unsaved tabs are in the way.
// A server not connected says so (Connect); Git missing there offers the command that installs
// it, typed into that place's terminal (never run by itself).
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { ignoreChoices, ignorePattern, namesList, pickActions, pickAfterClick, pickedWords, tidyPicked } from '../gitFiles.js';
import { GIT_LABELS, branchNameProblem, canCommit, mergeRequestLink } from '../gitStatus.js';
import { server } from '../servers.js';
import { connLabel, isRemotePath, remoteParts } from '../where.js';
import { Modal } from './components.js';
import { FileIcon } from './fileIcon.js';
import { Icon } from './icons.js';
import { Menu, MenuButton } from './menu.js';
import { ConflictsSection } from './conflicts.js';

const baseName = (p) => String(p).split(/[\\/]/).pop();
/** The connection a folder is on (a server or a place), or null for one on this computer. */
const connOf = (dir) => (isRemotePath(dir) ? server(remoteParts(dir).id) : null);
/** A folder as the person knows it: its path here, or "build-box: /srv/app". */
const shownPath = (dir) => {
  const conn = connOf(dir);
  return conn ? `${connLabel(conn)}: ${remoteParts(dir).path}` : dir;
};

/**
 * Git is not installed where the folder is: on this computer, a link to get it; on a server or
 * in a place, the command that installs it there (from git:info's `install`), typed into its
 * terminal for the person to check and run.
 */
function GitMissing({ dir, info, actions }) {
  const conn = connOf(dir);
  if (!conn)
    return html`<div class="git-none">
      <p class="small">Git is not installed on this computer. Install it, then read again.</p>
      <p><button type="button" class="btn sm" onClick=${() => window.open('https://git-scm.com/downloads', '_blank', 'noopener')}><${Icon} name="external" size=${14} />Get Git (git-scm.com)</button></p>
    </div>`;
  const where = connLabel(conn);
  const install = info?.install;
  return html`<div class="git-none git-missing">
    <p class="small">Git is not installed on <strong>${where}</strong>. Install it there, then read again.</p>
    ${install
      ? html`<pre class="git-install"><code>${install.command}</code></pre>
        <p class="muted small">${install.asRoot ? 'Run it as root there (no sudo was found).' : 'It is typed into a terminal there, for you to check and run with Enter.'}</p>
        <p><button type="button" class="btn sm primary" onClick=${() => actions.typeInTerminal(install.command, remoteParts(dir).path, remoteParts(dir).id, { then: 'Then read Git again in the Git panel.' })}><${Icon} name="terminal" size=${14} />Type it in ${where}’s terminal</button></p>`
      : html`<p class="muted small">Install it with the package manager there (apt, dnf, apk…), then read again.</p>`}
  </div>`;
}
const folderOfRel = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
/** A path inside the repository as a path on this computer. */
export const fullPath = (root, rel) => (/^[A-Za-z]:|\\/.test(root) ? `${root.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}` : `${root.replace(/\/+$/, '')}/${rel}`);
const firstLine = (text) => String(text).split('\n').find((l) => l.trim()) ?? '';

function FileRow({ rel, code, root, staged, busy, actions, onStage, picked, onPick, onMenu }) {
  const path = fullPath(root, rel);
  const gone = code === 'D';
  return html`<div class=${`git-file code-${code} ${picked ? 'picked' : ''}`} onContextMenu=${(e) => onMenu(rel, e)}>
    <input type="checkbox" class="git-check" checked=${picked} aria-label=${`Pick ${rel}`} title="Pick it (Shift: the ones between, Ctrl+A: all of them)"
      onClick=${(e) => onPick(rel, { shift: e.shiftKey })} />
    <button type="button" class="git-file-name" title=${`${rel} · ${GIT_LABELS[code] ?? code}${gone ? '' : ' · click to open (Ctrl+click or Shift+click picks)'}`}
      onClick=${(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return onPick(rel, { shift: e.shiftKey });
        if (!gone) actions.openDiskPath(path);
      }}>
      <${FileIcon} name=${baseName(rel)} size=${14} />
      <span class="git-file-base">${baseName(rel)}</span>
      <span class="git-file-dir muted small">${folderOfRel(rel)}</span>
    </button>
    ${code === 'M' && html`<button type="button" class="icon-btn xs" title="Compare with the last commit" aria-label=${`Compare ${rel} with the last commit`} onClick=${() => actions.compareWithHead(path)}><${Icon} name="compare" size=${13} /></button>`}
    <button type="button" class="icon-btn xs" disabled=${busy} title=${staged ? 'Unstage: leave it out of the next commit' : 'Stage: take it into the next commit'} aria-label=${`${staged ? 'Unstage' : 'Stage'} ${rel}`} onClick=${() => onStage(rel, !staged)}>
      <${Icon} name=${staged ? 'undo' : 'plus'} size=${13} />
    </button>
    <span class=${`git-badge git-${code}`} title=${GIT_LABELS[code] ?? code}>${code}</span>
  </div>`;
}

/** Stashing (all changes, or the picked files: `paths`): a name, and whether new files go too. */
function StashForm({ stashing, setStashing, busy, onStash }) {
  const input = useRef(null);
  useEffect(() => input.current?.focus(), []);
  return html`<form class="git-stash-form" onSubmit=${(e) => (e.preventDefault(), onStash())}>
    ${stashing.paths && html`<span class="small git-stash-what">Stash ${pickedWords(stashing.paths)}:</span>`}
    <input ref=${input} value=${stashing.message} placeholder="What it is (optional)" aria-label="Stash message" onInput=${(e) => setStashing({ ...stashing, message: e.currentTarget.value })}
      onKeyDown=${(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), setStashing(null))} />
    ${!stashing.paths && html`<label class="small"><input type="checkbox" checked=${stashing.untracked} onChange=${(e) => setStashing({ ...stashing, untracked: e.currentTarget.checked })} />New files too</label>`}
    <span class="git-stash-buttons"><button type="submit" class="btn sm primary" disabled=${busy}>Stash</button><button type="button" class="btn sm ghost" onClick=${() => setStashing(null)}>Cancel</button></span>
  </form>`;
}

/**
 * Staged or Changes: the files with their boxes, a box for them all in the head, and while some
 * are picked the bar of what can be done with them (`items(entries)` makes its menu).
 */
function FileSection({ id, title, entries, empty, headButton, picked, setPicked, anchor, busy, root, actions, onStage, items, quick, stashForm }) {
  const rels = entries.map(([r]) => r);
  const chosen = entries.filter(([r]) => picked.has(r));
  const [menu, setMenu] = useState(null); // { at, entries }
  const all = rels.length > 0 && chosen.length === rels.length;
  const onPick = (rel, { shift = false } = {}) => {
    setPicked(pickAfterClick(picked, rels, rel, { shift, anchor: anchor.current }));
    if (!shift) anchor.current = rel;
  };
  const onMenu = (rel, e) => {
    e.preventDefault();
    // A row not picked: it alone, as file managers do.
    const these = picked.has(rel) ? chosen : entries.filter(([r]) => r === rel);
    if (!picked.has(rel)) {
      setPicked(new Set([rel]));
      anchor.current = rel;
    }
    setMenu({ at: { x: e.clientX, y: e.clientY }, entries: these });
  };
  return html`<section class=${`git-section git-files-${id}`}
    onKeyDown=${(e) => {
      // Ctrl+A picks them all, unless it is selecting text in a field (the stash's name).
      const typing = e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !typing) {
        e.preventDefault();
        setPicked(new Set(rels));
      } else if (e.key === 'Escape' && picked.size) {
        e.preventDefault();
        e.stopPropagation();
        setPicked(new Set());
      }
    }}>
    <h3 class="git-section-head">
      ${rels.length > 0 && html`<input type="checkbox" class="git-check" checked=${all} indeterminate=${chosen.length > 0 && !all} aria-label=${`Pick all of ${title}`} title=${all ? 'Pick none' : 'Pick them all'} onClick=${() => setPicked(all ? new Set() : new Set(rels))} />`}
      ${title}<span class="muted small">${rels.length || ''}</span><span class="spacer" />${headButton}
    </h3>
    ${chosen.length > 0 &&
    html`<div class="git-pickbar" role="toolbar" aria-label=${`The picked files of ${title}`}>
      <span class="small git-pick-count">${chosen.length} picked</span>
      ${quick(chosen)}
      <${MenuButton} label="More for the picked files" className="icon-btn sm" items=${() => items(chosen)} />
      <button type="button" class="icon-btn sm git-pick-none" aria-label="Pick none" title="Pick none (Esc)" onClick=${() => setPicked(new Set())}><${Icon} name="x" size=${14} /></button>
    </div>`}
    ${stashForm}
    ${entries.length
      ? entries.map(([rel, code]) => html`<${FileRow} key=${`${id}:${rel}`} rel=${rel} code=${code} root=${root} staged=${id === 'staged'} busy=${busy} actions=${actions} onStage=${onStage} picked=${picked.has(rel)} onPick=${onPick} onMenu=${onMenu} />`)
      : html`<p class="muted small git-empty">${empty}</p>`}
    ${menu && html`<${Menu} items=${items(menu.entries)} at=${menu.at} label="Picked files" className="git-file-menu" onClose=${() => setMenu(null)} />`}
  </section>`;
}

/**
 * The Git panel for the repository `dir` is in. `tick` changes when Git's state may have
 * changed elsewhere (a save, the window back): it reads it again.
 */
export function GitPanel({ dir, tick, actions, onClose }) {
  const bridge = window.desktop?.git;
  const [status, setStatus] = useState(undefined); // undefined: reading; null: not a repository
  const [doing, setDoing] = useState(null); // what runs now ('pull'…), and Git's last progress line
  const [progress, setProgress] = useState('');
  const [problem, setProblem] = useState(null); // { kind, message, detail, action }
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [stashes, setStashes] = useState([]);
  const [inProgress, setInProgress] = useState(null);
  const [stashing, setStashing] = useState(null); // { message, untracked } while asking
  const [writing, setWriting] = useState(null); // an AbortController while the model writes the message
  const [none, setNone] = useState(null); // not a repository: { installed, root, defaultBranch, install, unsupported } (git:info)
  const [offline, setOffline] = useState(false); // a server or place not connected now
  const [picked, setPickedAll] = useState(() => ({ staged: new Set(), changes: new Set() })); // the files picked, by section
  const anchors = { staged: useRef(null), changes: useRef(null) }; // the last one clicked (Shift picks from it)
  const [kept, setKept] = useState(null); // what only this computer leaves out: { skipped, patterns }
  const box = useRef(null);
  const conn = connOf(dir);

  const load = async () => {
    let s = await bridge.status(dir).catch(() => null);
    if (s?.offline) {
      setNone(null);
      setOffline(true);
      return setStatus(null);
    }
    setOffline(false);
    if (!s) {
      // Why not: no git program (there), a server where Git cannot run, or a folder not in a
      // repository (offered to become one). Git just installed there: the repository shows now.
      const info = (await bridge.info?.(dir).catch(() => null)) ?? null;
      if (info?.installed && info.root) s = await bridge.status(dir).catch(() => null);
      if (!s || s.offline) {
        setStatus(null);
        setOffline(Boolean(info?.offline));
        setNone(info);
        return;
      }
    }
    setStatus(s);
    const [st, ip, ko] = await Promise.all([bridge.act(dir, { op: 'stashes' }), bridge.act(dir, { op: 'in-progress' }), bridge.act(dir, { op: 'kept-out' })]);
    setStashes(st?.ok ? st.result : []);
    setInProgress(ip?.ok ? ip.result : null);
    setKept(ko?.ok ? ko.result : null);
  };
  useEffect(() => {
    load();
  }, [dir, tick]);
  // Files no longer listed (staged, committed, stashed…) are no longer picked.
  useEffect(() => {
    setPickedAll((p) => {
      const staged = tidyPicked(p.staged, Object.keys(status?.staged ?? {}));
      const changes = tidyPicked(p.changes, Object.keys(status?.unstaged ?? {}));
      return staged === p.staged && changes === p.changes ? p : { staged, changes };
    });
  }, [status]);
  useEffect(() => bridge?.onProgress(({ root, line }) => status && root === status.root && setProgress(line)), [status?.root]);

  if (!bridge) return null;
  const root = status?.root;
  const run = async (action, label) => {
    setDoing(label);
    setProgress('');
    setProblem(null);
    const r = await actions.gitRun(dir, action);
    setDoing(null);
    setProgress('');
    if (!r.ok) setProblem({ ...r.error, action });
    // The first push of a branch: the site says where to open a merge request.
    const link = r.ok && action.op === 'push' ? mergeRequestLink(`${r.result?.stdout ?? ''}\n${r.result?.stderr ?? ''}`) : null;
    if (link) actions.toast(`Pushed. Open a ${link.label} for it?`, { timeout: 20000, action: { label: `Open the ${link.label} page`, run: () => window.open(link.url, '_blank', 'noopener') } });
    await load();
    return r;
  };
  const stageOne = (rel, on) => run({ op: on ? 'stage' : 'unstage', paths: [rel] }, on ? 'stage' : 'unstage');

  // ---- The picked files: what the bar and the menu do with them ----
  const setPicked = (section, set) => setPickedAll((p) => ({ ...p, [section]: set }));
  /** Done: the files are no longer picked; `text` said, with Undo when there is one. */
  const after = (section, r, text = '', undo = null) => {
    if (!r.ok) return;
    setPicked(section, new Set());
    if (text) actions.toast(text, undo ? { action: { label: 'Undo', run: undo }, timeout: 10000 } : {});
  };
  const ignoreIn = async (section, patterns, where) => {
    const r = await run({ op: 'ignore', patterns, where }, 'ignore');
    const added = r.ok ? (r.result?.added ?? []) : [];
    const list = added.join(', ') || 'it was there already';
    after(section, r, where === 'local' ? `Ignored on this computer only (.git/info/exclude): ${list}` : `Added to .gitignore: ${list}`, added.length ? () => run({ op: 'unignore', patterns: added, where }, 'ignore') : null);
  };
  const discard = async (section, d) => {
    const fresh = d.fresh ? `${d.fresh === 1 ? 'The new file' : `The ${d.fresh} new files`} (not in Git yet) will be deleted for good. ` : '';
    if (!confirm(`Discard your changes to ${namesList(d.paths)}?\n\n${fresh}Changes not staged are lost; staged changes stay.`)) return;
    after(section, await run({ op: 'discard', paths: d.paths }, 'discard'), `Discarded the changes to ${pickedWords(d.paths)}.`);
  };
  const keepOut = async (section, paths) => {
    const r = await run({ op: 'skip', paths, on: true }, 'skip');
    after(section, r, `Your changes to ${pickedWords(paths)} are kept out on this computer: see Kept out on this computer.`, () => run({ op: 'skip', paths, on: false }, 'skip'));
  };
  const untrack = async (section, paths, ignore) => {
    const r = await run({ op: 'untrack', paths }, 'untrack');
    const patterns = paths.map((x) => ignorePattern(x));
    const ig = r.ok && ignore ? await run({ op: 'ignore', patterns }, 'ignore') : null;
    const added = ig?.ok ? (ig.result?.added ?? []) : [];
    after(section, r, `Git no longer tracks ${pickedWords(paths)} (kept on disk${ignore ? ', in .gitignore' : ''}). Commit to make it so for everyone.`, async () => {
      await run({ op: 'unstage', paths }, 'unstage');
      if (added.length) await run({ op: 'unignore', patterns: added }, 'ignore');
    });
  };
  const startStash = (section, s) => setStashing({ message: '', untracked: s.untracked, paths: s.paths, section });
  const stashNow = async () => {
    const r = await run({ op: 'stash', message: stashing.message, untracked: stashing.untracked, ...(stashing.paths ? { paths: stashing.paths } : {}) }, 'stash');
    if (!r.ok) return;
    if (stashing.section) setPicked(stashing.section, new Set());
    actions.toast(`Stashed ${stashing.paths ? pickedWords(stashing.paths) : 'your changes'}: Pop in Stash brings ${stashing.paths?.length === 1 ? 'it' : 'them'} back.`);
    setStashing(null);
  };
  /** The ignore choices for new files (in .gitignore, or this computer only). */
  const ignoreItems = (section, rels) => {
    const ign = ignoreChoices(rels);
    const kinds = ['files', 'folders', 'ext'].filter((k) => ign[k]);
    return [
      { heading: true, label: 'Ignore in .gitignore (shared)' },
      ...kinds.map((k) => ({ key: `ig-${k}`, label: ign[k].label, icon: 'eyeOff', run: () => ignoreIn(section, ign[k].patterns, 'shared') })),
      { heading: true, label: 'Ignore on this computer only' },
      ...kinds.map((k) => ({ key: `il-${k}`, label: ign[k].label, icon: 'eyeOff', hint: '.git/info/exclude', run: () => ignoreIn(section, ign[k].patterns, 'local') })),
    ];
  };
  /** The menu for picked files of a section (the bar's ⋯ and a right-click). */
  const fileItems = (section, entries) => {
    const a = pickActions(section, entries);
    const rels = entries.map(([r]) => r);
    const openable = entries.filter(([, c]) => c !== 'D').map(([r]) => r);
    return [
      openable.length > 0 && openable.length <= 10 && { key: 'open', label: openable.length === 1 ? 'Open' : `Open ${openable.length} files`, icon: 'file', run: () => openable.forEach((x) => actions.openDiskPath(fullPath(root, x))) },
      a.compare && { key: 'compare', label: 'Compare with the last commit', icon: 'compare', run: () => actions.compareWithHead(fullPath(root, a.compare)) },
      { separator: true },
      a.stage && { key: 'stage', label: `Stage ${pickedWords(a.stage)}`, icon: 'plus', disabled: busy, run: () => run({ op: 'stage', paths: a.stage }, 'stage').then((r) => after(section, r)) },
      a.unstage && { key: 'unstage', label: `Unstage ${pickedWords(a.unstage)}`, icon: 'undo', disabled: busy, run: () => run({ op: 'unstage', paths: a.unstage }, 'unstage').then((r) => after(section, r)) },
      a.stash && { key: 'stash', label: `Stash ${pickedWords(a.stash.paths)}…`, icon: 'archive', hint: a.stash.left ? 'not the files in conflict' : '', disabled: busy, run: () => startStash(section, a.stash) },
      a.discard && { key: 'discard', label: 'Discard changes…', icon: 'trash', danger: true, disabled: busy, hint: a.discard.left ? 'not the files in conflict' : '', run: () => discard(section, a.discard) },
      a.ignore && { separator: true },
      ...(a.ignore ? ignoreItems(section, a.ignore) : []),
      (a.skip || a.untrack) && { separator: true },
      (a.skip || a.untrack) && { heading: true, label: 'Files Git follows' },
      a.skip && { key: 'skip', label: 'Keep my changes out, on this computer only', icon: 'eyeOff', hint: 'skip-worktree', run: () => keepOut(section, a.skip) },
      a.untrack && { key: 'untrack', label: 'Stop tracking (keep the file)', icon: 'x', run: () => untrack(section, a.untrack, false) },
      a.untrack && { key: 'untrack-ignore', label: 'Stop tracking and add to .gitignore', icon: 'x', run: () => untrack(section, a.untrack, true) },
      { separator: true },
      { key: 'copy', label: rels.length === 1 ? 'Copy its path' : 'Copy their paths', icon: 'copy', run: () => navigator.clipboard?.writeText(rels.join('\n')).then(() => actions.toast(rels.length === 1 ? 'Path copied' : `${rels.length} paths copied`)) },
    ];
  };
  /** The bar's own buttons for the picked files. */
  const quickFor = (section) => (entries) => {
    const a = pickActions(section, entries);
    return html`${a.stage && html`<button type="button" class="btn ghost xs" disabled=${busy} title="Take them into the next commit" onClick=${() => run({ op: 'stage', paths: a.stage }, 'stage').then((r) => after(section, r))}>Stage</button>`}
      ${a.unstage && html`<button type="button" class="btn ghost xs" disabled=${busy} title="Leave them out of the next commit" onClick=${() => run({ op: 'unstage', paths: a.unstage }, 'unstage').then((r) => after(section, r))}>Unstage</button>`}
      ${a.stash && html`<button type="button" class="btn ghost xs" disabled=${busy} title="Put their changes aside, to bring them back later" onClick=${() => startStash(section, a.stash)}>Stash…</button>`}
      ${a.discard && html`<button type="button" class="btn ghost xs danger" disabled=${busy} title="Throw away their changes not staged (new files are deleted)" onClick=${() => discard(section, a.discard)}>Discard…</button>`}
      ${a.ignore && html`<${MenuButton} label="Ignore: in .gitignore, or on this computer only" icon="eyeOff" className="icon-btn sm" items=${() => ignoreItems(section, a.ignore)} />`}`;
  };
  const commit = async () => {
    const r = await run({ op: 'commit', message, amend }, 'commit');
    if (r.ok) {
      actions.toast(`${amend ? 'Amended' : 'Committed'}: ${firstLine(message) || 'the last commit'}`);
      setMessage('');
      setAmend(false);
    }
  };
  // The model writes the message from the staged diff (in the box as it comes; Esc or the button again stops it).
  const writeMessage = async () => {
    if (writing) return writing.abort();
    const controller = new AbortController();
    setWriting(controller);
    const before = message;
    const text = await actions.writeCommitMessage(dir, { signal: controller.signal, onToken: (t) => setMessage(t) });
    setWriting(null);
    setMessage(text ?? before);
    box.current?.focus();
  };
  /** Git with the model, about this repository (asking `question` at once). */
  const askModel = (question = null) => actions.gitAssist(dir, question ? { question } : null);
  const reconnect = async () => {
    await actions.reconnectServer(remoteParts(dir).id);
    load();
  };
  const toggleAmend = async (on) => {
    setAmend(on);
    if (on && !message.trim()) {
      const r = await bridge.act(dir, { op: 'last-message' });
      if (r?.ok) setMessage(r.result);
    }
  };

  const staged = Object.entries(status?.staged ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const unstaged = Object.entries(status?.unstaged ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const conflicts = unstaged.filter(([, c]) => c === 'C');
  const ready = canCommit(status) || (amend && !conflicts.length);
  const busy = Boolean(doing);
  const name = root ? baseName(root) : baseName(dir);

  return html`<aside class="panel git-panel" aria-label="Git">
    <div class="panel-head">
      <h2><${Icon} name="branch" size=${16} />Git<span class="muted small git-repo" title=${shownPath(root ?? dir)}>${name}</span>${conn && html`<span class="muted small git-where" title=${`Git runs on ${connLabel(conn)}, with its own Git and sign-ins`}>${connLabel(conn)}</span>`}</h2>
      <span class="spacer" />
      ${status && actions.gitHistory && html`<button type="button" class="icon-btn sm" aria-label="History" title="History: the commits with their graph, branches and tags" onClick=${() => actions.gitHistory(root ?? dir)}><${Icon} name="history" size=${15} /></button>`}
      ${status && html`<button type="button" class="icon-btn sm" aria-label="Ask the model about this repository" title="Ask the model: about this repository, or to do something in it" onClick=${() => askModel()}><${Icon} name="sparkle" size=${15} /></button>`}
      <button type="button" class="icon-btn sm" aria-label="Read again" title="Read again" disabled=${busy} onClick=${load}><${Icon} name="rotate" size=${15} /></button>
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body git-body">
      ${status === undefined && html`<p class="muted small">Reading…</p>`}
      ${status === null &&
      (offline
        ? html`<div class="git-none git-offline">
            <p class="small"><strong>${conn ? connLabel(conn) : 'The server'}</strong> is not connected${none?.message ? `: ${none.message}` : ''}.</p>
            <p><button type="button" class="btn sm primary" onClick=${reconnect}><${Icon} name="rotate" size=${14} />Connect</button></p>
          </div>`
        : none?.unsupported
        ? html`<div class="git-none"><p class="small">${none.unsupported}</p></div>`
        : none && none.installed === false
        ? html`<${GitMissing} dir=${dir} info=${none} actions=${actions} />`
        : html`<div class="git-none">
            <p class="small"><strong>${baseName(dir)}</strong> is not in a Git repository.</p>
            <p><button type="button" class="btn primary sm" onClick=${() => actions.gitInit(dir)}><${Icon} name="branch" size=${14} />Make it a Git repository…</button></p>
            <p class="muted small">Or open a file or a folder that is in one: the panel shows its repository.</p>
          </div>`)}
      ${status &&
      html`<div class="git-branch-row">
          <button type="button" class="btn sm git-branch-btn" disabled=${busy} title="Switch to another branch, or make one" onClick=${() => actions.chooseBranch(dir)}>
            <${Icon} name="branch" size=${14} /><span>${status.branch || 'no branch'}</span><${Icon} name="chevronDown" size=${12} />
          </button>
          ${(status.ahead > 0 || status.behind > 0) && html`<span class="git-ab small" title=${`${status.ahead} commit(s) to push, ${status.behind} to pull`}>↑${status.ahead} ↓${status.behind}</span>`}
          ${!status.upstream && status.branch && status.branch !== 'detached' && html`<span class="muted small" title="Push sends it to the remote and follows it from then on">not on the remote yet</span>`}
          <span class="spacer" />
          <button type="button" class="btn ghost sm" disabled=${busy} title="Fetch: see what is new on the remote, without changing your files" onClick=${() => run({ op: 'fetch' }, 'fetch')}><${Icon} name="sync" size=${14} />Fetch</button>
          <button type="button" class="btn ghost sm" disabled=${busy} title="Pull: bring the remote's commits into this branch" onClick=${() => run({ op: 'pull' }, 'pull')}><${Icon} name="download" size=${14} />Pull</button>
          <button type="button" class="btn ghost sm" disabled=${busy} title="Push: send this branch's commits to the remote" onClick=${() => run({ op: 'push' }, 'push')}><${Icon} name="upload" size=${14} />Push</button>
        </div>
        ${doing && html`<p class="git-progress small" role="status"><span class="spinner" aria-hidden="true" />${{ fetch: 'Fetching', pull: 'Pulling', push: 'Pushing', commit: 'Committing', switch: 'Switching' }[doing] ?? 'Working'}…${progress ? html` <span class="muted">${progress}</span>` : ''}</p>`}
        ${problem &&
        html`<div class="notice error git-problem" role="alert">
          <${Icon} name="alert" size=${16} />
          <span><strong>${problem.message}</strong>${problem.detail && html`<pre class="git-detail">${problem.detail}</pre>`}
            ${problem.kind === 'diverged' &&
            html`<span class="git-problem-actions">
              <button type="button" class="btn sm" onClick=${() => run({ op: 'pull', how: 'merge' }, 'pull')}>Pull, merging</button>
              <button type="button" class="btn sm" onClick=${() => run({ op: 'pull', how: 'rebase' }, 'pull')}>Pull, rebasing mine on top</button>
            </span>`}
            ${problem.kind === 'rejected' && html`<span class="git-problem-actions"><button type="button" class="btn sm" onClick=${() => run({ op: 'pull' }, 'pull')}>Pull first</button></span>`}
            ${problem.kind === 'offline' && conn && html`<span class="git-problem-actions"><button type="button" class="btn sm" onClick=${() => (setProblem(null), reconnect())}>Reconnect</button></span>`}
            ${problem.kind !== 'unsaved' && problem.kind !== 'offline' && html`<span class="git-problem-actions"><button type="button" class="btn ghost sm" title="The model looks at the repository and Git’s message, explains, and offers the steps to fix it" onClick=${() => askModel(`This failed in the Git panel: ${problem.action?.op ?? 'a Git command'}. Git said:\n${problem.message}${problem.detail ? `\n${problem.detail}` : ''}\nWhat happened, and how do I fix it?`)}><${Icon} name="sparkle" size=${13} />Ask the model</button></span>`}
          </span>
          <button type="button" class="icon-btn xs" aria-label="Dismiss" onClick=${() => setProblem(null)}><${Icon} name="x" size=${13} /></button>
        </div>`}
        ${inProgress &&
        html`<div class="notice git-in-progress">
          <${Icon} name="alert" size=${16} />
          <span>A ${inProgress} is halfway${conflicts.length ? `: ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} in conflict. Fix each (look for <<<<<<<), stage it, then commit` : ': commit to finish it'}, or abort it.</span>
          <span class="git-problem-actions">
            <button type="button" class="btn sm" disabled=${busy} onClick=${() => run({ op: 'abort', what: inProgress }, 'abort')}>Abort the ${inProgress}</button>
            ${!conflicts.length && html`<button type="button" class="btn sm primary" disabled=${busy} title=${inProgress === 'merge' ? 'Make the merge commit with Git’s message (the files as staged)' : `git ${inProgress} --continue: the next step, with the files as staged`}
              onClick=${() => run({ op: 'continue', what: inProgress }, 'continue').then((r) => r.ok && actions.toast(inProgress === 'merge' ? 'Merged: the merge commit is made.' : `The ${inProgress} went on.`))}>${inProgress === 'merge' ? 'Finish the merge' : `Continue the ${inProgress}`}</button>`}
            <button type="button" class="btn ghost sm" title="The model explains where things stand and walks you through finishing (or undoing) it" onClick=${() => askModel(`A ${inProgress} stopped halfway${conflicts.length ? ` with conflicts in ${conflicts.map(([r]) => r).join(', ')}` : ''}. Explain where things stand and help me finish it, or go back safely.`)}><${Icon} name="sparkle" size=${13} />Help me finish</button>
          </span>
        </div>`}
        <${ConflictsSection} root=${root} status=${status} inProgress=${inProgress} busy=${busy} run=${run} actions=${actions} />
        <div class="git-commit">
          <textarea ref=${box} rows="3" placeholder=${amend ? 'The last commit’s message (Ctrl+Enter amends)' : 'Message (Ctrl+Enter commits)'} value=${message} aria-label="Commit message"
            onInput=${(e) => setMessage(e.currentTarget.value)}
            onKeyDown=${(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ready && !busy) {
                e.preventDefault();
                commit();
              }
            }} />
          <div class="git-commit-row">
            <label class="small git-amend"><input type="checkbox" checked=${amend} onChange=${(e) => toggleAmend(e.currentTarget.checked)} />Amend the last commit</label>
            <span class="spacer" />
            <button type="button" class=${`icon-btn sm ${writing ? 'on' : ''}`} disabled=${busy || (!staged.length && !writing)} aria-label=${writing ? 'Stop writing the message' : 'Write the message with the model'}
              title=${writing ? 'Stop' : staged.length ? 'The model writes the message from what is staged' : 'Stage some changes first: the model writes the message from them'} onClick=${writeMessage}>
              <${Icon} name=${writing ? 'stop' : 'sparkle'} size=${15} />
            </button>
            <button type="button" class="btn primary sm" disabled=${busy || !ready || (!amend && !message.trim())}
              title=${conflicts.length ? 'Fix and stage the files in conflict first' : !staged.length && !amend ? 'Stage some changes first' : ''} onClick=${commit}>
              <${Icon} name="check" size=${14} />${amend ? 'Amend' : `Commit${staged.length ? ` ${staged.length}` : ''}`}
            </button>
          </div>
        </div>
        <${FileSection} id="staged" title="Staged" entries=${staged} picked=${picked.staged} setPicked=${(set) => setPicked('staged', set)} anchor=${anchors.staged}
          busy=${busy} root=${root} actions=${actions} onStage=${stageOne} items=${(e) => fileItems('staged', e)} quick=${quickFor('staged')}
          empty="Nothing staged: stage files here, from Folders, or one change at a time from the bar next to the line numbers."
          headButton=${staged.length > 0 && html`<button type="button" class="btn ghost xs" disabled=${busy} onClick=${() => run({ op: 'unstage-all' }, 'unstage')}>Unstage all</button>`}
          stashForm=${stashing?.section === 'staged' && html`<${StashForm} stashing=${stashing} setStashing=${setStashing} busy=${busy} onStash=${stashNow} />`} />
        <${FileSection} id="changes" title="Changes" entries=${unstaged} picked=${picked.changes} setPicked=${(set) => setPicked('changes', set)} anchor=${anchors.changes}
          busy=${busy} root=${root} actions=${actions} onStage=${stageOne} items=${(e) => fileItems('changes', e)} quick=${quickFor('changes')}
          empty="No changes since the last commit."
          headButton=${unstaged.length > 0 && html`<button type="button" class="btn ghost xs" disabled=${busy} onClick=${() => run({ op: 'stage-all' }, 'stage')}>Stage all</button>`}
          stashForm=${stashing?.section === 'changes' && html`<${StashForm} stashing=${stashing} setStashing=${setStashing} busy=${busy} onStash=${stashNow} />`} />
        <details class="git-section git-stash" open=${stashes.length > 0}>
          <summary class="git-section-head">Stash<span class="muted small">${stashes.length || ''}</span></summary>
          ${stashing && !stashing.section
            ? html`<${StashForm} stashing=${stashing} setStashing=${setStashing} busy=${busy} onStash=${stashNow} />`
            : html`<button type="button" class="btn sm git-stash-new" disabled=${busy || (!staged.length && !unstaged.length)} title="Put your changes aside (your files go back to the last commit), to bring them back later. To stash some files only, pick them above." onClick=${() => setStashing({ message: '', untracked: true })}><${Icon} name="archive" size=${14} />Stash changes…</button>`}
          ${stashes.map(
            (st) => html`<div class="git-stash-row" key=${st.ref}>
              <span class="git-stash-text" title=${`${st.ref} · ${st.message}`}>${st.message || st.ref}<span class="muted small"> · ${st.when}</span></span>
              <button type="button" class="btn ghost xs" disabled=${busy} title="Bring the changes back and drop it from the list" onClick=${() => run({ op: 'stash-pop', ref: st.ref }, 'stash')}>Pop</button>
              <button type="button" class="btn ghost xs" disabled=${busy} title="Bring the changes back, keep it in the list" onClick=${() => run({ op: 'stash-apply', ref: st.ref }, 'stash')}>Apply</button>
              <button type="button" class="btn ghost xs danger" disabled=${busy} title="Throw it away" onClick=${() => confirm(`Throw away “${st.message || st.ref}”? Its changes are lost.`) && run({ op: 'stash-drop', ref: st.ref }, 'stash')}>Drop</button>
            </div>`,
          )}
        </details>
        <${KeptOut} kept=${kept} busy=${busy} run=${run} />`}
    </div>
  </aside>`;
}

/**
 * What only this computer leaves out of Git, never shared: tracked files whose changes are kept
 * out (skip-worktree: Git acts as if they were unchanged) and the patterns of .git/info/exclude.
 * Each can be taken back.
 */
function KeptOut({ kept, busy, run }) {
  if (!kept) return null;
  const count = kept.skipped.length + kept.patterns.length;
  return html`<details class="git-section git-kept" open=${count > 0}>
    <summary class="git-section-head">Kept out on this computer<span class="muted small">${count || ''}</span></summary>
    <p class="muted small git-kept-help">Only here, never committed or shared. Files whose changes you keep out look unchanged to Git; a pull that changes one of them stops until you follow it again.</p>
    ${kept.skipped.map(
      (rel) => html`<div class="git-kept-row" key=${`s:${rel}`}>
        <${FileIcon} name=${baseName(rel)} size=${14} />
        <span class="git-kept-text" title=${`${rel}: your changes are kept out (skip-worktree)`}>${baseName(rel)} <span class="muted small">${folderOfRel(rel)}</span></span>
        <button type="button" class="btn ghost xs" disabled=${busy} title="Git sees your changes to it again" onClick=${() => run({ op: 'skip', paths: [rel], on: false }, 'skip')}>Follow again</button>
      </div>`,
    )}
    ${kept.patterns.map(
      (pattern) => html`<div class="git-kept-row" key=${`p:${pattern}`}>
        <${Icon} name="eyeOff" size=${14} />
        <code class="git-kept-text" title=${`${pattern} in .git/info/exclude`}>${pattern}</code>
        <button type="button" class="btn ghost xs" disabled=${busy} title="Take it out of .git/info/exclude" onClick=${() => run({ op: 'unignore', patterns: [pattern], where: 'local' }, 'ignore')}>Stop ignoring</button>
      </div>`,
    )}
    ${!count && html`<p class="muted small git-empty">Nothing yet. Pick new files and ignore them on this computer only, or changed files to keep your changes out.</p>`}
  </details>`;
}

/**
 * The status bar's branch (and the panel's): the branches here (the current one marked, with
 * what is to push and pull), the remote ones not here yet (switching to one makes a local
 * branch that follows it), and a new branch from the current one.
 */
export function BranchDialog({ dir, actions, onClose }) {
  const bridge = window.desktop?.git;
  const [branches, setBranches] = useState(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(null); // the new branch's name, while typing
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    bridge.act(dir, { op: 'branches' }).then((r) => setBranches(r?.ok ? r.result : { local: [], remote: [] }));
  }, [dir]);
  const go = async (action) => {
    setBusy(true);
    setProblem(null);
    const r = await actions.gitRun(dir, action);
    setBusy(false);
    if (!r.ok) return setProblem(r.error);
    actions.toast(`On ${action.track ? action.name.slice(action.name.indexOf('/') + 1) : action.name} now`);
    onClose();
  };
  const f = filter.trim().toLowerCase();
  const local = (branches?.local ?? []).filter((b) => !f || b.name.toLowerCase().includes(f));
  const here = new Set((branches?.local ?? []).map((b) => b.name));
  const remote = (branches?.remote ?? []).filter((b) => !here.has(b.branch) && (!f || b.name.toLowerCase().includes(f)));
  const current = branches?.local.find((b) => b.current)?.name ?? '';
  const nameProblem = creating !== null ? branchNameProblem(creating) || (here.has(creating) ? 'There is a branch with that name already.' : '') : '';
  return html`<${Modal} title="Branches" onClose=${onClose} className="branch-dialog">
    <input class="branch-filter" placeholder="Find a branch" value=${filter} aria-label="Find a branch" onInput=${(e) => setFilter(e.currentTarget.value)} autofocus />
    ${problem && html`<p class="notice error small" role="alert"><${Icon} name="alert" size=${14} /><span>${problem.message}${problem.detail ? html`<pre class="git-detail">${problem.detail}</pre>` : ''}</span></p>`}
    ${!branches && html`<p class="muted small">Reading…</p>`}
    ${branches &&
    html`<div class="branch-list" role="list">
      ${local.map(
        (b) => html`<button type="button" role="listitem" class=${`branch-row${b.current ? ' current' : ''}`} disabled=${busy || b.current} key=${b.name}
          title=${b.current ? 'The branch you are on' : `Switch to ${b.name}`} onClick=${() => go({ op: 'switch', name: b.name })}>
          <${Icon} name=${b.current ? 'check' : 'branch'} size=${14} /><span class="branch-name">${b.name}</span>
          ${(b.ahead > 0 || b.behind > 0) && html`<span class="git-ab small">↑${b.ahead} ↓${b.behind}</span>`}
          ${b.gone && html`<span class="muted small" title="Its branch on the remote was deleted">gone on the remote</span>`}
          <span class="spacer" /><span class="muted small">${b.when}</span>
        </button>`,
      )}
      ${remote.length > 0 && html`<p class="branch-group muted small">On the remote only</p>`}
      ${remote.map(
        (b) => html`<button type="button" role="listitem" class="branch-row remote" disabled=${busy} key=${b.name} title=${`A branch here that follows ${b.name}`} onClick=${() => go({ op: 'switch', name: b.name, track: true })}>
          <${Icon} name="cloud" size=${14} /><span class="branch-name">${b.name}</span><span class="spacer" /><span class="muted small">${b.when}</span>
        </button>`,
      )}
      ${!local.length && !remote.length && html`<p class="muted small">No branch named like that.</p>`}
    </div>`}
    ${creating === null
      ? html`<button type="button" class="btn sm" disabled=${!branches} onClick=${() => setCreating(f.replace(/\s+/g, '-'))}><${Icon} name="plus" size=${14} />New branch from ${current || 'here'}…</button>`
      : html`<form class="branch-new" onSubmit=${(e) => {
          e.preventDefault();
          if (!nameProblem) go({ op: 'switch', name: creating, create: true });
        }}>
          <label class="field"><span class="field-label">New branch, from ${current || 'here'} (your changes come along)</span>
            <input value=${creating} placeholder="feature/login" spellcheck="false" autocomplete="off" onInput=${(e) => setCreating(e.currentTarget.value)} autofocus />
          </label>
          ${creating && nameProblem && html`<p class="small error-text">${nameProblem}</p>`}
          <span class="field-row"><button type="submit" class="btn primary sm" disabled=${busy || Boolean(nameProblem)}>Make it and switch</button><button type="button" class="btn ghost sm" onClick=${() => setCreating(null)}>Cancel</button></span>
        </form>`}
    ${creating === null && actions.gitHistory && html`<button type="button" class="btn ghost sm branch-history" onClick=${() => (onClose(), actions.gitHistory(dir))}><${Icon} name="history" size=${14} />History: the commits of every branch</button>`}
  </${Modal}>`;
}

const sameFolder = (a, b) => {
  const n = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(String(a)) ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};
const errorText = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/**
 * Making a folder a Git repository (git init, here or with the git of the server or place it is
 * on): the first branch's name (the person's init.defaultBranch, else main). A folder inside
 * another repository says so first (a second repository for the same files); one that is a
 * repository already offers its panel; Git missing there offers its install command.
 */
export function GitInitDialog({ dir, actions, onClose }) {
  const bridge = window.desktop?.git;
  const [info, setInfo] = useState(undefined); // undefined: reading; { installed, root, defaultBranch } or { error }
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    bridge.info(dir).then(
      (i) => {
        setInfo(i ?? { error: 'Git does not work for this folder.' });
        if (i?.defaultBranch) setBranch(i.defaultBranch);
      },
      (err) => setInfo({ error: errorText(err) }),
    );
  }, [dir]);
  const name = baseName(dir);
  const already = Boolean(info?.root) && sameFolder(info.root, dir);
  const inside = info?.root && !already ? info.root : null;
  const ready = Boolean(info?.installed) && !already;
  const nameProblem = branchNameProblem(branch.trim());
  const make = async (ev) => {
    ev.preventDefault();
    if (!ready || nameProblem || busy) return;
    setBusy(true);
    setProblem('');
    try {
      const made = await bridge.init(dir, { branch: branch.trim() });
      onClose();
      actions.gitMade(dir, made);
    } catch (err) {
      setProblem(errorText(err));
      setBusy(false);
    }
  };
  return html`<${Modal} title=${`Make ${name} a Git repository`} onClose=${onClose} className="git-init-dialog"
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>${ready ? 'Cancel' : 'Close'}</button>
      ${ready && html`<button type="submit" form="git-init-form" class="btn primary" disabled=${busy || Boolean(nameProblem)}>${busy ? 'Making it…' : 'Make it a repository'}</button>`}`}>
    ${info === undefined && html`<p class="muted small">Looking at the folder…</p>`}
    ${info?.error && html`<p class="notice error" role="alert"><${Icon} name="alert" size=${15} /><span>${info.error}</span></p>`}
    ${info?.offline && html`<p class="notice error" role="alert"><${Icon} name="alert" size=${15} /><span>${connOf(dir) ? connLabel(connOf(dir)) : 'The server'} is not connected${info.message ? `: ${info.message}` : ''}. Connect again, then try again.</span></p>`}
    ${info?.unsupported && html`<p class="notice"><${Icon} name="info" size=${15} /><span>${info.unsupported}</span></p>`}
    ${info && !info.error && !info.offline && !info.unsupported && !info.installed &&
    (connOf(dir)
      ? html`<${GitMissing} dir=${dir} info=${info} actions=${{ ...actions, typeInTerminal: (...args) => (onClose(), actions.typeInTerminal(...args)) }} />`
      : html`<p class="notice"><${Icon} name="info" size=${15} /><span>Git is not installed on this computer. Install it from <a href="https://git-scm.com/downloads" target="_blank" rel="noopener">git-scm.com</a>, then try again.</span></p>`)}
    ${already &&
    html`<p class="notice"><${Icon} name="info" size=${15} /><span>${name} is a Git repository already.</span></p>
      <p><button type="button" class="btn sm" onClick=${() => (onClose(), actions.toggleGit(dir))}><${Icon} name="branch" size=${14} />Open its Git panel</button></p>`}
    ${ready &&
    html`<form id="git-init-form" class="git-init-form" onSubmit=${make}>
      <p class="small">Git starts keeping the history of <strong>${name}</strong> <bdi class="muted">(${shownPath(dir)})</bdi>${connOf(dir) ? `, with the Git of ${connLabel(connOf(dir))}` : ''}. No file changes and nothing is committed yet: stage and commit its files in the Git panel next.</p>
      ${inside &&
      html`<p class="notice warn"><${Icon} name="alert" size=${15} /><span>${name} is inside the repository <strong>${baseName(inside)}</strong> <bdi>(${shownPath(inside)})</bdi>. A repository here is a second one for the same files, and ${baseName(inside)} may still follow them: usually you want its Git panel instead.
        <button type="button" class="btn ghost xs" onClick=${() => (onClose(), actions.toggleGit(inside))}>Open ${baseName(inside)}’s Git panel</button></span></p>`}
      <label class="field"><span class="field-label">The first branch’s name</span>
        <input value=${branch} spellcheck="false" autocomplete="off" aria-invalid=${Boolean(nameProblem)} onInput=${(e) => setBranch(e.currentTarget.value)} autofocus />
      </label>
      ${nameProblem && html`<p class="small error-text">${nameProblem}</p>`}
      ${problem && html`<p class="notice error small" role="alert"><${Icon} name="alert" size=${14} /><span>${problem}</span></p>`}
    </form>`}
  </${Modal}>`;
}
