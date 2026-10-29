import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { draggedPaths, dropped, isOwnDrop } from '../dragOut.js';
import { baseName, breadcrumbs, isImageName, opensHere, opensInEditor, parentOf, peekKind, rangeOf, rootOf, selectionSummary, sortsUp, topmost } from '../folders.js';
import { formatBytes } from '../format.js';
import { pathName } from '../compares.js';
import { dropOperation, inFolder, itemsName, paneCommand, paneRows, sameNamed, transferable } from '../panes.js';
import { getSettings, saveSettings } from '../settings.js';
import { server, servers, serverStatus } from '../servers.js';
import { onTransfers, running } from '../transfers.js';
import { isRemotePath, remoteParts, remoteRoot } from '../where.js';
import { isAndroidApp } from '../platform.js';
import { toast } from './components.js';
import { FileIcon } from './fileIcon.js';
import { binName, DeleteDialog, ExistsDialog, NameField } from './folders.js';
import { FileViewer } from './folderPreview.js';
import { Icon } from './icons.js';
import { Menu, MenuButton } from './menu.js';
import { PHONE, SidewaysButton, useMedia } from './phone.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const fail = (err) => toast(message(err), { kind: 'error', timeout: 8000 });
const other = (side) => (side === 'left' ? 'right' : 'left');
const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) || p;
const count = (n, what = 'item') => `${n} ${what}${n === 1 ? '' : 's'}`;
// What a drag from a pane carries (the side and the paths; also kept here, since a drag's
// data cannot be read until the drop).
const PANE_DRAG = 'text/x-pane-paths';
let dragging = null; // { side, paths }
const shortDate = (ms) => {
  const d = new Date(ms);
  return d.toLocaleString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { year: 'numeric', month: 'short', day: 'numeric' });
};
/** Where a folder is, under its name: on a server, the server's name and the path there. */
const placeOf = (p) => (isRemotePath(p) ? `${server(remoteParts(p).id)?.name ?? 'Server'}: ${remoteParts(p).path || '/'}` : p);

/**
 * One of the two lists: the folder `path` (here or on a server), browsed on its own. It
 * reads its folder, keeps its selection and cursor, and tells the tab what the keys and
 * menus ask (`onCommand`); `handle` gives the tab its folder, what is picked, and `load`.
 */
function Pane({ side, path, root, active, settings, actions, handle, sort, onSort, onActivate, onGo, onCommand, onPick, drop }) {
  const bridge = window.desktop.folders;
  const [listing, setListing] = useState(null); // { entries, truncated } | { error }
  const [selected, setSelected] = useState(() => new Set());
  const [cursor, setCursor] = useState(null);
  const [anchor, setAnchor] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [creating, setCreating] = useState(null); // { kind, name }
  const [menu, setMenu] = useState(null); // { entry, at }
  const [viewing, setViewing] = useState(null);
  const list = useRef(null);
  const typed = useRef({ text: '', at: 0 });
  const comeFrom = useRef(null); // the folder gone up from: picked once the one above is read
  const up = root ? parentOf(path, root) : null;
  const rows = listing && !listing.error ? paneRows(listing.entries, { up, hidden: settings.showHidden, sort: sort.by, reverse: sort.reverse }) : up ? paneRows([], { up }) : [];
  const entries = rows.filter((r) => !r.up);
  const order = rows.map((r) => r.path);
  const byPath = new Map(rows.map((r) => [r.path, r]));

  const load = async () => {
    try {
      const l = await bridge.list(path);
      setListing(l);
      const present = new Set(l.entries.map((e) => e.path));
      if (comeFrom.current && present.has(comeFrom.current)) {
        select([comeFrom.current]);
        comeFrom.current = null;
      } else setSelected((sel) => ([...sel].every((p) => present.has(p)) ? sel : new Set([...sel].filter((p) => present.has(p)))));
    } catch (err) {
      setListing({ error: message(err) });
    }
  };
  useEffect(() => {
    setListing(null);
    setSelected(new Set());
    setCursor(null);
    setAnchor(null);
    setRenaming(null);
    setCreating(null);
    load();
  }, [path]);
  useLayoutEffect(() => {
    if (cursor) list.current?.querySelector(`[data-path="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const select = (paths, { at = paths[paths.length - 1] ?? null, keepAnchor = false } = {}) => {
    setSelected(new Set(paths));
    setCursor(at);
    if (!keepAnchor) setAnchor(at);
  };
  // What an action works on: the entries picked (a folder with what is inside it once), or the one the cursor is on.
  const targets = () => {
    const picked = entries.filter((e) => selected.has(e.path));
    if (!picked.length) {
      const e = cursor && byPath.get(cursor);
      return e && !e.up ? [e] : [];
    }
    const top = new Set(topmost(picked.map((e) => e.path)));
    return picked.filter((e) => top.has(e.path));
  };
  const goUp = () => {
    if (!up) return;
    comeFrom.current = path;
    onGo(up);
  };
  const openEntry = async (e) => {
    if (e.up) return goUp();
    if (e.dir) return onGo(e.path);
    const here = settings.folderMediaOpens !== 'program';
    if (here && peekKind(e.name) === 'image') return setViewing(e.path);
    if (!opensHere(e.name) || (peekKind(e.name) === 'doc' && !here)) return bridge.openExternal(e.path).catch(fail);
    const problem = await actions.openDiskPath(e.path, { report: false });
    if (problem && /not a text file/i.test(problem)) return bridge.openExternal(e.path).catch(fail);
    if (problem) toast(`${e.name}: ${problem}`, { kind: 'error' });
  };
  const openSelected = () => {
    const items = targets();
    if (items.length === 1 || (cursor && byPath.get(cursor)?.up)) return openEntry(items.length === 1 ? items[0] : byPath.get(cursor));
    for (const e of items.filter((x) => !x.dir).slice(0, 20)) openEntry(e);
  };
  const create = async ({ kind, name }) => {
    setCreating(null);
    try {
      const made = kind === 'folder' ? await bridge.newFolder(path, name) : await bridge.newFile(path, name, { text: '' });
      await load();
      select([made]);
      window.dispatchEvent(new CustomEvent('folders:reload'));
    } catch (err) {
      fail(err);
      setCreating({ kind, name });
    }
    list.current?.focus();
  };
  const rename = async (e, name) => {
    setRenaming(null);
    list.current?.focus();
    if (name === e.name) return;
    try {
      const to = await bridge.rename(e.path, name);
      actions.followDiskMoves([{ from: e.path, to }]);
      await onCommand('reloadAll');
      select([to]);
      toast(`Renamed to ${name}`, {
        timeout: 8000,
        action: {
          label: 'Undo',
          run: async () => {
            const back = await bridge.rename(to, e.name).catch(fail);
            if (back) actions.followDiskMoves([{ from: to, to: back }]), onCommand('reloadAll');
          },
        },
      });
    } catch (err) {
      fail(err);
    }
  };

  handle.current = {
    side,
    path,
    entries,
    targets,
    load,
    select,
    focus: () => list.current?.focus(),
    rename: () => targets().length === 1 && setRenaming(targets()[0].path),
    newFolder: () => setCreating({ kind: 'folder', name: 'New folder' }),
    newFile: () => setCreating({ kind: 'file', name: 'New file.txt' }),
  };

  const onKeyDown = (ev) => {
    if (ev.target.matches('input')) return;
    const handled = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    const mod = ev.ctrlKey || ev.metaKey;
    const at = order.indexOf(cursor);
    const moveCursor = (to) => {
      const next = order[Math.max(0, Math.min(order.length - 1, to))];
      if (!next) return;
      if (ev.shiftKey) select(rangeOf(order, anchor ?? next, next).filter((p) => !byPath.get(p)?.up), { at: next, keepAnchor: true });
      else if (mod) setCursor(next);
      else select(byPath.get(next)?.up ? [] : [next], { at: next });
    };
    const nav = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: order.length - 1, PageDown: at + 15, PageUp: at - 15 };
    if (ev.key in nav && !ev.altKey) return handled(), moveCursor(at === -1 ? 0 : nav[ev.key]);
    const row = cursor && byPath.get(cursor);
    // → goes into the folder at the cursor, ← up, as in a lynx-like file manager.
    if (ev.key === 'ArrowRight' && !mod && !ev.altKey && !ev.shiftKey) return handled(), row?.dir && openEntry(row);
    if (ev.key === 'ArrowLeft' && !mod && !ev.altKey && !ev.shiftKey) return handled(), goUp();
    const cmd = paneCommand(ev);
    if (cmd) {
      handled();
      if (cmd === 'open') return openSelected();
      if (cmd === 'up') return goUp();
      if (cmd === 'rename') return handle.current.rename();
      if (cmd === 'newFolder') return handle.current.newFolder();
      if (cmd === 'selectAll') return select(entries.map((e) => e.path), { at: cursor ?? entries[0]?.path ?? null });
      if (cmd === 'escape') return setSelected(new Set());
      if (cmd === 'view') return row && !row.dir && setViewing(row.path);
      if (cmd === 'properties') return actions.showProperties(targets().length === 1 ? targets()[0].path : path);
      if (cmd === 'mark') {
        if (row && !row.up) {
          const next = new Set(selected);
          next.has(row.path) ? next.delete(row.path) : next.add(row.path);
          setSelected(next);
        }
        const below = order[at + 1];
        if (below) setCursor(below);
        return;
      }
      return onCommand(cmd, side);
    }
    // Typing a name goes to it.
    if (ev.key.length === 1 && !mod && !ev.altKey && ev.key !== ' ') {
      handled();
      const now = Date.now();
      typed.current = { text: now - typed.current.at < 800 ? typed.current.text + ev.key.toLowerCase() : ev.key.toLowerCase(), at: now };
      const from = typed.current.text.length > 1 ? Math.max(at, 0) : at + 1;
      const hit = [...order.slice(from), ...order.slice(0, from)].find((p) => !byPath.get(p).up && byPath.get(p).name.toLowerCase().startsWith(typed.current.text));
      if (hit) select([hit]);
    }
  };

  const remote = isRemotePath(path);
  const conn = remote ? server(remoteParts(path).id) : null;
  const state = conn ? serverStatus(conn.id).state : null;
  const crumbs = root ? breadcrumbs(path, root) : [{ name: pathName(path), path }];
  const rootLabel = remote ? (conn?.name ?? 'Server') : null;
  const terminalFor = (p) => (isRemotePath(p) ? server(remoteParts(p).id)?.protocol === 'sftp' : Boolean(bridge.terminal));

  const entryItems = () => {
    const items = targets();
    const one = items.length === 1 ? items[0] : null;
    const files = items.filter((e) => !e.dir);
    const twin = one && sameNamed(onCommand('otherEntries', side) ?? [], one);
    return [
      { label: 'Open (Enter)', icon: one?.dir ? 'folderOpen' : 'file', run: openSelected },
      one && !one.dir && isImageName(one.name) && { label: 'View it large (Space)', icon: 'fullscreen', run: () => setViewing(one.path) },
      one && !one.dir && { label: 'Open with its program', icon: 'external', run: () => bridge.openExternal(one.path).catch(fail) },
      { separator: true },
      { label: `Copy to the ${other(side)} (F5)`, icon: side === 'left' ? 'arrowRight' : 'arrowLeft', run: () => onCommand('copy', side) },
      { label: `Move to the ${other(side)} (F6)`, icon: side === 'left' ? 'arrowRight' : 'arrowLeft', run: () => onCommand('move', side) },
      one?.dir && { label: `Open it on the ${other(side)} too`, icon: 'panes', run: () => onCommand('openOther', side, one.path) },
      twin && (twin.dir === one.dir) && (one.dir || (opensInEditor(one.name) && opensInEditor(twin.name))) &&
        { label: `Compare with the one on the ${other(side)}`, icon: 'compare', run: () => onCommand('compareTwin', side, [one, twin]) },
      files.length === 2 && items.length === 2 && files.every((e) => opensInEditor(e.name)) && { label: 'Compare the two', icon: 'compare', run: () => actions.compareDiskFiles(files[0].path, files[1].path) },
      { separator: true },
      one && { label: 'Rename (F2)', icon: 'edit', run: () => setRenaming(one.path) },
      { label: 'Delete (F8)', icon: 'trash', danger: true, run: () => onCommand('delete', side) },
      { separator: true },
      { label: one ? 'Copy path' : 'Copy paths', icon: 'copy', run: () => (one ? actions.copyPath(one.path) : navigator.clipboard.writeText(items.map((e) => e.path).join('\n')).then(() => toast('Paths copied'))) },
      one && { label: 'Properties (Alt+Enter)', icon: 'info', run: () => actions.showProperties(one.path) },
      one && terminalFor(one.path) && { label: one.dir ? 'Open a terminal here' : 'Open a terminal in its folder', icon: 'terminal', run: () => actions.terminalHere(one.dir ? one.path : dirOf(one.path)) },
    ];
  };
  const backgroundItems = () => [
    { label: 'New folder (F7)', icon: 'folderPlus', run: handle.current.newFolder },
    { label: 'New file', icon: 'filePlus', run: handle.current.newFile },
    { label: 'Refresh', icon: 'rotate', run: load },
    { label: `This folder on the ${other(side)} too`, icon: 'panes', run: () => onCommand('openOther', side, path) },
    { separator: true },
    { label: settings.showHidden ? 'Hide hidden files' : 'Show hidden files', icon: 'eye', run: () => saveSettings({ showHidden: !getSettings().showHidden }) },
    terminalFor(path) && { label: 'Open a terminal here', icon: 'terminal', run: () => actions.terminalHere(path) },
    { label: 'Properties of this folder', icon: 'info', run: () => actions.showProperties(path) },
    { label: 'Copy path', icon: 'copy', run: () => actions.copyPath(path) },
  ];

  const header = (id, label, cls) => {
    const on = sort.by === id;
    const way = sortsUp(id, sort.reverse);
    return html`<button type="button" class="pane-col ${cls} ${on ? 'on' : ''}" aria-sort=${on ? (way ? 'ascending' : 'descending') : 'none'} title=${`Sort by ${label.toLowerCase()}`}
      onClick=${() => onSort(on ? { by: id, reverse: !sort.reverse } : { by: id, reverse: false })}><span>${label}</span>${on && html`<${Icon} name="arrowUp" size=${12} class=${way ? '' : 'down'} />`}</button>`;
  };
  const row = (e) => {
    const isSel = selected.has(e.path);
    const name = renaming === e.path
      ? html`<${NameField} initial=${e.name} dir=${e.dir} label=${`New name for ${e.name}`} onDone=${(n) => rename(e, n)} onCancel=${() => (setRenaming(null), list.current?.focus())} />`
      : html`<span class="pane-name">${e.name}</span>`;
    return html`<div key=${e.up ? '..' : e.path} data-path=${e.path} role="option" aria-selected=${isSel}
      class="pane-row ${e.dir ? 'is-dir' : ''} ${e.up ? 'is-up' : ''} ${isSel ? 'selected' : ''} ${cursor === e.path ? 'cursor' : ''} ${e.hidden ? 'hidden-entry' : ''} ${drop.target === e.path && drop.side === side ? 'drop-target' : ''}"
      title=${e.up ? `Up to ${baseName(e.path)}` : isRemotePath(e.path) ? remoteParts(e.path).path : e.path}
      draggable=${!e.up && renaming !== e.path}
      onDragStart=${(ev) => drop.start(ev, side, e, selected.has(e.path) ? targets().map((t) => t.path) : [e.path], () => !selected.has(e.path) && select([e.path]))}
      ...${e.dir ? drop.props(side, e.path) : {}}
      onClick=${(ev) => {
        ev.stopPropagation();
        onActivate();
        if (e.up) return select([], { at: e.path });
        if (ev.shiftKey) select(rangeOf(order, anchor ?? e.path, e.path).filter((p) => !byPath.get(p)?.up), { at: e.path, keepAnchor: true });
        else if (ev.ctrlKey || ev.metaKey) {
          const next = new Set(selected);
          next.has(e.path) ? next.delete(e.path) : next.add(e.path);
          setSelected(next);
          setCursor(e.path);
          setAnchor(e.path);
        } else select([e.path]);
      }}
      onDblClick=${(ev) => (ev.stopPropagation(), openEntry(e))}
      onContextMenu=${(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onActivate();
        if (e.up) return setMenu({ entry: null, at: { x: ev.clientX, y: ev.clientY } });
        if (!selected.has(e.path)) select([e.path]);
        setMenu({ entry: e, at: { x: ev.clientX, y: ev.clientY } });
      }}>
      <span class="pane-cell-name">
        ${e.up ? html`<${Icon} name="arrowUp" size=${15} />` : e.dir ? html`<${Icon} name="folder" size=${15} />` : html`<${FileIcon} name=${e.name} size=${16} plain=${settings.fileIcons === false} />`}
        ${name}
      </span>
      <span class="pane-cell size">${e.dir ? '' : formatBytes(e.size)}</span>
      <span class="pane-cell date" title=${e.mtimeMs ? new Date(e.mtimeMs).toLocaleString() : ''}>${e.mtimeMs && !e.up ? shortDate(e.mtimeMs) : ''}</span>
    </div>`;
  };

  return html`<section class="pane ${side} ${active ? 'active' : ''} kind-${remote ? 'remote' : 'disk'}" aria-label=${`${side === 'left' ? 'Left' : 'Right'}: ${pathName(path)}`}
      onMouseDown=${onActivate}>
    <div class="pane-head" title=${placeOf(path)}>
      <${Icon} name=${remote ? 'server' : 'folder'} size=${15} />
      <span class="pane-head-name">${pathName(path)}</span>
      ${remote && html`<span class="conn-dot state-${state}" title=${state} />`}
      <span class="pane-head-where"><bdi>${placeOf(path)}</bdi></span>
      <span class="spacer" />
      <button type="button" class="icon-btn xs" aria-label="Up one folder" title="Up one folder (Backspace)" disabled=${!up} onClick=${goUp}><${Icon} name="arrowUp" size=${14} /></button>
      <button type="button" class="icon-btn xs" aria-label=${`Refresh the ${side}`} title="Read it again" onClick=${load}><${Icon} name="rotate" size=${14} /></button>
      <button type="button" class="icon-btn xs" aria-label=${`Another folder on the ${side}`} title=${`Another folder on the ${side} (here or on a server)`} onClick=${onPick}><${Icon} name="edit" size=${13} /></button>
    </div>
    <nav class="crumbs pane-crumbs" aria-label="Folder path">
      ${crumbs.map(
        (c, i) => html`${i > 0 && html`<span class="crumb-sep" key=${`s${i}`}>›</span>`}<button type="button" key=${c.path} class="crumb ${i === crumbs.length - 1 ? 'current' : ''} ${drop.target === c.path && drop.side === side ? 'drop-target' : ''}"
          aria-current=${i === crumbs.length - 1 ? 'location' : undefined} title=${isRemotePath(c.path) ? remoteParts(c.path).path || '/' : c.path} onClick=${() => onGo(c.path)} ...${i < crumbs.length - 1 ? drop.props(side, c.path) : {}}>${i === 0 && rootLabel ? rootLabel : c.name}</button>`,
      )}
    </nav>
    <div class="pane-columns" role="presentation">${header('name', 'Name', 'name')}${header('size', 'Size', 'size')}${header('modified', 'Modified', 'date')}</div>
    <div class="pane-list ${drop.target === path && drop.side === side ? 'drop-target' : ''}" role="listbox" aria-multiselectable="true" tabindex="0" ref=${list}
      aria-label=${`Files in ${pathName(path)} (${side})`}
      onKeyDown=${onKeyDown}
      onFocus=${onActivate}
      onClick=${() => setSelected(new Set())}
      onContextMenu=${(ev) => (ev.preventDefault(), onActivate(), setSelected(new Set()), setMenu({ entry: null, at: { x: ev.clientX, y: ev.clientY } }))}
      ...${drop.props(side, path)}>
      ${creating &&
      html`<div class="pane-row creating">
        <span class="pane-cell-name">${creating.kind === 'folder' ? html`<${Icon} name="folder" size=${15} />` : html`<${FileIcon} name=${creating.name} size=${16} />`}
          <${NameField} initial=${creating.name} dir=${creating.kind === 'folder'} label=${creating.kind === 'folder' ? 'New folder name' : 'New file name'}
            onDone=${(name) => create({ ...creating, name })} onCancel=${() => (setCreating(null), list.current?.focus())} /></span>
      </div>`}
      ${listing?.error &&
      html`<div class="pane-empty">
        <p class="error-text small">${listing.error}</p>
        <p><button type="button" class="btn sm" onClick=${(ev) => (ev.stopPropagation(), load())}>Try again</button> <button type="button" class="btn ghost sm" onClick=${(ev) => (ev.stopPropagation(), onPick())}>Another folder…</button></p>
      </div>`}
      ${!listing && html`<p class="muted small pane-empty">Reading the folder…</p>`}
      ${rows.map(row)}
      ${listing && !listing.error && !entries.length && !creating && html`<p class="muted small pane-empty">${(listing.entries ?? []).some((e) => e.hidden) && !settings.showHidden ? 'Only hidden files here.' : 'This folder is empty. Copy or drop files here.'}</p>`}
      ${listing?.truncated && html`<p class="muted small pane-empty">Showing the first ${listing.entries.length.toLocaleString()} entries.</p>`}
    </div>
    <div class="pane-foot muted small" aria-live="polite">${selectionSummary(entries, selected, formatBytes)}</div>
    ${menu && html`<${Menu} items=${menu.entry ? entryItems() : backgroundItems()} at=${menu.at} label=${menu.entry?.name ?? pathName(path)} onClose=${() => setMenu(null)} />`}
    ${viewing &&
    html`<${FileViewer} entries=${entries.filter((e) => !e.dir)} path=${viewing}
      onPath=${(p) => (setViewing(p), select([p]))}
      onOpen=${(e) => (setViewing(null), bridge.openExternal(e.path).catch(fail))}
      onOpenOutside=${(e) => bridge.openExternal(e.path).catch(fail)}
      onReadText=${(e) => (setViewing(null), actions.readImageFiles([e.path], dirOf(e.path)))}
      onClose=${() => (setViewing(null), list.current?.focus())} />`}
  </section>`;
}

/**
 * Two folders side by side in a tab, each browsed on its own (here or on any server), like
 * WinSCP's or Total Commander's two panes: F5 copies and F6 moves what is picked to the other
 * side (also the bar's buttons, or a drag), F7 makes a folder, F2 renames, F8 deletes, Tab
 * goes to the other side. **Compare these folders** turns the tab into their comparison.
 * The record's sides are where each pane is now, so the tab's name follows and it can be saved.
 */
export function PanesTab({ id, record, settings, actions, star = null }) {
  const bridge = window.desktop.folders;
  const [roots, setRoots] = useState(null);
  const [active, setActive] = useState('left');
  const [exists, setExists] = useState(null); // { names, target, run }
  const [doomed, setDoomed] = useState(null); // { side, entries }
  const [dropAt, setDropAt] = useState({ side: null, target: null });
  const panes = { left: useRef(null), right: useRef(null) };
  const left = record.left.path;
  const right = record.right.path;
  const pathOf = (side) => record[side].path;
  const sorts = record.sorts ?? {};
  const sortOf = (side) => sorts[side] ?? { by: 'name', reverse: false };

  useEffect(() => {
    bridge.roots().then(setRoots, () => setRoots([]));
  }, []);
  const rootFor = (p) => rootOf(p, [...(roots ?? []), ...servers().map((c) => remoteRoot(c.id))]);
  useLayoutEffect(() => {
    panes.left.current?.focus();
  }, []);
  const activate = (side) => {
    if (active !== side) setActive(side);
  };
  const focusSide = (side) => {
    setActive(side);
    panes[side].current?.focus();
  };
  const go = (side, path) => actions.updateCompare(id, { [side]: { path } });
  const reloadAll = () => Promise.all(['left', 'right'].map((s) => panes[s].current?.load()));
  // The pane showing `dir` (the other side first): what was copied or moved there is picked.
  const paneShowing = (dir, from) => [other(from), from].find((s) => pathOf(s) === dir);

  // Both folders are watched (apart from the sidebar's), and read again when the window comes back.
  useEffect(() => {
    const dirs = [...new Set([left, right])];
    bridge.watch(dirs, 'panes').catch(() => {});
    const off = bridge.onChanged((change) => ['left', 'right'].forEach((s) => pathOf(s) === change.dir && panes[s].current?.load()));
    const onFocus = () => reloadAll();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      bridge.watch(null, 'panes').catch(() => {});
      window.removeEventListener('focus', onFocus);
    };
  }, [left, right]);
  // A copy or move to or from a server ends in the background: both read again.
  useEffect(() => onTransfers((_jobs, job) => job && !running(job) && reloadAll()), []);
  // A server that connects again: its side is read again.
  const states = [left, right].filter(isRemotePath).map((p) => serverStatus(remoteParts(p).id).state).join(',');
  const statesBefore = useRef(states);
  useEffect(() => {
    if (states !== statesBefore.current && states.includes('connected')) reloadAll();
    statesBefore.current = states;
  }, [states]);

  const after = () => window.dispatchEvent(new CustomEvent('folders:reload'));
  const copyNow = async (from, paths, target, onExists) => {
    try {
      const copies = await bridge.copy(paths, target, { onExists });
      // To or from a server: in the background (the Transfers card); both are read again when it ends.
      if (copies.transfer) return;
      if (!copies.length) return toast('Nothing was copied: those are there already.');
      await reloadAll();
      const there = paneShowing(target, from);
      if (there) panes[there].current?.select(copies.map((c) => c.to));
      after();
      toast(`Copied ${count(copies.length)} to ${pathName(target)}`, { timeout: 8000, action: { label: 'Undo', run: () => bridge.trash(copies.map((c) => c.to)).then(reloadAll, fail) } });
    } catch (err) {
      fail(err);
    }
  };
  const moveNow = async (from, paths, target, onExists) => {
    try {
      const moves = await bridge.move(paths, target, { onExists });
      if (moves.transfer) return;
      if (!moves.length) return toast('Nothing was moved: those are there already.');
      actions.followDiskMoves(moves);
      await reloadAll();
      const there = paneShowing(target, from);
      if (there) panes[there].current?.select(moves.map((m) => m.to));
      after();
      toast(`Moved ${count(moves.length)} to ${pathName(target)}`, {
        timeout: 8000,
        action: {
          label: 'Undo',
          run: async () => {
            const back = [];
            for (const m of moves) back.push(...(await bridge.move([m.to], dirOf(m.from)).catch((err) => (fail(err), []))));
            actions.followDiskMoves(back);
            reloadAll();
          },
        },
      });
    } catch (err) {
      fail(err);
    }
  };
  /** Copies or moves `paths` (from the `from` side) into `target`: names already there are asked about first. */
  const transfer = async (op, from, paths, target) => {
    const { go: list, here, into } = transferable(paths, target);
    if (!list.length) {
      if (into.length) return toast('A folder cannot go into itself, or into a folder inside it.');
      return here.length && toast(`${itemsName(here)} ${here.length === 1 ? 'is' : 'are'} already in ${pathName(target)}.`);
    }
    const run = (onExists) => (op === 'copy' ? copyNow : moveNow)(from, list, target, onExists);
    const taken = await bridge.existing(target, list.map(baseName)).catch(() => []);
    if (!taken.length) return run('keep');
    setExists({ names: taken, target, run });
  };
  const copyIn = async (files, target) => {
    const run = async (onExists) => {
      try {
        const copies = await bridge.copyIn(files, target, { onExists });
        if (copies.transfer) return;
        await reloadAll();
        after();
        toast(copies.length ? `Added ${count(copies.length)} to ${pathName(target)}` : 'Nothing was added: those are there already.');
      } catch (err) {
        fail(err);
      }
    };
    const taken = await bridge.existing(target, files.map((f) => f.name).filter(Boolean)).catch(() => []);
    if (!taken.length) return run('keep');
    setExists({ names: taken, target, run });
  };
  const remove = async ({ side, entries }) => {
    setDoomed(null);
    try {
      const gone = await bridge.trash(entries.map((e) => e.path));
      actions.closeDiskPaths(gone);
      await reloadAll();
      after();
      toast(isRemotePath(entries[0]?.path) || isAndroidApp() ? `Deleted ${count(gone.length)}` : `Moved ${count(gone.length)} to ${binName()}`);
    } catch (err) {
      fail(err);
      reloadAll();
    }
    panes[side].current?.focus();
  };

  /** What a pane's keys and menus ask of the tab. */
  const command = (cmd, side = active, arg) => {
    const pane = panes[side].current;
    if (cmd === 'reloadAll') return reloadAll();
    if (cmd === 'otherEntries') return panes[other(side)].current?.entries;
    if (cmd === 'switch') return focusSide(other(side));
    if (cmd === 'openOther') return go(other(side), arg);
    if (cmd === 'compareTwin') {
      const [mine, theirs] = side === 'left' ? arg : [arg[1], arg[0]];
      return mine.dir ? actions.compareFolders(mine.path, theirs.path) : actions.compareDiskFiles(mine.path, theirs.path);
    }
    const items = pane?.targets() ?? [];
    if (cmd === 'copy' || cmd === 'move') {
      if (!items.length) return toast(`Pick what to ${cmd} first (click, Ctrl+click, Shift+click or Ctrl+A).`);
      return transfer(cmd, side, items.map((e) => e.path), pathOf(other(side)));
    }
    if (cmd === 'delete') return items.length && setDoomed({ side, entries: items });
    if (cmd === 'rename') return pane?.rename();
    if (cmd === 'newFolder') return pane?.newFolder();
  };

  // Dragging: from one side to the other (or onto a folder on either side). Within one place it
  // moves, between places it copies (Ctrl copies, Shift moves); files from other apps are copied in.
  const drop = {
    side: dropAt.side,
    target: dropAt.target,
    start(ev, side, e, paths, pickIt) {
      pickIt();
      dragging = { side, paths: topmost(paths) };
      ev.dataTransfer.effectAllowed = 'copyMove';
      ev.dataTransfer.setData(PANE_DRAG, JSON.stringify(dragging));
      ev.dataTransfer.setData('text/plain', dragging.paths.join('\n'));
    },
    props: (side, target) => ({
      onDragOver: (ev) => {
        const types = ev.dataTransfer?.types ?? [];
        const ours = dragging;
        const fromFolders = types.includes('text/x-folder-paths') || draggedPaths().length > 0;
        if (!ours && !fromFolders && !types.includes('Files')) return;
        if (ours && (ours.paths.includes(target) || ours.paths.every((p) => inFolder(p, target)))) return;
        ev.preventDefault();
        ev.stopPropagation();
        const from = ours?.paths[0] ?? draggedPaths()[0];
        ev.dataTransfer.dropEffect = from ? dropOperation(from, target, ev) : 'copy';
        if (dropAt.side !== side || dropAt.target !== target) setDropAt({ side, target });
      },
      onDragLeave: (ev) => !ev.currentTarget.contains(ev.relatedTarget) && setDropAt((d) => (d.target === target && d.side === side ? { side: null, target: null } : d)),
      onDrop: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setDropAt({ side: null, target: null });
        const ours = dragging;
        dragging = null;
        if (ours) return transfer(dropOperation(ours.paths[0], target, ev), ours.side, ours.paths, target);
        // From the Folders sidebar (files on a server, or files here dragged out and back).
        const fromServer = ev.dataTransfer.getData('text/x-folder-paths');
        if (fromServer) {
          const paths = JSON.parse(fromServer);
          return transfer(dropOperation(paths[0], target, ev), side, paths, target);
        }
        if (isOwnDrop(ev.dataTransfer)) {
          const paths = draggedPaths();
          dropped();
          if (paths.length) return transfer(dropOperation(paths[0], target, ev), side, paths, target);
        }
        const files = [...(ev.dataTransfer?.files ?? [])];
        if (files.length) copyIn(files, target);
      },
    }),
  };
  useEffect(() => {
    const end = () => ((dragging = null), setDropAt({ side: null, target: null }));
    window.addEventListener('dragend', end);
    return () => window.removeEventListener('dragend', end);
  }, []);

  // A phone held upright: one pane at a time, a switch between them, the rest in ⋯.
  const phone = useMedia(PHONE);
  const to = other(active);
  const arrow = active === 'left' ? 'arrowRight' : 'arrowLeft';
  const label = (text) => (active === 'left' ? html`<span class="label">${text}</span><${Icon} name=${arrow} size=${14} />` : html`<${Icon} name=${arrow} size=${14} /><span class="label">${text}</span>`);
  const moreItems = () => [
    ...(phone
      ? [
          { label: 'New folder', icon: 'folderPlus', run: () => command('newFolder') },
          { label: 'Rename', icon: 'edit', run: () => command('rename') },
          { label: 'Delete', icon: 'trash', danger: true, run: () => command('delete') },
          { label: 'Read both folders again', icon: 'sync', run: reloadAll },
          { separator: true },
        ]
      : []),
    { label: 'Swap the sides', icon: 'rotate', run: () => actions.updateCompare(id, { left: record.right, right: record.left }) },
    { label: 'The left folder on the right too', icon: 'arrowRight', disabled: left === right, run: () => go('right', left) },
    { label: 'The right folder on the left too', icon: 'arrowLeft', disabled: left === right, run: () => go('left', right) },
    { separator: true },
    { label: 'New file on the side in use', icon: 'filePlus', run: () => panes[active].current?.newFile() },
    { label: settings.showHidden ? 'Hide hidden files' : 'Show hidden files', icon: 'eye', run: () => saveSettings({ showHidden: !getSettings().showHidden }) },
    { label: 'Open both in Folders', icon: 'folderOpen', run: () => actions.showSections?.([left, right], right) },
  ];

  // The bar's buttons do not take the focus: the keys stay with the list in use (F5 elsewhere runs a file).
  return html`<div class="panes-tab" role="region" aria-label="Two panes">
    <div class="ccmp-bar panes-bar" onMouseDown=${(ev) => ev.target.closest('button') && ev.preventDefault()}>
      ${star}
      <${SidewaysButton} />
      <button type="button" class="btn ghost sm" title="Compare the two folders shown: what differs, file by file (and back to the two panes from there)"
        onClick=${() => actions.updateCompare(id, { mode: 'folders', show: record.show ?? 'diff', expanded: [] })}><${Icon} name="compare" size=${15} /><span class="label wide">Compare these folders</span></button>
      <span class="ccmp-gap" />
      <button type="button" class="btn ghost sm" title=${`Copy what is picked on the ${active} to the ${to} (F5)`} onClick=${() => command('copy')}>${label('Copy')}</button>
      <button type="button" class="btn ghost sm" title=${`Move what is picked on the ${active} to the ${to} (F6)`} onClick=${() => command('move')}>${label('Move')}</button>
      ${!phone &&
      html`<span class="ccmp-gap" />
        <button type="button" class="icon-btn sm" aria-label="New folder (F7)" title="New folder (F7)" onClick=${() => command('newFolder')}><${Icon} name="folderPlus" size=${16} /></button>
        <button type="button" class="icon-btn sm" aria-label="Rename (F2)" title="Rename (F2)" onClick=${() => command('rename')}><${Icon} name="edit" size=${15} /></button>
        <button type="button" class="icon-btn sm" aria-label="Delete (F8)" title="Delete (F8)" onClick=${() => command('delete')}><${Icon} name="trash" size=${15} /></button>`}
      <span class="spacer" />
      ${!phone &&
      html`<span class="muted small panes-keys">Tab: the other side · F5 copy · F6 move</span>
        <button type="button" class="icon-btn sm" aria-label="Read both folders again" title="Read both folders again" onClick=${reloadAll}><${Icon} name="sync" size=${15} /></button>`}
      <${MenuButton} label="More" items=${moreItems} />
    </div>
    ${phone &&
    html`<div class="panes-switch" role="tablist" aria-label="Which side shows">
      ${['left', 'right'].map(
        (side) => html`<button type="button" key=${side} role="tab" aria-selected=${active === side} class="panes-switch-btn ${side} ${active === side ? 'on' : ''} kind-${isRemotePath(pathOf(side)) ? 'remote' : 'disk'}"
          onClick=${() => activate(side)}><span class="panes-switch-mark">${side === 'left' ? '◧' : '◨'}</span><span class="panes-switch-name">${pathName(pathOf(side))}</span></button>`,
      )}
    </div>`}
    <div class="panes ${phone ? 'one' : ''}">
      ${['left', 'right'].map(
        (side) => html`<${Pane} key=${side} side=${side} path=${pathOf(side)} root=${roots ? rootFor(pathOf(side)) : null} active=${active === side} settings=${settings} actions=${actions}
          handle=${panes[side]} sort=${sortOf(side)} onSort=${(s) => actions.updateCompare(id, { sorts: { ...sorts, [side]: s } }, { silent: false })}
          onActivate=${() => activate(side)} onGo=${(p) => go(side, p)} onCommand=${command} onPick=${() => actions.pickCompareFolder({ id, side })} drop=${drop} />`,
      )}
    </div>
    ${exists && html`<${ExistsDialog} names=${exists.names} target=${exists.target} onChoose=${(how) => (setExists(null), exists.run(how))} onClose=${() => (setExists(null), panes[active].current?.focus())} />`}
    ${doomed && html`<${DeleteDialog} entries=${doomed.entries} onConfirm=${() => remove(doomed)} onClose=${() => (setDoomed(null), panes[doomed.side].current?.focus())} />`}
  </div>`;
}
