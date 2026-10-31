import { html, useEffect, useLayoutEffect, useReducer, useRef, useState } from '../../vendor/preact-htm.js';
import { getSettings, saveSettings } from '../settings.js';
import { server, servers } from '../servers.js';
import { dropIndex, tabName } from '../terminalTabs.js';
import {
  activeTerminal,
  attach,
  clearTerminal,
  closeTerminal,
  copyFromTerminal,
  fitSoon,
  focusTerminal,
  localShells,
  moveTerminal,
  onTerminals,
  pasteIntoTerminal,
  renameTerminal,
  setActiveTerminal,
  showTerminalOn,
  splitTerminals,
  terminalFolder,
  terminalHasSelection,
  terminals,
  terminalShown,
  unsplitTerminals,
} from '../terminals.js';
import { KINDS } from '../where.js';
import { Icon } from './icons.js';
import { Menu, MenuButton } from './menu.js';
import { Splitter } from './splitter.js';

const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
// What a terminal tab's drag carries: its key, and whether it came from the tab strip or a
// side's head (kept here too, since a drag's data cannot be read before the drop).
const TERMINAL_DRAG = 'text/x-terminal';
let dragging = null; // { key, from: 'tab' | 'half' }
// Touch screens do not drag tabs (a press scrolls the strip); phones have no room for two.
const touchScreen = () => matchMedia('(pointer: coarse)').matches;
const roomForTwo = () => !matchMedia('(max-width: 640px)').matches;

/** The name being typed for a tab: Enter (or leaving it) keeps it, Escape goes back. */
function TabNameField({ initial, onDone, onCancel }) {
  const input = useRef(null);
  const settled = useRef(false);
  useLayoutEffect(() => {
    input.current.focus();
    input.current.select();
  }, []);
  const finish = (keep) => {
    if (settled.current) return;
    settled.current = true;
    keep ? onDone(input.current.value) : onCancel();
  };
  return html`<input ref=${input} class="terminal-tab-input" defaultValue=${initial} aria-label="The terminal's name" spellcheck="false" maxLength="60"
    onKeyDown=${(e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    }}
    onBlur=${() => finish(true)} />`;
}

/**
 * The terminal panel under the editor (desktop): shells on this computer and on servers,
 * one tab each. Hiding it keeps them running; closing a tab ends its shell. Tabs can be
 * renamed (double-click), dragged along the strip, and dragged onto the left or right half
 * of the panel to show two terminals side by side; a side's head dragged back onto the
 * tabs (or Unsplit) shows one again.
 */
export function TerminalPanel({ settings, actions, onHide }) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  useEffect(() => onTerminals(rerender), []);
  const screens = useRef(null);
  const halves = { left: useRef(null), right: useRef(null) };
  const strip = useRef(null);
  const panel = useRef(null);
  const [menu, setMenu] = useState(null); // { at, s }
  const [renaming, setRenaming] = useState(null); // key
  const [dropAt, setDropAt] = useState(null); // index in the strip
  const [zone, setZone] = useState(null); // 'left' | 'right' while a tab is held over the screens
  const [ratio, setRatio] = useState(() => getSettings().terminalSplit || 0.5);
  const [shells, setShells] = useState([]); // this computer's ({ id, label, kind }), for New terminal
  useEffect(() => {
    localShells().then(setShells);
  }, []);
  const list = terminals();
  const current = activeTerminal();
  const split = splitTerminals();
  const sideOf = (s) => (split ? (split.left === s ? 'left' : split.right === s ? 'right' : null) : null);
  const byKey = (key) => list.find((s) => s.key === key) ?? null;
  const touch = touchScreen();
  const two = list.length > 1 && roomForTwo();

  // Each session's screen lives in a side's container; the ones not shown are hidden.
  useLayoutEffect(() => {
    for (const s of list) {
      const side = split ? sideOf(s) : s === current ? 'left' : null;
      attach(s, halves[side === 'right' ? 'right' : 'left'].current);
      s.el.hidden = !side;
    }
    if (current) focusTerminal(current);
  }, [current?.key, list.length, split?.left?.key, split?.right?.key]);
  useEffect(() => {
    const observer = new ResizeObserver(() => terminals().forEach((s) => terminalShown(s) && fitSoon(s)));
    observer.observe(halves.left.current);
    observer.observe(halves.right.current);
    return () => {
      observer.disconnect();
      // Hidden while a terminal had the keys: the menu's shortcuts are the window's again.
      window.desktop?.terminal?.ownKeys(false);
    };
  }, []);
  // Rename from the command palette: the tab in use.
  useEffect(() => {
    const start = () => activeTerminal() && setRenaming(activeTerminal().key);
    window.addEventListener('terminal:rename', start);
    return () => window.removeEventListener('terminal:rename', start);
  }, []);
  useEffect(() => {
    const end = () => ((dragging = null), setDropAt(null), setZone(null));
    window.addEventListener('dragend', end);
    return () => window.removeEventListener('dragend', end);
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
  // This computer's shells (the one chosen in Settings first), then the servers'.
  const chosen = shells.find((sh) => sh.id === settings.terminalShell) ?? shells[0];
  const newItems = () => [
    ...(shells.length > 1
      ? [
          { heading: true, label: `${KINDS.disk.label} · ${actions.localTerminalDir() || 'your home folder'}`, key: 'h-here' },
          ...[chosen, ...shells.filter((sh) => sh !== chosen)].map((sh) => ({ key: `sh-${sh.id}`, label: sh.label, icon: 'disk', hint: sh === chosen ? 'The usual one (Settings)' : undefined, run: () => actions.openTerminal('local', actions.localTerminalDir(), { shell: sh.id }) })),
        ]
      : [{ label: KINDS.disk.label, icon: 'disk', hint: actions.localTerminalDir() || 'Your home folder', run: here }]),
    { separator: true },
    ...(sftp.length
      ? sftp.map((c) => ({ label: `${c.name} (${c.user ? `${c.user}@` : ''}${c.host})`, icon: 'server', run: () => actions.openTerminal(c.id) }))
      : [{ label: 'Connect to a server…', icon: 'server', run: () => actions.editServer() }]),
  ];
  // This computer's terminals by their shell when there is a choice of them; servers' by name.
  const place = (s) => (s.connId === 'local' ? (shells.length > 1 && s.profileLabel ? s.profileLabel : KINDS.disk.label) : (server(s.connId)?.name ?? 'Server'));
  // The folder it is in now (what the shell said after its last command).
  const folderOf = (s) => (terminalFolder(s) ? baseName(terminalFolder(s)) : '');
  const nameOf = (s) => (s.task && !s.name ? `${s.label} · ${folderOf(s)}` : tabName({ name: s.name, runner: s.runner, place: place(s), folder: folderOf(s) }));
  const titleOf = (s) => [s.name ? `${nameOf(s)}: ${tabName({ runner: s.runner, place: place(s), folder: folderOf(s) })}` : nameOf(s), terminalFolder(s), s.profileLabel && s.connId === 'local' ? s.profileLabel : '', s.title].filter(Boolean).join('\n');
  const rename = (s) => setRenaming(s.key);

  // ---- Dragging tabs: along the strip (their order), onto a half of the screens (split) ----
  const startDrag = (e, s, from) => {
    dragging = { key: s.key, from };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(TERMINAL_DRAG, s.key);
  };
  const overStrip = (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const tabs = [...strip.current.querySelectorAll('.terminal-tab')];
    const middles = tabs.map((t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    const at = dropIndex(middles, e.clientX, list.findIndex((s) => s.key === dragging.key));
    if (at !== dropAt) setDropAt(at);
  };
  const dropOnStrip = (e) => {
    e.preventDefault();
    const d = dragging;
    const at = dropAt;
    dragging = null;
    setDropAt(null);
    const s = d && byKey(d.key);
    if (!s) return;
    moveTerminal(s, at ?? list.length);
    // A side's head brought back to the tabs: one terminal again, that one.
    if (d.from === 'half') unsplitTerminals(s);
  };
  const overScreens = (e) => {
    if (!dragging || !two) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = screens.current.getBoundingClientRect();
    const side = e.clientX < r.left + r.width / 2 ? 'left' : 'right';
    if (side !== zone) setZone(side);
  };
  const dropOnScreens = (e) => {
    e.preventDefault();
    const d = dragging;
    const side = zone;
    dragging = null;
    setZone(null);
    const s = d && byKey(d.key);
    if (s && side) showTerminalOn(s, side);
  };

  const tabMenu = (s) => {
    const side = sideOf(s);
    return [
      { label: 'Rename…', icon: 'edit', hint: 'Or double-click the tab', run: () => rename(s) },
      two && side !== 'left' && { label: 'Show on the left', icon: 'panes', run: () => showTerminalOn(s, 'left') },
      two && side !== 'right' && { label: 'Show on the right', icon: 'panes', run: () => showTerminalOn(s, 'right') },
      split && { label: 'One terminal again (this one)', icon: 'terminal', run: () => unsplitTerminals(s) },
      { separator: true },
      list.indexOf(s) > 0 && { label: 'Move left', icon: 'arrowLeft', run: () => moveTerminal(s, list.indexOf(s) - 1) },
      list.indexOf(s) < list.length - 1 && { label: 'Move right', icon: 'arrowRight', run: () => moveTerminal(s, list.indexOf(s) + 1) },
      { separator: true },
      { label: 'Close (ends the shell)', icon: 'x', danger: true, run: () => closeTerminal(s) },
      list.length > 1 && { label: 'Close the others', icon: 'x', run: () => list.filter((x) => x !== s).forEach(closeTerminal) },
    ];
  };
  const screenMenu = (s) => [
    { label: 'Copy (Ctrl+Shift+C)', icon: 'copy', disabled: !terminalHasSelection(s), run: () => copyFromTerminal(s) },
    { label: 'Paste (Ctrl+Shift+V)', icon: 'clipboard', run: () => pasteIntoTerminal(s) },
    { label: 'Ask the model about the error', icon: 'sparkle', run: () => (setActiveTerminal(s), actions.explainTerminalError()) },
    { label: 'Clear', icon: 'eraser', run: () => clearTerminal(s) },
    { separator: true },
    { label: 'Rename…', icon: 'edit', run: () => rename(s) },
    split && { label: 'One terminal again (this one)', icon: 'terminal', run: () => unsplitTerminals(s) },
    { separator: true },
    { label: 'Close this terminal', icon: 'x', danger: true, run: () => closeTerminal(s) },
  ];

  const tab = (s, i) => {
    const side = sideOf(s);
    return html`${dropAt === i && html`<span class="terminal-tab-drop" key=${`drop${i}`} aria-hidden="true" />`}
      <div key=${s.key} role="tab" aria-selected=${s === current} draggable=${!touch && renaming !== s.key}
        class="terminal-tab ${s.connId === 'local' ? 'kind-disk' : 'kind-remote'} ${s === current ? 'active' : ''} ${side ? `on-${side}` : ''} ${s.exited ? 'exited' : ''} ${dragging?.key === s.key ? 'dragging' : ''}"
        title=${titleOf(s)}
        onDragStart=${(e) => startDrag(e, s, 'tab')}
        onContextMenu=${(e) => (e.preventDefault(), setMenu({ at: { x: e.clientX, y: e.clientY }, items: tabMenu(s), label: nameOf(s) }))}>
        ${renaming === s.key
          ? html`<span class="terminal-tab-name editing"><span class="conn-dot ${s.exited ? 'state-disconnected' : 'state-connected'}" />
              <${TabNameField} initial=${s.name || nameOf(s)} onDone=${(name) => (renameTerminal(s, name === nameOf(s) && !s.name ? '' : name), setRenaming(null), focusTerminal(s))} onCancel=${() => (setRenaming(null), focusTerminal(s))} /></span>`
          : html`<button type="button" class="terminal-tab-name" onClick=${() => setActiveTerminal(s)} onDblClick=${() => rename(s)}>
              <span class="conn-dot ${s.exited ? 'state-disconnected' : 'state-connected'}" />${side && html`<span class="terminal-side" title=${`Shown on the ${side}`}>${side === 'left' ? '◧' : '◨'}</span>`}<span class="terminal-tab-text">${nameOf(s)}</span>
            </button>`}
        <button type="button" class="icon-btn xs" aria-label=${`Close ${nameOf(s)}`} title="Close (ends the shell)" onClick=${() => closeTerminal(s)}><${Icon} name="x" size=${13} /></button>
      </div>`;
  };
  // While split: each side's head (its name, dragged back onto the tabs to show it alone).
  const halfHead = (side) => {
    const s = split?.[side];
    if (!s) return null;
    return html`<div class="terminal-half-head ${s === current ? 'active' : ''} ${s.connId === 'local' ? 'kind-disk' : 'kind-remote'}" draggable=${!touch}
      title="Drag onto the tabs to show it alone, or onto the other side to swap" onDragStart=${(e) => startDrag(e, s, 'half')}>
      <${Icon} name="grip" size=${12} class="grip" />
      <button type="button" class="terminal-half-name" onClick=${() => (setActiveTerminal(s), focusTerminal(s))}>${nameOf(s)}</button>
      <span class="spacer" />
      <button type="button" class="icon-btn xs" aria-label=${`Show only ${nameOf(s)}`} title="Show only this one" onClick=${() => unsplitTerminals(s)}><${Icon} name="fullscreen" size=${12} /></button>
    </div>`;
  };
  const startRatio = useRef(ratio);
  const ratioNow = useRef(ratio);
  ratioNow.current = ratio;

  return html`<section class="terminal-panel" ref=${panel} style=${{ height: `${height}px` }} aria-label="Terminal">
    <div class="terminal-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal" onPointerDown=${resize} />
    <div class="terminal-head">
      <${Icon} name="terminal" size=${15} />
      <div class="terminal-tabs ${dropAt !== null ? 'dropping' : ''}" role="tablist" aria-label="Terminals" ref=${strip}
        onDragOver=${overStrip} onDragLeave=${(e) => !strip.current.contains(e.relatedTarget) && setDropAt(null)} onDrop=${dropOnStrip}>
        ${list.map(tab)}
        ${dropAt === list.length && html`<span class="terminal-tab-drop" aria-hidden="true" />`}
      </div>
      <${MenuButton} label="New terminal" icon="plus" items=${newItems} />
      <span class="spacer" />
      <button type="button" class="btn ghost sm terminal-tasks" title="Tasks (Ctrl+Shift+B): the project's npm scripts, Makefile targets, pyproject and Composer scripts" onClick=${() => actions.showTasks()}><${Icon} name="play" size=${14} /><span class="hide-narrow">Tasks</span></button>
      ${split
        ? html`<button type="button" class="icon-btn sm" aria-label="One terminal again" title="One terminal again (the one in use)" onClick=${() => unsplitTerminals()}><${Icon} name="terminal" size=${15} /></button>`
        : two && html`<button type="button" class="icon-btn sm" aria-label="Two side by side" title="Two side by side: this one and the next (or drag a tab onto a side)" onClick=${() => showTerminalOn(current, 'left')}><${Icon} name="panes" size=${15} /></button>`}
      <button type="button" class="icon-btn sm" aria-label="Ask about the error" title="Ask the model about the error: the selection, or the last output (with the code it points to)" disabled=${!current} onClick=${() => actions.explainTerminalError()}><${Icon} name="sparkle" size=${15} /></button>
      <button type="button" class="icon-btn sm" aria-label="Clear" title="Clear the screen" disabled=${!current} onClick=${() => (clearTerminal(), focusTerminal())}><${Icon} name="eraser" size=${15} /></button>
      <button type="button" class="icon-btn sm" aria-label="Hide the terminal" title="Hide (Ctrl+\`); the shells keep running" onClick=${onHide}><${Icon} name="chevronDown" size=${16} /></button>
    </div>
    <div class="terminal-screens ${split ? 'split' : ''}" ref=${screens} style=${{ '--terminal-split': `${(ratio * 100).toFixed(1)}%` }}
      onDragOver=${overScreens} onDragLeave=${(e) => !screens.current.contains(e.relatedTarget) && setZone(null)} onDrop=${dropOnScreens}
      onContextMenu=${(e) => {
        const s = byKey(e.target.closest?.('.terminal-screen')?.dataset.key) ?? current;
        if (!s) return;
        e.preventDefault();
        setMenu({ at: { x: e.clientX, y: e.clientY }, items: screenMenu(s), label: nameOf(s) });
      }}>
      <div class="terminal-half left ${split && split.left === current ? 'active' : ''}">
        ${halfHead('left')}
        <div class="terminal-half-body" ref=${halves.left} />
      </div>
      ${split &&
      html`<${Splitter} orientation="vertical" label="Resize the two terminals" className="terminal-split"
        onStart=${() => (startRatio.current = ratio)}
        onMove=${(d) => setRatio(Math.min(0.85, Math.max(0.15, startRatio.current + d / Math.max(1, screens.current.clientWidth))))}
        onEnd=${() => saveSettings({ terminalSplit: Number(ratioNow.current.toFixed(3)) })}
        onReset=${() => (setRatio(0.5), saveSettings({ terminalSplit: 0 }))} />`}
      <div class="terminal-half right ${split && split.right === current ? 'active' : ''}" hidden=${!split}>
        ${halfHead('right')}
        <div class="terminal-half-body" ref=${halves.right} />
      </div>
      ${zone &&
      html`<div class="terminal-drop-zones" aria-hidden="true">
        <div class="terminal-drop-zone ${zone === 'left' ? 'on' : ''}"><span>On the left</span></div>
        <div class="terminal-drop-zone ${zone === 'right' ? 'on' : ''}"><span>On the right</span></div>
      </div>`}
      ${!list.length &&
      html`<div class="terminal-empty">
        <p>A terminal on ${KINDS.disk.label.toLowerCase()}, or on a server (signed in like its files).</p>
        <div class="terminal-empty-servers">
          <button type="button" class="btn sm" onClick=${here}><${Icon} name="disk" size=${15} />${KINDS.disk.label}</button>
          ${sftp.map((c) => html`<button type="button" key=${c.id} class="btn sm" onClick=${() => actions.openTerminal(c.id)}><${Icon} name="server" size=${15} />${c.name}</button>`)}
          ${!sftp.length && html`<button type="button" class="btn sm" onClick=${() => actions.editServer()}><${Icon} name="server" size=${15} />Connect to a server…</button>`}
        </div>
        <p class="muted small">Only SFTP (SSH) servers have terminals. “Open a terminal here” in Folders opens one in that folder; F5 runs the open file in one.</p>
      </div>`}
    </div>
    ${menu && html`<${Menu} at=${menu.at} label=${menu.label} items=${menu.items} onClose=${() => (setMenu(null), focusTerminal())} />`}
  </section>`;
}
