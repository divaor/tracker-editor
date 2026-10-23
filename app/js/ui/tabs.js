import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { languageNames, PLAIN_TEXT } from '../editor.js';
import { formatBytes, timeAgo } from '../format.js';
import { getSettings, isSyncConfigured, saveSettings } from '../settings.js';
import { fileKey, parseKey, store } from '../store.js';
import { syncNow } from '../syncManager.js';
import { projectKey } from '../tracker-model.js';
import { ProjectChip } from './components.js';
import { Icon } from './icons.js';
import { serverLabel } from '../lspTools.js';
import { dictationSupported } from './dictation.js';
import { canDragOut, draggedTab, dropped, isOwnDrop, onDragOutEnd, startDragOut } from '../dragOut.js';
import { Menu, MenuButton } from './menu.js';
import { isRemotePath, KINDS, kindOfKey, protocolName, remoteAddress, remoteParts, whereState } from '../where.js';
import { server, serverStatus } from '../servers.js';
import { mirrorOf } from '../mirrors.js';
import { mirrorState } from './mirrors.js';
import { indentLabel } from '../indent.js';
import { problemsSummary } from './problems.js';

/** The server of a file on one ({ conn, status }), or null. */
const serverOf = (path) => {
  const { id } = remoteParts(path);
  return { conn: server(id), status: serverStatus(id) };
};

function tabInfo(key) {
  const k = parseKey(key);
  const kind = kindOfKey(key);
  if (k?.kind === 'file') {
    const f = store.get(k.id);
    return f && { kind, name: f.name, project: f.project, encrypted: f.encrypted, snippet: f.snippet, unsynced: f.dirty || f.pending, dotTitle: 'Not synced yet', title: `My files (synced): ${[f.project, f.name].filter(Boolean).join(' / ')}${f.encrypted ? ' · encrypted' : ''}` };
  }
  if (k?.kind === 'disk') {
    const d = store.diskTab(k.path);
    if (!d) return null;
    if (kind === 'remote') {
      const { conn } = serverOf(d.path);
      return { kind, name: d.name, project: '', unsynced: d.dirty, follow: d.follow, offline: d.offline, dotTitle: 'Not saved to the server', title: `On ${conn?.name ?? 'a server'}: ${remoteAddress(d.path, conn)}${d.dirty ? ' · not saved to the server' : ''}` };
    }
    return { kind, name: d.name, project: '', unsynced: d.dirty, follow: d.follow, dotTitle: 'Not saved', title: `On this computer: ${d.path}${d.dirty ? ' · not saved' : ''}` };
  }
  const t = k && store.repoTab(k.path);
  return t && { kind, name: t.name, project: store.doc(k.path)?.project ?? '', unsynced: t.dirty, dotTitle: 'Not synced yet', title: `Tracker document: ${t.path}` };
}

/**
 * Where the open file lives and how it stands, colored by kind: "My files ·
 * Synced", "This computer · Not saved", "db1 · Saved on the server"…
 */
export function WhereChip({ kind, label, state, title, onClick }) {
  const tip = [title ?? KINDS[kind].hint, state.detail].filter(Boolean).join('\n');
  return html`<button type="button" class="where-chip kind-${kind} tone-${state.tone}" title=${tip} onClick=${onClick} aria-label=${`${label}: ${state.text}`}>
    <${Icon} name=${KINDS[kind].icon} size=${14} /><span class="where-label">${label}</span><span class="where-state">${state.text}</span>
  </button>`;
}

const syncInfo = (sync) => ({ configured: isSyncConfigured(), phase: sync?.phase });

// Unpinned tabs by project, in the order each project first appears; tabs
// without one last.
function groupTabs(keys) {
  const groups = new Map();
  for (const key of keys) {
    const project = tabInfo(key)?.project ?? '';
    const id = project ? projectKey(project) : '';
    if (!groups.has(id)) groups.set(id, { id, name: project, keys: [] });
    groups.get(id).keys.push(key);
  }
  const list = [...groups.values()];
  return [...list.filter((g) => g.id), ...list.filter((g) => !g.id)];
}

const narrowScreen = () => matchMedia('(max-width: 860px)').matches;
// A finger rather than a mouse: tabs get a ⋯ button and a long press for their menu.
const touchScreen = () => matchMedia('(pointer: coarse)').matches;
const LONG_PRESS_MS = 500;

/**
 * How many tabs are cut off at each edge of the scrolled strip, and whether to hint at
 * that edge ({ left, right, moreLeft, moreRight }): for a hidden tab, or more than the
 * width of the + button out of sight. `activeSide` is the edge the open tab is past
 * (less than half of it shows), or null.
 */
export function hiddenTabs(view, tabs, active = null) {
  const out = { left: 0, right: 0, activeSide: null };
  for (const t of tabs) {
    if (t.left < view.left - 1) out.left++;
    else if (t.right > view.right + 1) out.right++;
  }
  out.moreLeft = out.left > 0 || view.scrollLeft > 40;
  out.moreRight = out.right > 0 || view.scrollWidth - view.scrollLeft - view.width > 40;
  if (active) {
    const shown = Math.min(active.right, view.right) - Math.max(active.left, view.left);
    if (shown < (active.right - active.left) / 2) out.activeSide = active.left < view.left ? 'left' : 'right';
  }
  return out;
}

/** The tabs past the strip's edges, from the page: see hiddenTabs. */
function measureTabs(el) {
  const box = el.getBoundingClientRect();
  const tabs = [...el.querySelectorAll('.tab')].map((t) => t.getBoundingClientRect());
  const active = el.querySelector('.tab.active')?.getBoundingClientRect() ?? null;
  return hiddenTabs({ left: box.left, right: box.right, width: el.clientWidth, scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth }, tabs, active);
}

export function TabBar({ session, projects, settings, actions }) {
  const strip = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [menu, setMenu] = useState(null); // { key, at }
  const [edges, setEdges] = useState({ left: 0, right: 0, moreLeft: false, moreRight: false, activeSide: null });
  const [list, setList] = useState(null); // the menu of all the open tabs: { at }
  const listButton = useRef(null);
  const press = useRef(null); // a finger held on a tab: { timer, x, y, fired }
  const touch = touchScreen();
  useEffect(() => {
    const el = strip.current;
    const tab = el?.querySelector('.tab.active');
    if (!tab) return;
    // The last tab: all the way, so the + after it shows too.
    if (tab === [...el.querySelectorAll('.tab')].at(-1)) el.scrollLeft = el.scrollWidth;
    else tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [session.active, session.open.length, session.pinned?.length]);
  useEffect(() => onDragOutEnd(() => setDragging(null)), []);
  // The hints at the edges follow scrolling, resizing and tabs coming and going.
  const measure = () => {
    const el = strip.current;
    if (!el) return;
    const next = measureTabs(el);
    setEdges((prev) => (Object.keys(next).every((k) => prev[k] === next[k]) ? prev : next));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const el = strip.current;
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // A mouse wheel scrolls the tabs sideways (a touchpad's sideways swipe already does).
    const onWheel = (e) => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    };
    const resize = new ResizeObserver(later);
    resize.observe(el);
    el.addEventListener('scroll', later, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      el.removeEventListener('scroll', later);
      el.removeEventListener('wheel', onWheel);
    };
  }, []);
  const scrollBy = (dir) => strip.current?.scrollBy({ left: dir * Math.max(120, strip.current.clientWidth * 0.7), behavior: 'smooth' });
  /** Brings the open tab back into view (it may have been scrolled away). */
  const reveal = () => strip.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  const openList = () => {
    const r = (listButton.current ?? strip.current)?.getBoundingClientRect();
    if (r) setList({ at: { x: r.right, y: r.bottom + 4, right: true } });
  };
  // From Help and the View menu (actions.command): 'tabs:reveal', 'tabs:list'.
  useEffect(() => {
    const onReveal = () => reveal();
    const onList = () => openList();
    window.addEventListener('tabs:reveal', onReveal);
    window.addEventListener('tabs:list', onList);
    return () => (window.removeEventListener('tabs:reveal', onReveal), window.removeEventListener('tabs:list', onList));
  }, []);
  const openMenu = (key, at) => setMenu({ key, at });
  const endPress = () => {
    clearTimeout(press.current?.timer);
    if (press.current && !press.current.fired) press.current = null;
  };
  const pinned = session.pinned ?? [];
  const unpinned = session.open.filter((k) => !pinned.includes(k));
  const groups = settings.groupTabs ? groupTabs(unpinned) : [{ id: null, keys: unpinned }];
  const showHeaders = settings.groupTabs && groups.some((g) => g.id);
  const byKey = new Map(projects.map((p) => [p.key, p]));

  const menuItems = (key) => {
    const isPinned = pinned.includes(key);
    const at = session.open.indexOf(key);
    const group = settings.groupTabs ? groups.find((g) => g.keys.includes(key)) : null;
    const closable = (keys) => keys.filter((k) => !pinned.includes(k));
    const others = closable(session.open.filter((k) => k !== key));
    const right = closable(session.open.slice(at + 1));
    return [
      { label: isPinned ? 'Unpin' : 'Pin', icon: 'pin', run: () => store.pin(key, !isPinned) },
      !narrowScreen() &&
        (key === session.side
          ? { label: 'Close the side view', icon: 'columns', run: actions.closeSide }
          : { label: 'Open to the side', icon: 'columns', disabled: session.open.length < 2, run: () => actions.openSide(key) }),
      { label: 'History', icon: 'history', run: () => (actions.showInMain(key), actions.showHistory()) },
      { label: 'Compare with…', icon: 'columns', run: () => (actions.showInMain(key), actions.compareWith()) },
      { label: 'Compare with clipboard', icon: 'copy', run: () => (actions.showInMain(key), actions.compareWithClipboard()) },
      { separator: true },
      { label: 'Copy for Claude', icon: 'claude', run: () => actions.copyForClaude(key) },
      parseKey(key)?.kind === 'disk' && { label: 'Copy path', icon: 'copy', run: () => actions.copyPath(parseKey(key).path) },
      parseKey(key)?.kind === 'disk' && { label: 'Show in folder', icon: 'folder', run: () => actions.showOnDisk(parseKey(key).path) },
      { separator: true },
      { label: 'Close', icon: 'x', run: () => actions.close(key) },
      { label: 'Close others', disabled: !others.length, run: () => actions.closeMany(others) },
      { label: 'Close tabs to the right', disabled: !right.length, run: () => actions.closeMany(right) },
      group?.id && { label: `Close the ${group.name} tabs`, run: () => actions.closeMany(closable(group.keys)) },
      { label: 'Close all', disabled: !closable(session.open).length, run: () => actions.closeMany(closable(session.open)) },
      { separator: true },
      { label: 'Group tabs by project', checked: settings.groupTabs, run: () => saveSettings({ groupTabs: !getSettings().groupTabs }) },
    ];
  };

  const tab = (key) => {
    const info = tabInfo(key);
    if (!info) return null;
    const isActive = key === session.active;
    const isSide = key === session.side;
    const isPinned = pinned.includes(key);
    return html`<div key=${key} role="tab" aria-selected=${isActive} tabindex=${isActive ? 0 : -1}
        class="tab kind-${info.kind} ${isActive ? 'active' : ''} ${isSide ? 'side' : ''} ${isPinned ? 'pinned' : ''} ${info.unsynced ? 'unsynced' : ''} ${info.offline ? 'offline' : ''} ${dragging === key ? 'dragging' : ''}"
        title=${`${isSide ? `${info.title} · in the side view` : info.title}${touch ? '' : `\n${isPinned ? 'Double-click to unpin' : 'Double-click to pin'} · middle-click to close`}`}
        draggable=${!touch}
        onDragStart=${(e) => {
          setDragging(key);
          // Desktop: a real file drag, so the tab can go to other apps too (dragOut.js).
          const item = canDragOut() && actions.dragOutItem(key);
          if (item) {
            e.preventDefault();
            startDragOut(key, item);
            return;
          }
          e.dataTransfer.effectAllowed = 'copyMove';
          e.dataTransfer.setData('text/x-tab', key);
          // Dropped in another app (a chat box, another window), it is the text.
          const text = actions.tabText(key);
          if (text && text.length <= 1024 * 1024) e.dataTransfer.setData('text/plain', text);
        }}
        onDragEnd=${() => setDragging(null)}
        onDragOver=${(e) => dragging && e.preventDefault()}
        onDrop=${(e) => {
          const from = e.dataTransfer.getData('text/x-tab') || (isOwnDrop(e.dataTransfer) && draggedTab());
          if (from) {
            e.preventDefault();
            e.stopPropagation();
            store.move(from, session.open.indexOf(key));
            dropped();
            setDragging(null);
          }
        }}
        onClick=${() => {
          // The click that ends a long press only opened the menu.
          if (press.current?.fired) return void (press.current = null);
          actions.activate(key);
        }}
        onDblClick=${(e) => {
          if (e.target.closest('button')) return;
          e.stopPropagation();
          store.pin(key, !isPinned);
          actions.toast(isPinned ? `Unpinned “${info.name}”` : `Pinned “${info.name}”: it stays first and is kept when you close others. Double-click it again to unpin.`, { timeout: isPinned ? 2500 : 5000 });
        }}
        onMouseDown=${(e) => e.button === 1 && e.preventDefault()}
        onAuxClick=${(e) => e.button === 1 && (e.preventDefault(), actions.close(key))}
        onPointerDown=${(e) => {
          clearTimeout(press.current?.timer);
          press.current = null;
          if (e.pointerType !== 'touch') return;
          const at = { x: e.clientX, y: e.clientY };
          press.current = {
            ...at,
            fired: false,
            timer: setTimeout(() => {
              press.current.fired = true;
              navigator.vibrate?.(12);
              openMenu(key, at);
            }, LONG_PRESS_MS),
          };
        }}
        onPointerMove=${(e) => press.current && !press.current.fired && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10 && endPress()}
        onPointerUp=${endPress}
        onPointerCancel=${endPress}
        onContextMenu=${(e) => {
          e.preventDefault();
          openMenu(key, { x: e.clientX, y: e.clientY });
        }}
        onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && actions.activate(key)}>
      ${isPinned && html`<${Icon} name="pin" size=${12} class="tab-pin" />`}
      ${isSide && html`<${Icon} name="columns" size=${13} class="tab-side" />`}
      <${Icon} name=${info.follow ? 'follow' : KINDS[info.kind].icon} size=${13} class="tab-kind" />
      ${info.encrypted && html`<${Icon} name="lock" size=${12} class="tab-lock" />`}
      ${info.snippet && html`<${Icon} name="snippet" size=${12} class="tab-lock" />`}
      <span class="tab-name">${info.name}</span>
      <span class="tab-dot" title=${info.dotTitle} />
      ${touch &&
      isActive &&
      html`<button type="button" class="tab-close tab-menu" aria-label=${`More for ${info.name}`} aria-haspopup="menu" tabindex="-1"
        onClick=${(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(key, { x: r.right, y: r.bottom + 4, right: true });
        }}><${Icon} name="more" size=${15} /></button>`}
      <button type="button" class="tab-close" aria-label=${`Close ${info.name}`} tabindex="-1"
        onClick=${(e) => {
          e.stopPropagation();
          actions.close(key);
        }}><${Icon} name="x" size=${13} /></button>
    </div>`;
  };

  // At an edge with tabs past it: how many, and a click scrolls that way; when the open tab
  // is one of them, the hint stands out and a click brings it back.
  const hint = (side) => {
    const count = edges[side];
    const more = side === 'left' ? edges.moreLeft : edges.moreRight;
    if (!more) return null;
    const hasActive = edges.activeSide === side;
    const label = hasActive
      ? `Your open tab is to the ${side}: show it`
      : count
        ? `${count} more ${count === 1 ? 'tab' : 'tabs'} to the ${side}`
        : `More to the ${side}`;
    return html`<button type="button" class="tab-hint ${side} ${hasActive ? 'has-active' : ''}" aria-label=${label} title=${`${label} (or scroll with the mouse wheel)`} tabindex="-1"
      onClick=${() => (hasActive ? reveal() : scrollBy(side === 'left' ? -1 : 1))}>
      ${side === 'left' && html`<${Icon} name="chevronRight" size=${14} class="flip" />`}${hasActive && html`<span class="tab-hint-active" aria-hidden="true">open tab</span>`}${count > 0 && html`<span class="tab-hint-count">${count}</span>`}${side === 'right' && html`<${Icon} name="chevronRight" size=${14} />`}
    </button>`;
  };
  // Every open tab in a list, the open one checked; with tabs out of sight.
  const listItems = () => [
    { label: 'Show the open tab', icon: 'eye', disabled: !session.active, run: reveal },
    { separator: true },
    ...session.open.map((key) => {
      const info = tabInfo(key);
      return info && { key, label: info.name, icon: pinned.includes(key) ? 'pin' : KINDS[info.kind].icon, hint: info.project || KINDS[info.kind].label, checked: key === session.active, run: () => actions.activate(key) };
    }),
  ];
  const overflowing = edges.moreLeft || edges.moreRight;

  return html`<div class="tabbar-wrap"><div class="tabbar-strip">${hint('left')}<div class="tabbar" role="tablist" aria-label="Open files" ref=${strip}
      onDblClick=${(e) => e.target === e.currentTarget && actions.newFile()}>
    ${pinned.map(tab)}
    ${groups.map((g) => {
      const collapsed = showHeaders && session.collapsed?.includes(g.id || 'none');
      const shown = collapsed ? g.keys.filter((k) => k === session.active || k === session.side) : g.keys;
      const color = g.id ? byKey.get(g.id)?.color : null;
      return html`
        ${showHeaders &&
        html`<button type="button" key=${`group:${g.id}`} class="tab-group ${collapsed ? 'collapsed' : ''}" style=${color ? { '--pc': color } : undefined}
          aria-expanded=${!collapsed} title=${collapsed ? `Show the ${g.name || 'other'} tabs` : `Fold the ${g.name || 'other'} tabs`}
          onClick=${() => store.toggleGroup(g.id || 'none')}>
          ${g.id ? html`<span class="project-dot" />` : ''}<span>${g.name || 'Other'}</span>${collapsed && html`<span class="count">${g.keys.length}</span>`}
        </button>`}
        ${shown.map(tab)}`;
    })}
    <button type="button" class="tab-new" aria-label="New file" title="New file (Alt+N)" onClick=${() => actions.newFile()}><${Icon} name="plus" size=${16} /></button>
    ${menu && session.open.includes(menu.key) && html`<${Menu} items=${menuItems(menu.key)} at=${menu.at} label="Tab" onClose=${() => setMenu(null)} />`}
  </div>${hint('right')}</div>
    ${overflowing &&
    html`<button type="button" class="tab-list-btn ${edges.activeSide ? 'has-active' : ''}" ref=${listButton} aria-label="All open tabs" title=${`All open tabs (${session.open.length})${edges.activeSide ? ' · your open tab is out of sight' : ''}`}
      aria-haspopup="menu" aria-expanded=${Boolean(list)} onClick=${() => (list ? setList(null) : openList())}>
      <${Icon} name="chevronDown" size=${15} /><span class="tab-list-count">${session.open.length}</span>
    </button>`}
    ${list && html`<${Menu} items=${listItems()} at=${list.at} label="Open tabs" owner=${listButton} onClose=${() => setList(null)} />`}
  </div>`;
}

/** Project, tags and actions for the file in the active tab. */
// "1.2 MB"
const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The bar of a file on disk (or on a server) edited in place: saving, reloading, following it as it grows. */
function DiskBar({ disk, buttons, moreItems, actions }) {
  const { path, dirty, follow, conflict, missing, truncated, offline } = disk;
  const remote = isRemotePath(path);
  const srv = remote ? serverOf(path) : null;
  const readOnly = follow || truncated;
  const state = whereState({ kind: remote ? 'remote' : 'disk', disk, server: srv?.status });
  const location = remote ? remoteParts(path).path : path;
  const folder = location.slice(0, location.length - disk.name.length - 1) || location;
  const where = remote ? `${KINDS.remote.hint}\n${protocolName(srv.conn?.protocol)} · ${remoteAddress(path, srv.conn)}` : `${KINDS.disk.hint}\n${path}`;
  const encoding = `${disk.eol === 'crlf' ? 'Windows (CRLF)' : 'Unix (LF)'} line endings · ${disk.encoding === 'latin1' ? 'Windows-1252' : 'UTF-8'}${disk.bom ? ' with BOM' : ''}, kept when saving`;
  const elsewhere = remote ? 'on the server' : 'on disk';
  // In a mirrored folder: also kept on the other side.
  const mirrored = mirrorOf(path);
  return html`<div class="filebar-stack">
    <div class="filebar">
      <${WhereChip} kind=${remote ? 'remote' : 'disk'} label=${remote ? (srv.conn?.name ?? 'Server') : 'This computer'} state=${state} title=${where} onClick=${() => actions.showOnDisk(path)} />
      ${mirrored &&
      html`<button type="button" class="mirror-badge" onClick=${() => actions.syncMirror(mirrored.mirror.id)}
        title=${`Mirrored: kept the same as ${mirrored.side === 'local' ? `${server(mirrored.mirror.conn)?.name ?? 'the server'}: ${mirrored.mirror.remote}` : mirrored.mirror.local}. ${mirrorState(mirrored.mirror).text}. Click to sync now.`}>
        <span aria-hidden="true">⇄</span><span class="label">${mirrored.side === 'local' ? (server(mirrored.mirror.conn)?.name ?? 'Server') : 'This computer'}</span>
      </button>`}
      <span class="filebar-note" title=${`${remote ? remoteAddress(path, srv.conn) : path}\n${encoding}`}><span class="filebar-title">${disk.name}</span><span class="muted small filebar-path">${folder}</span></span>
      <span class="spacer" />
      ${buttons}
      <button type="button" class="btn ghost sm ${follow ? 'on' : ''}" aria-pressed=${follow} disabled=${missing}
        title=${follow ? 'Stop following (the file becomes editable)' : 'Follow the file as it grows, like tail -f (read-only meanwhile)'} onClick=${() => actions.followDisk(path, !follow)}>
        <${Icon} name="follow" size=${15} /><span class="label">Follow</span>
      </button>
      <button type="button" class="btn ghost sm" disabled=${missing} title=${`Read the file ${elsewhere} again`} onClick=${() => (dirty ? actions.openDialog({ type: 'reloadDisk', path }) : actions.reloadDisk(path))}>
        <${Icon} name="rotate" size=${15} /><span class="label">Reload</span>
      </button>
      ${!readOnly &&
      html`<button type="button" class="btn ${dirty || missing ? 'primary' : 'ghost'} sm" title=${remote ? 'Save to the server (Ctrl+S)' : 'Save to disk (Ctrl+S)'} disabled=${disk.saving} onClick=${() => actions.saveDisk(path)}>
        <${Icon} name="save" size=${15} /><span class="label">Save</span>
      </button>`}
      <${MenuButton} label="More" items=${moreItems} />
    </div>
    ${remote && offline &&
    html`<div class="filebar-notice warn" role="alert">
      <${Icon} name="cloudOff" size=${15} /><span>${srv.conn?.name ?? 'The server'} cannot be reached${srv.status.error ? `: ${srv.status.error.replace(/\.+$/, '')}` : ''}.${dirty ? ' Your edits are kept on this device; Save sends them when it is back.' : ''}</span>
      <span class="spacer" />
      <button type="button" class="btn sm" onClick=${() => actions.reconnectServer(remoteParts(path).id)}>Reconnect</button>
    </div>`}
    ${conflict &&
    html`<div class="filebar-notice warn" role="alert">
      <${Icon} name="alert" size=${15} /><span>The file changed ${elsewhere} while you were editing it here.</span>
      <span class="spacer" />
      <button type="button" class="btn ghost sm" onClick=${() => actions.compareDisk(path)}>Compare</button>
      <button type="button" class="btn ghost sm" onClick=${() => actions.reloadDisk(path)}>Reload (lose my edits)</button>
      <button type="button" class="btn sm" onClick=${() => actions.saveDisk(path, { force: true })}>Keep mine and save over it</button>
    </div>`}
    ${missing &&
    html`<div class="filebar-notice warn" role="status"><${Icon} name="alert" size=${15} /><span>The file is not ${elsewhere} any more (moved, renamed or deleted). Save puts it back.</span></div>`}
    ${truncated &&
    html`<div class="filebar-notice" role="status"><${Icon} name="disk" size=${15} /><span>A ${formatSize(disk.size)} file: showing its last part, read-only. Follow shows new lines as they are written.</span></div>`}
  </div>`;
}

export function FileBar({ file, repo, disk, sealed, projects, canPreview, preview, settings, sync, actions }) {
  const previewButton =
    canPreview &&
    html`<button type="button" class="btn ghost sm ${preview ? 'on' : ''}" aria-pressed=${preview} title="Show a reading view next to the text" onClick=${actions.togglePreview}><${Icon} name="eye" size=${15} /><span class="label">Preview</span></button>`;
  const listenButton = html`<button type="button" class="btn ghost sm" title="Read aloud from the cursor, or the selection (Alt+R)" onClick=${actions.readAloud}><${Icon} name="volume" size=${15} /><span class="label">Listen</span></button>`;
  const shareButton = html`<button type="button" class="btn ghost sm" title="Share: WhatsApp, Teams, email, copy…" onClick=${actions.share}><${Icon} name="share" size=${15} /><span class="label">Share</span></button>`;
  const moreItems = (id) => [
    disk && { label: 'Show in folder', icon: 'folder', run: () => actions.showOnDisk(disk.path) },
    disk && { label: 'Copy path', icon: 'copy', run: () => actions.copyPath(disk.path) },
    disk && { label: 'Copy into my files (synced)', icon: 'filePlus', run: () => actions.copyToFiles(disk.path) },
    disk && { label: 'Properties', icon: 'info', run: () => actions.showProperties(disk.path) },
    disk && (!isRemotePath(disk.path) || server(remoteParts(disk.path).id)?.protocol === 'sftp') && { label: 'Open a terminal in its folder', icon: 'terminal', run: () => actions.terminalHere(disk.path.slice(0, Math.max(disk.path.lastIndexOf('/'), disk.path.lastIndexOf('\\'))) || disk.path) },
    disk && { separator: true },
    id && { label: 'Details…', icon: 'tag', run: () => actions.openDialog({ type: 'file', id }) },
    !disk?.follow && { label: 'Format document (Shift+Alt+F)', icon: 'code', run: () => actions.formatDocument() },
    { label: 'Text tools: case, sort, duplicates, trim…', icon: 'edit', run: () => actions.openDialog({ type: 'help', query: 'Edit and text' }) },
    { label: 'Outline and links (Ctrl+Shift+O)', icon: 'list', run: actions.toggleOutline },
    { label: 'Filter lines (Alt+L)', icon: 'search', run: actions.toggleFilter },
    { label: 'Record or stop a macro (Ctrl+Shift+R)', icon: 'play', run: actions.toggleRecording },
    { label: 'Run the macro…', icon: 'skipForward', run: actions.runMacro },
    !disk && { label: 'History', icon: 'history', run: actions.showHistory },
    { label: 'Compare with…', icon: 'columns', run: actions.compareWith },
    { label: 'Compare with clipboard', icon: 'copy', run: actions.compareWithClipboard },
    { label: 'Text from an image…', icon: 'scan', run: actions.imageToText },
    dictationSupported() && !disk?.follow && { label: 'Dictate', icon: 'mic', run: actions.startDictation },
    window.desktop?.ocr && { label: 'Text from a screenshot…', icon: 'scan', run: actions.screenshotToText },
    id && { label: 'Send checklist to tracker…', icon: 'checklist', run: actions.sendChecklist },
    window.desktop?.typing && { label: 'Type into another window', icon: 'keyboard', run: () => actions.typeOut() },
    { label: disk && !isRemotePath(disk.path) ? 'Copy for Claude (the path)' : 'Copy for Claude (name and text)', icon: 'claude', run: () => actions.copyForClaude(store.session.active) },
    settings.llm.enabled && { label: 'Ask the model… (Ctrl+K)', icon: 'sparkle', run: actions.askSelection },
    { label: 'Insert snippet…', icon: 'snippet', run: actions.openSnippets },
    id && { label: 'Save as snippet', icon: 'snippet', run: actions.saveSnippet },
    id && { label: store.get(id)?.snippet ? 'Not a snippet' : 'Use as a snippet', icon: 'snippet', run: () => actions.toggleSnippet(id) },
    id && settings.llm.enabled && { label: 'Suggest project and tags', icon: 'sparkle', run: actions.suggestFiling },
    id && { label: store.get(id)?.encrypted ? 'Stop encrypting' : 'Encrypt', icon: store.get(id)?.encrypted ? 'unlock' : 'lock', run: () => actions.setEncrypted(id, !store.get(id)?.encrypted) },
    id && { separator: true },
    id && { label: 'Move to trash', icon: 'trash', danger: true, run: () => actions.remove(id) },
  ];
  if (disk) return html`<${DiskBar} disk=${disk} buttons=${[previewButton, listenButton, shareButton]} moreItems=${() => moreItems()} actions=${actions} />`;
  if (repo) {
    // A tracker document: its item's title and project; the path is in the tooltip.
    const doc = store.doc(repo.path);
    const project = doc?.project && projects.find((p) => p.key === projectKey(doc.project));
    return html`<div class="filebar">
      <${WhereChip} kind="doc" label="Tracker" state=${whereState({ kind: 'doc', repo })} title=${`${KINDS.doc.hint}\n${repo.path}`} />
      <span class="filebar-note" title=${`From the tracker: ${repo.path}`}><span class="filebar-title">${doc?.item.title || repo.name}</span></span>
      ${doc?.project && html`<${ProjectChip} project=${project} name=${doc.project} />`}
      <span class="spacer" />
      ${previewButton}
      ${listenButton}
      ${shareButton}
      <${MenuButton} label="More" items=${() => moreItems()} />
    </div>`;
  }
  if (!file) return null;
  const project = projects.find((p) => p.key === projectKey(file.project));
  const synced = html`<${WhereChip} kind="synced" label="My files" state=${whereState({ kind: 'synced', file, sync: syncInfo(sync) })}
    onClick=${() => (isSyncConfigured() ? syncNow() : (location.hash = '#/settings'))} />`;
  if (sealed) {
    return html`<div class="filebar">
      ${synced}
      ${file.project && html`<${ProjectChip} project=${project} name=${file.project} />`}
      <span class="filebar-note"><${Icon} name="lock" size=${14} />Encrypted · locked on this device</span>
      <span class="spacer" />
      <${MenuButton} label="More" items=${() => [{ label: 'Move to trash', icon: 'trash', danger: true, run: () => actions.remove(file.id) }]} />
    </div>`;
  }
  const linked = store.trackerItems().filter((i) => !i.deleted && i.url?.includes(`#/file/${encodeURIComponent(file.id)}`));
  return html`<div class="filebar">
    ${synced}
    ${file.project
      ? html`<${ProjectChip} project=${project} name=${file.project} onClick=${() => actions.openDialog({ type: 'file', id: file.id })} />`
      : html`<button type="button" class="btn ghost sm add-project" onClick=${() => actions.openDialog({ type: 'file', id: file.id })}><${Icon} name="folder" size=${14} />Add project</button>`}
    <span class="filebar-tags">
      ${file.tags.map((t) => html`<span class="tag" key=${t}>#${t}</span>`)}
      <button type="button" class="btn ghost sm" title="Name, project, tags and language" onClick=${() => actions.openDialog({ type: 'file', id: file.id })}><${Icon} name="tag" size=${14} />${file.tags.length ? 'Edit' : 'Tags'}</button>
    </span>
    <span class="spacer" />
    ${previewButton}
    ${listenButton}
    ${shareButton}
    ${settings.llm.enabled && html`<button type="button" class="btn ghost sm" title="Summarize with the model" onClick=${actions.summarize}><${Icon} name="sparkle" size=${15} /><span class="label">Summarize</span></button>`}
    <button type="button" class="btn ghost sm" title=${linked.length ? `On the tracker: ${linked.map((i) => i.title).join(', ')}` : 'Add to the tracker as a task, idea or doc to read'}
      onClick=${() => actions.openDialog({ type: 'send', id: file.id })}>
      <${Icon} name="send" size=${15} /><span class="label">${linked.length ? 'On tracker' : 'Send to tracker'}</span>
    </button>
    <${MenuButton} label="More" items=${() => moreItems(file.id)} />
  </div>`;
}

export function SyncBadge({ sync, compact = false }) {
  const configured = isSyncConfigured();
  let icon = 'cloud';
  let label;
  let cls = 'ok';
  if (sync.phase === 'disabled' || !configured) {
    icon = 'cloudOff';
    label = 'Sync off';
    cls = 'muted';
  } else if (sync.phase === 'syncing') {
    icon = 'sync';
    label = 'Syncing…';
    cls = 'busy';
  } else if (sync.phase === 'error') {
    icon = 'alert';
    label = 'Sync error';
    cls = 'error';
  } else if (sync.phase === 'offline') {
    icon = 'cloudOff';
    label = 'Offline';
    cls = 'warn';
  } else if (sync.pending) {
    icon = 'sync';
    label = `${sync.pending} unsynced`;
    cls = 'pending';
  } else {
    label = `Synced ${timeAgo(sync.lastSyncAt)}`;
  }
  const title = sync.error ?? (configured ? 'Sync now (Ctrl+S)' : 'Set up sync in Settings');
  return html`<button type="button" class="sync-badge ${cls} ${compact ? 'compact' : ''}" title=${title} aria-label=${label}
    onClick=${() => (configured ? syncNow() : (location.hash = '#/settings'))}>
    <${Icon} name=${icon} size=${16} />${!compact && html`<span>${label}</span>`}
  </button>`;
}

const INDENT_SOURCES = {
  detected: 'From the text',
  editorconfig: 'From .editorconfig',
  chosen: 'Picked for this file',
  default: 'The default (Settings → Editor)',
};

// The status bar's "Spaces: 4" / "Tab size: 4": tabs or spaces, the width, converting.
function IndentButton({ indent, actions }) {
  const [at, setAt] = useState(null);
  const button = useRef(null);
  const items = () => [
    { label: 'Indent with spaces', run: () => actions.setIndent({ tabs: false }), checked: !indent.tabs },
    { label: 'Indent with tabs', run: () => actions.setIndent({ tabs: true }), checked: indent.tabs },
    { separator: true },
    ...[2, 4, 8].map((n) => ({ label: `${n} ${indent.tabs ? 'columns per tab' : 'spaces'}`, key: `w${n}`, run: () => actions.setIndent({ size: n }), checked: indent.size === n })),
    { separator: true },
    { label: 'Convert the indentation to spaces', icon: 'replace', run: () => actions.convertIndent(false) },
    { label: 'Convert the indentation to tabs', icon: 'replace', run: () => actions.convertIndent(true) },
    { label: 'From the text again', icon: 'rotate', hint: INDENT_SOURCES[indent.source], run: () => actions.setIndent(null) },
  ];
  return html`<button type="button" ref=${button} class="status-item status-btn-text status-indent hide-narrow" aria-haspopup="menu" aria-expanded=${Boolean(at)}
      title=${`Indentation: ${INDENT_SOURCES[indent.source] ?? ''}. Click to change it or convert the file.`}
      onClick=${(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAt(at ? null : { x: r.right, y: r.top - 4, right: true, above: true });
      }}>${indentLabel(indent)}</button>
    ${at && html`<${Menu} items=${items()} at=${at} label="Indentation" owner=${button} onClose=${() => setAt(null)} />`}`;
}

// "5 lines changed" from the editor's Git changes.
const changedLines = (changes) => (changes ?? []).reduce((n, c) => n + (c.kind === 'deleted' ? 1 : c.to - c.from + 1), 0);

/**
 * The open file's language server: its state (click: the Language servers panel), or Set up…
 * when none is installed, or Start when it stopped.
 */
function ServerStatus({ lsp, open, actions }) {
  if (lsp.pending) return html`<span class="status-item status-lsp muted" title="Looking for a language server">Language server…</span>`;
  if (lsp.missing)
    return html`<button type="button" class="status-item status-btn-text status-lsp state-missing" title=${`No ${lsp.missing.language} language server on this computer: what to install`} onClick=${() => actions.setUpLanguageServer(lsp.missing)}>
      <${Icon} name="code" size=${13} /><span>Set up ${lsp.missing.language}…</span>
    </button>`;
  if (lsp.stopped)
    return html`<button type="button" class="status-item status-btn-text status-lsp state-stopped" title=${`${lsp.stopped} Click to start it again.`} onClick=${() => actions.retryLanguageServer()}>
      <${Icon} name="code" size=${13} /><span>${lsp.server ?? "Language server"} stopped · Start</span>
    </button>`;
  return html`<button type="button" class=${`status-item status-btn-text status-lsp state-${lsp.state}`} aria-pressed=${Boolean(open)} title=${`${lsp.server}: ${lsp.state === 'running' ? 'checks this file and answers F12, Shift+F12, F2, completion and hover' : lsp.message || lsp.state}. Click for the Language servers panel.`} onClick=${() => actions.showLanguageServers()}>
    <span class="server-dot state-${lsp.state}" aria-hidden="true" /><span>${serverLabel(lsp)}</span>
  </button>`;
}

export function StatusBar({ recording, big, cursor, language, file, repo, disk, settings, actions, problems, problemsOpen, git, lsp, lspOpen }) {
  const setLanguage = (value) => file && actions.patch(file.id, { language: value === 'auto' ? '' : value });
  let state = '';
  const kind = file ? 'synced' : repo ? 'doc' : disk ? (isRemotePath(disk.path) ? 'remote' : 'disk') : null;
  const srv = kind === 'remote' ? serverOf(disk.path) : null;
  if (file) state = file.dirty ? 'Saved on this device · not synced yet' : file.sha ? `Synced · edited ${timeAgo(file.modifiedAt)}${file.modifiedBy ? ` on ${file.modifiedBy}` : ''}` : 'Saved on this device';
  if (repo) state = repo.dirty ? 'Edited · goes to the tracker on the next sync' : 'Tracker file';
  if (kind === 'disk') state = disk.dirty ? 'Not saved to disk · Ctrl+S saves' : disk.follow ? 'Following the file as it grows' : 'File on this computer · not synced';
  if (kind === 'remote') state = `${protocolName(srv.conn?.protocol)} · ${remoteAddress(disk.path, srv.conn)}${disk.dirty ? ' · not saved to the server' : ''}`;
  const label = { synced: 'My files', doc: 'Tracker', disk: 'This computer', remote: srv?.conn?.name ?? 'Server' }[kind];
  const connection = srv && { connected: 'Connected', connecting: 'Connecting…', error: `Not connected: ${srv.status.error}`, disconnected: 'Not connected' }[srv.status.state];
  return html`<footer class="statusbar">
    ${kind &&
    html`<span class="status-where kind-${kind}" title=${connection ? `${KINDS[kind].hint}\n${connection}` : KINDS[kind].hint}>
      <${Icon} name=${KINDS[kind].icon} size=${13} /><span>${label}</span>${srv && html`<span class="conn-dot state-${srv.status.state}" aria-label=${connection} />`}
    </span>`}
    <span class="status-item status-state" title=${file ? `${formatBytes(store.text(file.id).length)}` : ''}>${state}</span>
    ${recording && html`<button type="button" class="status-item status-btn-text status-recording" title="Recording a macro: Ctrl+Shift+R stops" onClick=${actions.toggleRecording}>● Recording macro</button>`}
    ${big && html`<span class="status-item status-big" title="A very large file: highlighting, wrapping and completion are off to keep it fast">Large file</span>`}
    ${problems &&
    html`<button type="button" class="status-item status-btn-text status-problems ${problems.list.some((p) => p.severity === 'error') ? 'has-errors' : problems.list.length ? 'has-warnings' : ''}"
      aria-pressed=${Boolean(problemsOpen)} title=${`${problemsSummary(problems.list)} (Ctrl+Shift+M; F8 goes to the next)`} onClick=${actions.toggleProblems}>
      <${Icon} name="xCircle" size=${13} /><span>${problems.list.filter((p) => p.severity === 'error').length}</span>
      <${Icon} name="alert" size=${13} /><span>${problems.list.filter((p) => p.severity !== 'error').length}</span>
    </button>`}
    ${lsp && html`<${ServerStatus} lsp=${lsp} open=${lspOpen} actions=${actions} />`}
    ${git &&
    html`<button type="button" class="status-item status-btn-text status-git hide-narrow" disabled=${!git.tracked}
      title=${git.tracked ? `Git: branch ${git.branch}${git.changes ? ` · ${changedLines(git.changes) ? `${changedLines(git.changes)} line${changedLines(git.changes) === 1 ? '' : 's'} changed` : 'no changes'} since the last commit` : ''}. Click to compare.` : `Git: branch ${git.branch} · a new file, not committed yet`}
      onClick=${() => actions.compareWithHead()}>
      <${Icon} name="branch" size=${13} /><span>${git.branch}</span>${git.tracked && git.changes && changedLines(git.changes) > 0 ? html`<span class="git-count">±${changedLines(git.changes)}</span>` : ''}
    </button>`}
    <span class="spacer" />
    ${cursor?.scope && html`<button type="button" class="status-item status-btn-text status-scope hide-narrow" title=${`In ${cursor.scope} · Ctrl+P then @ goes to another`} onClick=${() => actions.gotoSymbol()}>
      <${Icon} name="code" size=${13} /><span>${cursor.scope}</span>
    </button>`}
    ${cursor && html`<span class="status-item">Ln ${cursor.line}, Col ${cursor.column}${cursor.selected ? ` (${cursor.selected} selected)` : ''}${cursor.cursors > 1 ? ` · ${cursor.cursors} cursors` : ''}</span>`}
    ${cursor && html`<span class="status-item hide-narrow">${cursor.lines} lines</span>`}
    ${file &&
    html`<label class="status-item status-select" title="Language (highlighting)">
      <select value=${file.language || 'auto'} onChange=${(e) => setLanguage(e.currentTarget.value)} aria-label="Language">
        <option value="auto">${file.language ? 'Auto (by name)' : `${language} (auto)`}</option>
        ${languageNames().map((name) => html`<option key=${name} value=${name}>${name}</option>`)}
      </select>
    </label>`}
    ${(repo || disk) && html`<span class="status-item">${language || PLAIN_TEXT}</span>`}
    ${cursor?.indent && html`<${IndentButton} indent=${cursor.indent} actions=${actions} />`}
    <button type="button" class="status-item status-btn-text ${settings.wordWrap ? 'on' : ''}" title="Word wrap (Alt+Z)" aria-pressed=${settings.wordWrap} onClick=${() => saveSettings({ wordWrap: !getSettings().wordWrap })}>
      <${Icon} name="wrap" size=${14} /><span class="hide-narrow">Wrap</span>
    </button>
    ${disk
      ? html`<span class="status-item hide-narrow" title="The file's encoding and line endings, kept when saving">${disk.encoding === 'latin1' ? 'Windows-1252' : 'UTF-8'}${disk.bom ? ' BOM' : ''} · ${disk.eol === 'crlf' ? 'CRLF' : 'LF'}</span>`
      : html`<span class="status-item hide-narrow">UTF-8 · LF</span>`}
  </footer>`;
}
