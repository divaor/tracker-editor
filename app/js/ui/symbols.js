import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { outline } from '../outline.js';
import { fuzzyScore, matchRanges } from '../search.js';
import { findLanguage } from '../editor.js';
import { store } from '../store.js';
import { KINDS } from '../where.js';
import { Icon } from './icons.js';
import { ClearButton } from './components.js';
import { FileIcon } from './fileIcon.js';
import { ListEmpty, ListFoot, Marked, useListNav } from './listNav.js';

// The outline of a synced file, kept until its text changes.
const outlines = new Map(); // id → { text, entries }
function symbolsOf(file) {
  const text = store.text(file.id);
  const known = outlines.get(file.id);
  if (known?.text === text) return known.entries;
  const language = file.language || findLanguage(file.name)?.name || '';
  const lines = text.split('\n');
  const entries = language && language !== 'Markdown' ? outline(text, language).map((s) => ({ ...s, column: Math.max(1, (lines[s.line - 1] ?? '').indexOf(s.title) + 1) })) : [];
  outlines.set(file.id, { text, entries });
  return entries;
}

const baseName = (p) => p.split(/[\\/]/).pop();

/**
 * A list to pick from over the window, with keys (↑ ↓ PageUp PageDown Enter, Escape): QuickOpen's
 * look. `action` is what Enter does (the footer says it), `icon` the field's.
 */
export function PickList({ title, placeholder, query, setQuery, rows, render, onPick, onClose, empty, note, action = 'open', icon = 'search', emptyIcon = 'search' }) {
  const [index, setIndex] = useState(0);
  // Kept inside the list when it gets shorter (the folders' and the servers' answers come later).
  const sel = Math.min(index, rows.length - 1);
  const input = useRef(null);
  const listRef = useRef(null);
  const nav = useListNav(listRef, sel, setIndex, rows.length);
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    input.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const pick = (row) => {
    onClose();
    onPick(row);
  };
  const onKeyDown = (e) => {
    if (nav.key(e, { empty: !setQuery || !query })) return;
    if (e.key === 'Enter' && rows[sel]) {
      e.preventDefault();
      pick(rows[sel]);
    }
  };
  return html`<div class="modal-backdrop top" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="quick-open qo" role="dialog" aria-label=${title}>
      <div class="quick-title">${title}</div>
      ${setQuery &&
      html`<div class="qo-field">
        <${Icon} name=${icon} size=${17} class="qo-field-icon" />
        <input value=${query} placeholder=${placeholder} aria-label=${title} ref=${input} autocomplete="off" spellcheck=${false}
          role="combobox" aria-expanded="true" aria-controls="pick-list" aria-autocomplete="list" aria-activedescendant=${rows[sel] ? `pick-row-${sel}` : undefined}
          onInput=${(e) => {
            setQuery(e.currentTarget.value);
            setIndex(0);
            nav.reset();
          }}
          onKeyDown=${onKeyDown} />
        <${ClearButton} value=${query} onClear=${() => (setQuery(''), setIndex(0), nav.reset())} label="Clear" />
      </div>`}
      <div class="quick-list qo-list" id="pick-list" role="listbox" aria-label=${title} tabindex=${setQuery ? undefined : 0} onKeyDown=${setQuery ? null : onKeyDown}
        ref=${(el) => {
          listRef.current = el;
          if (!setQuery) input.current = el;
        }}>
        ${rows.map(
          (row, i) => html`<button type="button" key=${`${row.path ?? row.id}:${row.line}:${i}`} id=${`pick-row-${i}`} role="option" aria-selected=${i === sel}
            class="quick-row qo-row symbol-row ${i === sel ? 'active' : ''}" onPointerMove=${nav.hover(i)} onClick=${() => pick(row)}>${render(row)}</button>`,
        )}
        ${!rows.length && html`<${ListEmpty} icon=${emptyIcon} title=${empty} />`}
        ${note && html`<p class="qo-note">${note}</p>`}
      </div>
      <${ListFoot} action=${action} />
    </div>
  </div>`;
}

// Where a symbol or a declaration is, in its kind's color: one of my files (by name), else its
// path in the folder (`text` instead, when given).
function whereOf(row, text = row.id ? row.fileName : row.rel || baseName(row.path)) {
  const kind = row.id ? 'synced' : row.kind || 'disk';
  return html`<span class="qo-place kind-${kind}">${text && html`<${Icon} name=${KINDS[kind]?.icon ?? 'file'} size=${12} class="qo-kind" /><span class="qo-place-text">${text}</span>`}</span>`;
}

// A declaration's folder: "My files", or the folders of its path inside the one shown.
const folderOf = (p) => (p.id ? KINDS.synced.label : p.rel?.includes('/') ? p.rel.slice(0, p.rel.lastIndexOf('/')) : '');

/**
 * Ctrl+T: a class, function or section in any file: your files and those in the folders
 * open in Folders (`roots`: [{ dir, label, kind }], read in the main process).
 */
export function SymbolSearch({ files, roots, servers = null, actions, onClose, initial = '' }) {
  const [query, setQuery] = useState(initial);
  const [inFolders, setInFolders] = useState({ list: [], loading: roots.length > 0, truncated: false });
  // The language servers' own (workspace/symbol): precise, for the projects they run for.
  const [fromServers, setFromServers] = useState([]);
  useEffect(() => {
    if (!servers || !query.trim()) return setFromServers([]);
    let stale = false;
    const timer = setTimeout(
      () =>
        servers.workspaceSymbols(query.trim()).then(
          (list) => !stale && setFromServers(list.filter((s) => rootOf(s.path, roots)).map((s) => ({ ...s, rel: relOf(s.path, roots), kind: kindOf(s.path, roots), symbolKind: s.kind }))),
          () => !stale && setFromServers([]),
        ),
      180,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);
  const own = useMemo(() => files.flatMap((f) => symbolsOf(f).map((s) => ({ ...s, id: f.id, fileName: f.name }))), [files]);
  useEffect(() => {
    if (!roots.length || !window.desktop?.code) return undefined;
    let stale = false;
    const timer = setTimeout(
      () =>
        window.desktop.code.symbols(roots.map((r) => r.dir), query).then(
          (r) => !stale && setInFolders({ list: r.symbols.map((s) => ({ ...s, rel: relOf(s.path, roots), kind: kindOf(s.path, roots) })), loading: false, truncated: r.truncated }),
          () => !stale && setInFolders({ list: [], loading: false, truncated: false }),
        ),
      query ? 120 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query]);
  const rows = useMemo(() => {
    // A server's answer first when two name the same place.
    const seen = new Set(fromServers.map((s) => `${s.path}:${s.line}`));
    const all = [...fromServers, ...own, ...inFolders.list.filter((s) => !seen.has(`${s.path}:${s.line}`))];
    const scored = all.map((s, i) => ({ s, i, score: query ? fuzzyScore(s.title, query) : 0 })).filter((r) => r.score >= 0);
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.slice(0, 200).map((r) => r.s);
  }, [own, inFolders, fromServers, query]);
  return html`<${PickList} title="Go to a symbol in all files" placeholder="Type part of a class, function or section name…" query=${query} setQuery=${setQuery} rows=${rows}
    onClose=${onClose} onPick=${(s) => actions.openAt(s)}
    empty=${inFolders.loading ? 'Reading the files in your folders…' : query ? 'No class, function or section matches.' : 'No classes, functions or sections found.'}
    note=${inFolders.truncated ? 'Some folders have too many files: only part of them was read.' : ''}
    action="go to" icon="code" emptyIcon="code"
    render=${(s) => html`<span class="qo-icon ${s.level > 1 ? 'qo-sub' : ''}"><${Icon} name=${s.level > 1 ? 'chevronRight' : 'code'} size=${14} /></span>
      <span class="qo-name"><${Marked} text=${s.title} ranges=${matchRanges(s.title, query)} /></span>${s.container && html`<span class="qo-container">${s.container}</span>`}
      ${whereOf(s)}${s.symbolKind && html`<span class="qo-chip qo-kind-chip" title=${`From ${s.server}`}>${s.symbolKind}</span>`}<span class="qo-line">line ${s.line}</span>`} />`;
}

const rootOf = (path, roots) => roots.find((r) => path === r.dir || path.startsWith(`${r.dir.replace(/[\\/]+$/, '')}/`) || path.startsWith(`${r.dir.replace(/[\\/]+$/, '')}\\`));
const relOf = (path, roots) => {
  const r = rootOf(path, roots);
  return r ? path.slice(r.dir.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/') : path;
};
const kindOf = (path, roots) => rootOf(path, roots)?.kind ?? 'disk';

/** F12 found the name declared in several places: pick one ([{ path | id, line, column, text }]). */
export function DeclarationPicker({ word, places, roots, actions, onClose }) {
  const rows = places.map((p) => ({ ...p, rel: p.path ? relOf(p.path, roots) : '', kind: p.path ? kindOf(p.path, roots) : null }));
  return html`<${PickList} title=${`“${word}” is declared in ${places.length} places`} rows=${rows} onClose=${onClose} onPick=${(p) => actions.openAt({ ...p, title: word })}
    empty="Nowhere." action="go to" emptyIcon="code"
    render=${(p) => html`<span class="qo-icon"><${FileIcon} name=${p.id ? p.fileName : baseName(p.path)} size=${16} /></span>
      <span class="qo-name">${p.id ? p.fileName : baseName(p.path)}</span><span class="qo-code">${p.text}</span>
      ${whereOf(p, folderOf(p))}<span class="qo-line">line ${p.line}</span>`} />`;
}
