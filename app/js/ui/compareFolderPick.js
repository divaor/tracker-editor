// The other folder of a comparison or of two panes (desktop, Android app): one tree of where it
// can be, in blocks — the folder next to the other side, each folder shown in Folders (in its
// color, as there), other folders picked before, servers (connected when opened) — each folder
// listed when it is opened. Favorites and recent folders are chips that open the tree down to
// them; the filter narrows what is listed. Below: the system's folder dialog, a new server, a
// path typed on a server. folderPick.js (pure) builds the rows.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { pathName } from '../compares.js';
import { blockFor, moveIn, parentPath, pathKey, pickBlocks, pickRows, quickFolders, revealChain, rowKey, samePath, subfolders, trailLabel } from '../folderPick.js';
import { placeLabel, withCurrent } from '../folders.js';
import { getSettings } from '../settings.js';
import { onServers, server, servers, serverStatus } from '../servers.js';
import { folderColor } from '../tabGroups.js';
import { folderGroupOf } from '../tabViews.js';
import { isRemotePath, KINDS, protocolName, remoteParts, toRemoteUri } from '../where.js';
import { ClearButton, Modal } from './components.js';
import { Icon } from './icons.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const innerPath = (p) => remoteParts(p).path.replace(/\/+$/, '');
const serverName = (id) => server(id)?.name ?? 'Server';
/** Where a folder is, under its name: the folder holding it (on a server: the server's name first). */
function whereOf(p) {
  if (!p) return '';
  if (isRemotePath(p)) {
    const inner = innerPath(p);
    return `${serverName(remoteParts(p).id)} · ${inner ? inner.slice(0, inner.lastIndexOf('/')) || '/' : '/'}`;
  }
  return placeLabel(parentPath(p) || p);
}
/** A folder in full, for a tooltip or a folder outside every block. */
const fullPlace = (p) => (isRemotePath(p) ? `${serverName(remoteParts(p).id)}: ${innerPath(p) || '/'}` : placeLabel(p));

/**
 * The folder to compare with. `other` is the folder on the other side (marked, and not taken
 * unless `panes`, where two panes may show the same folder); `side` is where the pick goes.
 * `openServer` opens that server's block at once (back from adding it: `onNewServer`).
 */
export function CompareFolderDialog({ other = '', side = 'right', panes = false, openServer = '', onPick, onClose, onNewServer, actions }) {
  const settings = getSettings();
  const hidden = Boolean(settings.showHidden);
  const shown = withCurrent(settings.folderSections, settings.folder);
  const [roots, setRoots] = useState([]); // folders picked before
  const [, setTick] = useState(0);
  const [listings, setListings] = useState(() => new Map()); // pathKey → { state, folders, truncated, error }
  const asked = useRef(new Set());
  const live = useRef(true);
  // The folders open: pathKey → path. At first the folders shown in Folders (a few of them: not the
  // other side itself, nor a server not connected, which would connect), the one holding the
  // other side, and its block down to it.
  const [expanded, setExpanded] = useState(() => {
    const open = new Map();
    const add = (p) => p && open.set(pathKey(p), p);
    const inFolders = pickBlocks({ shown }).filter((b) => b.kind === 'shown');
    if (inFolders.length <= 4) for (const b of inFolders) if (!samePath(b.root, other) && (!b.server || serverStatus(b.server).state === 'connected')) add(b.root);
    if (other) {
      add(parentPath(other));
      const holder = blockFor(other, inFolders);
      if (holder) for (const p of revealChain(other, holder.root)) add(p);
    }
    return open;
  });
  const [conns, setConns] = useState({}); // server id → { state: 'connecting' | 'connected' | 'error', root, error }
  const [gone, setGone] = useState(false); // the folder next to the other side could not be listed
  const [selected, setSelected] = useState(null); // { key, path, block }
  const [filter, setFilter] = useState('');
  const [note, setNote] = useState(null);
  const [typing, setTyping] = useState(false);
  const [srv, setSrv] = useState('');
  const [path, setPath] = useState('');
  const [suggest, setSuggest] = useState([]);
  const [busy, setBusy] = useState(null);
  const tree = useRef(null);
  const pathField = useRef(null);

  useEffect(() => {
    live.current = true;
    window.desktop.folders.roots().then((r) => live.current && setRoots(r), () => {});
    const off = onServers(() => live.current && setTick((t) => t + 1));
    return () => {
      live.current = false;
      off();
    };
  }, []);

  // ---- Listing, opening, connecting ----
  const setListing = (key, value) => live.current && setListings((m) => new Map(m).set(key, value));
  const list = (p) => {
    const key = pathKey(p);
    if (!p || asked.current.has(key)) return;
    asked.current.add(key);
    setListing(key, { state: 'loading' });
    window.desktop.folders.list(p).then(
      (l) => setListing(key, { state: 'done', folders: subfolders(l.entries), truncated: Boolean(l.truncated) }),
      (err) => setListing(key, { state: 'error', error: message(err) }),
    );
  };
  const listAgain = (p) => {
    asked.current.delete(pathKey(p));
    list(p);
  };
  useEffect(() => {
    for (const p of expanded.values()) list(p);
  }, [expanded]);
  const open = (p, on = true) =>
    setExpanded((m) => {
      const next = new Map(m);
      if (on) next.set(pathKey(p), p);
      else next.delete(pathKey(p));
      return next;
    });
  const openAll = (paths) =>
    setExpanded((m) => {
      const next = new Map(m);
      for (const p of paths) next.set(pathKey(p), p);
      return next;
    });
  const connect = async (id) => {
    setConns((c) => ({ ...c, [id]: { state: 'connecting' } }));
    try {
      const { root } = await window.desktop.remote.connect(id);
      if (live.current) setConns((c) => ({ ...c, [id]: { state: 'connected', root } }));
      return root;
    } catch (err) {
      if (live.current) setConns((c) => ({ ...c, [id]: { state: 'error', error: message(err) } }));
      return null;
    }
  };
  /** A server's block opened: connected first, then its start folder listed. */
  const openServerBlock = async (id) => {
    if (conns[id]?.state === 'connecting') return null;
    const root = conns[id]?.root ?? (await connect(id));
    if (root) open(root);
    return root;
  };

  // ---- The blocks ----
  const connected = Object.fromEntries(Object.entries(conns).filter(([, c]) => c.root).map(([id, c]) => [id, c.root]));
  // Colors as Folders gives its headers; a folder picked before that is not shown there takes
  // one no block above it has, so no two blocks look alike.
  const taken = new Set();
  const blocks = pickBlocks({ other, shown, picked: roots, servers: servers().map((c) => c.id), connected })
    .filter((b) => !(b.kind === 'next' && gone))
    .map((b) => {
      const colored = settings.tabColors !== 'off' && b.root && b.kind !== 'server';
      let color = colored ? folderGroupOf(b.root, settings).color : null;
      if (color && b.kind === 'picked' && taken.has(color)) color = folderColor(b.root, taken);
      if (color && b.kind !== 'next') taken.add(color);
      if (b.kind === 'server') {
        const c = server(b.server);
        return { ...b, label: c?.name ?? 'Server', where: [`${protocolName(c?.protocol)} · ${c?.user ? `${c.user}@` : ''}${c?.host ?? ''}`, b.root && (innerPath(b.root) || '/')].filter(Boolean).join(' · '), remote: true, color };
      }
      const why = b.kind === 'next' ? `next to ${pathName(other)}` : b.kind === 'picked' ? 'picked before' : '';
      return { ...b, label: pathName(b.root), where: whereOf(b.root), why, remote: isRemotePath(b.root), color };
    });
  const byId = new Map(blocks.map((b) => [b.id, b]));
  // Where a folder belongs, for its trail and its color: the deepest block holding it (not the "next" one).
  const homeBlocks = blocks.filter((b) => b.kind !== 'next');
  const rows = pickRows(blocks, { expanded: new Set(expanded.keys()), listings, filter, hidden, other });

  // The folder next to the other side cannot be listed (outside the folders picked): left out.
  const nextRoot = other ? parentPath(other) : '';
  useEffect(() => {
    if (nextRoot && listings.get(pathKey(nextRoot))?.state === 'error') setGone(true);
  }, [listings]);
  // The other side inside a folder picked before (not one shown): its block opens down to it.
  useEffect(() => {
    if (!other || !roots.length || blockFor(other, homeBlocks.filter((b) => b.kind === 'shown'))) return;
    const holder = blockFor(
      other,
      homeBlocks.filter((b) => b.kind === 'picked'),
    );
    if (holder) openAll(revealChain(other, holder.root));
  }, [roots]);
  // Back from adding a server: its block opens, its start folder picked.
  useEffect(() => {
    if (!openServer) return;
    const inFolders = blocks.find((b) => b.kind === 'shown' && b.server === openServer);
    if (inFolders) {
      open(inFolders.root);
      setSelected({ key: rowKey(inFolders.id), path: inFolders.root, block: inFolders.id });
      return;
    }
    openServerBlock(openServer).then((root) => root && live.current && setSelected({ key: rowKey(`server:${openServer}`), path: root, block: `server:${openServer}` }));
  }, []);

  // ---- Picking ----
  const choose = (p) => {
    if (!p) return;
    if (samePath(p, other) && !panes) return setNote({ text: 'That is the folder on the other side: pick another one.', error: true });
    onPick(p);
    onClose();
  };
  const select = (r) => r && setSelected({ key: r.key, path: r.path, block: r.block });
  // The first row worth the cursor: while filtering, the first folder that fits.
  const firstRow = () => (filter.trim() && rows.find((r) => r.match)) || rows.find((r) => r.type !== 'status');
  const toggle = (r) => {
    const b = byId.get(r.block);
    if (r.type === 'head' && b?.kind === 'server' && !b.root) return openServerBlock(b.server);
    if (r.canOpen && r.path) open(r.path, !r.open);
  };
  const keyDown = (e) => {
    const at = rows.find((r) => r.key === selected?.key);
    const move = (how) => {
      e.preventDefault();
      const key = moveIn(rows, selected?.key, how);
      select(rows.find((r) => r.key === key));
    };
    if (e.key === 'ArrowDown') move('down');
    else if (e.key === 'ArrowUp') move('up');
    else if (e.key === 'Home') move('home');
    else if (e.key === 'End') move('end');
    else if (e.key === 'ArrowRight' && at) {
      e.preventDefault();
      if (at.open) move('child');
      else toggle(at);
    } else if (e.key === 'ArrowLeft' && at) {
      e.preventDefault();
      if (at.open && at.path) open(at.path, false);
      else move('parent');
    } else if (e.key === 'Enter' && at) {
      e.preventDefault();
      if (selected.path) choose(selected.path);
      else toggle(at);
    }
  };
  // The cursor kept in sight (below the sticky head of its block), once its row is there: a chip's
  // folder shows only when the folders on the way are listed.
  const follow = useRef(false);
  useEffect(() => {
    follow.current = true;
  }, [selected?.key]);
  useLayoutEffect(() => {
    if (!follow.current) return;
    const row = tree.current?.querySelector('[aria-selected="true"]');
    if (!row) return;
    follow.current = false;
    row.scrollIntoView({ block: 'nearest' });
  });

  /** A chip: its block opens down to it, and it is picked (connecting to its server first when needed). */
  const reveal = async (p) => {
    setFilter('');
    let holder = blockFor(p, homeBlocks);
    if (!holder && isRemotePath(p)) {
      const id = remoteParts(p).id;
      const root = blocks.some((b) => b.kind === 'server' && b.server === id) ? await openServerBlock(id) : null;
      if (root && blockFor(p, [{ root }])) holder = { id: `server:${id}`, root };
    }
    if (!live.current) return;
    if (holder) openAll([holder.root, ...revealChain(p, holder.root)]);
    setSelected({ key: holder ? rowKey(holder.id, samePath(p, holder.root) ? '' : p) : `chip|${pathKey(p)}`, path: p, block: holder?.id ?? '' });
  };

  const pickHere = async () => {
    const picked = await window.desktop.folders.pick(other && !isRemotePath(other) ? other : undefined);
    if (picked) choose(picked);
  };
  const newServer = () => (onNewServer ? onNewServer() : (onClose(), actions.editServer()));

  // ---- A path typed on a server: its folders are suggested as you go ----
  const typedServer = srv || servers()[0]?.id || '';
  const base = path.slice(0, path.lastIndexOf('/') + 1);
  const typedConnected = typedServer && serverStatus(typedServer).state === 'connected';
  useEffect(() => {
    if (!typing || !typedConnected || !base.startsWith('/')) return setSuggest([]);
    let stale = false;
    const timer = setTimeout(() => {
      window.desktop.folders.list(toRemoteUri(typedServer, base)).then(
        (l) => !stale && setSuggest(subfolders(l.entries).filter((f) => hidden || !f.hidden).map((f) => `${innerPath(f.path)}/`)),
        () => !stale && setSuggest([]),
      );
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [typing, typedServer, base, typedConnected]);
  const startTyping = async () => {
    if (!typedServer || typedConnected || busy) return;
    setBusy(typedServer);
    const root = await connect(typedServer);
    setBusy(null);
    // What was typed meanwhile stays.
    if (root) setPath((typed) => typed || `${innerPath(root) || ''}/`);
    pathField.current?.focus();
  };
  const useTyped = async (ev) => {
    ev.preventDefault();
    const typed = path.trim();
    if (!typedServer || !typed) return;
    if (!typed.startsWith('/')) return setNote({ text: 'Type the whole path, starting with / (for example /var/www/site).', error: true });
    const uri = toRemoteUri(typedServer, typed.replace(/\/+$/, '') || '/');
    setBusy('path');
    try {
      await window.desktop.folders.list(uri);
      choose(uri);
    } catch (err) {
      setNote({ text: `${typed}: ${message(err)}`, error: true });
    } finally {
      if (live.current) setBusy(null);
    }
  };

  // ---- The view ----
  const isPicked = (r) => selected?.key === r.key;
  const ids = new Map(rows.map((r, i) => [r.key, `cfp-row-${i}`]));
  const colorStyle = (color) => (color ? { '--gc': color } : undefined);
  const twist = (r, label) =>
    r.canOpen
      ? html`<button type="button" class="cfp-twist ${r.open ? 'open' : ''}" tabindex="-1" aria-label=${r.open ? `Close ${label}` : `Open ${label}`}
          onClick=${(e) => (e.stopPropagation(), toggle(r))} onDblClick=${(e) => e.stopPropagation()}><${Icon} name="chevronRight" size=${13} /></button>`
      : html`<span class="cfp-twist" />`;
  const otherTag = (r) => r.isOther && html`<span class="cfp-other" title=${panes ? 'The folder on the other side' : 'The folder on the other side: pick another one'}>the other side</span>`;
  const headRow = (b, r) => {
    const state = b.kind === 'server' ? (conns[b.server]?.state ?? serverStatus(b.server).state) : null;
    return html`<div class="cfp-head ${isPicked(r) ? 'selected' : ''} ${r.isOther && !panes ? 'other' : ''}" id=${ids.get(r.key)} role="treeitem" aria-level="1" aria-expanded=${r.open} aria-selected=${isPicked(r)}
        title=${b.root ? fullPlace(b.root) : `${b.label}: open it to connect`}
        onClick=${() => (b.kind === 'server' && !b.root ? openServerBlock(b.server) : select(r))} onDblClick=${() => b.root && choose(b.root)}>
      ${twist(r, b.label)}
      <${Icon} name=${b.remote ? 'server' : 'folder'} size=${15} class="cfp-head-icon" />
      <span class="cfp-head-name">${b.label}</span>
      ${b.why && html`<span class="cfp-why">${b.why}</span>`}
      <span class="cfp-head-where">${b.where}</span>
      ${otherTag(r)}
      ${state && html`<span class="conn-dot state-${state}" title=${state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…' : 'Not connected: opening it connects'} />`}
    </div>`;
  };
  const folderRow = (r) => html`<div class="cfp-row ${isPicked(r) ? 'selected' : ''} ${r.isOther && !panes ? 'other' : ''} ${r.match ? 'match' : ''}" id=${ids.get(r.key)} role="treeitem"
      aria-level=${r.depth + 1} aria-expanded=${r.canOpen ? r.open : undefined} aria-selected=${isPicked(r)} style=${{ '--depth': r.depth }} title=${fullPlace(r.path)}
      onClick=${() => select(r)} onDblClick=${() => choose(r.path)}>
    ${twist(r, r.name)}
    <${Icon} name=${r.open && r.canOpen ? 'folderOpen' : 'folder'} size=${15} class="cfp-icon" />
    <span class="cfp-name">${r.name}</span>
    ${otherTag(r)}
  </div>`;
  const statusRow = (r) => html`<div class="cfp-status ${r.state}" style=${{ '--depth': r.depth }} role="none">
    ${r.state === 'loading' && html`<span class="spinner" aria-hidden="true" />Reading…`}
    ${r.state === 'empty' && 'No folders in it'}
    ${r.state === 'truncated' && 'Only the first ones are listed: open one of them, or pick it with Browse.'}
    ${r.state === 'error' && html`<span class="error-text">${r.error}</span><button type="button" class="btn ghost sm" onClick=${() => listAgain(r.path)}>Try again</button>`}
  </div>`;
  // A server's block before it lists anything: connecting, or why it could not.
  const serverState = (b) => {
    const c = b.kind === 'server' && !b.root ? conns[b.server] : null;
    if (c?.state === 'connecting') return html`<div class="cfp-status" style=${{ '--depth': 1 }}><span class="spinner" aria-hidden="true" />Connecting…</div>`;
    if (c?.state === 'error')
      return html`<div class="cfp-status error" style=${{ '--depth': 1 }}><span class="error-text">${c.error}</span><button type="button" class="btn ghost sm" onClick=${() => openServerBlock(b.server)}>Try again</button></div>`;
    return null;
  };
  const grouped = new Map(blocks.map((b) => [b.id, []]));
  for (const r of rows) grouped.get(r.block)?.push(r);
  const blockView = (b) => {
    const list = grouped.get(b.id) ?? [];
    if (!list.length) return null;
    return html`<section key=${b.id} class="cfp-block kind-${b.remote ? 'remote' : 'disk'} ${b.color ? 'grouped' : ''} ${b.kind === 'next' ? 'next' : ''}" style=${colorStyle(b.color)} role="none">
      ${list.map((r) => (r.type === 'head' ? headRow(b, r) : r.type === 'folder' ? folderRow(r) : statusRow(r)))}
      ${!filter && serverState(b)}
    </section>`;
  };

  // The chips: favorites and recent folders that can be reached from here.
  const reachable = (p) => (isRemotePath(p) ? Boolean(server(remoteParts(p).id)) : Boolean(blockFor(p, homeBlocks)));
  const chips = quickFolders(settings.folderFavorites ?? [], settings.folderRecent ?? [], { leave: panes ? '' : other }).filter((c) => reachable(c.path));
  const chipColor = (p) => blockFor(p, homeBlocks)?.color ?? null;

  // The folder picked, in words: where it belongs ("site › src › lib"), else where it is.
  const pickedPath = selected?.path ?? '';
  const home = pickedPath ? blockFor(pickedPath, homeBlocks) : null;
  const trail = pickedPath ? (home ? trailLabel(pickedPath, home.root, home.label) : null) ?? fullPlace(pickedPath) : '';
  const blocked = Boolean(pickedPath) && samePath(pickedPath, other) && !panes;
  const otherSide = side === 'right' ? 'left' : 'right';
  const title = panes ? `The folder on the ${side}${other ? `, next to ${pathName(other)}` : ''}` : `Compare ${other ? pathName(other) : 'a folder'} with…`;
  const footer = html`<div class="cfp-picked" aria-live="polite">
      ${pickedPath
        ? html`<span class="cfp-dot kind-${isRemotePath(pickedPath) ? 'remote' : 'disk'}" style=${colorStyle(home?.color)} aria-hidden="true" /><strong class="cfp-picked-name">${pathName(pickedPath)}</strong><span class="cfp-trail" title=${fullPlace(pickedPath)}>${trail}</span>`
        : html`<span class="muted">Pick a folder in the tree${chips.length ? ' or above' : ''}.</span>`}
      ${other && html`<span class="cfp-side muted small">It goes on the ${side}; ${pathName(other)} stays on the ${otherSide}.</span>`}
    </div>
    <button type="button" class="btn" onClick=${onClose}>Cancel</button>
    <button type="button" class="btn primary" disabled=${!pickedPath || blocked} title=${blocked ? 'That is the folder on the other side' : ''} onClick=${() => choose(pickedPath)}>${panes ? 'Use this folder' : 'Compare'}</button>`;

  return html`<${Modal} title=${title} wide className="cfp-dialog" onClose=${onClose} footer=${footer}>
    <div class="cfp-top">
      <div class="cfp-filter">
        <${Icon} name="search" size=${15} />
        <input type="search" value=${filter} placeholder="Filter the folders shown" aria-label="Filter the folders shown" spellcheck="false"
          onInput=${(e) => setFilter(e.currentTarget.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault();
              e.stopPropagation();
              setFilter('');
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (!rows.some((r) => r.key === selected?.key)) select(firstRow());
              tree.current?.focus();
            } else if (e.key === 'Enter') {
              // Filtering: Enter picks the first folder that fits; again, it is taken.
              e.preventDefault();
              const at = rows.find((r) => r.key === selected?.key);
              if (at?.path && (!filter.trim() || at.match)) choose(at.path);
              else select(firstRow());
            }
          }} />
        <${ClearButton} value=${filter} onClear=${() => setFilter('')} label="Clear the filter" />
      </div>
      ${chips.length > 0 &&
      html`<div class="cfp-chips" role="toolbar" aria-label="Favorite and recent folders">
        ${chips.map(
          (c) => html`<button type="button" key=${c.path} class="cfp-chip kind-${isRemotePath(c.path) ? 'remote' : 'disk'} ${samePath(c.path, pickedPath) ? 'on' : ''}" style=${colorStyle(chipColor(c.path))}
            title=${`${c.kind === 'favorite' ? 'Favorite' : 'Recent'}: ${fullPlace(c.path)}`} onClick=${() => reveal(c.path)}>
            <${Icon} name=${c.kind === 'favorite' ? 'star' : 'clock'} size=${12} /><span class="cfp-dot" aria-hidden="true" /><span class="cfp-chip-name">${pathName(c.path)}</span>
          </button>`,
        )}
      </div>`}
    </div>
    ${note && html`<p class="notice ${note.error ? 'error' : ''}" role="status"><${Icon} name=${note.error ? 'alert' : 'info'} size=${15} /><span>${note.text}</span></p>`}
    <div class="cfp-tree" role="tree" aria-label="Folders to pick from" tabindex="0" aria-activedescendant=${ids.get(selected?.key)} ref=${tree} onKeyDown=${keyDown}>
      ${blocks.map(blockView)}
      ${filter && !rows.length && html`<p class="muted small cfp-none">No folder listed so far matches. Clear the filter and open folders to look further down.</p>`}
      ${!filter && !blocks.length && html`<p class="muted small cfp-none">No folders yet: browse for one below, or connect to a server.</p>`}
    </div>
    <div class="cfp-ways">
      <button type="button" class="btn sm" onClick=${pickHere}><${Icon} name="folderOpen" size=${15} />Browse ${KINDS.disk.label.toLowerCase()}…</button>
      ${window.desktop?.remote && html`<button type="button" class="btn sm" onClick=${newServer}><${Icon} name="server" size=${15} />Connect to a new server…</button>`}
      ${servers().length > 0 && html`<button type="button" class="btn ghost sm" aria-expanded=${typing} onClick=${() => setTyping((t) => !t)}><${Icon} name="edit" size=${15} />A path on a server…</button>`}
    </div>
    ${typing &&
    servers().length > 0 &&
    html`<form class="sbs-remote cfp-typed" onSubmit=${useTyped}>
      <div class="sbs-remote-row">
        <select value=${typedServer} aria-label="Server" onChange=${(e) => (setSrv(e.currentTarget.value), setPath(''), setSuggest([]))}>
          ${servers().map((c) => html`<option value=${c.id}>${c.name}</option>`)}
        </select>
        <input ref=${pathField} value=${path} list="cfp-paths" placeholder="/var/www/site" aria-label="Path on the server" spellcheck="false"
          onFocus=${startTyping} onInput=${(e) => setPath(e.currentTarget.value)} />
        <datalist id="cfp-paths">${suggest.map((s) => html`<option value=${s} />`)}</datalist>
        <button type="submit" class="btn sm" disabled=${!path.trim() || Boolean(busy)}>${busy === 'path' ? 'Checking…' : panes ? 'Use it' : 'Compare'}</button>
      </div>
      <span class="muted small">${busy === typedServer ? 'Connecting…' : typedConnected ? 'Its folders are suggested as you type.' : 'It connects when you click the path.'}</span>
    </form>`}
  </${Modal}>`;
}
