// A Terminals tab (0.54): terminals in the editor's place, full size, as a session of its own
// (terminalsTabs.js keeps and brings it back; its record is a comparison tab's, mode 'terminals').
// The strip, the split and the screens are the panel's (TerminalDeck), in the tab's own host.
import { html, useEffect, useReducer, useState } from '../../vendor/preact-htm.js';
import { getSettings, saveSettings } from '../settings.js';
import { store } from '../store.js';
import { onTerminals, terminalLayout, terminals } from '../terminals.js';
import { cleanSavedSessions, savedSessionOf, tabRecordPatch, withSavedSession } from '../terminalSessions.js';
import { newId } from '../tracker-model.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';
import { MenuButton } from './menu.js';
import { savedSessionItems, TabNameField, TerminalDeck } from './terminal.js';

const savedSessions = () => cleanSavedSessions(getSettings().terminalSessions);

/**
 * "Save this session as…": a Terminals tab's terminals (their places, folders, shells, names, the
 * logins they run) and layout kept by name in settings `terminalSessions`, never their output. A
 * name taken replaces that one; the tab's own saved session is offered first.
 */
export function SaveTerminalSessionDialog({ id, actions, onClose }) {
  const record = store.compare(id);
  const own = savedSessions().find((s) => s.id === record?.savedId);
  const [name, setName] = useState(own?.name ?? record?.name ?? 'Terminals');
  const [runAgain, setRunAgain] = useState(Boolean(record?.runAgain));
  if (!record) return null;
  const live = tabRecordPatch(terminals(id), terminalLayout(id));
  const taken = savedSessions().find((s) => s.name.toLowerCase() === name.trim().toLowerCase() && s.id !== own?.id);
  const save = (ev) => {
    ev.preventDefault();
    const clean = name.trim().slice(0, 60) || record.name || 'Terminals';
    const saved = savedSessionOf({ ...record, ...live, runAgain }, { id: taken?.id ?? own?.id ?? newId().slice(0, 40), name: clean });
    if (!saved) return actions.toast('No terminal to save in this tab yet.');
    saveSettings({ terminalSessions: withSavedSession(getSettings().terminalSessions, saved) });
    store.updateCompare(id, { savedId: saved.id, name: clean, runAgain });
    actions.toast(`Saved “${clean}”: open it again from the + menu, the start screen or Ctrl+Shift+P (Open a saved terminal session).`);
    onClose();
  };
  return html`<${Modal} title="Save this terminal session" onClose=${onClose}
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="submit" form="save-terminal-session" class="btn primary"><${Icon} name="star" size=${15} />${taken ? 'Replace it' : 'Save'}</button>`}>
    <form id="save-terminal-session" class="fields" onSubmit=${save}>
      <label class="field"><span class="field-label">Name</span>
        <input value=${name} autofocus spellcheck="false" maxLength="60" onInput=${(e) => setName(e.currentTarget.value)} /></label>
      <label class="terminal-session-check"><input type="checkbox" checked=${runAgain} onChange=${(e) => setRunAgain(e.currentTarget.checked)} /><span>Run the logins (ssh…) its terminals are running again by itself when it opens</span></label>
    </form>
    ${taken && html`<p class="notice"><${Icon} name="alert" size=${15} /><span>A saved session is called “${taken.name}” already: it is replaced.</span></p>`}
    <ul class="saved-compares">
      ${live.terminals.map((t) => html`<li key=${t.id} class="saved-compare"><${Icon} name=${t.connId === 'local' ? 'disk' : 'server'} size=${15} /><span class="saved-compare-open"><span class="saved-compare-name">${actions.terminalEntryLabel(t).label}</span><span class="muted small">${actions.terminalEntryLabel(t).where} · ${actions.terminalEntryLabel(t).detail}${t.running ? ` · ${t.running}` : ''}</span></span></li>`)}
    </ul>
    <p class="muted small">Their output is not saved with it. Terminals on servers kept in tmux attach to the same session there while it runs.</p>
  </${Modal}>`;
}

/** The saved terminal sessions: open one in a Terminals tab, rename it, or remove it. */
export function SavedTerminalSessionsDialog({ actions, onClose }) {
  const [list, setList] = useState(savedSessions);
  const [editing, setEditing] = useState(null); // { id, name }
  const write = (next) => {
    const clean = cleanSavedSessions(next);
    saveSettings({ terminalSessions: clean });
    setList(clean);
  };
  return html`<${Modal} title="Saved terminal sessions" onClose=${onClose} footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Close</button>`}>
    ${!list.length && html`<p class="muted">None yet. In a Terminals tab (Ctrl+Shift+\`), ⋯ → Save this session as… keeps its terminals by name.</p>`}
    <ul class="saved-compares">
      ${list.map(
        (s) => html`<li key=${s.id} class="saved-compare">
          <${Icon} name="terminal" size=${15} />
          ${editing?.id === s.id
            ? html`<form class="saved-compare-rename" onSubmit=${(e) => (e.preventDefault(), write(list.map((x) => (x.id === s.id ? { ...x, name: editing.name.trim() || x.name } : x))), setEditing(null))}>
                <input value=${editing.name} autofocus aria-label="Name" maxLength="60" onInput=${(e) => setEditing({ id: s.id, name: e.currentTarget.value })} />
                <button type="submit" class="btn sm">Rename</button></form>`
            : html`<button type="button" class="saved-compare-open" title=${actions.terminalSessionText(s)} onClick=${() => (onClose(), actions.openSavedTerminalSession(s.id))}>
                <span class="saved-compare-name">${s.name}</span><span class="muted small">${actions.terminalSessionText(s)}${s.runAgain ? ' · runs its logins again' : ''}</span></button>`}
          <button type="button" class="icon-btn xs" aria-label=${`Rename ${s.name}`} title="Rename" onClick=${() => setEditing({ id: s.id, name: s.name })}><${Icon} name="edit" size=${13} /></button>
          <button type="button" class="icon-btn xs" aria-label=${`Remove ${s.name}`} title="Remove (tabs open from it stay)" onClick=${() => write(list.filter((x) => x.id !== s.id))}><${Icon} name="trash" size=${13} /></button>
        </li>`,
      )}
    </ul>
  </${Modal}>`;
}

export function TerminalsTab({ id, record, settings, actions }) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  useEffect(() => onTerminals(rerender), []);
  const [restoring, setRestoring] = useState(() => !actions.terminalsTabStarted(id));
  const [renaming, setRenaming] = useState(false);
  // Its terminals start the first time it shows in this run (terminalsTabs.js), as they were.
  useEffect(() => {
    let live = true;
    actions.startTerminalsTab(id).finally(() => live && setRestoring(false));
    return () => {
      live = false;
    };
  }, [id]);
  const list = terminals(id);
  const waiting = (record.terminals ?? []).length;
  const name = record.name || 'Terminals';
  const rename = (next) => {
    setRenaming(false);
    const clean = String(next ?? '').trim().slice(0, 60);
    if (clean && clean !== name) store.updateCompare(id, { name: clean });
  };
  const moreItems = () => [
    { label: 'Run those again by itself when this tab opens', icon: 'play', checked: Boolean(record.runAgain), hint: 'Logins (ssh, mosh, et, telnet) its terminals were running; nothing else is ever run by itself', run: () => store.updateCompare(id, { runAgain: !record.runAgain }) },
    { separator: true },
    { label: 'Save this session as…', icon: 'star', hint: 'Its terminals, folders, names and layout, to open again from the + menu or the start screen', disabled: !list.length, run: () => actions.saveTerminalSession(id) },
    { label: 'Rename the session…', icon: 'edit', hint: 'The tab’s name', run: () => setRenaming(true) },
    { separator: true },
    ...savedSessionItems(actions),
    { label: 'Saved sessions…', icon: 'list', run: () => actions.showSavedTerminalSessions() },
    { separator: true },
    list.length > 0 && { label: 'Move them all to the panel', icon: 'arrowDown', hint: 'Their shells keep running', run: () => actions.moveTerminalsToPanel(id) },
    { label: 'Close the tab (ends its terminals)', icon: 'x', danger: true, run: () => actions.close(`c:${id}`) },
  ];
  const lead = renaming
    ? html`<span class="terminals-tab-name editing"><${Icon} name="terminal" size=${15} /><${TabNameField} initial=${name} label="The session’s name" className="terminal-tab-input" onDone=${rename} onCancel=${() => setRenaming(false)} /></span>`
    : html`<button type="button" class="terminals-tab-name" title=${`${name}: this Terminals tab’s session (double-click to rename). It comes back as it is when the app starts again.`} onDblClick=${() => setRenaming(true)}>
        <${Icon} name="terminal" size=${15} /><span class="terminals-tab-label">${name}</span>
      </button>`;
  return html`<div class="terminals-tab" data-id=${id} aria-label=${`Terminals: ${name}`}>
    <${TerminalDeck} host=${id} settings=${settings} actions=${actions} lead=${lead}
      busy=${restoring && !list.length && waiting ? `Opening ${waiting} terminal${waiting === 1 ? '' : 's'}…` : ''}
      tools=${html`<button type="button" class="btn ghost sm terminals-tab-save" title="Save this session as… (its terminals, folders, names and layout)" disabled=${!list.length} onClick=${() => actions.saveTerminalSession(id)}><${Icon} name="star" size=${14} /><span class="hide-narrow">Save…</span></button>
        <${MenuButton} label="The session: run logins again, save, saved sessions" icon="more" items=${moreItems} />`} />
  </div>`;
}
