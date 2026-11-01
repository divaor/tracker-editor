// The Debug panel (Debugging, desktop): the run's controls (Continue or Pause, Step over, into,
// out, Restart, Stop), the call stack (threads and frames: a click shows that frame and its
// place), the variables (scopes, opened as you go), watch expressions (evaluated at each stop),
// the breakpoints of every file (on or off, removed, all off; exceptions to stop on) and the
// debug console (what the program writes; an expression evaluated in the frame shown, ↑ ↓ for
// the ones before). Also the dialogs: a breakpoint's condition, log message or hit count, and
// setting up an adapter that is missing.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { ADAPTERS, breakpointNote, breakpointRows, framePlace, shortValue } from '../debugTools.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

const baseName = (p) => String(p).split(/[\\/]/).pop();

/** The run's state in words, for the panel and the status bar. */
export function debugStatus(run) {
  if (!run) return '';
  if (run.status === 'starting') return 'Starting…';
  if (run.status === 'running') return 'Running';
  if (run.status === 'paused') return run.reason || 'Paused';
  return 'Ended';
}

function Controls({ dbg, run, actions }) {
  const live = run && run.status !== 'ended';
  const paused = run?.status === 'paused';
  const btn = (label, icon, keys, onClick, disabled = false, extra = '') =>
    html`<button type="button" class=${`icon-btn sm ${extra}`} aria-label=${label} title=${keys ? `${label} (${keys})` : label} disabled=${disabled} onMouseDown=${(e) => e.preventDefault()} onClick=${onClick}><${Icon} name=${icon} size=${16} /></button>`;
  return html`<div class="debug-controls" role="toolbar" aria-label="Debugging">
    ${paused ? btn('Continue', 'play', 'F5', () => dbg.continue(), false, 'debug-go') : btn('Pause', 'pause', '', () => dbg.pause(), run?.status !== 'running')}
    ${btn('Step over', 'stepOver', 'F10', () => dbg.stepOver(), !paused)}
    ${btn('Step into', 'stepInto', 'F11', () => dbg.stepInto(), !paused)}
    ${btn('Step out', 'stepOut', 'Shift+F11', () => dbg.stepOut(), !paused)}
    <span class="debug-controls-gap" />
    ${btn(live ? 'Restart' : 'Debug again', 'rotate', '', () => actions.debugRestart(), !run)}
    ${btn('Stop', 'stop', 'Shift+F5', () => dbg.stop(), !live, 'debug-stop')}
  </div>`;
}

function Section({ title, count, open: initial = true, children, extra, className = '' }) {
  const [open, setOpen] = useState(initial);
  return html`<section class=${`debug-section ${className} ${open ? 'open' : ''}`}>
    <div class="debug-section-head">
      <button type="button" class="debug-section-title" aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <${Icon} name=${open ? 'chevronDown' : 'chevronRight'} size=${13} />${title}${count ? html`<span class="muted small"> ${count}</span>` : ''}
      </button>
      <span class="spacer" />
      ${open && extra}
    </div>
    ${open && html`<div class="debug-section-body">${children}</div>`}
  </section>`;
}

function CallStack({ dbg, run }) {
  const threads = dbg.threads();
  if (!threads.length) return html`<p class="muted small debug-empty">${run?.status === 'running' ? 'Running: the stack shows when it pauses.' : 'Nothing yet.'}</p>`;
  return html`<div class="debug-stack">
    ${threads.map(
      (t) => html`<div class="debug-thread" key=${`${t.session}:${t.id}`}>
        <div class="debug-thread-name small"><${Icon} name=${t.paused ? 'pause' : 'play'} size=${12} />${t.sessionName ? `${t.sessionName} · ` : ''}${t.name}<span class="muted"> ${t.paused ? 'paused' : 'running'}</span></div>
        ${t.frames.map((f) => {
          const place = framePlace(f);
          const on = run?.focus?.session === t.session && run.focus.frame === f.id;
          return html`<button type="button" key=${f.id} class=${`debug-frame ${on ? 'on' : ''} ${place ? '' : 'no-place'} ${f.presentationHint === 'subtle' || f.presentationHint === 'deemphasize' ? 'subtle' : ''}`} title=${place ? `${place.path}:${place.line}` : f.source?.name ?? ''} onClick=${() => dbg.showFrame(t.session, t.id, f.id)}>
            <span class="debug-frame-name">${f.name}</span>
            <span class="debug-frame-place muted">${place ? `${baseName(place.path)}:${place.line}` : f.source?.name ?? ''}</span>
          </button>`;
        })}
      </div>`,
    )}
  </div>`;
}

function Variables({ dbg, run }) {
  const rows = dbg.rows();
  if (!rows.length) return html`<p class="muted small debug-empty">${run?.status === 'paused' ? 'Loading…' : 'The variables show when it pauses.'}</p>`;
  return html`<div class="debug-vars" role="tree" aria-label="Variables">
    ${rows.map(
      (r) => html`<div key=${r.path} role="treeitem" aria-expanded=${r.ref ? r.open : undefined} class=${`debug-var ${r.scope ? 'scope' : ''}`} style=${{ '--depth': r.depth }} title=${r.type ? `${r.name}: ${r.type}` : r.name}
          onClick=${() => r.ref && dbg.toggle(r)}>
        <span class="debug-var-twisty">${r.ref ? html`<${Icon} name=${r.open ? 'chevronDown' : 'chevronRight'} size=${12} />` : ''}</span>
        <span class="debug-var-name">${r.name}</span>${!r.scope && html`<span class="debug-var-value">${shortValue(r.value)}</span>`}${r.loading && html`<span class="muted small"> …</span>`}
      </div>`,
    )}
  </div>`;
}

function Watch({ run, watches, actions }) {
  const [text, setText] = useState('');
  const add = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    actions.addWatch(text.trim());
    setText('');
  };
  return html`<div class="debug-watch">
    ${watches.map((w) => {
      const v = run?.watch?.get(w);
      return html`<div class="debug-watch-row" key=${w}>
        <span class="debug-var-name">${w}</span>
        <span class=${`debug-var-value ${v?.error ? 'error' : ''}`} title=${v?.error || v?.value || ''}>${v ? (v.error ? v.error : shortValue(v.value)) : ''}</span>
        <button type="button" class="icon-btn xs" aria-label=${`Remove ${w}`} title="Remove" onClick=${() => actions.removeWatch(w)}><${Icon} name="x" size=${12} /></button>
      </div>`;
    })}
    <form class="debug-watch-add" onSubmit=${add}>
      <input value=${text} onInput=${(e) => setText(e.currentTarget.value)} placeholder="An expression to watch" aria-label="An expression to watch" spellcheck="false" autocomplete="off" />
    </form>
  </div>`;
}

function Breakpoints({ settings, actions, adapterCaps }) {
  const rows = breakpointRows(settings.breakpoints);
  const ex = settings.debugExceptions ?? {};
  return html`<div class="debug-bps">
    ${!rows.length && html`<p class="muted small debug-empty">None. <kbd>F9</kbd> puts one on the cursor's line; so does a click left of a line number in a Python, JavaScript or TypeScript file opened from Folders.</p>`}
    ${rows.map(
      (b) => html`<div class=${`debug-bp ${b.enabled === false ? 'off' : ''}`} key=${`${b.path}:${b.line}`}>
        <input type="checkbox" checked=${b.enabled !== false} aria-label=${`${b.name} line ${b.line}: on`} onChange=${(e) => actions.setBreakpoint(b.path, b.line, { enabled: e.currentTarget.checked })} />
        <button type="button" class="debug-bp-place" title=${`${b.path}:${b.line}`} onClick=${() => actions.openDiskPath(b.path, { line: b.line })}>
          <span class=${`debug-bp-dot ${b.logMessage ? 'log' : b.condition || b.hitCondition ? 'conditional' : ''}`} aria-hidden="true" />${b.name}<span class="muted">:${b.line}</span>
          ${breakpointNote(b) && html`<span class="debug-bp-note muted small">${breakpointNote(b)}</span>`}
        </button>
        <button type="button" class="icon-btn xs" aria-label=${`Remove the breakpoint at ${b.name}:${b.line}`} title="Remove" onClick=${() => actions.removeBreakpoint(b.path, b.line)}><${Icon} name="x" size=${12} /></button>
      </div>`,
    )}
    <div class="debug-exceptions small">
      <label><input type="checkbox" checked=${ex.uncaught !== false} onChange=${(e) => actions.setDebugExceptions({ uncaught: e.currentTarget.checked })} /> Stop on uncaught exceptions</label>
      <label title=${adapterCaps ? '' : 'Every exception raised, caught or not'}><input type="checkbox" checked=${Boolean(ex.all)} onChange=${(e) => actions.setDebugExceptions({ all: e.currentTarget.checked })} /> Stop on every exception (caught too)</label>
    </div>
  </div>`;
}

function Console({ dbg, run }) {
  const [text, setText] = useState('');
  const history = useRef([]);
  const at = useRef(-1);
  const out = useRef(null);
  const entries = run?.console ?? [];
  // Kept at the bottom while new lines come (unless scrolled up to read).
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = out.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const submit = (e) => {
    e.preventDefault();
    const expr = text.trim();
    if (!expr) return;
    history.current = [expr, ...history.current.filter((h) => h !== expr)].slice(0, 100);
    at.current = -1;
    setText('');
    stick.current = true;
    dbg.evaluate(expr);
  };
  const onKey = (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const h = history.current;
    if (!h.length) return;
    e.preventDefault();
    at.current = e.key === 'ArrowUp' ? Math.min(h.length - 1, at.current + 1) : Math.max(-1, at.current - 1);
    setText(at.current < 0 ? '' : h[at.current]);
  };
  const live = run && run.status !== 'ended';
  return html`<div class="debug-console">
    <div class="debug-console-out" ref=${out} role="log" aria-label="Debug console" onScroll=${(e) => (stick.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 24)}>
      ${!entries.length && html`<span class="muted small">What the program writes shows here.</span>`}
      ${entries.map((e, i) => html`<span key=${i} class=${`debug-out ${e.kind}`}>${e.text}</span>`)}
    </div>
    <form class="debug-console-in" onSubmit=${submit}>
      <span class="debug-prompt" aria-hidden="true">›</span>
      <input value=${text} disabled=${!live} onInput=${(e) => setText(e.currentTarget.value)} onKeyDown=${onKey} placeholder=${live ? (run.status === 'paused' ? 'Evaluate in the frame shown (↑ ↓: earlier ones)' : 'Evaluate (pause to use the frame’s variables)') : 'Not running'} aria-label="Evaluate an expression" spellcheck="false" autocomplete="off" />
    </form>
  </div>`;
}

/** `dbg`: the debugger (dap.js); `tick` changes when it says so. */
export function DebugPanel({ dbg, tick, settings, actions, onClose }) {
  const run = dbg?.run ?? null;
  const caps = run?.top?.caps ?? null;
  const adapter = run ? ADAPTERS[run.adapter]?.label ?? '' : '';
  return html`<aside class="panel debug-panel" aria-label="Debug" data-tick=${tick}>
    <div class="panel-head">
      <h2><${Icon} name="bug" size=${16} />Debug${adapter && html`<span class="muted small">${adapter}</span>`}</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <${Controls} dbg=${dbg} run=${run} actions=${actions} />
    <div class="panel-body debug-body">
      ${run
        ? html`<p class=${`debug-state small ${run.status}`} role="status"><span class="debug-state-dot" aria-hidden="true" /><span><strong title=${run.file}>${run.label}</strong> · ${debugStatus(run)}</span></p>`
        : html`<div class="debug-intro small">
            <p>Debug a Python, JavaScript or TypeScript file opened from Folders: put breakpoints on lines (<kbd>F9</kbd>, or a click left of the line numbers), then <kbd>Alt+F5</kbd>. The test at the cursor: <kbd>Ctrl+Alt+F5</kbd> (or right-click its ▶).</p>
            <button type="button" class="btn sm" onClick=${() => actions.debugFile()}><${Icon} name="bug" size=${14} />Debug this file</button>
          </div>`}
      ${run && html`<${Section} title="Call stack" className="debug-stack-section"><${CallStack} dbg=${dbg} run=${run} /></${Section}>`}
      ${run && html`<${Section} title="Variables"><${Variables} dbg=${dbg} run=${run} /></${Section}>`}
      <${Section} title="Watch" count=${(settings.debugWatches ?? []).length || ''}><${Watch} run=${run} watches=${settings.debugWatches ?? []} actions=${actions} /></${Section}>
      <${Section} title="Breakpoints" count=${breakpointRows(settings.breakpoints).length || ''}
        extra=${html`<button type="button" class="btn link xs" onClick=${() => actions.toggleAllBreakpoints()}>${breakpointRows(settings.breakpoints).every((b) => b.enabled === false) ? 'All on' : 'All off'}</button>
          <button type="button" class="btn link xs" onClick=${() => actions.removeAllBreakpoints()}>Remove all</button>`}>
        <${Breakpoints} settings=${settings} actions=${actions} adapterCaps=${caps} />
      </${Section}>
      ${run && html`<${Section} title="Debug console" className="debug-console-section" extra=${html`<button type="button" class="btn link xs" onClick=${() => dbg.clearConsole()}>Clear</button>`}><${Console} dbg=${dbg} run=${run} /></${Section}>`}
    </div>
  </aside>`;
}

const FIELDS = {
  condition: { title: 'Breakpoint condition', label: 'Stop only when this is true', placeholder: 'count > 3', hint: 'An expression in the program’s language, evaluated each time the line is reached.' },
  hitCondition: { title: 'Hit count', label: 'Stop only on this hit', placeholder: '3, or >= 3', hint: 'debugpy and js-debug take a number (that hit) or a comparison (>= 3, % 2).' },
  logMessage: { title: 'Log message', label: 'Write this instead of stopping', placeholder: 'count is {count}', hint: 'A log point: the message goes to the debug console and the program goes on; {expressions} in braces are filled in.' },
};
/** A breakpoint's condition, hit count or log message (empty clears it). */
export function BreakpointDialog({ field, path, line, value = '', onSave, onClose }) {
  const [text, setText] = useState(value);
  const f = FIELDS[field];
  const input = useRef(null);
  useEffect(() => input.current?.select(), []);
  const submit = (e) => {
    e.preventDefault();
    onSave(text.trim());
  };
  return html`<${Modal} title=${`${f.title}: ${baseName(path)} line ${line}`} onClose=${onClose}
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="submit" form="breakpoint-field" class="btn primary">${text.trim() || !value ? 'Save' : 'Clear it'}</button>`}>
    <form id="breakpoint-field" onSubmit=${submit}>
      <label class="field"><span class="field-label">${f.label}</span>
        <input ref=${input} value=${text} onInput=${(e) => setText(e.currentTarget.value)} placeholder=${f.placeholder} spellcheck="false" autocomplete="off" />
      </label>
      <p class="muted small">${f.hint} Empty: none.</p>
    </form>
  </${Modal}>`;
}

/**
 * An adapter that is not installed (dap:start's `missing`): what to install, typed into a
 * terminal on this computer for the person to run (nothing is downloaded or run behind their back).
 */
export function SetupDebuggerDialog({ missing, platform, actions, onClose }) {
  const shown = (install) => install[platform === 'win32' ? 'powershell' : 'posix'] ?? install.posix;
  return html`<${Modal} title=${`Set up debugging: ${missing.language}`} onClose=${onClose}
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Close</button>
      ${missing.install.length > 0 && html`<button type="button" class="btn primary" onClick=${() => (onClose(), actions.debugRetry())}>It is installed: debug</button>`}`}>
    <p>${missing.language} programs are debugged through <strong>${missing.label}</strong>${missing.adapter === 'node' ? ', VS Code’s JavaScript debugger,' : ''} on this computer${missing.install.length ? '. Install it with:' : '.'}</p>
    ${missing.install.map(
      (install, i) => html`<div class="setup-command" key=${i}>
        <code>${shown(install)}</code>
        <span class="spacer" />
        <button type="button" class="btn sm" title="Opens a terminal on this computer with the command typed in: press Enter to run it" onClick=${() => (onClose(), actions.typeInTerminal((kind) => install[kind === 'wsl' ? 'posix' : kind] ?? shown(install), missing.root, 'local'))}><${Icon} name="terminal" size=${14} />Type it in a terminal</button>
        <button type="button" class="icon-btn sm" aria-label="Copy the command" title="Copy" onClick=${() => actions.copyText(shown(install))}><${Icon} name="copy" size=${14} /></button>
      </div>`,
    )}
    <p class="muted small">${missing.note}${missing.install.length ? ' Then come back and debug.' : ''}</p>
  </${Modal}>`;
}
