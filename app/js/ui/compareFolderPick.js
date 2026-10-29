import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { pathName, pathWhere } from '../compares.js';
import { rootOf, withCurrent } from '../folders.js';
import { getSettings } from '../settings.js';
import { onServers, servers, serverStatus } from '../servers.js';
import { isRemotePath, KINDS, protocolName, remoteParts, toRemoteUri } from '../where.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const innerPath = (p) => remoteParts(p).path.replace(/\/+$/, '');
/** The folder a folder is in (on a server too); '' at the top. */
const parentPath = (p) => {
  if (isRemotePath(p)) {
    const inner = innerPath(p);
    return inner ? toRemoteUri(remoteParts(p).id, inner.slice(0, inner.lastIndexOf('/')) || '/') : '';
  }
  const cut = Math.max(p.replace(/[\\/]+$/, '').lastIndexOf('/'), p.replace(/[\\/]+$/, '').lastIndexOf('\\'));
  const parent = cut > 0 ? p.slice(0, cut) : '';
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
};

/**
 * The folder to compare with (desktop): the folders shown in Folders, the ones picked before,
 * favorites and recent folders (here and on servers), a server's start folder, a path on a
 * server, or one picked in the system dialog. `other` is the folder on the other side (left out).
 */
export function CompareFolderDialog({ other, side = 'right', onPick, onClose, actions }) {
  const settings = getSettings();
  const [roots, setRoots] = useState([]);
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [srv, setSrv] = useState('');
  const [path, setPath] = useState('');
  const [suggest, setSuggest] = useState([]);
  const [siblings, setSiblings] = useState([]);
  const pathField = useRef(null);
  useEffect(() => {
    window.desktop.folders.roots().then(setRoots, () => {});
    return onServers(() => setTick((t) => t + 1));
  }, []);
  // The folders next to the other one (another copy of a project, last week's export…).
  useEffect(() => {
    const parent = other && parentPath(other);
    if (!parent) return;
    window.desktop.folders.list(parent).then(
      (l) => setSiblings(l.entries.filter((e) => e.dir && e.path !== other && (!e.hidden || getSettings().showHidden)).map((e) => e.path).slice(0, 40)),
      () => setSiblings([]),
    );
  }, [other]);

  const connect = async (id) => {
    setBusy(id);
    setNote(null);
    try {
      return (await window.desktop.remote.connect(id)).root;
    } catch (err) {
      setNote({ text: message(err), error: true });
      return null;
    } finally {
      setBusy(null);
    }
  };
  const choose = (p) => {
    if (p === other) return setNote({ text: 'That is the folder on the other side: pick another one.', error: true });
    onPick(p);
    onClose();
  };
  const pickHere = async () => {
    const picked = await window.desktop.folders.pick(other && !isRemotePath(other) ? other : undefined);
    if (picked) choose(picked);
  };
  const startFolder = async (id) => {
    const root = await connect(id);
    if (root) choose(root);
  };

  // A path typed on a server: its folders are suggested as you go.
  const server = srv || servers()[0]?.id || '';
  const base = path.slice(0, path.lastIndexOf('/') + 1);
  const connected = server && serverStatus(server).state === 'connected';
  useEffect(() => {
    if (!connected || !base.startsWith('/')) return setSuggest([]);
    let stale = false;
    const timer = setTimeout(() => {
      window.desktop.folders.list(toRemoteUri(server, base)).then(
        (l) => !stale && setSuggest(l.entries.filter((e) => e.dir && (!e.hidden || getSettings().showHidden)).map((e) => `${remoteParts(e.path).path.replace(/\/+$/, '')}/`)),
        () => !stale && setSuggest([]),
      );
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [server, base, connected]);
  const startTyping = async () => {
    if (!server || connected || busy) return;
    const root = await connect(server);
    // What was typed meanwhile stays.
    if (root) setPath((typed) => typed || `${innerPath(root) || ''}/`);
    pathField.current?.focus();
  };
  const useTyped = async (ev) => {
    ev.preventDefault();
    const typed = path.trim();
    if (!server || !typed) return;
    if (!typed.startsWith('/')) return setNote({ text: 'Type the whole path, starting with / (for example /var/www/site).', error: true });
    const uri = toRemoteUri(server, typed.replace(/\/+$/, '') || '/');
    if (!connected && !(await connect(server))) return;
    setBusy('path');
    try {
      await window.desktop.folders.list(uri);
      choose(uri);
    } catch (err) {
      setNote({ text: `${typed}: ${message(err)}`, error: true });
    } finally {
      setBusy(null);
    }
  };

  const seen = new Set([other]);
  const fresh = (c) => c.path && !seen.has(c.path) && seen.add(c.path);
  const favorites = settings.folderFavorites ?? [];
  const recent = settings.folderRecent ?? [];
  const shown = withCurrent(settings.folderSections, settings.folder);
  const next = siblings.map((p) => ({ path: p, icon: 'folder', why: 'Next to it' })).filter(fresh);
  const here = [
    ...shown.filter((p) => !isRemotePath(p)).map((p) => ({ path: p, icon: 'columns', why: 'In Folders' })),
    ...roots.map((p) => ({ path: p, icon: 'folder', why: 'Picked before' })),
    ...favorites.filter((p) => !isRemotePath(p) && rootOf(p, roots)).map((p) => ({ path: p, icon: 'star', why: 'Favorite' })),
    ...recent.filter((p) => !isRemotePath(p) && rootOf(p, roots)).map((p) => ({ path: p, icon: 'clock', why: 'Recent' })),
  ].filter(fresh);
  const onServer = (id) =>
    [
      ...shown.filter((p) => isRemotePath(p) && remoteParts(p).id === id).map((p) => ({ path: p, icon: 'columns', why: 'In Folders' })),
      ...favorites.filter((p) => isRemotePath(p) && remoteParts(p).id === id).map((p) => ({ path: p, icon: 'star', why: 'Favorite' })),
      ...recent.filter((p) => isRemotePath(p) && remoteParts(p).id === id).map((p) => ({ path: p, icon: 'clock', why: 'Recent' })),
    ].filter(fresh);
  const candidate = (c) => html`<li key=${c.path}>
    <button type="button" class="sbs-add" title=${c.path} onClick=${() => choose(c.path)}>
      <${Icon} name=${c.icon} size=${15} /><span class="sbs-name">${pathName(c.path)}</span><span class="sbs-where">${pathWhere(c.path)}</span>
      <span class="sbs-why">${c.why}</span><${Icon} name="chevronRight" size=${15} class="sbs-plus" />
    </button>
  </li>`;

  return html`<${Modal} title=${`Compare ${other ? pathName(other) : 'a folder'} with…`} wide className="side-by-side-dialog compare-folder-dialog" onClose=${onClose}
    footer=${html`<span class="muted small">${other ? `It goes on the ${side}; ${pathName(other)} stays on the ${side === 'right' ? 'left' : 'right'}.` : ''}</span><span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>`}>
    ${note && html`<p class="notice ${note.error ? 'error' : ''}" role="status"><${Icon} name=${note.error ? 'alert' : 'info'} size=${15} /><span>${note.text}</span></p>`}
    ${next.length > 0 &&
    html`<h4 class="sbs-group"><${Icon} name="folder" size=${14} />Next to ${pathName(other)}</h4>
      <ul class="sbs-list">${next.map(candidate)}</ul>`}
    <h4 class="sbs-group"><${Icon} name="disk" size=${14} />${KINDS.disk.label}</h4>
    <ul class="sbs-list">
      ${here.map(candidate)}
      <li><button type="button" class="sbs-add" onClick=${pickHere}><${Icon} name="folderOpen" size=${15} /><span class="sbs-name">Pick a folder…</span><span class="sbs-where">in the system dialog</span><${Icon} name="chevronRight" size=${15} class="sbs-plus" /></button></li>
    </ul>
    ${servers().map((c) => {
      const state = serverStatus(c.id).state;
      return html`<h4 class="sbs-group" key=${`h:${c.id}`}><${Icon} name="server" size=${14} />${c.name}<span class="muted small">${protocolName(c.protocol)} · ${c.user ? `${c.user}@` : ''}${c.host}</span><span class="conn-dot state-${state}" title=${state} /></h4>
      <ul class="sbs-list" key=${`l:${c.id}`}>
        <li><button type="button" class="sbs-add" disabled=${Boolean(busy)} onClick=${() => startFolder(c.id)}>
          <${Icon} name="server" size=${15} /><span class="sbs-name">Its start folder</span><span class="sbs-where">${busy === c.id ? 'Connecting…' : state === 'connected' ? 'connected' : 'connects first'}</span><${Icon} name="chevronRight" size=${15} class="sbs-plus" />
        </button></li>
        ${onServer(c.id).map(candidate)}
      </ul>`;
    })}
    ${servers().length > 0 &&
    html`<form class="sbs-remote" onSubmit=${useTyped}>
      <span class="field-label">A folder on a server, by its path</span>
      <div class="sbs-remote-row">
        <select value=${server} aria-label="Server" onChange=${(e) => (setSrv(e.currentTarget.value), setPath(''), setSuggest([]))}>
          ${servers().map((c) => html`<option value=${c.id}>${c.name}</option>`)}
        </select>
        <input ref=${pathField} value=${path} list="cmp-paths" placeholder="/var/www/site" aria-label="Path on the server" spellcheck="false"
          onFocus=${startTyping} onInput=${(e) => setPath(e.currentTarget.value)} />
        <datalist id="cmp-paths">${suggest.map((s) => html`<option value=${s} />`)}</datalist>
        <button type="submit" class="btn sm" disabled=${!path.trim() || Boolean(busy)}>${busy === 'path' ? 'Checking…' : 'Compare'}</button>
      </div>
      <span class="muted small">${busy === server ? 'Connecting…' : connected ? 'Its folders are suggested as you type.' : 'It connects when you click the path.'}</span>
    </form>`}
    ${!servers().length && html`<div class="form-actions"><button type="button" class="btn sm" onClick=${() => (onClose(), actions.editServer())}><${Icon} name="server" size=${15} />Connect to a server…</button></div>`}
  </${Modal}>`;
}
