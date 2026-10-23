import { html, useEffect, useLayoutEffect, useReducer, useRef, useState } from '../../vendor/preact-htm.js';
import { saveSettings } from '../settings.js';
import { server, servers } from '../servers.js';
import { activeTerminal, attach, clearTerminal, closeTerminal, copyFromTerminal, fitSoon, focusTerminal, onTerminals, pasteIntoTerminal, setActiveTerminal, terminalHasSelection, terminals } from '../terminals.js';
import { Icon } from './icons.js';
import { Menu, MenuButton } from './menu.js';

const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/**
 * The terminal panel under the editor (desktop): shells on this computer and on servers,
 * one tab each. Hiding it keeps them running; closing a tab ends its shell.
 */
export function TerminalPanel({ settings, actions, onHide }) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  useEffect(() => onTerminals(rerender), []);
  const screens = useRef(null);
  const panel = useRef(null);
  const [menu, setMenu] = useState(null);
  const list = terminals();
  const current = activeTerminal();

  // Each session's screen lives in the container; only the active one shows.
  useLayoutEffect(() => {
    for (const s of list) {
      attach(s, screens.current);
      s.el.hidden = s !== current;
    }
    if (current) {
      fitSoon(current);
      focusTerminal(current);
    }
  }, [current?.key, list.length]);
  useEffect(() => {
    const observer = new ResizeObserver(() => activeTerminal() && fitSoon(activeTerminal()));
    observer.observe(screens.current);
    return () => {
      observer.disconnect();
      // Hidden while a terminal had the keys: the menu's shortcuts are the window's again.
      window.desktop?.terminal?.ownKeys(false);
    };
  }, []);

  // The panel's height: dragged at its top edge, kept in the settings.
  const height = Math.max(120, settings.terminalHeight || 280);
  const resize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const start = panel.current.offsetHeight;
    let next = start;
    const move = (ev) => {
      next = Math.round(Math.max(120, Math.min(innerHeight * 0.75, start + startY - ev.clientY)));
      panel.current.style.height = `${next}px`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      saveSettings({ terminalHeight: next });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const sftp = servers().filter((c) => c.protocol === 'sftp');
  const here = () => actions.openTerminal('local', actions.localTerminalDir());
  const newItems = () => [
    { label: 'This computer', icon: 'disk', hint: actions.localTerminalDir() || 'Your home folder', run: here },
    { separator: true },
    ...(sftp.length
      ? sftp.map((c) => ({ label: `${c.name} (${c.user ? `${c.user}@` : ''}${c.host})`, icon: 'server', run: () => actions.openTerminal(c.id) }))
      : [{ label: 'Connect to a server…', icon: 'server', run: () => actions.editServer() }]),
  ];
  const place = (s) => (s.connId === 'local' ? 'This computer' : (server(s.connId)?.name ?? 'Server'));
  const tabLabel = (s) => `${s.runner ? 'Run · ' : ''}${place(s)}${s.cwd ? ` · ${baseName(s.cwd)}` : ''}`;

  return html`<section class="terminal-panel" ref=${panel} style=${{ height: `${height}px` }} aria-label="Terminal">
    <div class="terminal-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal" onPointerDown=${resize} />
    <div class="terminal-head">
      <${Icon} name="terminal" size=${15} />
      <div class="terminal-tabs" role="tablist" aria-label="Terminals">
        ${list.map(
          (s) => html`<div key=${s.key} role="tab" aria-selected=${s === current} class="terminal-tab ${s.connId === 'local' ? 'kind-disk' : 'kind-remote'} ${s === current ? 'active' : ''} ${s.exited ? 'exited' : ''}" title=${s.title || `${tabLabel(s)}${s.cwd ? ` (${s.cwd})` : ''}`}>
            <button type="button" class="terminal-tab-name" onClick=${() => setActiveTerminal(s)}>
              <span class="conn-dot ${s.exited ? 'state-disconnected' : 'state-connected'}" />${tabLabel(s)}
            </button>
            <button type="button" class="icon-btn xs" aria-label=${`Close ${tabLabel(s)}`} title="Close (ends the shell)" onClick=${() => closeTerminal(s)}><${Icon} name="x" size=${13} /></button>
          </div>`,
        )}
      </div>
      <${MenuButton} label="New terminal" icon="plus" items=${newItems} />
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Clear" title="Clear the screen" disabled=${!current} onClick=${() => (clearTerminal(), focusTerminal())}><${Icon} name="eraser" size=${15} /></button>
      <button type="button" class="icon-btn sm" aria-label="Hide the terminal" title="Hide (Ctrl+\`); the shells keep running" onClick=${onHide}><${Icon} name="chevronDown" size=${16} /></button>
    </div>
    <div class="terminal-screens" ref=${screens}
      onContextMenu=${(e) => {
        if (!current) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}>
      ${!list.length &&
      html`<div class="terminal-empty">
        <p>A terminal on this computer, or on a server (signed in like its files).</p>
        <div class="terminal-empty-servers">
          <button type="button" class="btn sm" onClick=${here}><${Icon} name="disk" size=${15} />This computer</button>
          ${sftp.map((c) => html`<button type="button" key=${c.id} class="btn sm" onClick=${() => actions.openTerminal(c.id)}><${Icon} name="server" size=${15} />${c.name}</button>`)}
          ${!sftp.length && html`<button type="button" class="btn sm" onClick=${() => actions.editServer()}><${Icon} name="server" size=${15} />Connect to a server…</button>`}
        </div>
        <p class="muted small">Only SFTP (SSH) servers have terminals. “Open a terminal here” in Folders opens one in that folder; F5 runs the open file in one.</p>
      </div>`}
    </div>
    ${menu &&
    html`<${Menu} at=${menu} label="Terminal" onClose=${() => (setMenu(null), focusTerminal())}
      items=${[
        { label: 'Copy (Ctrl+Shift+C)', icon: 'copy', disabled: !terminalHasSelection(), run: () => copyFromTerminal() },
        { label: 'Paste (Ctrl+Shift+V)', icon: 'clipboard', run: () => pasteIntoTerminal() },
        { label: 'Clear', icon: 'eraser', run: () => clearTerminal() },
        { separator: true },
        { label: 'Close this terminal', icon: 'x', danger: true, run: () => closeTerminal(current) },
      ]} />`}
  </section>`;
}
