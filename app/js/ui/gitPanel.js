// Git that writes (desktop, folders on this computer): the Git panel (Ctrl+Shift+G) and the
// branch picker (the status bar's branch). The panel shows the repository the open file or the
// folder in Folders is in: its branch, fetch / pull / push with Git's progress, a commit box
// (amend too), the changes staged and not staged (stage or unstage each, or all), what is in
// the middle of a merge or rebase, and the stash. Every command goes through
// actions.gitRun (the main process's git:act), which also says when unsaved tabs are in the way.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { GIT_LABELS, branchNameProblem, canCommit } from '../gitStatus.js';
import { Modal } from './components.js';
import { FileIcon } from './fileIcon.js';
import { Icon } from './icons.js';

const baseName = (p) => String(p).split(/[\\/]/).pop();
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
  const box = useRef(null);

  const load = async () => {
    const s = await bridge.status(dir).catch(() => null);
    setStatus(s);
    if (!s) return;
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
      <h2><${Icon} name="branch" size=${16} />Git<span class="muted small git-repo" title=${root ?? dir}>${name}</span></h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Read again" title="Read again" disabled=${busy} onClick=${load}><${Icon} name="rotate" size=${15} /></button>
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body git-body">
      ${status === undefined && html`<p class="muted small">Reading…</p>`}
      ${status === null && html`<p class="muted small">${baseName(dir)} is not in a Git repository (or Git is not installed on this computer). Open a file or a folder that is, and the panel shows its repository.</p>`}
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
          </span>
          <button type="button" class="icon-btn xs" aria-label="Dismiss" onClick=${() => setProblem(null)}><${Icon} name="x" size=${13} /></button>
        </div>`}
        ${inProgress &&
        html`<div class="notice git-in-progress">
          <${Icon} name="alert" size=${16} />
          <span>A ${inProgress} is halfway${conflicts.length ? `: ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} in conflict. Fix each (look for <<<<<<<), stage it, then commit` : ': commit to finish it'}, or abort it.</span>
          <button type="button" class="btn sm" disabled=${busy} onClick=${() => run({ op: 'abort', what: inProgress }, 'abort')}>Abort the ${inProgress}</button>
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
