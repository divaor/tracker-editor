import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { isRemotePath, remoteParts } from '../where.js';
import { server } from '../servers.js';
import { Icon } from './icons.js';
import { ClearButton } from './components.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const plural = (n, what, many = `${what}s`) => `${n.toLocaleString()} ${n === 1 ? what : many}`;
const folderName = (dir) => (isRemotePath(dir) ? remoteParts(dir).path : dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '/';

function Highlight({ text, at, length }) {
  return html`${text.slice(0, at)}<mark>${text.slice(at, at + length)}</mark>${text.slice(at + length)}`;
}

/**
 * Find in a folder and the folders inside it (desktop), on this computer or on a
 * server. It runs when you press Enter, file by file, and can be stopped; what it
 * finds opens as files on disk, at the line. Another folder mounts a new panel (key).
 */
export function FolderSearchPanel({ dir, actions, onClose }) {
  const bridge = window.desktop.folders;
  const [query, setQuery] = useState(() => {
    const selected = actions.selectionText?.() ?? '';
    return selected && !selected.includes('\n') && selected.length < 120 ? selected : '';
  });
  const [options, setOptions] = useState({ caseSensitive: false, wholeWord: false, regex: false });
  const [files, setFiles] = useState('');
  const [hidden, setHidden] = useState(false);
  const [run, setRun] = useState(null); // { id, results, stats, done, error }
  const [collapsed, setCollapsed] = useState(() => new Set());
  const current = useRef(null);
  const input = useRef(null);
  current.current = run;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    return bridge.onFound((m) => {
      if (m.searchId !== current.current?.id) return;
      if (m.type === 'found') setRun((r) => r && r.id === m.searchId && { ...r, results: [...r.results, m.file] });
      else setRun((r) => r && r.id === m.searchId && { ...r, stats: m.stats });
    });
  }, []);
  useEffect(() => () => current.current && !current.current.done && bridge.stopFind(current.current.id), []);

  const start = () => {
    if (!query) return;
    if (run && !run.done) bridge.stopFind(run.id);
    const id = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setCollapsed(new Set());
    setRun({ id, results: [], stats: null, done: false, error: '' });
    bridge.find(id, dir, query, { ...options, files, hidden }).then(
      (stats) => setRun((r) => r && r.id === id && { ...r, stats, done: true }),
      (err) => setRun((r) => r && r.id === id && { ...r, done: true, error: message(err) }),
    );
  };
  const stop = () => run && !run.done && bridge.stopFind(run.id);
  const toggle = (key) => setOptions({ ...options, [key]: !options[key] });
  const open = (file, m = file.matches[0]) => actions.openDiskPath(file.path, { line: m?.line, column: m?.column, length: m?.length });
  const openAll = async () => {
    for (const f of run.results.slice(0, 30)) await actions.openDiskPath(f.path, { report: false });
    if (run.results[0]) open(run.results[0]);
  };

  const stats = run?.stats;
  const where = isRemotePath(dir) ? `${server(remoteParts(dir).id)?.name ?? 'Server'}: ${remoteParts(dir).path}` : dir;
  const total = (run?.results ?? []).reduce((n, f) => n + f.count, 0);
  const skipped = stats ? [stats.skipped.large && `${plural(stats.skipped.large, 'large file')}`, stats.skipped.binary && `${stats.skipped.binary.toLocaleString()} not text`, stats.skipped.unreadable && `${stats.skipped.unreadable.toLocaleString()} unreadable`].filter(Boolean) : [];

  return html`<aside class="panel search-panel folder-search" aria-label="Find in a folder">
    <div class="panel-head">
      <h2><${Icon} name="search" size=${16} />Find in ${folderName(dir)}</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body">
      <p class="muted small folder-search-where ${isRemotePath(dir) ? 'kind-remote' : 'kind-disk'}" title=${where}><${Icon} name=${isRemotePath(dir) ? 'server' : 'folder'} size=${14} />${where}</p>
      <form class="search-box" onSubmit=${(e) => (e.preventDefault(), start())}>
        <input ref=${input} value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} placeholder="Find in these files… (Enter)" aria-label="Find in this folder"
          onKeyDown=${(e) => e.key === 'Escape' && (run && !run.done ? stop() : onClose())} />
        <${ClearButton} value=${query} onClear=${() => setQuery('')} label="Clear the search" />
        <div class="search-options" role="group" aria-label="Options">
          <button type="button" class="opt ${options.caseSensitive ? 'on' : ''}" aria-pressed=${options.caseSensitive} title="Match case" onClick=${() => toggle('caseSensitive')}>Aa</button>
          <button type="button" class="opt ${options.wholeWord ? 'on' : ''}" aria-pressed=${options.wholeWord} title="Whole word" onClick=${() => toggle('wholeWord')}><u>ab</u></button>
          <button type="button" class="opt ${options.regex ? 'on' : ''}" aria-pressed=${options.regex} title="Regular expression" onClick=${() => toggle('regex')}>.*</button>
        </div>
      </form>
      <div class="folder-search-filters">
        <input value=${files} onInput=${(e) => setFiles(e.currentTarget.value)} placeholder="Files: *.js, *.md, !*.min.js" aria-label="Only these files"
          title="Which files: patterns like *.log, a ! in front leaves them out" onKeyDown=${(e) => e.key === 'Enter' && start()} />
        <label class="check-inline" title="Also files and folders whose names start with a dot"><input type="checkbox" checked=${hidden} onChange=${(e) => setHidden(e.currentTarget.checked)} />Hidden</label>
        ${run && !run.done
          ? html`<button type="button" class="btn sm" onClick=${stop}><${Icon} name="stop" size=${14} />Stop</button>`
          : html`<button type="button" class="btn sm primary" disabled=${!query} onClick=${start}>Find</button>`}
      </div>
      ${run?.error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${run.error}</p>`}
      ${run && !run.error &&
      html`<p class="muted small search-summary" aria-live="polite">
        ${!run.done
          ? `Searching… ${plural(stats?.scanned ?? 0, 'file')} read${run.results.length ? `, ${plural(total, 'match', 'matches')} in ${plural(run.results.length, 'file')}` : ''}`
          : `${total ? `${plural(total, 'match', 'matches')} in ${plural(run.results.length, 'file')}` : 'No matches'} · ${plural(stats?.scanned ?? 0, 'file')} searched${stats?.stopped ? ' (stopped)' : ''}`}
        ${run.done && skipped.length ? html`<br />Left out: ${skipped.join(', ')}.` : ''}
        ${run.done && stats?.truncated ? html`<br />It stopped there: too many files. Narrow it with “Files”, or search a folder further in.` : ''}
      </p>`}
      ${run?.results.length > 1 &&
      html`<div class="search-open" role="group" aria-label="Open the files found">
        <button type="button" class="btn ghost sm" onClick=${openAll}>Open ${run.results.length > 30 ? 'the first 30' : `all ${run.results.length}`}</button>
        <span class="spacer" />
        <button type="button" class="icon-btn sm" title="Only the file names" aria-label="Collapse all" onClick=${() => setCollapsed(collapsed.size ? new Set() : new Set(run.results.map((f) => f.path)))}><${Icon} name="list" size=${15} /></button>
      </div>`}
      <div class="search-results">
        ${run?.results.map(
          (f) => html`<div class="result-file" key=${f.path}>
            <div class="result-head">
              <button type="button" class="result-toggle" aria-expanded=${!collapsed.has(f.path)} title=${f.name} onClick=${() =>
                setCollapsed((c) => {
                  const next = new Set(c);
                  next.has(f.path) ? next.delete(f.path) : next.add(f.path);
                  return next;
                })}>
                <${Icon} name="chevronDown" size=${14} class=${collapsed.has(f.path) ? 'collapsed' : ''} />
                <span class="result-name">${f.name}</span><span class="count">${f.count}</span>
              </button>
              <button type="button" class="icon-btn sm result-open" aria-label=${`Open ${f.name}`} title="Open this file" onClick=${() => open(f)}><${Icon} name="external" size=${14} /></button>
            </div>
            ${!collapsed.has(f.path) &&
            f.matches.map(
              (m) => html`<button type="button" class="result-line" key=${m.line} onClick=${() => open(f, m)}>
                <span class="line-no">${m.line}</span>
                <span class="line-text">${m.prefix ? '…' : ''}<${Highlight} text=${m.preview} at=${m.at} length=${m.length} /></span>
              </button>`,
            )}
          </div>`,
        )}
      </div>
    </div>
  </aside>`;
}
