import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { isRemotePath, remoteParts } from '../where.js';
import { server } from '../servers.js';
import { Icon } from './icons.js';
import { ClearButton, toast } from './components.js';
import { replaceAll } from '../replace.js';
import { store } from '../store.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const plural = (n, what, many = `${what}s`) => `${n.toLocaleString()} ${n === 1 ? what : many}`;
const folderName = (dir) => (isRemotePath(dir) ? remoteParts(dir).path : dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '/';

function Highlight({ text, at, length, instead = null }) {
  const found = text.slice(at, at + length);
  // With Replace: the match struck out and what takes its place.
  if (instead !== null) return html`${text.slice(0, at)}<del>${found}</del><ins>${instead}</ins>${text.slice(at + length)}`;
  return html`${text.slice(0, at)}<mark>${found}</mark>${text.slice(at + length)}`;
}

// What one match turns into (for the preview; the files themselves are replaced whole).
const insteadOf = (found, query, options, replacement) => {
  try {
    return replaceAll(found, query, options, replacement).text;
  } catch {
    return replacement;
  }
};

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
  // Replace: shown or not, what to put instead, the files left out, and what was done.
  const [replacing, setReplacing] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [leftOut, setLeftOut] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [replaced, setReplaced] = useState(null); // { total, files, skipped }
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
    setLeftOut(new Set());
    setReplaced(null);
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

  // Replace in every file found (and ticked): files open with unsaved edits are left alone.
  const chosen = (run?.results ?? []).filter((f) => !leftOut.has(f.path));
  const replaceAllFiles = async () => {
    if (!run?.done || !chosen.length || busy) return;
    const unsaved = chosen.filter((f) => store.diskTab(f.path)?.dirty);
    const paths = chosen.filter((f) => !unsaved.includes(f)).map((f) => f.path);
    if (!paths.length) return toast('Those files have unsaved edits: save them first.', { kind: 'error' });
    setBusy(true);
    try {
      const result = await bridge.replace(dir, query, options, replacement, paths);
      const skipped = [...result.skipped, ...unsaved.map((f) => ({ path: f.path, reason: 'unsaved edits' }))];
      setReplaced({ total: result.total, files: result.files.length, skipped });
      // Open tabs show the new text (they had no edits of their own).
      for (const f of result.files) if (store.diskTab(f.path)) await actions.reloadDisk(f.path);
      const done = new Set(result.files.map((f) => f.path));
      setRun((r) => r && { ...r, results: r.results.filter((f) => !done.has(f.path)) });
      if (result.total) {
        toast(`Replaced ${plural(result.total, 'match', 'matches')} in ${plural(result.files.length, 'file')}`, {
          timeout: 15000,
          action: result.id && {
            label: 'Undo',
            run: async () => {
              try {
                const back = await bridge.replaceUndo(result.id);
                for (const p of back.restored) if (store.diskTab(p)) await actions.reloadDisk(p);
                toast(back.skipped.length ? `Put back ${plural(back.restored.length, 'file')}; ${plural(back.skipped.length, 'file')} changed since, left as they are.` : `Put back ${plural(back.restored.length, 'file')}.`);
                start();
              } catch (err) {
                toast(message(err), { kind: 'error' });
              }
            },
          },
        });
      }
    } catch (err) {
      toast(message(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const tick = (path) =>
    setLeftOut((s) => {
      const next = new Set(s);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

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
      <form class="search-box ${replacing ? 'with-replace' : ''}" onSubmit=${(e) => (e.preventDefault(), start())}>
        <button type="button" class="opt replace-toggle ${replacing ? 'on' : ''}" aria-pressed=${replacing} aria-label="Replace" title="Replace in the files found"
          onClick=${() => setReplacing(!replacing)}><${Icon} name="chevronRight" size=${14} class=${replacing ? 'open' : ''} /></button>
        <input ref=${input} value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} placeholder="Find in these files… (Enter)" aria-label="Find in this folder"
          onKeyDown=${(e) => e.key === 'Escape' && (run && !run.done ? stop() : onClose())} />
        <${ClearButton} value=${query} onClear=${() => setQuery('')} label="Clear the search" />
        <div class="search-options" role="group" aria-label="Options">
          <button type="button" class="opt ${options.caseSensitive ? 'on' : ''}" aria-pressed=${options.caseSensitive} title="Match case" onClick=${() => toggle('caseSensitive')}>Aa</button>
          <button type="button" class="opt ${options.wholeWord ? 'on' : ''}" aria-pressed=${options.wholeWord} title="Whole word" onClick=${() => toggle('wholeWord')}><u>ab</u></button>
          <button type="button" class="opt ${options.regex ? 'on' : ''}" aria-pressed=${options.regex} title="Regular expression" onClick=${() => toggle('regex')}>.*</button>
        </div>
      </form>
      ${replacing &&
      html`<div class="search-box replace-box">
        <input value=${replacement} onInput=${(e) => setReplacement(e.currentTarget.value)} placeholder=${options.regex ? 'Replace with… ($1 for a group, \\n for a new line)' : 'Replace with…'} aria-label="Replace with"
          onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), replaceAllFiles())} />
        <button type="button" class="btn sm ${run?.done && chosen.length ? 'primary' : ''}" disabled=${!run?.done || !chosen.length || busy} onClick=${replaceAllFiles}
          title="Replace in the files found and ticked (those open with unsaved edits are left out)">
          <${Icon} name="replace" size=${14} />${busy ? 'Replacing…' : run?.done && chosen.length ? `Replace in ${plural(chosen.length, 'file')}` : 'Replace'}
        </button>
      </div>`}
      <div class="folder-search-filters">
        <input value=${files} onInput=${(e) => setFiles(e.currentTarget.value)} placeholder="Files: *.js, *.md, !*.min.js" aria-label="Only these files"
          title="Which files: patterns like *.log, a ! in front leaves them out" onKeyDown=${(e) => e.key === 'Enter' && start()} />
        <label class="check-inline" title="Also files and folders whose names start with a dot"><input type="checkbox" checked=${hidden} onChange=${(e) => setHidden(e.currentTarget.checked)} />Hidden</label>
        ${run && !run.done
          ? html`<button type="button" class="btn sm" onClick=${stop}><${Icon} name="stop" size=${14} />Stop</button>`
          : html`<button type="button" class="btn sm primary" disabled=${!query} onClick=${start}>Find</button>`}
      </div>
      ${run?.error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${run.error}</p>`}
      ${replaced &&
      html`<p class="muted small replace-summary" aria-live="polite">
        Replaced ${plural(replaced.total, 'match', 'matches')} in ${plural(replaced.files, 'file')}.
        ${replaced.skipped.length > 0 && html`<br />Left as they were: ${replaced.skipped.map((x) => `${x.path.split(/[\\/]/).pop()} (${x.reason})`).join(', ')}.`}
      </p>`}
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
              ${replacing && html`<input type="checkbox" class="result-pick" checked=${!leftOut.has(f.path)} aria-label=${`Replace in ${f.name}`} onChange=${() => tick(f.path)} />`}
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
                <span class="line-text">${m.prefix ? '…' : ''}<${Highlight} text=${m.preview} at=${m.at} length=${m.length}
                  instead=${replacing && !leftOut.has(f.path) ? insteadOf(m.preview.slice(m.at, m.at + m.length), query, options, replacement) : null} /></span>
              </button>`,
            )}
          </div>`,
        )}
      </div>
    </div>
  </aside>`;
}
