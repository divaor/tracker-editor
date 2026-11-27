import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { addSection, baseName, folderLabel, isWithin, moveSectionTo, parentPath, replaceSection, rootOf, upOf, withCurrent } from '../folders.js';
import { folderListModel } from '../folderList.js';
import { isAndroidApp } from '../platform.js';
import { getSettings } from '../settings.js';
import { onServers, server, servers, serverStatus } from '../servers.js';
import { folderGroupOf } from '../tabViews.js';
import { connDetail, connIcon, connLabel, isPlace, isRemotePath, KINDS, remoteParts, toRemoteUri } from '../where.js';
import { ClearButton, Modal } from './components.js';
import { blocksOf, FolderSection, navKey, placeWhereOf } from './folderMenu.js';
import { Icon } from './icons.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const innerPath = (p) => remoteParts(p).path.replace(/\/+$/, '');
/** A folder's name: its own, or the server's for a server's top folder. */
const nameOf = (p) => (isRemotePath(p) ? (innerPath(p) ? baseName(innerPath(p)) : (server(remoteParts(p).id)?.name ?? 'Server')) : folderLabel(p));
const DRIVE_ICONS = { drive: 'disk', share: 'server', storage: 'disk', home: 'home', volume: 'disk', top: 'folder' };
const STATES = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected', error: 'Cannot connect' };

/**
 * The folders shown side by side in the folders view (0.54 look): two parts. **Shown side by
 * side**: the draft, in order (dragged, or ↑ ↓), each edged in its color, × takes one out.
 * **Add a folder**: the sections of Folders' list (folderList.js) with a filter: favorites, the
 * folders picked here by drive (nested), servers and places as cards (the server's head with
 * its kind, address and state; its start folder, the folders used there, and its own "Path on
 * this server…" field, whose ~ and $HOME are the server's home), recent ones, and Pick a folder…
 * Each row is one button with the add mark at its right edge; rows already there say Added.
 * Nothing changes until Show.
 */
export function SideBySideDialog({ onClose, actions }) {
  const settings = getSettings();
  const before = useRef(withCurrent(settings.folderSections, settings.folder));
  const [draft, setDraft] = useState(before.current);
  const [roots, setRoots] = useState([]);
  const [home, setHome] = useState('');
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(null); // what is connecting or being checked
  const [note, setNote] = useState(null); // { text, error }
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null); // { path, after }
  const [query, setQuery] = useState('');
  const [typing, setTyping] = useState({}); // server id → the path typed in its card
  const [suggest, setSuggest] = useState({ id: '', list: [] });
  const [active, setActive] = useState(''); // the server whose path field has the focus
  const addPart = useRef(null);
  const filterField = useRef(null);
  useEffect(() => {
    window.desktop.folders.roots().then(setRoots, () => {});
    window.desktop.folders.places?.().then((p) => setHome(p?.home ?? ''), () => {});
    return onServers(() => setTick((t) => t + 1));
  }, []);
  // Each folder in the color of its tab group, as its header in the tree (once per dialog).
  const colors = useMemo(() => new Map(), []);
  const colorOf = (p) => {
    if (settings.tabColors === 'off') return null;
    if (!colors.has(p)) colors.set(p, folderGroupOf(p, settings).color ?? null);
    return colors.get(p);
  };

  const added = (p) => draft.some((s) => isWithin(p, s));
  const add = (p) => {
    const next = addSection(draft, p);
    setNote(next === draft ? { text: `${nameOf(p)} is shown already${draft.includes(p) ? '' : ` (in ${nameOf(draft.find((s) => isWithin(p, s)))})`}.` } : null);
    setDraft(next);
  };
  const remove = (p) => setDraft(draft.filter((s) => s !== p));
  const move = (p, by) => {
    const at = draft.indexOf(p);
    const to = draft[at + by];
    if (to) setDraft(moveSectionTo(draft, p, to, by > 0));
  };
  /** Connected to the server (it may ask for a password or a code): its start folder. */
  const connect = async (id) => {
    setBusy(id);
    setNote(null);
    try {
      return (await window.desktop.remote.connect(id)).root;
    } catch (err) {
      setNote({ text: `${server(id)?.name ?? 'The server'}: ${message(err)}`, error: true });
      return null;
    } finally {
      setBusy(null);
    }
  };
  const addStart = async (id) => {
    const root = await connect(id);
    if (root) add(root);
  };
  const pick = async () => {
    const local = draft.find((s) => !isRemotePath(s));
    const picked = await window.desktop.folders.pick(local ? parentPath(local) || local : undefined);
    if (!picked) return;
    window.desktop.folders.roots().then(setRoots, () => {});
    add(picked);
  };

  // A path typed in a server's card: its folders suggested as you go (once it is connected).
  const typed = active ? (typing[active] ?? '') : '';
  const base = typed.slice(0, typed.lastIndexOf('/') + 1);
  const activeConnected = active && serverStatus(active).state === 'connected';
  useEffect(() => {
    if (!activeConnected || !base.startsWith('/')) return setSuggest({ id: '', list: [] });
    let stale = false;
    const timer = setTimeout(() => {
      window.desktop.folders.list(toRemoteUri(active, base)).then(
        (l) => !stale && setSuggest({ id: active, list: l.entries.filter((e) => e.dir && (!e.hidden || getSettings().showHidden)).map((e) => `${remoteParts(e.path).path.replace(/\/+$/, '')}/`) }),
        () => !stale && setSuggest({ id: '', list: [] }),
      );
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [active, base, activeConnected]);
  const startTyping = async (id) => {
    setActive(id);
    if (serverStatus(id).state === 'connected' || busy) return;
    const root = await connect(id);
    // What was typed meanwhile stays.
    if (root) setTyping((t) => ({ ...t, [id]: t[id] || `${innerPath(root) || ''}/` }));
  };
  const addTyped = async (ev, id) => {
    ev.preventDefault();
    const text = (typing[id] ?? '').trim();
    if (!text) return;
    if (serverStatus(id).state !== 'connected' && !(await connect(id))) return;
    setBusy(`path:${id}`);
    try {
      // ~ and $HOME are the server's home.
      const full = await window.desktop.remote.expandPath(id, text);
      if (!full.startsWith('/')) throw new Error('Type the whole path, starting with / or ~ (for example /var/www/site or ~/site).');
      const uri = toRemoteUri(id, full.replace(/\/+$/, '') || '/');
      await window.desktop.folders.list(uri);
      add(uri);
      setTyping((t) => ({ ...t, [id]: '' }));
    } catch (err) {
      setNote({ text: `${text}: ${message(err)}`, error: true });
    } finally {
      setBusy(null);
    }
  };

  // What can be added: Folders' list without what is shown (the draft is that) and the comparisons.
  const conns = servers().map((c) => ({ id: c.id, label: connLabel(c), detail: connDetail(c), icon: connIcon(c), state: serverStatus(c.id).state, place: isPlace(c) }));
  const sections = folderListModel({
    shown: draft,
    roots,
    favorites: settings.folderFavorites ?? [],
    recent: settings.folderRecent ?? [],
    servers: conns,
    home,
    query,
    colorOf,
    hereLabel: KINDS.disk.label,
  }).filter((s) => s.id !== 'shown' && s.id !== 'saved');
  // Every server gets its card, with or without folders used there before.
  const withServers = (() => {
    if (!conns.length) return sections;
    const at = sections.findIndex((s) => s.id === 'servers');
    const listed = at >= 0 ? sections[at] : { id: 'servers', label: 'Servers and places', rows: [] };
    const q = query.trim().toLowerCase();
    const rows = [...listed.rows];
    for (const c of conns) {
      if (rows.some((r) => r.type === 'server' && r.id === c.id)) continue;
      if (q && !`${c.label} ${c.detail}`.toLowerCase().includes(q)) continue;
      rows.push({ type: 'server', key: `server|${c.id}`, ...c, name: c.label, path: `remote://${c.id}/`, color: colorOf(`remote://${c.id}/`), depth: 0 });
    }
    const out = at >= 0 ? [...sections] : [...sections.filter((s) => s.id !== 'recent'), listed, ...sections.filter((s) => s.id === 'recent')];
    out[at >= 0 ? at : out.indexOf(listed)] = { ...listed, rows };
    return out.filter((s) => s.rows.length);
  })();
  const hasComputer = withServers.some((s) => s.id === 'computer');

  const addRow = (r, { nested = false, block = false } = {}) => {
    if (r.type === 'server') return serverHead(r);
    // A common parent (or a drive's top) inside a folder picked can be added too.
    const reach = !isRemotePath(r.path) ? Boolean(rootOf(r.path, roots)) : true;
    const canAdd = r.type === 'drive' ? r.pick || reach : !r.junction || reach;
    const there = added(r.path);
    const flat = !nested && r.type === 'folder';
    const name = flat ? nameOf(r.path) : r.name;
    const icon = r.type === 'drive' ? (DRIVE_ICONS[r.kind] ?? 'disk') : 'folder';
    return html`<div key=${r.key} class="fm-row sbs-row-add fm-${r.type} ${r.junction ? 'junction' : ''} ${nested ? 'nested' : ''} ${block ? 'block-head' : ''} ${there ? 'is-added' : ''}"
        style=${{ '--depth': nested ? r.depth - 1 : 0, ...(r.type === 'folder' && r.color ? { '--gc': r.color } : {}) }} role="presentation">
      <button type="button" class="fm-open sbs-add" data-nav="" disabled=${!canAdd || there || Boolean(busy)}
        title=${canAdd ? (there ? `${r.path}\nShown already` : `Add ${r.path} beside the others`) : `${r.path}\nNot picked: add one of the folders in it`}
        onClick=${() => canAdd && !there && add(r.path)}>
        <${Icon} name=${icon} size=${r.type === 'drive' ? 15 : 14} class="fm-icon" />
        <span class="fm-name">${r.prefix && html`<span class="fm-prefix">${r.prefix}</span>`}<strong>${name}</strong></span>
        ${flat && html`<span class="fm-where"><bdi>${placeWhereOf(r.path, conns, home)}</bdi></span>`}
        ${r.type === 'drive' && !r.pick && html`<span class="fm-where">${r.count} picked</span>`}
        ${r.section === 'favorites' && html`<${Icon} name="star" size=${12} class="sbs-fav" />`}
        ${canAdd && (there ? html`<span class="sbs-added"><${Icon} name="check" size=${13} />Added</span>` : html`<span class="sbs-plus" aria-hidden="true"><${Icon} name="plus" size=${15} /></span>`)}
      </button>
    </div>`;
  };
  // A server's card: its head (kind, address, state), its start folder, the folders used there, a path field.
  const serverHead = (r) => html`<div key=${r.key} class="fm-row fm-server block-head sbs-server-head" role="presentation">
    <div class="fm-open sbs-server-info">
      <${Icon} name=${r.icon} size=${15} class="fm-icon" />
      <span class="fm-name"><strong>${r.name}</strong></span>
      <span class="fm-where"><bdi>${r.detail}</bdi></span>
      <span class="conn-dot state-${r.state}" title=${STATES[r.state] ?? r.state} />
      <span class="sbs-state">${busy === r.id ? 'Connecting…' : STATES[r.state] ?? r.state}</span>
    </div>
  </div>`;
  const serverCard = (head, rows) => {
    const connected = head.state === 'connected';
    const start = connected ? null : 'Connects when added';
    const value = typing[head.id] ?? '';
    return html`<div class="fm-block fm-server-block sbs-card" key=${head.key} style=${head.color ? { '--gc': head.color } : null}>
      ${serverHead(head)}
      <div class="fm-row sbs-row-add nested" role="presentation" style=${{ '--depth': 0 }}>
        <button type="button" class="fm-open sbs-add" data-nav="" disabled=${Boolean(busy)} title=${`Add ${head.name}’s start folder beside the others`} onClick=${() => addStart(head.id)}>
          <${Icon} name="home" size=${14} class="fm-icon" />
          <span class="fm-name"><strong>Its start folder</strong></span>
          <span class="fm-where">${busy === head.id ? 'Connecting…' : (start ?? 'where it opens')}</span>
          <span class="sbs-plus" aria-hidden="true"><${Icon} name="plus" size=${15} /></span>
        </button>
      </div>
      ${rows.map((r) => addRow(r, { nested: true }))}
      <form class="sbs-path" onSubmit=${(e) => addTyped(e, head.id)}>
        <${Icon} name="folderOpen" size=${14} />
        <input value=${value} list=${`sbs-paths-${head.id}`} placeholder="Path on this server… (/var/www/site, ~/site)" aria-label=${`Path on ${head.name}`} spellcheck="false"
          onFocus=${() => startTyping(head.id)} onInput=${(e) => setTyping((t) => ({ ...t, [head.id]: e.currentTarget.value }))} />
        <datalist id=${`sbs-paths-${head.id}`}>${suggest.id === head.id && suggest.list.map((s) => html`<option value=${s} />`)}</datalist>
        <button type="submit" class="btn sm" disabled=${!value.trim() || Boolean(busy)}>${busy === `path:${head.id}` ? 'Checking…' : 'Add'}</button>
      </form>
    </div>`;
  };
  const sectionBody = (s) =>
    blocksOf(s.rows).map((b) => {
      if (b.head?.type === 'server') return serverCard(b.head, b.rows);
      if (b.head)
        return html`<div class="fm-block fm-drive-block" key=${b.head.key} style=${b.head.color ? { '--gc': b.head.color } : null}>
          ${addRow(b.head, { block: true })}${b.rows.map((r) => addRow(r, { nested: true }))}
        </div>`;
      return b.rows.map((r) => addRow(r, {}));
    });

  const fresh = draft.filter((p) => !before.current.includes(p));
  const changed = draft.join('\n') !== before.current.join('\n');
  const show = () => {
    actions.showSections(draft, fresh.at(-1));
    onClose();
  };
  const dropAt = (ev, p) => {
    if (!dragging) return;
    ev.preventDefault();
    const r = ev.currentTarget.getBoundingClientRect();
    const after = ev.clientY > r.top + r.height / 2;
    if (over?.path !== p || over.after !== after) setOver({ path: p, after });
  };
  const endDrag = () => (setDragging(null), setOver(null));
  const pickRow = html`<div class="fm-row sbs-row-add sbs-pick" role="presentation">
    <button type="button" class="fm-open sbs-add" data-nav="" onClick=${pick}>
      <${Icon} name="folderOpen" size=${14} class="fm-icon" /><span class="fm-name"><strong>Pick a folder…</strong></span><span class="fm-where">in the system dialog</span>
      <span class="sbs-plus" aria-hidden="true"><${Icon} name="plus" size=${15} /></span>
    </button>
  </div>`;

  return html`<${Modal} title="Folders side by side" wide className="side-by-side-dialog" onClose=${onClose}
    footer=${html`<span class="sbs-foot-links"><button type="button" class="btn ghost sm" onClick=${() => (onClose(), actions.editServer())}><${Icon} name="server" size=${15} />Connect to a new server…</button>
      ${!isAndroidApp() && html`<button type="button" class="btn ghost sm" onClick=${() => (onClose(), actions.importSshConfig())}>Servers from your SSH config…</button>`}</span>
      <span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!draft.length || !changed} onClick=${show}><${Icon} name="columns" size=${15} />${draft.length > 1 ? `Show these ${draft.length}` : 'Show it'}</button>`}>
    <section class="sbs-part sbs-part-shown" aria-label="Shown side by side">
      <h3 class="sbs-part-head"><span class="sbs-step">1</span>Shown side by side<span class="muted small">${draft.length ? `${draft.length} ${draft.length === 1 ? 'folder' : 'folders'}, each a root of the tree · drag or ↑ ↓ to reorder` : 'none yet: add one below'}</span></h3>
      <ol class="sbs-shown" aria-label="Folders shown, in order">
        ${draft.map((p, i) => {
          const c = colorOf(p);
          return html`<li key=${p} draggable="true" class="sbs-row ${isRemotePath(p) ? 'kind-remote' : 'kind-disk'} ${dragging === p ? 'dragging' : ''} ${over?.path === p && dragging !== p ? (over.after ? 'drop-after' : 'drop-before') : ''}"
            style=${c ? { '--gc': c } : null} title="Drag to put it elsewhere in the order"
            onDragStart=${(ev) => (ev.dataTransfer.setData('text/x-folder-section', p), (ev.dataTransfer.effectAllowed = 'move'), setDragging(p))}
            onDragOver=${(ev) => dropAt(ev, p)}
            onDrop=${(ev) => (ev.preventDefault(), dragging && over && setDraft(moveSectionTo(draft, dragging, over.path, over.after)), endDrag())}
            onDragEnd=${endDrag}>
            <span class="sbs-grip" aria-hidden="true">⠿</span>
            <span class="sbs-no">${i + 1}</span>
            <${Icon} name=${isRemotePath(p) ? connIcon(server(remoteParts(p).id)) : 'folder'} size=${15} class="sbs-kind" />
            <span class="sbs-name">${nameOf(p)}</span><span class="sbs-where">${placeWhereOf(p, conns, home)}</span>
            ${fresh.includes(p) && html`<span class="sbs-new">new</span>`}
            <button type="button" class="icon-btn xs sbs-parent" aria-label=${`The folder above ${nameOf(p)} instead`} title="The folder above it instead (past the folder picked too: a new one is asked about first)" disabled=${!upOf(p)}
              onClick=${async () => {
                const up = await actions.folderUp(p);
                if (!up) return;
                window.desktop.folders.roots().then(setRoots, () => {});
                setDraft((d) => replaceSection(d, p, up));
              }}><${Icon} name="cornerUp" size=${14} /></button>
            <button type="button" class="icon-btn xs" aria-label=${`Move ${nameOf(p)} up`} title="Up" disabled=${i === 0} onClick=${() => move(p, -1)}><${Icon} name="arrowUp" size=${13} /></button>
            <button type="button" class="icon-btn xs sbs-down" aria-label=${`Move ${nameOf(p)} down`} title="Down" disabled=${i === draft.length - 1} onClick=${() => move(p, 1)}><${Icon} name="arrowUp" size=${13} /></button>
            <button type="button" class="icon-btn xs" aria-label=${`Take ${nameOf(p)} out`} title="Take it out (nothing is deleted)" onClick=${() => remove(p)}><${Icon} name="x" size=${13} /></button>
          </li>`;
        })}
      </ol>
      ${note && html`<p class="notice ${note.error ? 'error' : ''}" role="status"><${Icon} name=${note.error ? 'alert' : 'info'} size=${15} /><span>${note.text}</span></p>`}
    </section>

    <section class="sbs-part sbs-part-add" aria-label="Add a folder" ref=${addPart} onKeyDown=${(e) => e.target.tagName !== 'INPUT' || e.target === filterField.current ? navKey(e, addPart.current, filterField.current) && e.preventDefault() : null}>
      <h3 class="sbs-part-head"><span class="sbs-step">2</span>Add a folder<span class="muted small">one or several</span></h3>
      <div class="fm-filter">
        <${Icon} name="search" size=${15} />
        <input ref=${filterField} value=${query} placeholder="Find a folder or a server" aria-label="Find a folder to add" spellcheck="false" autocomplete="off" onInput=${(e) => setQuery(e.currentTarget.value)} />
        <${ClearButton} value=${query} onClear=${() => setQuery('')} label="Clear" />
      </div>
      <div class="sbs-add-list">
        ${withServers.map((s) => html`<${FolderSection} key=${s.id} section=${s}>${sectionBody(s)}${s.id === 'computer' && !query.trim() && pickRow}</${FolderSection}>`)}
        ${!hasComputer && html`<${FolderSection} section=${{ id: 'computer', label: KINDS.disk.label, rows: [] }}>${pickRow}</${FolderSection}>`}
        ${query.trim() && !withServers.length && html`<p class="muted small fm-none">Nothing matches “${query.trim()}”.</p>`}
      </div>
    </section>
  </${Modal}>`;
}
