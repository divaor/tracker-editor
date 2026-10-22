import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { canDragOut, startDragOut } from '../dragOut.js';
import { baseName, breadcrumbs, filterEntries, parentOf, rootOf } from '../folders.js';
import { formatBytes, timeAgo } from '../format.js';
import { saveSettings } from '../settings.js';
import { diskKey } from '../store.js';
import { toast } from './components.js';
import { Icon } from './icons.js';
import { Menu, MenuButton } from './menu.js';

const PLACES = [
  { id: 'documents', label: 'Documents' },
  { id: 'desktop', label: 'Desktop' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'home', label: 'Home' },
];

/**
 * The folders view of the sidebar (desktop): folders picked in the system
 * dialog, browsed like a file explorer. Files open as tabs on disk: edited in
 * place and never synced, unless copied into your files.
 */
export function FoldersView({ settings, activeKey, openKeys, actions }) {
  const bridge = window.desktop.folders;
  const [roots, setRoots] = useState(null);
  const [places, setPlaces] = useState({});
  const [listing, setListing] = useState(null); // { dir, entries, truncated, error? }
  const [filter, setFilter] = useState('');
  const [naming, setNaming] = useState(null); // the new file's name while it is typed
  const [menu, setMenu] = useState(null); // { entry, at }
  const nameInput = useRef(null);
  const dir = settings.folder;
  const root = roots && rootOf(dir, roots);

  const refreshRoots = () => bridge.roots().then(setRoots);
  useEffect(() => {
    refreshRoots();
    bridge.places().then(setPlaces, () => {});
  }, []);
  // The folder shown: the last one (picked from the menu, the list may be behind), or the first
  // picked when it is gone or was forgotten.
  useEffect(() => {
    if (!roots || root || (!roots.length && !dir)) return;
    let stale = false;
    bridge.roots().then((fresh) => {
      if (stale) return;
      if (!fresh.length) return roots.length && setRoots(fresh);
      if (!rootOf(dir, fresh)) saveSettings({ folder: fresh[0] });
      setRoots(fresh);
    });
    return () => {
      stale = true;
    };
  }, [roots, root, dir]);
  const load = async (target) => {
    try {
      setListing(await bridge.list(target));
    } catch (err) {
      setListing({ dir: target, entries: [], error: err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') });
    }
  };
  useEffect(() => {
    if (root) load(dir);
  }, [dir, root]);
  // Back in the window: the folder may have changed meanwhile.
  useEffect(() => {
    if (!root) return;
    const onFocus = () => load(dir);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [dir, root]);
  useEffect(() => {
    if (naming === '') nameInput.current?.focus();
  }, [naming]);

  const go = (target) => {
    setFilter('');
    setNaming(null);
    saveSettings({ folder: target });
  };
  const pick = async (defaultPath) => {
    if (await actions.openFolder(defaultPath)) {
      setFilter('');
      refreshRoots();
    }
  };
  const forget = async (folder) => {
    await bridge.forget(folder);
    refreshRoots();
  };
  const createFile = async () => {
    const name = naming?.trim();
    if (!name) return setNaming(null);
    try {
      const file = await bridge.newFile(dir, name);
      setNaming(null);
      await load(dir);
      actions.openDiskPath(file);
    } catch (err) {
      toast(err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, ''), { kind: 'error' });
    }
  };

  if (!roots) return html`<div class="file-list" />`;
  if (!roots.length) {
    return html`<div class="folders-empty">
      <p>Browse a folder on this computer and open its files here, like in a file explorer.</p>
      <p class="muted small">They are edited in place and are not synced. "Copy into my files" makes a copy that syncs.</p>
      <button type="button" class="btn primary" onClick=${() => pick()}><${Icon} name="folderOpen" size=${16} />Open a folder…</button>
      <div class="folder-places">
        <span class="muted small">Start in</span>
        ${PLACES.filter((p) => places[p.id]).map(
          (p) => html`<button type="button" key=${p.id} class="btn ghost sm" title=${`Pick a folder, starting in ${places[p.id]}`} onClick=${() => pick(places[p.id])}>${p.label}</button>`,
        )}
      </div>
    </div>`;
  }
  if (!root) return html`<div class="file-list" />`;

  const crumbs = breadcrumbs(dir, root);
  const up = parentOf(dir, root);
  const entries = filterEntries(listing?.dir === dir ? listing.entries : [], { query: filter, hidden: settings.showHidden });
  const hiddenCount = (listing?.entries ?? []).filter((e) => e.hidden).length;
  const rootItems = () => [
    ...roots.map((r) => ({ label: r, icon: 'folder', checked: r === root, run: () => go(r) })),
    { separator: true },
    { label: 'Open another folder…', icon: 'folderOpen', run: () => pick(up ?? root) },
    ...PLACES.filter((p) => places[p.id] && !roots.includes(places[p.id])).map((p) => ({ label: `Pick in ${p.label}…`, run: () => pick(places[p.id]) })),
    { separator: true },
    { label: settings.showHidden ? 'Hide hidden files' : `Show hidden files${hiddenCount ? ` (${hiddenCount} here)` : ''}`, icon: 'eye', run: () => saveSettings({ showHidden: !settings.showHidden }) },
    { label: 'Show this folder in the file explorer', icon: 'external', run: () => actions.showOnDisk(dir) },
    { label: `Forget ${baseName(root)}`, icon: 'x', run: () => forget(root) },
  ];
  const rowItems = (e) =>
    e.dir
      ? [
          { label: 'Open', icon: 'folderOpen', run: () => go(e.path) },
          { label: 'Copy path', icon: 'copy', run: () => actions.copyPath(e.path) },
          { label: 'Show in the file explorer', icon: 'external', run: () => actions.showOnDisk(e.path) },
        ]
      : [
          { label: 'Open', icon: 'file', run: () => actions.openDiskPath(e.path) },
          { label: 'Copy into my files (synced)', icon: 'filePlus', run: () => actions.copyToFiles(e.path) },
          { label: 'Copy for Claude (the path)', icon: 'claude', run: () => actions.copyPath(e.path, { claude: true }) },
          { label: 'Copy path', icon: 'copy', run: () => actions.copyPath(e.path) },
          { label: 'Show in the file explorer', icon: 'external', run: () => actions.showOnDisk(e.path) },
        ];

  return html`
    <div class="folders-head">
      <div class="folders-root">
        <button type="button" class="btn ghost sm folders-root-name" title=${root} onClick=${() => go(root)}><${Icon} name="folder" size=${15} /><span>${baseName(root)}</span></button>
        <span class="spacer" />
        <button type="button" class="icon-btn sm" aria-label="Up one folder" title="Up one folder" disabled=${!up} onClick=${() => go(up)}><${Icon} name="arrowUp" size=${16} /></button>
        <button type="button" class="icon-btn sm" aria-label="Refresh" title="Refresh" onClick=${() => load(dir)}><${Icon} name="rotate" size=${16} /></button>
        <button type="button" class="icon-btn sm" aria-label="New file here" title="New file here" onClick=${() => setNaming('')}><${Icon} name="filePlus" size=${16} /></button>
        <${MenuButton} label="Folders" items=${rootItems} />
      </div>
      ${crumbs.length > 1 &&
      html`<nav class="crumbs" aria-label="Folder path">
        ${crumbs.map(
          (c, i) => html`${i > 0 && html`<span class="crumb-sep" key=${`s${i}`}>›</span>`}<button type="button" key=${c.path} class="crumb ${i === crumbs.length - 1 ? 'current' : ''}"
            aria-current=${i === crumbs.length - 1 ? 'location' : undefined} title=${c.path} onClick=${() => go(c.path)}>${c.name}</button>`,
        )}
      </nav>`}
      <div class="sidebar-filter">
        <${Icon} name="search" size=${15} />
        <input value=${filter} onInput=${(e) => setFilter(e.currentTarget.value)} placeholder=${`Filter ${baseName(dir)}`} aria-label="Filter this folder" />
      </div>
      ${naming !== null &&
      html`<form class="folders-new" onSubmit=${(e) => (e.preventDefault(), createFile())}>
        <input ref=${nameInput} value=${naming} placeholder="notes.md" aria-label="New file name"
          onInput=${(e) => setNaming(e.currentTarget.value)} onKeyDown=${(e) => e.key === 'Escape' && (e.stopPropagation(), setNaming(null))} />
        <button type="submit" class="btn sm primary">Create</button>
      </form>`}
    </div>
    <div class="file-list folder-list" role="list" aria-label=${`Files in ${baseName(dir)}`}>
      ${listing?.error && html`<p class="error-text small empty-list">${listing.error}</p>`}
      ${entries.map((e) => {
        const key = diskKey(e.path);
        return html`<button type="button" key=${e.path} role="listitem" class="folder-row ${e.dir ? 'is-dir' : ''} ${activeKey === key ? 'active' : ''} ${e.hidden ? 'hidden-entry' : ''}"
          title=${e.path} draggable=${!e.dir && canDragOut()}
          onDragStart=${(ev) => {
            // To the desktop, a folder, a terminal or the Claude app, as the file itself.
            ev.preventDefault();
            startDragOut(null, { path: e.path });
          }}
          onClick=${() => (e.dir ? go(e.path) : actions.openDiskPath(e.path))}
          onContextMenu=${(ev) => {
            ev.preventDefault();
            setMenu({ entry: e, at: { x: ev.clientX, y: ev.clientY } });
          }}>
          <${Icon} name=${e.dir ? 'folder' : 'file'} size=${15} />
          <span class="folder-name">${e.name}</span>
          ${openKeys.includes(key) && html`<span class="tab-dot open-dot" title="Open in a tab" />`}
          <span class="spacer" />
          ${!e.dir && html`<span class="muted small folder-meta" title=${new Date(e.mtimeMs).toLocaleString()}>${formatBytes(e.size)} · ${timeAgo(new Date(e.mtimeMs).toISOString())}</span>`}
        </button>`;
      })}
      ${listing?.dir === dir && !listing.error && !entries.length &&
      html`<p class="muted small empty-list">${filter ? 'Nothing here matches.' : hiddenCount && !settings.showHidden ? `Only hidden files here (${hiddenCount}).` : 'This folder is empty.'}</p>`}
      ${listing?.truncated && html`<p class="muted small empty-list">Showing the first ${listing.entries.length.toLocaleString()} entries. Filter to find the others, or open a folder inside.</p>`}
    </div>
    <div class="sidebar-foot folders-foot">
      <span class="muted small">On disk · not synced</span>
    </div>
    ${menu && html`<${Menu} items=${rowItems(menu.entry)} at=${menu.at} label=${menu.entry.name} onClose=${() => setMenu(null)} />`}
  `;
}
