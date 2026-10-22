import { html, useState } from '../../vendor/preact-htm.js';
import { languageNames } from '../editor.js';
import { formatBytes, formatDateTime } from '../format.js';
import { contentPath, fileLink } from '../model.js';
import { getSettings } from '../settings.js';
import { store } from '../store.js';
import { syncNow } from '../syncManager.js';
import { checklistItems } from '../checklist.js';
import { AREAS, newId, projectKey, resolveProjectName } from '../tracker-model.js';
import { Field, Modal, Segmented, TagInput } from './components.js';
import { Icon } from './icons.js';

const allTags = () => [...new Set(store.live().flatMap((f) => f.tags))].sort((a, b) => a.localeCompare(b));

/** Project input with suggestions; a name the tracker does not know yet gets an area. */
function ProjectField({ value, onChange, area, onArea, projects }) {
  const known = projects.find((p) => p.key === projectKey(value));
  return html`<div class="field span-2">
    <span>Project</span>
    <div class="input-row">
      <input value=${value} list="project-options" placeholder="No project" onInput=${(e) => onChange(e.currentTarget.value)} />
      ${value.trim() && !known?.registered &&
      html`<select value=${area} onChange=${(e) => onArea(e.currentTarget.value)} aria-label="Area for the new project" class="area-select">
        <option value="">No area</option>
        ${AREAS.map((a) => html`<option key=${a.id} value=${a.id}>${a.label}</option>`)}
      </select>`}
    </div>
    <datalist id="project-options">${projects.map((p) => html`<option key=${p.key} value=${p.name} />`)}</datalist>
    <small>${value.trim() && !known?.registered ? 'New project: it is added to the tracker too, so both apps share it.' : 'The tracker’s projects. Work and Personal filter both apps.'}</small>
  </div>`;
}

function queueProject(name, area, projects) {
  const known = projects.find((p) => p.key === projectKey(name));
  if (name && !known?.registered) store.addTrackerOp({ op: 'project', name, area });
}

export function FileDialog({ file, projects, actions, onClose }) {
  const [name, setName] = useState(file.name);
  const [project, setProject] = useState(file.project);
  const [area, setArea] = useState('');
  const [tags, setTags] = useState(file.tags);
  const [language, setLanguage] = useState(file.language || 'auto');
  const save = () => {
    const projectName = resolveProjectName(project, projects);
    queueProject(projectName, area, projects);
    actions.patch(file.id, { name: name.trim() || file.name, project: projectName, tags, language: language === 'auto' ? '' : language });
    onClose();
  };
  const link = fileLink(getSettings().appUrl, file.id);
  return html`<${Modal} title="File details" onClose=${onClose}
    footer=${html`
      <button type="button" class="btn ghost danger" onClick=${() => {
        onClose();
        actions.remove(file.id);
      }}><${Icon} name="trash" size=${15} />Delete</button>
      <span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" onClick=${save}>Save</button>`}>
    <form class="field-grid" onSubmit=${(e) => (e.preventDefault(), save())}>
      <${Field} label="Name" wide hint="The extension picks the highlighting, e.g. notes.md, script.py, query.sql.">
        <input value=${name} onInput=${(e) => setName(e.currentTarget.value)} />
      </${Field}>
      <${ProjectField} value=${project} onChange=${setProject} area=${area} onArea=${setArea} projects=${projects} />
      <div class="field span-2"><span>Tags</span><${TagInput} value=${tags} onChange=${setTags} suggestions=${allTags()} placeholder="Type a tag and press Enter, e.g. a repo name" /></div>
      <${Field} label="Language" wide>
        <select value=${language} onChange=${(e) => setLanguage(e.currentTarget.value)}>
          <option value="auto">Automatic (from the name)</option>
          ${languageNames().map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
        </select>
      </${Field}>
      <button type="submit" hidden />
    </form>
    <dl class="props file-props">
      <div><dt>Edited</dt><dd>${formatDateTime(file.modifiedAt)}${file.modifiedBy ? ` on ${file.modifiedBy}` : ''}</dd></div>
      <div><dt>Created</dt><dd>${formatDateTime(file.createdAt)}</dd></div>
      <div><dt>Size</dt><dd>${formatBytes(new TextEncoder().encode(store.text(file.id)).length)}</dd></div>
      <div><dt>In the repo</dt><dd><code>${file.sha ? contentPath(file) : 'Not synced yet'}</code></dd></div>
      <div><dt>Encryption</dt><dd>${file.encrypted ? 'The text is encrypted in your data repo' : 'Not encrypted'}
        <button type="button" class="btn link" onClick=${() => (onClose(), actions.setEncrypted(file.id, !file.encrypted))}>${file.encrypted ? 'Stop encrypting' : 'Encrypt'}</button></dd></div>
      <div class="span-2"><dt>Link</dt><dd class="copy-row"><code>${link}</code>
        <button type="button" class="btn sm" onClick=${async () => {
          try {
            await navigator.clipboard.writeText(link);
            actions.toast('Link copied');
          } catch {
            actions.toast(link, { timeout: 12000 });
          }
        }}><${Icon} name="copy" size=${14} />Copy</button></dd></div>
    </dl>
  </${Modal}>`;
}

const SEND_TYPES = [
  { id: 'doc', label: 'Doc to read', icon: 'doc' },
  { id: 'task', label: 'Task', icon: 'task' },
  { id: 'idea', label: 'Idea', icon: 'idea' },
];

/** Adds the file to the tracker (as a doc to read, a task or an idea) with a link back here. */
export function SendDialog({ file, projects, actions, onClose }) {
  const [type, setType] = useState('doc');
  const [title, setTitle] = useState(file.name.replace(/\.(md|txt)$/i, ''));
  const [project, setProject] = useState(file.project);
  const [area, setArea] = useState('');
  const [tags, setTags] = useState(file.tags);
  const [notes, setNotes] = useState('');
  const send = () => {
    const projectName = resolveProjectName(project, projects);
    queueProject(projectName, area, projects);
    store.addTrackerOp({
      op: 'item',
      item: { id: newId(), type, kind: type === 'doc' ? 'other' : '', title: title.trim() || file.name, url: fileLink(getSettings().appUrl, file.id), project: projectName, tags, notes },
    });
    onClose();
    actions.toast(`Adding “${title.trim() || file.name}” to your tracker…`);
    syncNow().then((r) => r && actions.toast('Added to your tracker. Open it there with “Open in editor”.'));
  };
  return html`<${Modal} title="Send to tracker" onClose=${onClose}
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" onClick=${send}><${Icon} name="send" size=${15} />Add to tracker</button>`}>
    <form class="field-grid" onSubmit=${(e) => (e.preventDefault(), send())}>
      <div class="field span-2"><span>Add as</span><${Segmented} options=${SEND_TYPES} value=${type} onChange=${setType} label="Type" /></div>
      <${Field} label="Title" wide><input value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} /></${Field}>
      <${ProjectField} value=${project} onChange=${setProject} area=${area} onArea=${setArea} projects=${projects} />
      <div class="field span-2"><span>Tags</span><${TagInput} value=${tags} onChange=${setTags} suggestions=${allTags()} /></div>
      <${Field} label="Notes (optional)" wide><textarea rows="3" value=${notes} onInput=${(e) => setNotes(e.currentTarget.value)} placeholder="What to do with it, a checklist (- [ ] step)…" /></${Field}>
      <button type="submit" hidden />
    </form>
    <p class="muted small">The tracker item links back to this file, so “Open in editor” on the tracker brings you here.</p>
  </${Modal}>`;
}

/**
 * The open items of a checklist (in the selection or the file) as tracker
 * tasks, each linking back to the file. Items already on the tracker from this
 * file start unticked.
 */
export function ChecklistDialog({ file, text, firstLine, projects, actions, onClose }) {
  const link = fileLink(getSettings().appUrl, file.id);
  const existing = new Set(
    store
      .trackerItems()
      .filter((i) => !i.deleted && i.url === link)
      .map((i) => i.title.toLowerCase()),
  );
  const [items, setItems] = useState(() => checklistItems(text, { firstLine }).map((it) => ({ ...it, on: !existing.has(it.title.toLowerCase()), known: existing.has(it.title.toLowerCase()) })));
  const [type, setType] = useState('task');
  const [project, setProject] = useState(file.project);
  const [area, setArea] = useState('');
  const [tags, setTags] = useState(file.tags);
  const chosen = items.filter((it) => it.on);
  const send = () => {
    const projectName = resolveProjectName(project, projects);
    queueProject(projectName, area, projects);
    for (const it of chosen) {
      store.addTrackerOp({
        op: 'item',
        item: { id: newId(), type, title: it.title, url: link, project: projectName, tags, due: it.due || undefined, notes: `From ${file.name}, line ${it.line}.` },
      });
    }
    onClose();
    actions.toast(`Adding ${chosen.length} item${chosen.length === 1 ? '' : 's'} to your tracker…`);
    syncNow().then((r) => r && actions.toast(`Added ${chosen.length} item${chosen.length === 1 ? '' : 's'} to your tracker.`));
  };
  const toggle = (i) => setItems(items.map((it, j) => (j === i ? { ...it, on: !it.on } : it)));
  return html`<${Modal} title="Send the checklist to the tracker" onClose=${onClose} className="checklist-dialog"
    footer=${html`<span class="muted small">${chosen.length} of ${items.length} chosen</span><span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!chosen.length} onClick=${send}><${Icon} name="send" size=${15} />Add ${chosen.length || ''} to tracker</button>`}>
    ${!items.length && html`<p class="muted">No open items here. Write them as a checklist (<code>- [ ] call the vendor</code>), a list, or one per line, then select them.</p>`}
    <div class="checklist-items">
      ${items.map(
        (it, i) => html`<label class="checklist-item" key=${`${it.line}-${i}`}>
          <input type="checkbox" checked=${it.on} onChange=${() => toggle(i)} />
          <span class="checklist-title">${it.title}</span>
          ${it.due && html`<span class="badge-latest">${it.due}</span>`}
          ${it.known && html`<span class="muted small">already on the tracker</span>`}
          <span class="muted small">line ${it.line}</span>
        </label>`,
      )}
    </div>
    ${items.length > 0 &&
    html`<div class="field-grid">
      <div class="field span-2"><span>Add as</span><${Segmented} options=${SEND_TYPES.filter((t) => t.id !== 'doc')} value=${type} onChange=${setType} label="Type" /></div>
      <${ProjectField} value=${project} onChange=${setProject} area=${area} onArea=${setArea} projects=${projects} />
      <div class="field span-2"><span>Tags</span><${TagInput} value=${tags} onChange=${setTags} suggestions=${allTags()} /></div>
    </div>`}
  </${Modal}>`;
}
