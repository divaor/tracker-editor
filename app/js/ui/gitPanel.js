// Git that writes (desktop: folders on this computer, on SSH servers and in places, Docker
// containers and WSL distributions, with the git there): the Git panel (Ctrl+Shift+G) and the
// branch picker (the status bar's branch). The panel shows the repository the open file or the
// folder in Folders is in: its branch, fetch / pull / push with Git's progress, a commit box
// (amend too), the changes staged and not staged (stage or unstage each, or all), what is in
// the middle of a merge or rebase, and the stash. Every command goes through
// actions.gitRun (the main process's git:act), which also says when unsaved tabs are in the way.
// A server not connected says so (Connect); Git missing there offers the command that installs
// it, typed into that place's terminal (never run by itself).
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { GIT_LABELS, branchNameProblem, canCommit, mergeRequestLink } from '../gitStatus.js';
import { server } from '../servers.js';
import { connLabel, isRemotePath, remoteParts } from '../where.js';
import { Modal } from './components.js';
import { FileIcon } from './fileIcon.js';
import { Icon } from './icons.js';

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

function FileRow({ rel, code, root, staged, busy, actions, onStage }) {
  const path = fullPath(root, rel);
  const gone = code === 'D';
  return html`<div class=${`git-file code-${code}`}>
    <button type="button" class="git-file-name" disabled=${gone} title=${`${rel} · ${GIT_LABELS[code] ?? code}${gone ? '' : ' · click to open'}`} onClick=${() => actions.openDiskPath(path)}>
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
    const [st, ip] = await Promise.all([bridge.act(dir, { op: 'stashes' }), bridge.act(dir, { op: 'in-progress' })]);
    setStashes(st?.ok ? st.result : []);
    setInProgress(ip?.ok ? ip.result : null);
  };
  useEffect(() => {
    load();
  }, [dir, tick]);
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
            <button type="button" class="btn ghost sm" title="The model explains where things stand and walks you through finishing (or undoing) it" onClick=${() => askModel(`A ${inProgress} stopped halfway${conflicts.length ? ` with conflicts in ${conflicts.map(([r]) => r).join(', ')}` : ''}. Explain where things stand and help me finish it, or go back safely.`)}><${Icon} name="sparkle" size=${13} />Help me finish</button>
          </span>
        </div>`}
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
        <section class="git-section">
          <h3 class="git-section-head">Staged<span class="muted small">${staged.length || ''}</span><span class="spacer" />
            ${staged.length > 0 && html`<button type="button" class="btn ghost xs" disabled=${busy} onClick=${() => run({ op: 'unstage-all' }, 'unstage')}>Unstage all</button>`}
          </h3>
          ${staged.length ? staged.map(([rel, code]) => html`<${FileRow} key=${`s:${rel}`} rel=${rel} code=${code} root=${root} staged busy=${busy} actions=${actions} onStage=${stageOne} />`) : html`<p class="muted small git-empty">Nothing staged: stage files here, from Folders, or one change at a time from the bar next to the line numbers.</p>`}
        </section>
        <section class="git-section">
          <h3 class="git-section-head">Changes<span class="muted small">${unstaged.length || ''}</span><span class="spacer" />
            ${unstaged.length > 0 && html`<button type="button" class="btn ghost xs" disabled=${busy} onClick=${() => run({ op: 'stage-all' }, 'stage')}>Stage all</button>`}
          </h3>
          ${unstaged.length ? unstaged.map(([rel, code]) => html`<${FileRow} key=${`u:${rel}`} rel=${rel} code=${code} root=${root} busy=${busy} actions=${actions} onStage=${stageOne} />`) : html`<p class="muted small git-empty">No changes since the last commit.</p>`}
        </section>
        <details class="git-section git-stash" open=${stashes.length > 0}>
          <summary class="git-section-head">Stash<span class="muted small">${stashes.length || ''}</span></summary>
          ${stashing
            ? html`<form class="git-stash-form" onSubmit=${async (e) => {
                e.preventDefault();
                const r = await run({ op: 'stash', message: stashing.message, untracked: stashing.untracked }, 'stash');
                if (r.ok) setStashing(null);
              }}>
                <input value=${stashing.message} placeholder="What it is (optional)" aria-label="Stash message" onInput=${(e) => setStashing({ ...stashing, message: e.currentTarget.value })} />
                <label class="small"><input type="checkbox" checked=${stashing.untracked} onChange=${(e) => setStashing({ ...stashing, untracked: e.currentTarget.checked })} />New files too</label>
                <span class="git-stash-buttons"><button type="submit" class="btn sm primary" disabled=${busy}>Stash</button><button type="button" class="btn sm ghost" onClick=${() => setStashing(null)}>Cancel</button></span>
              </form>`
            : html`<button type="button" class="btn sm git-stash-new" disabled=${busy || (!staged.length && !unstaged.length)} title="Put your changes aside (your files go back to the last commit), to bring them back later" onClick=${() => setStashing({ message: '', untracked: true })}><${Icon} name="archive" size=${14} />Stash changes…</button>`}
          ${stashes.map(
            (st) => html`<div class="git-stash-row" key=${st.ref}>
              <span class="git-stash-text" title=${`${st.ref} · ${st.message}`}>${st.message || st.ref}<span class="muted small"> · ${st.when}</span></span>
              <button type="button" class="btn ghost xs" disabled=${busy} title="Bring the changes back and drop it from the list" onClick=${() => run({ op: 'stash-pop', ref: st.ref }, 'stash')}>Pop</button>
              <button type="button" class="btn ghost xs" disabled=${busy} title="Bring the changes back, keep it in the list" onClick=${() => run({ op: 'stash-apply', ref: st.ref }, 'stash')}>Apply</button>
              <button type="button" class="btn ghost xs danger" disabled=${busy} title="Throw it away" onClick=${() => confirm(`Throw away “${st.message || st.ref}”? Its changes are lost.`) && run({ op: 'stash-drop', ref: st.ref }, 'stash')}>Drop</button>
            </div>`,
          )}
        </details>`}
    </div>
  </aside>`;
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
