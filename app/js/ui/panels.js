import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { findInFiles, quickOpen } from '../search.js';
import { matchSymbols } from '../codeNav.js';
import { shortAgo } from '../format.js';
import { fileKey, repoKey, store } from '../store.js';
import { folderFiles, onFolderIndex } from '../folderIndex.js';
import { pastedPath } from '../fileRefs.js';
import { looksLikeQuestion, questionOf } from '../askFind.js';
import { baseName } from '../folders.js';
import { KINDS } from '../where.js';
import { projectKey } from '../tracker-model.js';
import { groupQuick, quickKind, quickMarks, quickPlace, wordRanges } from '../quickRows.js';
import { Icon } from './icons.js';
import { FileIcon } from './fileIcon.js';
import { ListEmpty, ListFoot, ListSection, Marked, useListNav } from './listNav.js';
import { ClearButton, Segmented } from './components.js';

const SCOPES = [
  { id: 'all', label: 'All files' },
  { id: 'filtered', label: 'Filtered' },
  { id: 'open', label: 'Open tabs' },
];

// Tracker documents as search entries (id "r:<path>"); those not downloaded yet are left out.
const docEntries = (docs) =>
  docs.map((d) => ({ id: `r:${d.path}`, name: d.name, project: d.project, modifiedAt: d.modifiedAt, item: d.item.title, text: store.docText(d.path) })).filter((d) => d.text !== null);

function Highlight({ text, at, length }) {
  return html`${text.slice(0, at)}<mark>${text.slice(at, at + length)}</mark>${text.slice(at + length)}`;
}

/** Find in all files: like Notepad++'s "Find in all opened documents", across every synced file. */
export function SearchPanel({ files, docs, allFiles, allDocs, openKeys, actions, onClose, seed = null }) {
  const [query, setQuery] = useState(seed?.query ?? '');
  const [options, setOptions] = useState({ caseSensitive: false, wholeWord: Boolean(seed?.wholeWord), regex: false });
  const [scope, setScope] = useState('all');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [chosen, setChosen] = useState(() => new Set()); // files ticked to open together
  const input = useRef(null);
  useEffect(() => {
    const selected = seed ? '' : actions.selectionText();
    if (selected && !selected.includes('\n') && selected.length < 120) setQuery(selected);
    input.current?.focus();
    input.current?.select();
  }, []);

  const pool =
    scope === 'open' ? [...allFiles.filter((f) => openKeys.includes(fileKey(f.id))), ...docEntries(allDocs.filter((d) => openKeys.includes(repoKey(d.path))))]
    : scope === 'filtered' ? [...files, ...docEntries(docs)]
    : [...allFiles, ...docEntries(allDocs)];
  const ordered = [...pool].sort((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1));
  let result = null;
  let error = '';
  try {
    result = query ? findInFiles(ordered.map((f) => ({ id: f.id, name: f.name, text: f.text ?? store.text(f.id) })), query, options) : null;
  } catch (err) {
    error = err.message;
  }
  const toggle = (key) => setOptions({ ...options, [key]: !options[key] });
  const found = result?.files ?? [];
  const ticked = found.filter((f) => chosen.has(f.id));
  const tick = (id) =>
    setChosen((c) => {
      const next = new Set(c);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  // Each one at its first match; the first file ends up in front.
  const openMany = (list) => actions.openFiles(list.map((f) => ({ id: f.id, line: f.matches[0]?.line, column: f.matches[0]?.column, length: f.matches[0]?.length })));
  const allCollapsed = found.length > 0 && found.every((f) => collapsed.has(f.id));

  return html`<aside class="panel search-panel" aria-label="Find in files">
    <div class="panel-head">
      <h2><${Icon} name="search" size=${16} />Find in files</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body">
      <div class="search-box">
        <input ref=${input} value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} placeholder="Find in every file…" aria-label="Find in files"
          onKeyDown=${(e) => e.key === 'Escape' && onClose()} />
        <${ClearButton} value=${query} onClear=${() => setQuery('')} label="Clear the search" />
        <div class="search-options" role="group" aria-label="Options">
          <button type="button" class="opt ${options.caseSensitive ? 'on' : ''}" aria-pressed=${options.caseSensitive} title="Match case" onClick=${() => toggle('caseSensitive')}>Aa</button>
          <button type="button" class="opt ${options.wholeWord ? 'on' : ''}" aria-pressed=${options.wholeWord} title="Whole word" onClick=${() => toggle('wholeWord')}><u>ab</u></button>
          <button type="button" class="opt ${options.regex ? 'on' : ''}" aria-pressed=${options.regex} title="Regular expression" onClick=${() => toggle('regex')}>.*</button>
        </div>
      </div>
      <${Segmented} small options=${SCOPES} value=${scope} onChange=${setScope} label="Search in" />
      ${error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${error}</p>`}
      ${result &&
      html`<p class="muted small search-summary">
        ${result.total ? `${result.total} match${result.total === 1 ? '' : 'es'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}` : 'No matches'}
        ${result.truncated ? ' (showing the first ones)' : ''}
      </p>`}
      ${found.length > 0 &&
      html`<div class="search-open" role="group" aria-label="Open the files found">
        <label class="check-inline" title="Tick every file found">
          <input type="checkbox" checked=${ticked.length === found.length} indeterminate=${ticked.length > 0 && ticked.length < found.length}
            onChange=${(e) => setChosen(e.currentTarget.checked ? new Set(found.map((f) => f.id)) : new Set())} />All
        </label>
        <button type="button" class="btn sm ${ticked.length ? 'primary' : ''}" disabled=${!ticked.length} onClick=${() => openMany(ticked)}>
          <${Icon} name="file" size=${14} />Open ${ticked.length ? ticked.length : ''} selected
        </button>
        <button type="button" class="btn ghost sm" onClick=${() => openMany(found)}>Open all ${found.length}</button>
        <span class="spacer" />
        <button type="button" class="icon-btn sm" title=${allCollapsed ? 'Show every match' : 'Only the file names'} aria-label=${allCollapsed ? 'Expand all' : 'Collapse all'}
          onClick=${() => setCollapsed(allCollapsed ? new Set() : new Set(found.map((f) => f.id)))}><${Icon} name="list" size=${15} /></button>
      </div>`}
      <div class="search-results">
        ${result?.files.map(
          (f) => html`<div class="result-file ${chosen.has(f.id) ? 'chosen' : ''}" key=${f.id}>
            <div class="result-head">
              <input type="checkbox" class="result-pick" checked=${chosen.has(f.id)} aria-label=${`Select ${f.name}`} onChange=${() => tick(f.id)} />
              <button type="button" class="result-toggle" aria-expanded=${!collapsed.has(f.id)} onClick=${() => setCollapsed((c) => {
                const next = new Set(c);
                next.has(f.id) ? next.delete(f.id) : next.add(f.id);
                return next;
              })}>
                <${Icon} name="chevronDown" size=${14} class=${collapsed.has(f.id) ? 'collapsed' : ''} />
                <span class="result-name">${f.name}</span><span class="count">${f.count}</span>
              </button>
              <button type="button" class="icon-btn sm result-open" aria-label=${`Open ${f.name}`} title="Open this file" onClick=${() => openMany([f])}><${Icon} name="external" size=${14} /></button>
            </div>
            ${!collapsed.has(f.id) &&
            f.matches.map(
              (m) => html`<button type="button" class="result-line" key=${m.line} onClick=${() => actions.openFile(f.id, { line: m.line, column: m.column, length: m.length })}>
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

// Quick open's sections: the icon by their header and the color it takes.
const SECTION_LOOKS = {
  tabs: { icon: 'panes', tone: 'qo-tone-accent' },
  recent: { icon: 'clock', tone: '' },
  files: { icon: 'cloud', tone: 'kind-synced' },
  docs: { icon: 'paperclip', tone: 'kind-doc' },
  folders: { icon: 'folder', tone: 'kind-disk' },
  symbols: { icon: 'code', tone: 'qo-tone-accent' },
};

const fullTime = (iso) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(at) ? '' : new Date(at).toLocaleString();
};

/**
 * Ctrl+P: open a file by (fuzzy) name; also matches the project, and the files in the folders
 * open in Folders (`roots`: [{ dir, label, kind }]) by their path. The tabs open on disk or a
 * server first, then the newest of my files and the tracker's documents; while typing, the
 * matches under where they are (the section with the best one first), a path typed or pasted,
 * and the Ask row. "@" lists the open file's functions and sections, "#" any file's (Ctrl+T),
 * ">" the commands.
 */
export function QuickOpen({ files, docs, actions, onClose, initial = '', symbols = null, onSymbol, roots = [], hidden = false, openTabs = [], onAsk = null, projects = [], plainIcons = false }) {
  const [query, setQuery] = useState(initial);
  const [index, setIndex] = useState(0);
  // Files in the folders: listed in the background, the list grows when they come.
  const [, setListed] = useState(0);
  useEffect(() => onFolderIndex(() => setListed((n) => n + 1)), []);
  const inFolders = folderFiles(roots, { hidden });
  // "@…": the classes, functions and sections of the open file.
  const symbolMode = Boolean(symbols) && query.startsWith('@');
  const symbolList = useMemo(() => (symbolMode ? matchSymbols(symbols(), query.slice(1)).slice(0, 300) : []), [symbolMode, query]);
  const recent = useMemo(
    () =>
      [...files, ...docs.map((d) => ({ id: `r:${d.path}`, name: d.name, project: d.project, modifiedAt: d.modifiedAt, item: d.item.title }))]
        .sort((a, b) => (b.modifiedAt > a.modifiedAt ? 1 : -1)),
    [files, docs],
  );
  // Tabs open on disk or a server come first (the tab bar's view may hide them); folder files once each.
  const tabs = openTabs.map((t) => ({ ...t, tab: true }));
  const tabPaths = new Set(tabs.map((t) => t.path));
  const all = [...tabs, ...recent];
  // A whole path typed or pasted (desktop): opening it comes first.
  const typed = !symbolMode && window.desktop?.disk?.openTyped ? pastedPath(query) : null;
  const searching = Boolean(query.trim());
  const found = quickOpen(searching ? [...all, ...inFolders.files.filter((f) => !tabPaths.has(f.path))] : all, query, 60);
  // Find by asking (with a model on): a question, or anything after "?", is asked of the model; first
  // when it reads as a question (Enter asks), else after the names that match.
  const words = query.trim().split(/\s+/).filter(Boolean);
  const asking = Boolean(onAsk) && !symbolMode && (query.trim().startsWith('?') ? questionOf(query).length > 0 : words.length >= 3);
  const askRow = asking ? { id: 'ask', ask: true, name: questionOf(query) } : null;
  const named = typed ? [{ id: `typed:${typed}`, typed, name: baseName(typed) }, ...found] : found;
  const list = askRow ? (looksLikeQuestion(query) ? [askRow, ...named] : [...named, askRow]) : named;
  // Under their sections (the one with the best match first), and the keys go through them in that order.
  const groups = symbolMode ? [{ id: 'symbols', label: 'In this file', rows: symbolList }] : groupQuick(list, { searching });
  const rows = groups.flatMap((g) => g.rows);
  const at = new Map(rows.map((r, i) => [r, i]));
  // The chosen row, kept inside the list when it gets shorter (the folders' files come and go).
  const sel = Math.min(index, rows.length - 1);
  const input = useRef(null);
  const listRef = useRef(null);
  const nav = useListNav(listRef, sel, setIndex, rows.length);
  const search = (value) => {
    setQuery(value);
    setIndex(0);
    nav.reset();
  };
  const choose = (file) => {
    onClose();
    if (symbolMode) onSymbol?.(file);
    else if (file.ask) onAsk(query);
    else if (file.typed) actions.openTypedPath(file.typed);
    else if (file.path) actions.openDiskPath(file.path);
    else actions.openFile(file.id);
  };
  // Escape closes it wherever the focus is (a menu command can open it while
  // the window is still focusing), from the moment it shows.
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    // Here, once it is in the page (a ref runs before that).
    input.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const projectOf = (name) => projects.find((p) => p.key === projectKey(name)) ?? { name, color: '' };
  const symbolWords = query.slice(1).trim().split(/\s+/).filter(Boolean);

  const option = (row, cls, body, title = '') => {
    const i = at.get(row);
    return html`<button type="button" key=${row.id ?? `${row.line}-${i}`} id=${`qo-row-${i}`} role="option" aria-selected=${i === sel}
      class="quick-row qo-row ${cls} ${i === sel ? 'active' : ''}" title=${title || undefined} onPointerMove=${nav.hover(i)} onClick=${() => choose(row)}>${body}</button>`;
  };
  const place = (kind, text, ranges = []) =>
    html`<span class="qo-place">${text && html`<${Icon} name=${KINDS[kind]?.icon ?? 'file'} size=${12} class="qo-kind" /><span class="qo-place-text"><${Marked} text=${text} ranges=${ranges} /></span>`}</span>`;
  const fileRow = (f) => {
    if (f.ask)
      return option(
        f,
        'quick-ask',
        html`<span class="qo-icon qo-icon-ask"><${Icon} name="sparkle" size=${15} /></span>
          <span class="qo-name"><span class="qo-ask-label">Ask:</span> ${f.name}</span><span class="qo-place" /><span class="qo-hint">Find by asking</span>`,
        'Find by asking: the model works out what to look for, the editor searches your files, documents, tracker items and folders, and the model picks the best',
      );
    if (f.typed)
      return option(
        f,
        'kind-disk qo-typed',
        html`<span class="qo-icon"><${FileIcon} name=${f.name} size=${16} plain=${plainIcons} /></span>
          <span class="qo-name">Open ${f.name}</span>${place('disk', f.typed)}<span class="qo-hint">Path</span>`,
        f.typed,
      );
    const kind = quickKind(f);
    const marks = quickMarks(f, query);
    const project = !f.path && f.project ? projectOf(f.project) : null;
    return option(
      f,
      `kind-${kind}`,
      html`<span class="qo-icon"><${FileIcon} name=${f.name} size=${16} plain=${plainIcons} /></span>
        <span class="qo-name"><${Marked} text=${f.name} ranges=${marks.name} /></span>
        ${f.encrypted && html`<${Icon} name="lock" size=${12} class="qo-lock" />`}
        ${place(kind, quickPlace(f), marks.place)}
        ${f.path
          ? f.where && html`<span class="qo-chip qo-where" style=${f.color ? { '--pc': f.color } : null}><span class="qo-dot" />${f.where}</span>`
          : project &&
            html`<span class="qo-chip" style=${{ '--pc': project.color || 'var(--text-3)' }} title=${`Project: ${project.name}`}
              ><span class="qo-dot" /><${Marked} text=${project.name} ranges=${project.name.length === f.project.length ? marks.project : []}
            /></span>`}
        <span class="qo-time" title=${fullTime(f.modifiedAt) || undefined}>${shortAgo(f.modifiedAt)}</span>`,
      f.path ?? '',
    );
  };
  const symbolRow = (e) =>
    option(
      e,
      `symbol-row qo-symbol ${e.level > 1 ? 'qo-sub' : ''}`,
      html`<span class="qo-icon" style=${{ marginLeft: `${Math.min(e.level - 1, 5) * 14}px` }}><${Icon} name=${e.level > 1 ? 'chevronRight' : 'code'} size=${14} /></span>
        <span class="qo-name"><${Marked} text=${e.title} ranges=${wordRanges(e.title, symbolWords)} /></span><span class="qo-place" />
        <span class="qo-line">line ${e.line}</span>`,
    );

  // The prefixes that list other things, for the footer (a click switches; the field keeps the focus).
  const prefixes = [
    actions.commandPalette && { key: '>', label: 'commands', hint: 'Run a command by name', run: () => (onClose(), actions.commandPalette('')) },
    symbols && { key: '@', label: 'symbols', hint: 'A function, class or section of this file', run: () => search('@') },
    actions.gotoSymbolAll && { key: '#', label: 'all symbols', hint: 'A function, class or section in any file', run: () => (onClose(), actions.gotoSymbolAll('')) },
    onAsk && { key: '?', label: 'ask', hint: 'Find by asking: describe the file in your own words', run: () => search('? ') },
  ].filter(Boolean);
  const chosen = rows[sel];
  const action = symbolMode ? 'go to' : chosen?.ask ? 'ask' : chosen ? 'open' : searching ? 'create' : 'open';

  return html`<div class="modal-backdrop top" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="quick-open qo" role="dialog" aria-label="Open a file">
      <div class="qo-field">
        <${Icon} name=${symbolMode ? 'code' : 'search'} size=${17} class="qo-field-icon" />
        <input value=${query} placeholder=${`Search files by name${roots.length ? ', folder' : ''} or project…`} aria-label="File name" ref=${input}
          role="combobox" aria-expanded="true" aria-controls="qo-list" aria-autocomplete="list" aria-activedescendant=${chosen ? `qo-row-${sel}` : undefined}
          autocomplete="off" spellcheck=${false}
          onInput=${(e) => {
            const value = e.currentTarget.value;
            // "#…": a symbol in any file (Ctrl+T); ">…": a command (Ctrl+Shift+P).
            if (value.startsWith('#') && actions.gotoSymbolAll) {
              onClose();
              return actions.gotoSymbolAll(value.slice(1));
            }
            if (value.startsWith('>') && actions.commandPalette) {
              onClose();
              return actions.commandPalette(value.slice(1).trimStart());
            }
            search(value);
          }}
          onKeyDown=${(e) => {
            if (nav.key(e, { empty: !query })) return;
            if (e.key === 'Enter' && chosen) {
              e.preventDefault();
              choose(chosen);
            } else if (e.key === 'Enter' && searching && !symbolMode) {
              e.preventDefault();
              onClose();
              actions.newFile({ name: query.trim() });
            }
          }} />
        <${ClearButton} value=${query} onClear=${() => search('')} label="Clear" />
      </div>
      <div class="quick-list qo-list" id="qo-list" role="listbox" aria-label=${symbolMode ? 'Functions and sections' : 'Files'} ref=${listRef}>
        ${rows.length > 0 &&
        groups.map(
          (g) => html`<${ListSection} key=${g.id} label=${g.label} count=${g.rows.length} icon=${SECTION_LOOKS[g.id]?.icon} tone=${SECTION_LOOKS[g.id]?.tone}>
            ${g.rows.map((r) => (symbolMode ? symbolRow(r) : fileRow(r)))}
          </${ListSection}>`,
        )}
        ${symbolMode &&
        !rows.length &&
        html`<${ListEmpty} icon="code" title=${symbols().length ? 'No function or section matches' : 'No functions or sections in this file'}>
          ${symbols().length ? 'Try fewer letters, or part of another word of its name.' : 'Classes, functions and headings show here.'}
        </${ListEmpty}>`}
        ${!symbolMode &&
        !rows.length &&
        (searching
          ? html`<${ListEmpty} title=${`No file matches “${query.trim()}”${inFolders.loading ? ' yet' : ''}`}>
              ${inFolders.loading ? 'Still looking in your folders. ' : ''}Press <kbd>Enter</kbd> to create a file of that name.
            </${ListEmpty}>`
          : html`<${ListEmpty} icon="file" title="No files yet">Type a name and press <kbd>Enter</kbd> to create one.</${ListEmpty}>`)}
        ${!symbolMode && searching && roots.length > 0 && (inFolders.loading || inFolders.truncated) &&
        html`<p class="qo-note">${inFolders.loading ? 'Looking in your folders…' : 'Some folders have too many files: only the nearest ones are searched by name.'}</p>`}
      </div>
      <${ListFoot} action=${action}>
        ${prefixes.length > 0 &&
        html`<span class="qo-prefixes">
          ${prefixes.map(
            (p) => html`<button type="button" key=${p.key} class="qo-prefix" title=${p.hint} onPointerDown=${(e) => e.preventDefault()} onClick=${p.run}><kbd>${p.key}</kbd>${p.label}</button>`,
          )}
        </span>`}
      </${ListFoot}>
    </div>
  </div>`;
}
