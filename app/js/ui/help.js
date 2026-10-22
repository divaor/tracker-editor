import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { findCommands, groupsOf, keysFor } from '../commands.js';
import { renderMarkdown } from '../markdown.js';
import { ClearButton, Modal, Segmented } from './components.js';
import { Icon } from './icons.js';

const TABS = [
  { id: 'commands', label: 'Commands and shortcuts' },
  { id: 'guide', label: 'Guide' },
];
const isMac = () => window.desktop?.platform === 'darwin' || /Mac|iPhone|iPad/.test(navigator.platform);

/** A shortcut as keys: "Ctrl+Shift+F · F3" → <kbd>Ctrl</kbd>+<kbd>Shift</kbd>… */
const Keys = ({ keys }) =>
  keys &&
  html`<span class="help-keys">${keys.split(' · ').map(
    (combo, i) => html`${i > 0 && html`<span class="muted"> or </span>`}${combo.split('+').map((k, j) => html`${j > 0 && '+'}<kbd>${k}</kbd>`)}`,
  )}</span>`;

/** The cheat sheet: every command and its keys, searchable; a click runs the command. */
function CommandsTab({ query, setQuery, onRun }) {
  const mac = isMac();
  const desktop = Boolean(window.desktop);
  const input = useRef(null);
  const list = useRef(null);
  useEffect(() => input.current?.focus(), []);
  const found = findCommands(query, { desktop, mac });
  const runnable = found.filter((c) => c.run !== false);
  const move = (e, step) => {
    const buttons = [...(list.current?.querySelectorAll('button.help-command') ?? [])];
    const at = buttons.indexOf(document.activeElement);
    const next = buttons[at + step] ?? (step > 0 ? buttons[0] : null);
    if (next) e.preventDefault(), next.focus();
    else if (step < 0) e.preventDefault(), input.current?.focus();
  };
  return html`<div class="help-commands">
    <div class="help-tools">
      <div class="sidebar-filter help-search">
        <${Icon} name="search" size=${15} />
        <input ref=${input} value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} placeholder="Find a command or a key (format, sort, Ctrl+K…)" aria-label="Find a command"
          onKeyDown=${(e) => {
            if (e.key === 'ArrowDown') move(e, 1);
            if (e.key === 'Enter' && runnable[0]) e.preventDefault(), onRun(runnable[0]);
          }} />
        <${ClearButton} value=${query} onClear=${() => setQuery('')} label="Clear the search" />
      </div>
      <button type="button" class="btn sm" title="Print the cheat sheet, or save it as a PDF" onClick=${() => {
        document.body.classList.add('printing-help');
        setTimeout(() => (window.print(), document.body.classList.remove('printing-help')), 50);
      }}><${Icon} name="download" size=${15} />Print</button>
    </div>
    <div class="help-list" ref=${list} onKeyDown=${(e) => (e.key === 'ArrowDown' ? move(e, 1) : e.key === 'ArrowUp' ? move(e, -1) : null)}>
      ${groupsOf(found, Boolean(query.trim())).map((group) => {
        const rows = found.filter((c) => c.group === group);
        if (!rows.length) return null;
        return html`<section class="help-group" key=${group}>
          <h3>${group}</h3>
          ${rows.map((c) =>
            c.run === false
              ? html`<div class="help-command static" key=${c.id}><span class="help-label">${c.label}</span><${Keys} keys=${keysFor(c, { mac, desktop })} /></div>`
              : html`<button type="button" class="help-command" key=${c.id} title=${c.hint ?? 'Run it'} onClick=${() => onRun(c)}>
                  <span class="help-label">${c.label}</span><${Keys} keys=${keysFor(c, { mac, desktop })} />
                </button>`,
          )}
        </section>`;
      })}
      ${!found.length && html`<p class="muted">No command matches. Try other words, or the Guide.</p>`}
    </div>
  </div>`;
}

/** The guide (help/guide.md, the same as the one on the tracker), by section, searchable. */
function GuideTab() {
  const [text, setText] = useState(null);
  const [query, setQuery] = useState('');
  const body = useRef(null);
  useEffect(() => {
    fetch('help/guide.md')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
      .then(setText, () => setText(''));
  }, []);
  const sections = useMemo(() => (text ?? '').split(/\n(?=## )/), [text]);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? sections.filter((s, i) => i > 0 && words.every((w) => s.toLowerCase().includes(w))) : sections;
  const titles = sections.slice(1).map((s) => /^## (.+)/.exec(s)?.[1] ?? '');
  if (text === null) return html`<p class="muted">Loading the guide…</p>`;
  if (!text) return html`<p class="muted">The guide could not be loaded.</p>`;
  return html`<div class="help-guide">
    <nav class="help-toc" aria-label="Sections">
      <div class="sidebar-filter help-search">
        <${Icon} name="search" size=${15} />
        <input value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} placeholder="Find in the guide" aria-label="Find in the guide" />
        <${ClearButton} value=${query} onClear=${() => setQuery('')} label="Clear the search" />
      </div>
      ${titles.map(
        (t, i) => html`<button type="button" class="help-toc-item" key=${t}
          onClick=${() => {
            setQuery('');
            setTimeout(() => [...(body.current?.querySelectorAll('h2') ?? [])].find((h) => h.textContent.trim() === t.trim())?.scrollIntoView({ block: 'start' }), 0);
          }}>${t}</button>`,
      )}
    </nav>
    <div class="help-guide-body markdown" ref=${body}>
      ${shown.length
        ? html`<div dangerouslySetInnerHTML=${{ __html: renderMarkdown(shown.join('\n')) }} />`
        : html`<p class="muted">Nothing in the guide matches.</p>`}
    </div>
  </div>`;
}

/** Help (F1): the cheat sheet of commands and shortcuts (runnable), and the guide. */
export function HelpDialog({ tab: initialTab = 'commands', query: initialQuery = '', actions, onClose }) {
  const [tab, setTab] = useState(initialTab);
  const [query, setQuery] = useState(initialQuery);
  const run = (command) => {
    onClose();
    setTimeout(() => actions.command(command.id), 0);
  };
  return html`<${Modal} title="Help" wide className="help-dialog" onClose=${onClose}>
    <${Segmented} options=${TABS} value=${tab} onChange=${setTab} label="Help" />
    ${tab === 'commands' ? html`<${CommandsTab} query=${query} setQuery=${setQuery} onRun=${run} />` : html`<${GuideTab} />`}
  </${Modal}>`;
}
