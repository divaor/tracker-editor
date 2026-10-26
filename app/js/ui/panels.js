import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { findInFiles, quickOpen } from '../search.js';
import { matchSymbols } from '../codeNav.js';
import { timeAgo } from '../format.js';
import { fileKey, repoKey, store } from '../store.js';
import { folderFiles, onFolderIndex } from '../folderIndex.js';
import { pastedPath } from '../fileRefs.js';
import { baseName } from '../folders.js';
import { KINDS } from '../where.js';
import { Icon } from './icons.js';
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

/**
 * Ctrl+P: open a file by (fuzzy) name; also matches the project, and the files in the
 * folders open in Folders (`roots`: [{ dir, label, kind }]) by their path.
 */
export function QuickOpen({ files, docs, actions, onClose, initial = '', symbols = null, onSymbol, roots = [], hidden = false, openTabs = [] }) {
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
  const tabPaths = new Set(openTabs.map((t) => t.path));
  const all = [...openTabs, ...recent];
  // A whole path typed or pasted (desktop): opening it comes first.
  const typed = !symbolMode && window.desktop?.disk?.openTyped ? pastedPath(query) : null;
  const found = quickOpen(query.trim() ? [...all, ...inFolders.files.filter((f) => !tabPaths.has(f.path))] : all, query, 60);
  const list = typed ? [{ id: `typed:${typed}`, typed, name: baseName(typed) }, ...found] : found;
  const input = useRef(null);
  const choose = (file) => {
    onClose();
    if (symbolMode) onSymbol?.(file);
    else if (file.typed) actions.openTypedPath(file.typed);
    else if (file.path) actions.openDiskPath(file.path);
    else actions.openFile(file.id);
  };
  const rows = symbolMode ? symbolList : list;
  useEffect(() => setIndex(0), [query]);
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
  return html`<div class="modal-backdrop top" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="quick-open" role="dialog" aria-label="Open a file">
      <input value=${query} placeholder=${symbols ? `Type part of a file${roots.length ? ', folder' : ''} or project name; @ for this file’s functions and sections, # for any file’s…` : 'Type part of a file or project name…'} aria-label="File name" ref=${input}
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
          setQuery(value);
        }}
        onKeyDown=${(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIndex(Math.min(index + 1, rows.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIndex(Math.max(index - 1, 0));
          } else if (e.key === 'Enter' && rows[index]) {
            e.preventDefault();
            choose(rows[index]);
          } else if (e.key === 'Enter' && query.trim() && !symbolMode) {
            e.preventDefault();
            onClose();
            actions.newFile({ name: query.trim() });
          }
        }} />
      <div class="quick-list" role="listbox">
        ${symbolMode &&
        symbolList.map(
          (e, i) => html`<button type="button" key=${`${e.line}-${i}`} role="option" aria-selected=${i === index} class="quick-row symbol-row ${i === index ? 'active' : ''}"
            style=${{ paddingLeft: `${10 + (e.level - 1) * 14}px` }} onMouseEnter=${() => setIndex(i)} onClick=${() => choose(e)}>
            <${Icon} name=${e.level > 1 ? 'chevronRight' : 'code'} size=${14} /><span class="quick-name">${e.title}</span>
            <span class="spacer" /><span class="muted small">line ${e.line}</span>
          </button>`,
        )}
        ${symbolMode && !symbolList.length && html`<p class="muted small quick-empty">${symbols().length ? 'No function or section matches.' : 'No functions or sections found in this file (classes, functions and headings show here).'}</p>`}
        ${!symbolMode &&
        list.map((f, i) =>
          f.typed
            ? html`<button type="button" key=${f.id} role="option" aria-selected=${i === index} class="quick-row quick-disk kind-disk ${i === index ? 'active' : ''}"
                title=${f.typed} onMouseEnter=${() => setIndex(i)} onClick=${() => choose(f)}>
                <${Icon} name="disk" size=${15} class="quick-kind" /><span class="quick-name">Open ${f.name}</span>
                <span class="muted small quick-rel">${f.typed}</span>
              </button>`
            : f.path
            ? html`<button type="button" key=${f.id} role="option" aria-selected=${i === index} class="quick-row quick-disk kind-${f.kind} ${i === index ? 'active' : ''}"
                title=${f.path} onMouseEnter=${() => setIndex(i)} onClick=${() => choose(f)}>
                <${Icon} name=${KINDS[f.kind].icon} size=${15} class="quick-kind" /><span class="quick-name">${f.name}</span>
                ${f.rel.includes('/') && html`<span class="muted small quick-rel">${f.rel.slice(0, f.rel.lastIndexOf('/'))}</span>`}
                <span class="spacer" /><span class="quick-where">${f.where}</span>
              </button>`
            : html`<button type="button" key=${f.id} role="option" aria-selected=${i === index} class="quick-row ${i === index ? 'active' : ''}"
                onMouseEnter=${() => setIndex(i)} onClick=${() => choose(f)}>
                <${Icon} name=${f.item ? 'doc' : 'file'} size=${15} /><span class="quick-name">${f.name}</span>
                ${f.item && html`<span class="muted small quick-item">${f.item}</span>`}
                ${f.project && html`<span class="muted small">${f.project}</span>`}
                <span class="spacer" /><span class="muted small">${timeAgo(f.modifiedAt)}</span>
              </button>`,
        )}
        ${!symbolMode && !list.length && html`<p class="muted small quick-empty">${query.trim() ? html`No file matches${inFolders.loading ? ' yet (still looking in your folders)' : ''}. Press <kbd>Enter</kbd> to create “${query.trim()}”.` : 'No files yet.'}</p>`}
        ${!symbolMode && query.trim() && roots.length > 0 && (inFolders.loading || inFolders.truncated) &&
        html`<p class="muted small quick-note">${inFolders.loading ? 'Looking in your folders…' : 'Some folders have too many files: only the nearest ones are searched by name.'}</p>`}
      </div>
    </div>
  </div>`;
}
