import { html, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { baseName, folderLabel, openPlacement, parentPath, placeLabel } from '../folders.js';
import { folderListModel, openableRows } from '../folderList.js';
import { isRemotePath, KINDS, remoteParts } from '../where.js';
import { ClearButton } from './components.js';
import { Icon } from './icons.js';

// Folders' list of places (0.54): the folders shown, favorites, the folders picked on this computer
// by drive, servers with the folders used there, recent folders and saved comparisons, under a
// filter, then the actions. A folder picked opens in place of the current one when it is on the
// same drive (server, place), else beside the folders shown; Ctrl (Cmd) always beside, Shift
// always in place. The rows are shared with the side-by-side dialog (FolderRows).

/** How each section looks: its icon and its color (the kind colors where a kind is meant). */
export const SECTION_LOOKS = {
  shown: { icon: 'columns', color: 'var(--accent)' },
  favorites: { icon: 'star', color: 'var(--warn)' },
  computer: { icon: 'disk', color: 'var(--kind-disk)' },
  servers: { icon: 'server', color: 'var(--kind-remote)' },
  recent: { icon: 'clock', color: 'var(--text-3)' },
  saved: { icon: 'compare', color: 'var(--kind-compare)' },
  actions: { icon: 'more', color: 'var(--text-3)' },
};

const DRIVE_ICONS = { drive: 'disk', share: 'server', storage: 'disk', home: 'home', volume: 'disk', top: 'folder' };
const STATE_WORDS = { connected: 'connected', connecting: 'connecting…', disconnected: 'not connected', error: 'cannot connect' };

/** A folder's name in a flat list: a server's top by its server, the phone's storage by its name. */
export const placeNameOf = (p, servers) => {
  if (!isRemotePath(p)) return folderLabel(p);
  const inner = remoteParts(p).path.replace(/\/+$/, '');
  return inner ? baseName(inner) : (servers.find((s) => s.id === remoteParts(p).id)?.label ?? 'Server');
};
/** Where a folder is, under its name in a flat list: the folder holding it (the home folder as ~ on macOS and Linux), a server's name and its path there. */
export const placeWhereOf = (p, servers, home = '') => {
  if (!isRemotePath(p)) {
    const where = placeLabel(parentPath(p) || p);
    const h = home && home !== '/' && home.startsWith('/') ? home.replace(/\/+$/, '') : '';
    return h && (where === h || where.startsWith(`${h}/`)) ? `~${where.slice(h.length)}` : where;
  }
  const server = servers.find((s) => s.id === remoteParts(p).id)?.label ?? 'Server';
  const inner = remoteParts(p).path.replace(/\/+$/, '');
  return inner ? `${server} · ${inner.slice(0, inner.lastIndexOf('/')) || '/'}` : server;
};

/** The rows of the list's sections in blocks: a drive or a server with the folders under it. */
export function blocksOf(rows) {
  const out = [];
  for (const r of rows) {
    if (r.type === 'drive' || r.type === 'server') out.push({ head: r, rows: [] });
    else if (out.length && (r.drive || r.server) && out.at(-1).head && (r.drive ? out.at(-1).head.drive === r.drive : out.at(-1).head.id === r.server)) out.at(-1).rows.push(r);
    else out.push({ head: null, rows: [r] });
  }
  return out;
}

/**
 * One section's rows, drawn the list's way (`mode` 'menu') or the side-by-side dialog's ('add').
 * `render(row, { nested })` gives each row; drives and servers are blocks edged in their color.
 */
export function FolderSection({ section, children, long = false, filtering = false }) {
  const look = SECTION_LOOKS[section.id] ?? SECTION_LOOKS.actions;
  return html`<section class="fm-section fm-${section.id}" style=${{ '--sc': look.color }} aria-label=${section.label}>
    <h3 class="fm-head"><${Icon} name=${look.icon} size=${13} /><span>${section.label}</span>${section.count != null && html`<span class="fm-count">${section.count}</span>`}</h3>
    <div class="fm-rows ${long && !filtering ? 'long' : ''}">${children}</div>
  </section>`;
}

/** The blocks of a section: drives and servers as cards (a head row, then their folders), the rest as they are. */
export function sectionBlocks(rows, render) {
  return blocksOf(rows).map((b) =>
    b.head
      ? html`<div class="fm-block ${b.head.type === 'server' ? 'fm-server-block' : 'fm-drive-block'}" key=${b.head.key} style=${b.head.color ? { '--gc': b.head.color } : null}>
          ${render(b.head, { block: true })}${b.rows.map((r) => render(r, { nested: true }))}${b.head.after ?? null}
        </div>`
      : b.rows.map((r) => render(r, {})),
  );
}

// The focusable rows of a list, in order (the filter first).
const focusables = (el) => [...el.querySelectorAll('[data-nav]:not(:disabled)')];
/** Arrow keys, Home/End and PageUp/PageDown through `[data-nav]` elements inside `el`; true when handled. */
export function navKey(e, el, field) {
  const items = focusables(el);
  const at = items.indexOf(document.activeElement);
  const go = (i) => {
    const target = items[Math.max(0, Math.min(items.length - 1, i))];
    if (!target) return;
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  };
  const inField = document.activeElement === field;
  if (e.key === 'ArrowDown') return go(at + 1), true;
  if (e.key === 'ArrowUp') {
    if (at <= 0) field?.focus();
    else go(at - 1);
    return true;
  }
  if (inField) return false;
  if (e.key === 'Home') return go(0), true;
  if (e.key === 'End') return go(items.length - 1), true;
  if (e.key === 'PageDown') return go(at + 8), true;
  if (e.key === 'PageUp') return go(at - 8), true;
  return false;
}

/**
 * The whole path's crumbs (Folders, two panes): `.crumbs.whole` scrolls sideways with the wheel,
 * shows its end (where you are), and fades its start while it is cut off (`cut`).
 */
export const crumbsScroll = {
  onWheel: (e) => {
    if (!e.deltaY || e.deltaX) return;
    e.currentTarget.scrollLeft += e.deltaY;
  },
  onScroll: (e) => e.currentTarget.classList.toggle('cut', e.currentTarget.scrollLeft > 2),
};
/** Scrolls the crumbs to their end (a layout effect when the folder changes). */
export function crumbsToEnd(nav) {
  if (!nav) return;
  nav.scrollLeft = nav.scrollWidth;
  nav.classList.toggle('cut', nav.scrollLeft > 2);
}

/** What a click does: 'auto' (by the drive), 'beside' with Ctrl or Cmd, 'replace' with Shift. */
export const howOf = (e) => (e.ctrlKey || e.metaKey ? 'beside' : e.shiftKey ? 'replace' : 'auto');

/**
 * The list under Folders' ⋯ (`at`: { x, y, right }), fixed like a menu. `shown`: the folders in the
 * tree, `current` the one worked in, `roots` the folders picked here, `servers` [{ id, label,
 * detail, icon, state, place }]. `onOpen(path, how)`, `onServer(id, how)`, `onSaved(record)`,
 * `onFavorite(path)`, `onForget(path)`, `onCloseShown(path)`, `onForgetRecent(path)`; `actions`:
 * menu items after the lists (filtered by label too). `colorOf(path)` colors a folder as its
 * header in the tree and its tabs.
 */
export function FolderMenu({ at, owner, onClose, shown, current, roots, favorites, recent, servers, saved, home, colorOf, actions = [], onOpen, onServer, onSaved, onFavorite, onForget, onCloseShown, onForgetRecent, reachable = () => false }) {
  const ref = useRef(null);
  const field = useRef(null);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const colors = useMemo(() => new Map(), []);
  const colorFor = (p) => (colors.has(p) ? colors.get(p) : (colors.set(p, colorOf(p)), colors.get(p)));
  const sections = folderListModel({ shown, current, roots, favorites, recent, servers, saved, home, query, colorOf: colorFor, hereLabel: KINDS.disk.label });
  const q = query.trim().toLowerCase();
  const moreItems = actions.filter((a) => a && (a.separator ? !q : !q || String(a.label).toLowerCase().includes(q)));
  useLayoutEffect(() => {
    const el = ref.current;
    const r = el.getBoundingClientRect();
    const phone = innerWidth <= 640;
    const x = phone ? 8 : at.right ? at.x - r.width : at.x;
    setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, innerHeight - 160)) });
    field.current?.focus();
    const onDown = (e) => !el.contains(e.target) && !owner?.current?.contains(e.target) && !e.target.closest?.('.menu, .modal-backdrop') && onClose();
    // Escape with the focus elsewhere (after a click on a row's ☆) closes it too.
    const onKey = (e) => e.key === 'Escape' && !el.contains(e.target) && !e.defaultPrevented && (e.preventDefault(), onClose());
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const first = openableRows(sections, { reachable, matching: true })[0] ?? null;
  const take = (row, how) => {
    onClose();
    if (row.type === 'server') return onServer(row.id, how);
    if (row.type === 'saved') return onSaved(row.saved);
    return onOpen(row.path, how);
  };
  const hintOf = (row) => {
    if (row.type === 'saved') return 'Opens the comparison in a tab';
    const target = row.type === 'server' ? row.path : row.path;
    const place = openPlacement(target, shown, current);
    const now = place === 'focus' ? 'Shown already: worked in' : place === 'beside' ? 'Opens beside the folders shown (another drive or place)' : `Opens in place of ${placeNameOf(current, servers) || 'the folder shown'}`;
    return `${now}\nCtrl+click: beside the others · Shift+click: in place of the current one`;
  };
  const tagOf = (row) => {
    if (row.type === 'saved') return row.mode === 'panes' ? 'two panes' : 'compare';
    const place = openPlacement(row.path, shown, current);
    return place === 'focus' ? 'shown' : place === 'beside' ? 'beside' : 'here';
  };

  const onKeyDown = (e) => {
    if (navKey(e, ref.current, field.current)) return e.preventDefault();
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (query && document.activeElement === field.current) return setQuery('');
      return onClose();
    }
    if (e.key === 'Enter' && document.activeElement === field.current) {
      e.preventDefault();
      if (first) return take(first, howOf(e));
      const action = moreItems.find((a) => !a.separator && !a.disabled);
      if (action) return onClose(), action.run();
    }
    // Typing on a row goes on in the filter.
    if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== field.current) field.current?.focus();
  };

  const row = (r, { nested = false, block = false } = {}) => {
    const canOpen = r.type === 'drive' ? r.pick || reachable(r.path) : r.type === 'folder' ? !r.junction || reachable(r.path) : true;
    const name = r.type === 'folder' && (r.section === 'computer' || r.section === 'servers') ? r.name : r.type === 'folder' ? placeNameOf(r.path, servers) : r.name;
    const where = r.type === 'folder' && !nested ? placeWhereOf(r.path, servers, home) : r.type === 'server' ? r.detail : '';
    const icon = r.type === 'drive' ? (DRIVE_ICONS[r.kind] ?? 'disk') : r.type === 'server' ? r.icon : r.type === 'saved' ? (r.mode === 'panes' ? 'panes' : 'compare') : 'folder';
    const mine = r.type === 'folder' && r.color ? { '--gc': r.color } : null;
    const forget = r.section === 'shown' ? onCloseShown : r.type === 'drive' ? r.pick && onForget : r.picked ? onForget : (r.section === 'recent' || r.section === 'servers') && !r.junction ? onForgetRecent : null;
    const forgetLabel = r.section === 'shown' ? 'Close it in Folders (nothing is deleted)' : r.picked || r.type === 'drive' ? 'Forget it: Tinta no longer opens it until you pick it again (nothing is deleted)' : 'Take it off the recent folders';
    const star = (r.type === 'folder' && canOpen) || (r.type === 'drive' && canOpen);
    return html`<div key=${r.key} class="fm-row fm-${r.type} ${r.junction ? 'junction' : ''} ${r.current ? 'current' : ''} ${nested ? 'nested' : ''} ${block ? 'block-head' : ''}"
        style=${{ '--depth': nested ? r.depth - 1 : 0, ...(mine ?? {}) }} role="presentation">
      <button type="button" class="fm-open" data-nav="" disabled=${!canOpen} title=${canOpen ? `${r.type === 'saved' ? '' : `${isRemotePath(r.path) ? remoteParts(r.path).path : r.path}\n`}${hintOf(r)}` : `${r.path}\nNot opened here: open one of the folders in it, or go up to it from there`}
        onClick=${(e) => canOpen && take(r, howOf(e))}
        onKeyDown=${(e) => {
          if (e.key === 'Enter') return e.preventDefault(), e.stopPropagation(), canOpen && take(r, howOf(e));
          if ((e.key === 'Delete' || e.key === 'Backspace') && forget) return e.preventDefault(), e.stopPropagation(), forget(r.path);
        }}>
        <${Icon} name=${icon} size=${r.type === 'drive' || r.type === 'server' ? 15 : 14} class="fm-icon" />
        <span class="fm-name">${r.prefix && html`<span class="fm-prefix">${r.prefix}</span>`}<strong>${name}</strong></span>
        ${r.type === 'saved' && html`<span class="fm-where"><bdi>${placeNameOf(r.left, servers)}</bdi> ${r.mode === 'panes' ? '|' : '↔'} <bdi>${placeNameOf(r.right, servers)}</bdi></span>`}
        ${where && html`<span class="fm-where"><bdi>${where}</bdi></span>`}
        ${r.type === 'server' && html`<span class="conn-dot state-${r.state}" title=${STATE_WORDS[r.state] ?? r.state} />`}
        ${r.type === 'drive' && !r.pick && html`<span class="fm-where">${r.count} picked</span>`}
        ${r.current && html`<span class="fm-badge current" title="The folder worked in">working here</span>`}
        ${r.shown && !r.current && r.section !== 'shown' && html`<span class="fm-badge" title="Shown in Folders now">shown</span>`}
        ${canOpen && r.section !== 'shown' && html`<span class="fm-tag">${tagOf(r)}</span>`}
      </button>
      ${canOpen && r.type !== 'saved' && r.section !== 'shown' && tagOf(r) !== 'beside' && tagOf(r) !== 'shown' &&
      html`<button type="button" class="icon-btn xs fm-act" tabindex="-1" aria-label=${`Open ${name} beside the others`} title="Open beside the folders shown (Ctrl+click)"
        onClick=${() => take(r, 'beside')}><${Icon} name="columns" size=${13} /></button>`}
      ${star &&
      html`<button type="button" class="icon-btn xs fm-act fm-star ${r.favorite ? 'on' : ''}" tabindex="-1" aria-pressed=${r.favorite} aria-label=${r.favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
        title=${r.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick=${() => onFavorite(r.path)}><${Icon} name="star" size=${13} /></button>`}
      ${forget && r.section !== 'favorites' &&
      html`<button type="button" class="icon-btn xs fm-act fm-forget" tabindex="-1" aria-label=${`${r.section === 'shown' ? 'Close' : 'Forget'} ${name}`} title=${forgetLabel}
        onClick=${() => forget(r.path)}><${Icon} name="x" size=${13} /></button>`}
    </div>`;
  };

  const counted = sections.map((s) => ({ ...s, count: s.rows.filter((r) => (r.type === 'folder' && !r.junction) || (r.type === 'drive' && r.pick) || r.type === 'saved' || r.type === 'server').length }));
  return html`<div class="menu folder-menu" role="dialog" aria-label="Folders" ref=${ref} style=${{ left: `${pos.left}px`, top: `${pos.top}px` }} onKeyDown=${onKeyDown}>
    <div class="fm-filter">
      <${Icon} name="search" size=${15} />
      <input ref=${field} value=${query} placeholder="Find a folder, a server or a comparison" aria-label="Find a folder" spellcheck="false" autocomplete="off"
        onInput=${(e) => setQuery(e.currentTarget.value)} />
      <${ClearButton} value=${query} onClear=${() => setQuery('')} label="Clear" />
    </div>
    <div class="fm-body">
      ${q && !sections.length && !moreItems.length && html`<p class="muted small fm-none">Nothing matches “${query.trim()}”.</p>`}
      ${counted.map(
        (s) => html`<${FolderSection} key=${s.id} section=${s} long=${s.rows.length > 9} filtering=${Boolean(q)}>${sectionBlocks(s.rows, row)}</${FolderSection}>`,
      )}
      ${moreItems.some((a) => !a.separator) &&
      html`<${FolderSection} section=${{ id: 'actions', label: q ? 'Actions' : 'More' }}>
        ${moreItems.map((a, i) =>
          a.separator
            ? html`<div class="menu-separator" key=${`s${i}`} role="separator" />`
            : html`<button type="button" key=${a.key ?? a.label} data-nav="" class="menu-item fm-action ${a.danger ? 'danger' : ''}" disabled=${a.disabled} title=${a.hint}
                onClick=${() => (onClose(), a.run())}>${a.icon ? html`<${Icon} name=${a.icon} size=${15} />` : html`<span class="menu-icon" />`}<span>${a.label}</span>${a.hint && html`<span class="menu-hint">${a.hint}</span>`}${a.checked && html`<${Icon} name="check" size=${14} />`}</button>`,
        )}
      </${FolderSection}>`}
    </div>
    <div class="fm-foot muted small">Same drive: in place · elsewhere: beside · <kbd>Ctrl</kbd> beside · <kbd>Shift</kbd> in place</div>
  </div>`;
}
