// Compare with…: picks the file to compare the open one with, by section (comparePick.js):
// the open tabs (the ones next to it first), files in the folders open in Folders while
// typing, my files and tracker documents. Each row has its full name, the folder it is in
// under it, and the color of its project or folder; Browse… picks any other file.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { compareSections } from '../comparePick.js';
import { folderFiles, onFolderIndex } from '../folderIndex.js';
import { KINDS } from '../where.js';
import { Icon } from './icons.js';
import { ClearButton } from './components.js';
import { FileIcon } from './fileIcon.js';

/**
 * `current`: { name, detail } of the open file. `tabs`, `files`, `docs`: rows
 * ({ id, name, detail, kind, group: { name, color } | null, near?, rel?, project?, item?,
 * path?, language? }). `roots` ([{ dir, label, kind }]) are searched while typing; their
 * rows get `detailOf(path)` and `groupOfRoot(dir)`. `onPick(row)`; `onBrowse()` picks
 * another file (null: no Browse…).
 */
export function ComparePicker({ current, tabs, files, docs, roots = [], hidden = false, detailOf, groupOfRoot, plainIcons = false, onPick, onBrowse, onClose }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [, setListed] = useState(0);
  useEffect(() => onFolderIndex(() => setListed((n) => n + 1)), []);
  const typing = Boolean(query.trim());
  const inFolders = typing && roots.length ? folderFiles(roots, { hidden }) : { files: [], loading: false, truncated: false };
  const sections = compareSections({ tabs, folders: inFolders.files, files, docs }, query);
  const rows = sections.flatMap((s) => s.rows);
  const input = useRef(null);
  const list = useRef(null);
  const choose = (row) => {
    onClose();
    onPick(row);
  };
  const browse = () => {
    onClose();
    onBrowse();
  };
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.cmp-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [index, query]);
  // Escape closes it wherever the focus is, from the moment it shows.
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
  let at = -1;
  const row = (r) => {
    const i = ++at;
    const kind = KINDS[r.kind] ?? KINDS.synced;
    const group = r.group !== undefined ? r.group : r.root ? groupOfRoot?.(r.root) : null;
    const detail = r.detail ?? (r.path ? detailOf?.(r.path) : '') ?? '';
    return html`<button type="button" key=${r.id} role="option" aria-selected=${i === index} class="cmp-row kind-${r.kind} ${i === index ? 'active' : ''} ${group?.color ? 'has-group' : ''}"
      style=${group?.color ? { '--gc': group.color } : null} title=${r.path ?? r.name} onMouseMove=${() => i !== index && setIndex(i)} onClick=${() => choose(r)}>
      <${FileIcon} name=${r.name} language=${r.language ?? ''} size=${20} plain=${plainIcons} />
      <span class="cmp-text">
        <span class="cmp-name">${r.name}${r.near && html`<span class="cmp-near">${r.near === 'left' ? '◂ next to it' : 'next to it ▸'}</span>`}</span>
        ${detail && html`<span class="cmp-path">${detail}</span>`}
      </span>
      ${group?.name && html`<span class="cmp-group" title=${group.name}><span class="cmp-dot" aria-hidden="true" />${group.name}</span>`}
      <span class="cmp-kind" title=${kind.label}><${Icon} name=${kind.icon} size=${14} /></span>
    </button>`;
  };
  return html`<div class="modal-backdrop top" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="quick-open compare-picker" role="dialog" aria-label=${`Compare ${current.name} with…`}>
      <div class="cmp-head">
        <span class="cmp-title">Compare <strong>${current.name}</strong> with…</span>
        ${current.detail && html`<span class="cmp-current">${current.detail}</span>`}
      </div>
      <div class="cmp-search">
        <${Icon} name="search" size=${16} />
        <input value=${query} ref=${input} aria-label="File name"
          placeholder=${roots.length ? 'Type part of a name or folder: open tabs, your folders, my files…' : 'Type part of a file or project name…'}
          onInput=${(e) => setQuery(e.currentTarget.value)}
          onKeyDown=${(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex(Math.min(index + 1, rows.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex(Math.max(index - 1, 0));
            } else if (e.key === 'PageDown' || e.key === 'PageUp') {
              e.preventDefault();
              setIndex(Math.max(0, Math.min(rows.length - 1, index + (e.key === 'PageDown' ? 8 : -8))));
            } else if (e.key === 'Enter' && rows[index]) {
              e.preventDefault();
              choose(rows[index]);
            } else if (e.key === 'Enter' && onBrowse) {
              e.preventDefault();
              browse();
            }
          }} />
        <${ClearButton} value=${query} onClear=${() => setQuery('')} />
      </div>
      <div class="quick-list cmp-list" role="listbox" ref=${list}>
        ${sections.map(
          (s) => html`<div class="cmp-section" key=${s.id} role="presentation">
            <div class="cmp-section-head"><span>${s.title}</span><span class="cmp-count">${s.rows.length + s.more}</span>
              ${s.id === 'folders' && inFolders.loading && html`<span class="muted small">looking…</span>`}</div>
            ${s.rows.map(row)}
            ${s.more > 0 && html`<p class="muted small cmp-more">${s.more} more${typing ? '' : ': type to find them'}</p>`}
          </div>`,
        )}
        ${typing && roots.length > 0 && inFolders.loading && !sections.some((s) => s.id === 'folders') && html`<p class="muted small cmp-more">Looking in your folders…</p>`}
        ${typing && inFolders.truncated && html`<p class="muted small cmp-more">Some folders have too many files: only the nearest ones are searched by name.</p>`}
        ${!rows.length &&
        html`<div class="cmp-empty">
          <p>${typing ? html`No file matches “${query.trim()}”${inFolders.loading ? ' yet' : ''}.` : 'No other file is open, and there are none in my files yet.'}</p>
          ${onBrowse && html`<button type="button" class="btn primary" onClick=${browse}><${Icon} name="folderOpen" size=${16} />Browse for a file…</button>`}
        </div>`}
      </div>
      <div class="cmp-foot">
        ${onBrowse && html`<button type="button" class="btn sm" onClick=${browse} title="Pick any file to compare with"><${Icon} name="folderOpen" size=${15} />Browse…</button>`}
        <span class="spacer" />
        <span class="muted small cmp-keys"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> compare · <kbd>Esc</kbd> close</span>
      </div>
    </div>
  </div>`;
}
