import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { languageNames, PLAIN_TEXT } from '../editor.js';
import { formatBytes, timeAgo } from '../format.js';
import { getSettings, isSyncConfigured, saveSettings } from '../settings.js';
import { fileKey, parseKey, store } from '../store.js';
import { syncNow } from '../syncManager.js';
import { projectKey } from '../tracker-model.js';
import { ProjectChip } from './components.js';
import { Icon } from './icons.js';

function tabInfo(key) {
  const k = parseKey(key);
  if (k?.kind === 'file') {
    const f = store.get(k.id);
    return f && { name: f.name, unsynced: f.dirty || f.pending, title: [f.project, f.name].filter(Boolean).join(' / ') };
  }
  const t = k && store.repoTab(k.path);
  return t && { name: t.name, unsynced: t.dirty, repo: true, title: `From the tracker: ${t.path}` };
}

export function TabBar({ session, actions }) {
  const strip = useRef(null);
  const [dragging, setDragging] = useState(null);
  useEffect(() => {
    strip.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [session.active, session.open.length]);
  return html`<div class="tabbar" role="tablist" aria-label="Open files" ref=${strip}
      onDblClick=${(e) => e.target === e.currentTarget && actions.newFile()}>
    ${session.open.map((key, index) => {
      const info = tabInfo(key);
      if (!info) return null;
      const isActive = key === session.active;
      return html`<div key=${key} role="tab" aria-selected=${isActive} tabindex=${isActive ? 0 : -1}
          class="tab ${isActive ? 'active' : ''} ${info.unsynced ? 'unsynced' : ''} ${dragging === key ? 'dragging' : ''}" title=${info.title}
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
              store.move(from, index);
            }
          }}
          onClick=${() => actions.activate(key)}
          onAuxClick=${(e) => e.button === 1 && actions.close(key)}
          onKeyDown=${(e) => (e.key === 'Enter' || e.key === ' ') && actions.activate(key)}>
        ${info.repo && html`<${Icon} name="paperclip" size=${13} />`}
        <span class="tab-name">${info.name}</span>
        <span class="tab-dot" title="Not synced yet" />
        <button type="button" class="tab-close" aria-label=${`Close ${info.name}`} tabindex="-1"
          onClick=${(e) => {
            e.stopPropagation();
            actions.close(key);
          }}><${Icon} name="x" size=${13} /></button>
      </div>`;
    })}
    <button type="button" class="tab-new" aria-label="New file" title="New file (Alt+N)" onClick=${() => actions.newFile()}><${Icon} name="plus" size=${16} /></button>
  </div>`;
}

/** Project, tags and actions for the file in the active tab. */
export function FileBar({ file, repo, projects, isMarkdown, preview, settings, actions }) {
  const previewButton =
    isMarkdown &&
    html`<button type="button" class="btn ghost sm ${preview ? 'on' : ''}" aria-pressed=${preview} title="Show the Markdown rendered next to the text" onClick=${actions.togglePreview}><${Icon} name="eye" size=${15} /><span class="label">Preview</span></button>`;
  const listenButton = html`<button type="button" class="btn ghost sm" title="Read aloud from the cursor, or the selection (Alt+R)" onClick=${actions.readAloud}><${Icon} name="volume" size=${15} /><span class="label">Listen</span></button>`;
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
      <span class="filebar-status ${repo.dirty ? 'pending' : ''}" title=${repo.dirty ? 'Saved on this device; goes to the tracker on the next sync' : 'The same as on the tracker'}>
        <${Icon} name=${repo.dirty ? 'sync' : 'cloud'} size=${14} /><span class="label">${repo.dirty ? 'Not synced yet' : 'Synced'}</span>
      </span>
    </div>`;
  }
  if (!file) return null;
  const project = projects.find((p) => p.key === projectKey(file.project));
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
    ${settings.llm.enabled && html`<button type="button" class="btn ghost sm" title="Summarize with the local model" onClick=${actions.summarize}><${Icon} name="sparkle" size=${15} /><span class="label">Summarize</span></button>`}
    <button type="button" class="btn ghost sm" title=${linked.length ? `On the tracker: ${linked.map((i) => i.title).join(', ')}` : 'Add to the tracker as a task, idea or doc to read'}
      onClick=${() => actions.openDialog({ type: 'send', id: file.id })}>
      <${Icon} name="send" size=${15} /><span class="label">${linked.length ? 'On tracker' : 'Send to tracker'}</span>
    </button>
    <button type="button" class="icon-btn sm" aria-label="File details" title="Name, project, tags, language, delete" onClick=${() => actions.openDialog({ type: 'file', id: file.id })}><${Icon} name="more" size=${16} /></button>
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

export function StatusBar({ cursor, language, file, repo, settings, actions }) {
  const setLanguage = (value) => file && actions.patch(file.id, { language: value === 'auto' ? '' : value });
  let state = '';
  if (file) state = file.dirty ? 'Saved on this device · not synced yet' : file.sha ? `Synced · edited ${timeAgo(file.modifiedAt)}${file.modifiedBy ? ` on ${file.modifiedBy}` : ''}` : 'Saved on this device';
  if (repo) state = repo.dirty ? 'Edited · goes to the tracker on the next sync' : 'Tracker file';
  return html`<footer class="statusbar">
    <span class="status-item status-state" title=${file ? `${formatBytes(store.text(file.id).length)}` : ''}>${state}</span>
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
