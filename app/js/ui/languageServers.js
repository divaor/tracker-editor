import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { serverLabel, whereLabel } from '../lspTools.js';
import { Modal } from './components.js';
import { FileIcon } from './fileIcon.js';
import { Icon } from './icons.js';

const baseName = (p) => String(p).split(/[\\/]/).pop();

/**
 * The language servers running (desktop): which, for which folder, their state and their
 * messages (what they print), with Restart and Stop. For when something goes wrong.
 */
export function LanguageServersPanel({ lsp, tick, actions, onClose }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    let live = true;
    lsp.list().then((r) => live && setRows(r), () => live && setRows([]));
    return () => (live = false);
  }, [tick]);
  return html`<aside class="panel servers-panel" aria-label="Language servers">
    <div class="panel-head">
      <h2><${Icon} name="code" size=${16} />Language servers</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body">
      <p class="muted small">They check code as you type and know its types: TypeScript and JavaScript, Python, Go, Rust, C and C++, Java, C#, JSON, CSS, HTML, YAML, Bash, and servers of your own (Settings → Language servers). Each runs for a project folder (several projects share one when the server can take them all, as Pyright, gopls and rust-analyzer can): on this computer for files opened from Folders, on the server for files on an SSH server, and here for your synced files, each on its own.</p>
      ${rows === null && html`<p class="muted small">Loading…</p>`}
      ${rows?.length === 0 && html`<p class="muted small">None running. Open a code file (.ts, .py, .go, .json…) from Folders to start one.</p>`}
      ${rows?.map((r) => {
        const state = r.failed ? 'stopped' : r.ready && r.state === 'starting' ? 'running' : r.state;
        return html`<section class="server-row" key=${r.id}>
          <div class="server-head">
            <span class=${`server-dot state-${state}`} aria-hidden="true" />
            <strong>${r.server}</strong>
            <span class="muted small">${serverLabel({ server: '', state, progress: r.progress }).slice(3)}</span>
          </div>
          <p class="muted small server-root" title=${(r.folders ?? [r.root]).join('\n')}>${r.where?.kind === 'notes' ? 'Your synced files' : (r.folders ?? [r.root]).map(baseName).join(', ')} · ${whereLabel(r.where)} · ${r.files === 1 ? '1 open file' : `${r.files} open files`}</p>
          ${(r.failed || r.message) && html`<p class="small server-message">${r.failed || r.message}</p>`}
          <div class="server-actions">
            <button type="button" class="btn sm" onClick=${() => actions.restartLanguageServer(r.id)}><${Icon} name="rotate" size=${14} />Restart</button>
            <button type="button" class="btn ghost sm" onClick=${() => actions.stopLanguageServer(r.id)}>Stop</button>
            <button type="button" class="btn ghost sm" aria-expanded=${open === r.id} onClick=${() => setOpen(open === r.id ? null : r.id)}>${open === r.id ? 'Hide' : 'Show'} its messages</button>
          </div>
          ${open === r.id &&
          html`<pre class="server-log" aria-label="Messages">${[`$ ${r.command ?? ''}`, ...r.stderr, ...r.log].filter(Boolean).join('\n') || 'Nothing yet.'}</pre>`}
        </section>`;
      })}
    </div>
  </aside>`;
}

/**
 * A file whose language server is not installed: what to install, typed into a terminal (on
 * this computer, or on the SSH server the file is on) for the person to run (nothing is
 * downloaded or run behind their back).
 */
export function SetupServerDialog({ missing, actions, onClose }) {
  if (missing.custom)
    return html`<${Modal} title=${`${missing.language} is not found`} onClose=${onClose}
      footer=${html`<button type="button" class="btn" onClick=${onClose}>Close</button>
        <button type="button" class="btn primary" onClick=${() => (onClose(), actions.retryLanguageServer())}>Try again</button>`}>
      <p>The server you set up for these files was not found on this computer:</p>
      <div class="setup-command"><code>${missing.command}</code></div>
      <p class="muted small">Install it again, or change it in Settings → Language servers.</p>
    </${Modal}>`;
  return html`<${Modal} title=${`Set up ${missing.language}`} onClose=${onClose}
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Close</button>
      <button type="button" class="btn primary" onClick=${() => (onClose(), actions.retryLanguageServer())}>It is installed: start it</button>`}>
    <p>Type checking, completion with types, hover and project-wide F12 / Shift+F12 / F2 come from a <strong>language server</strong>, a program ${missing.where?.kind === 'remote' ? html`on the server, <strong>${missing.where.name}</strong>, that runs there for its files` : 'on this computer'}. Install one with:</p>
    ${missing.install.map(
      (command) => html`<div class="setup-command" key=${command}>
        <code>${command}</code>
        <span class="spacer" />
        <button type="button" class="btn sm" title=${`Opens a terminal ${whereLabel(missing.where)} with the command typed in: press Enter to run it`} onClick=${() => (onClose(), actions.typeInTerminal(command, missing.root, missing.where?.kind === 'remote' ? missing.where.id : 'local'))}><${Icon} name="terminal" size=${14} />Type it in a terminal</button>
        <button type="button" class="icon-btn sm" aria-label=${`Copy ${command}`} title="Copy" onClick=${() => actions.copyText(command)}><${Icon} name="copy" size=${14} /></button>
      </div>`,
    )}
    <p class="muted small">${missing.install.length > 1 ? 'Either one works. ' : ''}${missing.install.some((c) => c.startsWith('npm')) ? `It needs Node.js (nodejs.org) for npm${missing.install.some((c) => c.startsWith('pip')) ? ', or Python for pip' : ''}. A project with its own copy (in node_modules) uses that one. ` : ''}${missing.note ? `${missing.note} ` : ''}Then come back and start it.</p>
  </${Modal}>`;
}

/** F2 with a language server: the new name for a symbol, everywhere the server finds it. */
export function RenameSymbolDialog({ word, onRename, onClose }) {
  const [name, setName] = useState(word);
  // The server says what is a valid name for its language (CSS classes have dashes…).
  const valid = Boolean(name.trim()) && !/\s/.test(name) && name !== word;
  const submit = (e) => {
    e.preventDefault();
    if (valid) onRename(name);
  };
  return html`<${Modal} title=${`Rename ${word}`} onClose=${onClose}
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="submit" form="rename-symbol" class="btn primary" disabled=${!valid}>Rename</button>`}>
    <form id="rename-symbol" onSubmit=${submit}>
      <label class="field"><span class="field-label">New name</span>
        <input value=${name} onInput=${(e) => setName(e.currentTarget.value)} onFocus=${(e) => e.currentTarget.select()} spellcheck="false" autocomplete="off" />
      </label>
      <p class="muted small">Every use in the project, as the language server sees it. When other files change too, you see every change before it is made.</p>
    </form>
  </${Modal}>`;
}

/** Shift+F12 with a language server: where a name is used, across files; click one to go there. */
export function ReferencesPanel({ refs, actions, onClose }) {
  const files = [];
  for (const r of refs.list) {
    const last = files.at(-1);
    if (last?.path === r.path) last.items.push(r);
    else files.push({ path: r.path, items: [r] });
  }
  return html`<aside class="panel usages-panel references-panel" aria-label="References">
    <div class="panel-head">
      <h2><${Icon} name="code" size=${16} />References</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body">
      <p class="usages-word"><code>${refs.word}</code></p>
      <p class="muted small">${refs.list.length === 1 ? 'Once' : `${refs.list.length.toLocaleString()} times`}${files.length > 1 ? ` in ${files.length} files` : ''} · from ${refs.server}</p>
      <nav class="usages-list" aria-label=${`Where ${refs.word} is used`}>
        ${files.map(
          (f) => html`<div class="references-file" key=${f.path}>
            <p class="references-name" title=${f.path}><${Icon} name="file" size=${13} />${baseName(f.path)}<span class="muted small">${f.items.length}</span></p>
            ${f.items.map((u) => {
              const start = Math.max(0, u.column - 1 - 48);
              const at = u.column - 1;
              return html`<button type="button" key=${`${u.line}:${u.column}`} class="outline-row usage-row ${u.declaration ? 'declaration' : ''}" onClick=${() => actions.openPlace(u)} title=${`${f.path}, line ${u.line}`}>
                <span class="usage-line">${u.line}</span>
                <span class="usage-text">${u.text == null ? html`<span class="muted">line ${u.line}, column ${u.column}</span>` : html`${start ? '…' : ''}${u.text.slice(start, at).trimStart()}<mark>${u.text.slice(at, at + u.length)}</mark>${u.text.slice(at + u.length, at + u.length + 120)}`}</span>
              </button>`;
            })}
          </div>`,
        )}
      </nav>
    </div>
  </aside>`;
}

const KIND_WORDS = { tab: 'open', stored: 'open, not shown yet', disk: 'saved to disk', new: 'a new file' };

/**
 * Changes a language server wants in several files (a rename, a quick fix): each file with its
 * changed lines (before / after), ticked to take part. Open files change as an edit you can
 * undo; files not open are saved to disk; Undo afterwards takes it all back. `onDone(paths)`
 * with the files ticked, or `onDone(null)` (cancelled, or closed some other way).
 */
export function WorkspaceEditDialog({ title, entries, rel = (p) => p, onDone }) {
  const usable = entries.filter((e) => !e.error);
  const [ticked, setTicked] = useState(() => new Set(usable.map((e) => e.path)));
  const [open, setOpen] = useState(() => new Set(usable.slice(0, 3).map((e) => e.path)));
  const answered = useRef(false);
  const finish = (paths) => {
    if (answered.current) return;
    answered.current = true;
    onDone(paths);
  };
  useEffect(() => () => finish(null), []);
  const toggle = (set, setSet, path) => {
    const next = new Set(set);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSet(next);
  };
  const places = usable.filter((e) => ticked.has(e.path)).reduce((n, e) => n + e.edits.length, 0);
  const onDisk = usable.filter((e) => ticked.has(e.path) && (e.kind === 'disk' || e.kind === 'new')).length;
  return html`<${Modal} title=${title} wide onClose=${() => finish(null)}
    footer=${html`<span class="muted small edit-summary">${places} change${places === 1 ? '' : 's'} in ${ticked.size} file${ticked.size === 1 ? '' : 's'}${onDisk ? ` · ${onDisk} saved to disk` : ''}</span>
      <span class="spacer" />
      <button type="button" class="btn" onClick=${() => finish(null)}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!ticked.size} onClick=${() => finish([...ticked])}>Apply</button>`}>
    <p class="muted small">Files that are open change like an edit of yours (not saved yet). The others are saved to disk now, each only if it did not change since it was read. Undo, in the message afterwards, takes it all back.</p>
    <div class="edit-files" role="list">
      ${entries.map((e) => {
        const name = e.name ?? String(e.path).split(/[\\/]/).pop();
        return html`<section class="edit-file ${e.error ? 'failed' : ''}" role="listitem" key=${e.path}>
          <div class="edit-file-head">
            <input type="checkbox" checked=${!e.error && ticked.has(e.path)} disabled=${Boolean(e.error)} aria-label=${`Change ${name}`} onChange=${() => toggle(ticked, setTicked, e.path)} />
            <button type="button" class="edit-file-name" aria-expanded=${open.has(e.path)} onClick=${() => toggle(open, setOpen, e.path)} title=${e.path}>
              <${Icon} name=${open.has(e.path) ? 'chevronDown' : 'chevronRight'} size=${13} />
              <${FileIcon} name=${name} size=${15} />
              <span class="edit-name">${name}</span>
              <span class="muted small edit-rel">${e.name ? 'My files' : rel(e.path)}</span>
            </button>
            <span class="spacer" />
            <span class="muted small">${e.error ? e.error : `${e.edits.length} · ${KIND_WORDS[e.kind] ?? ''}`}</span>
          </div>
          ${open.has(e.path) &&
          !e.error &&
          html`<div class="edit-lines">
            ${(e.rows ?? []).map(
              (r) => html`<div class="edit-hunk" key=${r.line}>
                ${r.before.map((t, i) => html`<div class="edit-line del" key=${`b${i}`}><span class="edit-ln">${r.line + i}</span><span class="edit-mark">−</span><code>${t}</code></div>`)}
                ${r.after.map((t, i) => html`<div class="edit-line ins" key=${`a${i}`}><span class="edit-ln">${r.before.length ? '' : r.line + i}</span><span class="edit-mark">+</span><code>${t}</code></div>`)}
              </div>`,
            )}
          </div>`}
        </section>`;
      })}
    </div>
  </${Modal}>`;
}
