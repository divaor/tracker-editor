import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { outline } from '../outline.js';
import { fuzzyScore } from '../search.js';
import { findLanguage } from '../editor.js';
import { store } from '../store.js';
import { KINDS } from '../where.js';
import { Icon } from './icons.js';

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

/** A list to pick from over the window, with keys (↑ ↓ Enter, Escape): QuickOpen's look. */
export function PickList({ title, placeholder, query, setQuery, rows, render, onPick, onClose, empty, note }) {
  const [index, setIndex] = useState(0);
  const input = useRef(null);
  useEffect(() => setIndex(0), [query]);
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
  return html`<div class="modal-backdrop top" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="quick-open" role="dialog" aria-label=${title}>
      <div class="quick-title">${title}</div>
      ${setQuery &&
      html`<input value=${query} placeholder=${placeholder} aria-label=${title} ref=${input} onInput=${(e) => setQuery(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIndex(Math.min(index + 1, rows.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIndex(Math.max(index - 1, 0));
          } else if (e.key === 'Enter' && rows[index]) {
            e.preventDefault();
            pick(rows[index]);
          }
        }} />`}
      <div class="quick-list" role="listbox" tabindex=${setQuery ? undefined : 0} ref=${setQuery ? null : input}
        onKeyDown=${setQuery
          ? null
          : (e) => {
              if (e.key === 'ArrowDown') setIndex(Math.min(index + 1, rows.length - 1));
              else if (e.key === 'ArrowUp') setIndex(Math.max(index - 1, 0));
              else if (e.key === 'Enter' && rows[index]) pick(rows[index]);
              else return;
              e.preventDefault();
            }}>
        ${rows.map(
          (row, i) => html`<button type="button" key=${`${row.path ?? row.id}:${row.line}:${i}`} role="option" aria-selected=${i === index} class="quick-row symbol-row ${i === index ? 'active' : ''}"
            onMouseEnter=${() => setIndex(i)} onClick=${() => pick(row)}>${render(row)}</button>`,
        )}
        ${!rows.length && html`<p class="muted small quick-empty">${empty}</p>`}
        ${note && html`<p class="muted small quick-note">${note}</p>`}
      </div>
    </div>
  </div>`;
}

// Where a symbol or a declaration is: the file's name, its folder and kind.
function whereOf(row) {
  if (row.id) return html`<span class="muted small">${row.fileName}</span>`;
  return html`<span class="muted small quick-rel">${row.rel || baseName(row.path)}</span>`;
}

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
    render=${(s) => html`<${Icon} name=${s.level > 1 ? 'chevronRight' : 'code'} size=${14} class=${s.kind ? `quick-kind kind-${s.kind}` : ''} />
      <span class="quick-name">${s.title}</span>${s.container && html`<span class="muted small">${s.container}</span>`}${whereOf(s)}<span class="spacer" />${s.symbolKind && html`<span class="muted small" title=${`From ${s.server}`}>${s.symbolKind}</span>`}<span class="muted small">line ${s.line}</span>`} />`;
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
    empty="Nowhere."
    render=${(p) => html`<${Icon} name=${p.id ? 'cloud' : KINDS[p.kind]?.icon ?? 'file'} size=${14} class=${p.kind ? `quick-kind kind-${p.kind}` : ''} />
      <span class="quick-name">${p.id ? p.fileName : baseName(p.path)}</span><span class="muted small quick-rel">${p.text}</span><span class="spacer" />${p.rel && html`<span class="muted small quick-rel">${p.rel}</span>`}<span class="muted small">line ${p.line}</span>`} />`;
}
