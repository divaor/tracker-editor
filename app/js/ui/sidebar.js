import { html, useState } from '../../vendor/preact-htm.js';
import { timeAgo } from '../format.js';
import { saveSettings } from '../settings.js';
import { fileKey, repoKey, store } from '../store.js';
import { projectKey } from '../tracker-model.js';
import { Icon } from './icons.js';
import { ScopeBar, Segmented } from './components.js';

const SORTS = [
  { id: 'recent', label: 'Recent' },
  { id: 'name', label: 'Name' },
  { id: 'project', label: 'Project' },
];

function tagCounts(rows) {
  const counts = new Map();
  for (const r of rows) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// One list for the editor's files and the tracker's documents.
const fileRow = (f) => ({ key: fileKey(f.id), name: f.name, project: f.project, tags: f.tags, modifiedAt: f.modifiedAt, updatedAt: f.updatedAt, unsynced: f.dirty || f.pending, id: f.id, encrypted: f.encrypted });
const docRow = (d) => ({ key: repoKey(d.path), name: d.name, project: d.project, tags: d.tags, modifiedAt: d.modifiedAt, updatedAt: d.modifiedAt, unsynced: store.repoTab(d.path)?.dirty, id: `r:${d.path}`, item: d.item.title });

export function Sidebar({ files, docs, projects, settings, activeKey, actions }) {
  const [filter, setFilter] = useState('');
  const [tag, setTag] = useState(null);
  const [sort, setSort] = useState('recent');
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const q = filter.trim().toLowerCase();
  const rows = [...files.map(fileRow), ...docs.map(docRow)];
  const shown = rows
    .filter((r) => !tag || r.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
    .filter((r) => !q || [r.name, r.project, r.item ?? '', ...r.tags].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      if (sort === 'project') return (a.project || '￿').localeCompare(b.project || '￿') || a.name.localeCompare(b.name, undefined, { numeric: true });
      return (b.modifiedAt > a.modifiedAt ? 1 : b.modifiedAt < a.modifiedAt ? -1 : 0) || (b.updatedAt > a.updatedAt ? 1 : -1);
    });
  const tags = tagCounts(rows);
  const trashCount = store.trash().length;
  let lastProject = null;

  return html`<aside class="sidebar" aria-label="Files">
    <div class="sidebar-top">
      <${ScopeBar} scope=${settings.projectScope} projects=${projects} onChange=${(scope) => saveSettings({ projectScope: scope })} />
      <div class="sidebar-filter">
        <${Icon} name="search" size=${15} />
        <input value=${filter} onInput=${(e) => setFilter(e.currentTarget.value)} placeholder=${`Filter ${rows.length} file${rows.length === 1 ? '' : 's'}`} aria-label="Filter files" />
      </div>
      ${tags.length > 0 &&
      html`<div class="sidebar-tags">
        ${tags.slice(0, 18).map(
          ([t, n]) => html`<button type="button" key=${t} class="tag ${tag === t ? 'active' : ''}" aria-pressed=${tag === t} onClick=${() => setTag(tag === t ? null : t)}>#${t} <span class="muted">${n}</span></button>`,
        )}
      </div>`}
      <${Segmented} small options=${SORTS} value=${sort} onChange=${setSort} label="Sort files" />
    </div>
    <div class="file-list">
      ${shown.map((f) => {
        const project = byKey.get(projectKey(f.project));
        const header = sort === 'project' && f.project !== lastProject;
        lastProject = f.project;
        return html`
          ${header && html`<div class="file-group" key=${`g-${f.project}`}>${f.project ? html`<span class="project-dot" style=${{ '--pc': project?.color }} />${f.project}` : 'No project'}</div>`}
          <button type="button" key=${f.key} class="file-row ${activeKey === f.key ? 'active' : ''}" onClick=${() => actions.openFile(f.id)}
            title=${f.item ? `${f.name} · from the tracker: ${f.item}` : f.name}>
            <span class="file-row-main">
              <span class="file-name">${f.encrypted && html`<${Icon} name="lock" size=${12} />`}${f.name}</span>
              ${f.unsynced && html`<span class="tab-dot" title="Not synced yet" />`}
            </span>
            ${f.item && html`<span class="file-item"><${Icon} name="doc" size=${13} /><span>${f.item}</span></span>`}
            <span class="file-meta">
              ${f.project && sort !== 'project' && html`<span class="mini-project"><span class="project-dot" style=${{ '--pc': project?.color }} />${f.project}</span>`}
              ${f.tags.slice(0, 3).map((t) => html`<span class="mini-tag" key=${t}>#${t}</span>`)}
              <span class="spacer" />
              <span class="muted">${timeAgo(f.modifiedAt)}</span>
            </span>
          </button>
        `;
      })}
      ${!shown.length &&
      html`<p class="muted small empty-list">${rows.length ? 'No files match.' : 'No files here yet.'}${
        settings.projectScope.length ? html` <button type="button" class="btn link" onClick=${() => saveSettings({ projectScope: [] })}>Show all projects</button>` : ''
      }</p>`}
    </div>
    <div class="sidebar-foot">
      <button type="button" class="btn sm" onClick=${() => actions.newFile()}><${Icon} name="plus" size=${15} />New</button>
      <button type="button" class="btn sm" onClick=${() => actions.openFromDisk()}><${Icon} name="upload" size=${15} />Import</button>
      <button type="button" class="btn sm trash-btn" aria-label="Trash" title="Deleted files: restore them" onClick=${() => actions.openDialog({ type: 'trash' })}>
        <${Icon} name="trash" size=${15} />${trashCount > 0 && html`<span class="count">${trashCount}</span>`}
      </button>
    </div>
  </aside>`;
}
