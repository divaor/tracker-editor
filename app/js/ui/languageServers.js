import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { serverLabel } from '../lspTools.js';
import { Modal } from './components.js';
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
      <p class="muted small">They check code as you type and know its types: for TypeScript and JavaScript files, and Python ones, opened from Folders. Each runs for one project folder.</p>
      ${rows === null && html`<p class="muted small">Loading…</p>`}
      ${rows?.length === 0 && html`<p class="muted small">None running. Open a .ts, .js or .py file from Folders to start one.</p>`}
      ${rows?.map((r) => {
        const state = r.failed ? 'stopped' : r.ready && r.state === 'starting' ? 'running' : r.state;
        return html`<section class="server-row" key=${r.id}>
          <div class="server-head">
            <span class=${`server-dot state-${state}`} aria-hidden="true" />
            <strong>${r.server}</strong>
            <span class="muted small">${serverLabel({ server: '', state, progress: r.progress }).slice(3)}</span>
          </div>
          <p class="muted small server-root" title=${r.root}>${baseName(r.root)} · ${r.files === 1 ? '1 open file' : `${r.files} open files`}</p>
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
 * A file whose language server is not installed: what to install, typed into a terminal on
 * this computer for the person to run (nothing is downloaded or run behind their back).
 */
export function SetupServerDialog({ missing, actions, onClose }) {
  return html`<${Modal} title=${`Set up ${missing.language}`} onClose=${onClose}
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Close</button>
      <button type="button" class="btn primary" onClick=${() => (onClose(), actions.retryLanguageServer())}>It is installed: start it</button>`}>
    <p>Type checking, completion with types, hover and project-wide F12 / Shift+F12 / F2 come from a <strong>language server</strong>, a program on this computer. Install one with:</p>
    ${missing.install.map(
      (command) => html`<div class="setup-command" key=${command}>
        <code>${command}</code>
        <span class="spacer" />
        <button type="button" class="btn sm" title="Opens a terminal with the command typed in: press Enter to run it" onClick=${() => (onClose(), actions.typeInTerminal(command, missing.root))}><${Icon} name="terminal" size=${14} />Type it in a terminal</button>
        <button type="button" class="icon-btn sm" aria-label=${`Copy ${command}`} title="Copy" onClick=${() => actions.copyText(command)}><${Icon} name="copy" size=${14} /></button>
      </div>`,
    )}
    <p class="muted small">${missing.install.length > 1 ? 'Either one works. ' : ''}It needs Node.js (nodejs.org) for npm${missing.install.some((c) => c.startsWith('pip')) ? ', or Python for pip' : ''}. Then come back and start it. A project with its own copy (in node_modules) uses that one.</p>
  </${Modal}>`;
}

/** F2 with a language server: the new name for a symbol, everywhere the server finds it. */
export function RenameSymbolDialog({ word, onRename, onClose }) {
  const [name, setName] = useState(word);
  const valid = /^[\p{L}\p{N}_$]+$/u.test(name) && name !== word;
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
      <p class="muted small">Every use in the project, as the language server sees it. Files not open open as tabs with the change, not saved yet; Ctrl+Z takes it back in each.</p>
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
