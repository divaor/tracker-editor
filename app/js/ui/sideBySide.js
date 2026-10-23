import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { addSection, baseName, isWithin, moveSectionTo, rootOf, withCurrent } from '../folders.js';
import { getSettings } from '../settings.js';
import { onServers, server, servers, serverStatus } from '../servers.js';
import { isRemotePath, protocolName, remoteParts, toRemoteUri } from '../where.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))) || p;
const innerPath = (p) => remoteParts(p).path.replace(/\/+$/, '');
/** A folder's name: its own, or the server's for a server's top folder. */
const nameOf = (p) => (isRemotePath(p) ? (innerPath(p) ? baseName(innerPath(p)) : (server(remoteParts(p).id)?.name ?? 'Server')) : baseName(p));
/** Where it is: the folder holding it (on a server: the server's name first). */
const whereOf = (p) => {
  if (!isRemotePath(p)) return dirOf(p);
  const inner = innerPath(p);
  return `${server(remoteParts(p).id)?.name ?? 'Server'} · ${inner ? inner.slice(0, inner.lastIndexOf('/')) || '/' : '/'}`;
};

/**
 * The folders shown side by side in the folders view (desktop): their order (dragged, or ↑ ↓),
 * closing some, and adding one or several at once: the folders picked before, favorites and
 * recent folders (here and on servers), a server's start folder, a path typed on a server, or
 * one picked in the system dialog. Nothing changes until Show.
 */
export function SideBySideDialog({ onClose, actions }) {
  const settings = getSettings();
  const before = useRef(withCurrent(settings.folderSections, settings.folder));
  const [draft, setDraft] = useState(before.current);
  const [roots, setRoots] = useState([]);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(null); // what is connecting or being checked
  const [note, setNote] = useState(null); // { text, error }
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null); // { path, after }
  const [picked, setSrv] = useState('');
  const [path, setPath] = useState('');
  const [suggest, setSuggest] = useState([]);
  const pathField = useRef(null);
  useEffect(() => {
    window.desktop.folders.roots().then(setRoots, () => {});
    return onServers(() => setTick((t) => t + 1));
  }, []);

  const shown = (p) => draft.some((s) => isWithin(p, s));
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
    const picked = await window.desktop.folders.pick(local ? dirOf(local) : undefined);
    if (!picked) return;
    window.desktop.folders.roots().then(setRoots, () => {});
    add(picked);
  };

  // A path typed on a server: its folders are suggested as you go.
  const srv = picked || servers()[0]?.id || '';
  const base = path.slice(0, path.lastIndexOf('/') + 1);
  const connected = srv && serverStatus(srv).state === 'connected';
  useEffect(() => {
    if (!connected || !base.startsWith('/')) return setSuggest([]);
    let stale = false;
    const timer = setTimeout(() => {
      window.desktop.folders.list(toRemoteUri(srv, base)).then(
        (l) => !stale && setSuggest(l.entries.filter((e) => e.dir && (!e.hidden || getSettings().showHidden)).map((e) => `${remoteParts(e.path).path.replace(/\/+$/, '')}/`)),
        () => !stale && setSuggest([]),
      );
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [srv, base, connected]);
  const startTyping = async () => {
    if (!srv || connected || busy) return;
    const root = await connect(srv);
    if (root && !path) setPath(`${innerPath(root) || ''}/`);
    pathField.current?.focus();
  };
  const addTyped = async (ev) => {
    ev.preventDefault();
    const typed = path.trim();
    if (!srv || !typed) return;
    if (!typed.startsWith('/')) return setNote({ text: 'Type the whole path, starting with / (for example /var/www/site).', error: true });
    const uri = toRemoteUri(srv, typed.replace(/\/+$/, '') || '/');
    if (!connected && !(await connect(srv))) return;
    setBusy('path');
    try {
      await window.desktop.folders.list(uri);
      add(uri);
      setPath('');
    } catch (err) {
      setNote({ text: `${typed}: ${message(err)}`, error: true });
    } finally {
      setBusy(null);
    }
  };

  // What can be added: here (picked folders, favorites, recent ones inside them), then per server.
  const seen = new Set();
  const fresh = (p) => p && !seen.has(p) && !shown(p) && seen.add(p);
  const favorites = settings.folderFavorites ?? [];
  const recent = settings.folderRecent ?? [];
  const here = [
    ...roots.map((p) => ({ path: p, icon: 'folder', why: 'Picked before' })),
    ...favorites.filter((p) => !isRemotePath(p) && rootOf(p, roots)).map((p) => ({ path: p, icon: 'star', why: 'Favorite' })),
    ...recent.filter((p) => !isRemotePath(p) && rootOf(p, roots)).map((p) => ({ path: p, icon: 'clock', why: 'Recent' })),
  ].filter((c) => fresh(c.path));
  const onServer = (id) =>
    [
      ...favorites.filter((p) => isRemotePath(p) && remoteParts(p).id === id).map((p) => ({ path: p, icon: 'star', why: 'Favorite' })),
      ...recent.filter((p) => isRemotePath(p) && remoteParts(p).id === id).map((p) => ({ path: p, icon: 'clock', why: 'Recent' })),
    ].filter((c) => fresh(c.path));

  const candidate = (c) => html`<li key=${c.path}>
    <button type="button" class="sbs-add" title=${`Add ${c.path} beside the others`} onClick=${() => add(c.path)}>
      <${Icon} name=${c.icon} size=${15} /><span class="sbs-name">${nameOf(c.path)}</span><span class="sbs-where">${whereOf(c.path)}</span>
      <span class="sbs-why">${c.why}</span><${Icon} name="plus" size=${15} class="sbs-plus" />
    </button>
  </li>`;

  const added = draft.filter((p) => !before.current.includes(p));
  const changed = draft.join('\n') !== before.current.join('\n');
  const show = () => {
    actions.showSections(draft, added.at(-1));
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

  return html`<${Modal} title="Folders side by side" wide className="side-by-side-dialog" onClose=${onClose}
    footer=${html`<span class="muted small">${draft.length > 1 ? 'Each one is a root of the tree, under its own header.' : ''}</span><span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!draft.length || !changed} onClick=${show}><${Icon} name="columns" size=${15} />${draft.length > 1 ? `Show these ${draft.length}` : 'Show it'}</button>`}>
    <h3 class="sbs-heading">Shown, in this order</h3>
    ${!draft.length && html`<p class="muted small">None: add at least one below.</p>`}
    <ol class="sbs-shown" aria-label="Folders shown, in order">
      ${draft.map(
        (p, i) => html`<li key=${p} draggable="true" class="sbs-row ${isRemotePath(p) ? 'kind-remote' : 'kind-disk'} ${dragging === p ? 'dragging' : ''} ${over?.path === p && dragging !== p ? (over.after ? 'drop-after' : 'drop-before') : ''}"
          title="Drag to put it elsewhere in the order"
          onDragStart=${(ev) => (ev.dataTransfer.setData('text/x-folder-section', p), (ev.dataTransfer.effectAllowed = 'move'), setDragging(p))}
          onDragOver=${(ev) => dropAt(ev, p)}
          onDrop=${(ev) => (ev.preventDefault(), dragging && over && setDraft(moveSectionTo(draft, dragging, over.path, over.after)), endDrag())}
          onDragEnd=${endDrag}>
          <span class="sbs-grip" aria-hidden="true">⠿</span>
          <${Icon} name=${isRemotePath(p) ? 'server' : 'folder'} size=${15} class="sbs-kind" />
          <span class="sbs-name">${nameOf(p)}</span><span class="sbs-where">${whereOf(p)}</span>
          ${added.includes(p) && html`<span class="sbs-new">new</span>`}
          <button type="button" class="icon-btn xs" aria-label=${`Move ${nameOf(p)} up`} title="Up" disabled=${i === 0} onClick=${() => move(p, -1)}><${Icon} name="arrowUp" size=${13} /></button>
          <button type="button" class="icon-btn xs sbs-down" aria-label=${`Move ${nameOf(p)} down`} title="Down" disabled=${i === draft.length - 1} onClick=${() => move(p, 1)}><${Icon} name="arrowUp" size=${13} /></button>
          <button type="button" class="icon-btn xs" aria-label=${`Take ${nameOf(p)} out`} title="Take it out (nothing is deleted)" onClick=${() => remove(p)}><${Icon} name="x" size=${13} /></button>
        </li>`,
      )}
    </ol>
    ${note && html`<p class="notice ${note.error ? 'error' : ''}" role="status"><${Icon} name=${note.error ? 'alert' : 'info'} size=${15} />${note.text}</p>`}

    <h3 class="sbs-heading">Add beside them <span class="muted small">(one or several)</span></h3>
    <h4 class="sbs-group"><${Icon} name="disk" size=${14} />This computer</h4>
    <ul class="sbs-list">
      ${here.map(candidate)}
      <li><button type="button" class="sbs-add" onClick=${pick}><${Icon} name="folderOpen" size=${15} /><span class="sbs-name">Pick a folder…</span><span class="sbs-where">in the system dialog</span><${Icon} name="plus" size=${15} class="sbs-plus" /></button></li>
    </ul>
    ${servers().map((c) => {
      const state = serverStatus(c.id).state;
      return html`<h4 class="sbs-group" key=${`h:${c.id}`}><${Icon} name="server" size=${14} />${c.name}<span class="muted small">${protocolName(c.protocol)} · ${c.user ? `${c.user}@` : ''}${c.host}</span><span class="conn-dot state-${state}" title=${state} /></h4>
      <ul class="sbs-list" key=${`l:${c.id}`}>
        <li><button type="button" class="sbs-add" disabled=${Boolean(busy)} onClick=${() => addStart(c.id)}>
          <${Icon} name="server" size=${15} /><span class="sbs-name">Its start folder</span><span class="sbs-where">${busy === c.id ? 'Connecting…' : state === 'connected' ? 'connected' : 'connects first'}</span><${Icon} name="plus" size=${15} class="sbs-plus" />
        </button></li>
        ${onServer(c.id).map(candidate)}
      </ul>`;
    })}
    ${servers().length > 0 &&
    html`<form class="sbs-remote" onSubmit=${addTyped}>
      <span class="field-label">A folder on a server, by its path</span>
      <div class="sbs-remote-row">
        <select value=${srv} aria-label="Server" onChange=${(e) => (setSrv(e.currentTarget.value), setPath(''), setSuggest([]))}>
          ${servers().map((c) => html`<option value=${c.id}>${c.name}</option>`)}
        </select>
        <input ref=${pathField} value=${path} list="sbs-paths" placeholder="/var/www/site" aria-label="Path on the server" spellcheck="false"
          onFocus=${startTyping} onInput=${(e) => setPath(e.currentTarget.value)} />
        <datalist id="sbs-paths">${suggest.map((s) => html`<option value=${s} />`)}</datalist>
        <button type="submit" class="btn sm" disabled=${!path.trim() || Boolean(busy)}>${busy === 'path' ? 'Checking…' : 'Add'}</button>
      </div>
      <span class="muted small">${busy === srv ? 'Connecting…' : connected ? 'Its folders are suggested as you type.' : 'It connects when you click the path.'}</span>
    </form>`}
    <div class="form-actions">
      <button type="button" class="btn sm" onClick=${() => (onClose(), actions.editServer())}><${Icon} name="server" size=${15} />Connect to a new server…</button>
      <button type="button" class="btn ghost sm" onClick=${() => (onClose(), actions.importSshConfig())}>Servers from your SSH config…</button>
    </div>
  </${Modal}>`;
}
