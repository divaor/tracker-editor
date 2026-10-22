import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { languageNames, PLAIN_TEXT } from '../editor.js';
import { formatBytes, timeAgo } from '../format.js';
import { getSettings, isSyncConfigured, saveSettings } from '../settings.js';
import { fileKey, parseKey, store } from '../store.js';
import { syncNow } from '../syncManager.js';
import { projectKey } from '../tracker-model.js';
import { ProjectChip } from './components.js';
import { Icon } from './icons.js';
import { Menu, MenuButton } from './menu.js';

function tabInfo(key) {
  const k = parseKey(key);
  if (k?.kind === 'file') {
    const f = store.get(k.id);
    return f && { name: f.name, project: f.project, encrypted: f.encrypted, snippet: f.snippet, unsynced: f.dirty || f.pending, title: [f.project, f.name].filter(Boolean).join(' / ') + (f.encrypted ? ' · encrypted' : '') };
  }
  const t = k && store.repoTab(k.path);
  return t && { name: t.name, project: store.doc(k.path)?.project ?? '', unsynced: t.dirty, repo: true, title: `From the tracker: ${t.path}` };
}

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

export function TabBar({ session, projects, settings, actions }) {
  const strip = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [menu, setMenu] = useState(null); // { key, at }
  useEffect(() => {
    strip.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [session.active, session.open.length]);
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
        class="tab ${isActive ? 'active' : ''} ${isSide ? 'side' : ''} ${isPinned ? 'pinned' : ''} ${info.unsynced ? 'unsynced' : ''} ${dragging === key ? 'dragging' : ''}"
        title=${isSide ? `${info.title} · in the side view` : info.title}
        draggable="true"
        onDragStart=${(e) => {
          setDragging(key);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/x-tab', key);
        }}
        onDragEnd=${() => setDragging(null)}
        onDragOver=${(e) => dragging && e.preventDefault()}
        onDrop=${(e) => {
          const from = e.dataTransfer.getData('text/x-tab');
          if (from) {
            e.preventDefault();
            store.move(from, session.open.indexOf(key));
          }
        }}
        onClick=${() => actions.activate(key)}
        onAuxClick=${(e) => e.button === 1 && actions.close(key)}
        onContextMenu=${(e) => {
          e.preventDefault();
          setMenu({ key, at: { x: e.clientX, y: e.clientY } });
        }}
        onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && actions.activate(key)}>
      ${isPinned && html`<${Icon} name="pin" size=${12} class="tab-pin" />`}
      ${isSide && html`<${Icon} name="columns" size=${13} class="tab-side" />`}
      ${info.repo && html`<${Icon} name="paperclip" size=${13} />`}
      ${info.encrypted && html`<${Icon} name="lock" size=${12} class="tab-lock" />`}
      ${info.snippet && html`<${Icon} name="snippet" size=${12} class="tab-lock" />`}
      <span class="tab-name">${info.name}</span>
      <span class="tab-dot" title="Not synced yet" />
      <button type="button" class="tab-close" aria-label=${`Close ${info.name}`} tabindex="-1"
        onClick=${(e) => {
          e.stopPropagation();
          actions.close(key);
        }}><${Icon} name="x" size=${13} /></button>
    </div>`;
  };

  return html`<div class="tabbar" role="tablist" aria-label="Open files" ref=${strip}
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
  </div>`;
}

/** Project, tags and actions for the file in the active tab. */
export function FileBar({ file, repo, sealed, projects, canPreview, preview, settings, actions }) {
  const previewButton =
    canPreview &&
    html`<button type="button" class="btn ghost sm ${preview ? 'on' : ''}" aria-pressed=${preview} title="Show a reading view next to the text" onClick=${actions.togglePreview}><${Icon} name="eye" size=${15} /><span class="label">Preview</span></button>`;
  const listenButton = html`<button type="button" class="btn ghost sm" title="Read aloud from the cursor, or the selection (Alt+R)" onClick=${actions.readAloud}><${Icon} name="volume" size=${15} /><span class="label">Listen</span></button>`;
  const shareButton = html`<button type="button" class="btn ghost sm" title="Share: WhatsApp, Teams, email, copy…" onClick=${actions.share}><${Icon} name="share" size=${15} /><span class="label">Share</span></button>`;
  const moreItems = (id) => [
    id && { label: 'Details…', icon: 'tag', run: () => actions.openDialog({ type: 'file', id }) },
    { label: 'Outline and links (Ctrl+Shift+O)', icon: 'list', run: actions.toggleOutline },
    { label: 'Filter lines (Alt+L)', icon: 'search', run: actions.toggleFilter },
    { label: 'Record or stop a macro (Ctrl+Shift+R)', icon: 'play', run: actions.toggleRecording },
    { label: 'Run the macro…', icon: 'skipForward', run: actions.runMacro },
    { label: 'History', icon: 'history', run: actions.showHistory },
    { label: 'Compare with…', icon: 'columns', run: actions.compareWith },
    { label: 'Compare with clipboard', icon: 'copy', run: actions.compareWithClipboard },
    id && { label: 'Send checklist to tracker…', icon: 'checklist', run: actions.sendChecklist },
    window.desktop?.typing && { label: 'Type into another window', icon: 'keyboard', run: () => actions.typeOut() },
    settings.llm.enabled && { label: 'Ask the model… (Ctrl+K)', icon: 'sparkle', run: actions.askSelection },
    { label: 'Insert snippet…', icon: 'snippet', run: actions.openSnippets },
    id && { label: 'Save as snippet', icon: 'snippet', run: actions.saveSnippet },
    id && { label: store.get(id)?.snippet ? 'Not a snippet' : 'Use as a snippet', icon: 'snippet', run: () => actions.toggleSnippet(id) },
    id && settings.llm.enabled && { label: 'Suggest project and tags', icon: 'sparkle', run: actions.suggestFiling },
    id && { label: store.get(id)?.encrypted ? 'Stop encrypting' : 'Encrypt', icon: store.get(id)?.encrypted ? 'unlock' : 'lock', run: () => actions.setEncrypted(id, !store.get(id)?.encrypted) },
    id && { separator: true },
    id && { label: 'Move to trash', icon: 'trash', danger: true, run: () => actions.remove(id) },
  ];
  if (repo) {
    // A tracker document: its item's title and project; the path is in the tooltip.
    const doc = store.doc(repo.path);
    const project = doc?.project && projects.find((p) => p.key === projectKey(doc.project));
    return html`<div class="filebar">
      <span class="filebar-note" title=${`From the tracker: ${repo.path}`}><${Icon} name="doc" size=${14} /><span class="filebar-title">${doc?.item.title || repo.name}</span></span>
      ${doc?.project && html`<${ProjectChip} project=${project} name=${doc.project} />`}
      <span class="spacer" />
      ${previewButton}
      ${listenButton}
      ${shareButton}
      <span class="filebar-status ${repo.dirty ? 'pending' : ''}" title=${repo.dirty ? 'Saved on this device; goes to the tracker on the next sync' : 'The same as on the tracker'}>
        <${Icon} name=${repo.dirty ? 'sync' : 'cloud'} size=${14} /><span class="label">${repo.dirty ? 'Not synced yet' : 'Synced'}</span>
      </span>
      <${MenuButton} label="More" items=${() => moreItems()} />
    </div>`;
  }
  if (!file) return null;
  const project = projects.find((p) => p.key === projectKey(file.project));
  if (sealed) {
    return html`<div class="filebar">
      ${file.project && html`<${ProjectChip} project=${project} name=${file.project} />`}
      <span class="filebar-note"><${Icon} name="lock" size=${14} />Encrypted · locked on this device</span>
      <span class="spacer" />
      <${MenuButton} label="More" items=${() => [{ label: 'Move to trash', icon: 'trash', danger: true, run: () => actions.remove(file.id) }]} />
    </div>`;
  }
  const linked = store.trackerItems().filter((i) => !i.deleted && i.url?.includes(`#/file/${encodeURIComponent(file.id)}`));
  return html`<div class="filebar">
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
    ${settings.llm.enabled && html`<button type="button" class="btn ghost sm" title="Summarize with the local model" onClick=${actions.summarize}><${Icon} name="sparkle" size=${15} /><span class="label">Summarize</span></button>`}
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

export function StatusBar({ recording, big, cursor, language, file, repo, settings, actions }) {
  const setLanguage = (value) => file && actions.patch(file.id, { language: value === 'auto' ? '' : value });
  let state = '';
  if (file) state = file.dirty ? 'Saved on this device · not synced yet' : file.sha ? `Synced · edited ${timeAgo(file.modifiedAt)}${file.modifiedBy ? ` on ${file.modifiedBy}` : ''}` : 'Saved on this device';
  if (repo) state = repo.dirty ? 'Edited · goes to the tracker on the next sync' : 'Tracker file';
  return html`<footer class="statusbar">
    <span class="status-item status-state" title=${file ? `${formatBytes(store.text(file.id).length)}` : ''}>${state}</span>
    ${recording && html`<button type="button" class="status-item status-btn-text status-recording" title="Recording a macro: Ctrl+Shift+R stops" onClick=${actions.toggleRecording}>● Recording macro</button>`}
    ${big && html`<span class="status-item status-big" title="A very large file: highlighting, wrapping and completion are off to keep it fast">Large file</span>`}
    <span class="spacer" />
    ${cursor && html`<span class="status-item">Ln ${cursor.line}, Col ${cursor.column}${cursor.selected ? ` (${cursor.selected} selected)` : ''}${cursor.cursors > 1 ? ` · ${cursor.cursors} cursors` : ''}</span>`}
    ${cursor && html`<span class="status-item hide-narrow">${cursor.lines} lines</span>`}
    ${file &&
    html`<label class="status-item status-select" title="Language (highlighting)">
      <select value=${file.language || 'auto'} onChange=${(e) => setLanguage(e.currentTarget.value)} aria-label="Language">
        <option value="auto">${file.language ? 'Auto (by name)' : `${language} (auto)`}</option>
        ${languageNames().map((name) => html`<option key=${name} value=${name}>${name}</option>`)}
      </select>
    </label>`}
    ${repo && html`<span class="status-item">${language || PLAIN_TEXT}</span>`}
    <button type="button" class="status-item status-btn-text hide-narrow" title="Tab size" onClick=${() => saveSettings({ tabSize: settings.tabSize === 4 ? 2 : 4 })}>Spaces: ${settings.tabSize}</button>
    <button type="button" class="status-item status-btn-text ${settings.wordWrap ? 'on' : ''}" title="Word wrap (Alt+Z)" aria-pressed=${settings.wordWrap} onClick=${() => saveSettings({ wordWrap: !getSettings().wordWrap })}>
      <${Icon} name="wrap" size=${14} /><span class="hide-narrow">Wrap</span>
    </button>
    <span class="status-item hide-narrow">UTF-8 · LF</span>
  </footer>`;
}
