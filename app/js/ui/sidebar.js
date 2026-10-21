import { html, useState } from '../../vendor/preact-htm.js';
import { timeAgo } from '../format.js';
import { saveSettings } from '../settings.js';
import { fileKey } from '../store.js';
import { projectKey } from '../tracker-model.js';
import { Icon } from './icons.js';
import { ScopeBar, Segmented } from './components.js';

const SORTS = [
  { id: 'recent', label: 'Recent' },
  { id: 'name', label: 'Name' },
  { id: 'project', label: 'Project' },
];

function tagCounts(files) {
  const counts = new Map();
  for (const f of files) for (const t of f.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function Sidebar({ files, projects, settings, activeKey, actions }) {
  const [filter, setFilter] = useState('');
  const [tag, setTag] = useState(null);
  const [sort, setSort] = useState('recent');
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const q = filter.trim().toLowerCase();
  const shown = files
    .filter((f) => !tag || f.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
    .filter((f) => !q || f.name.toLowerCase().includes(q) || f.project.toLowerCase().includes(q) || f.tags.some((t) => t.toLowerCase().includes(q)))
    .sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      if (sort === 'project') return (a.project || '￿').localeCompare(b.project || '￿') || a.name.localeCompare(b.name, undefined, { numeric: true });
      return (b.modifiedAt > a.modifiedAt ? 1 : b.modifiedAt < a.modifiedAt ? -1 : 0) || (b.updatedAt > a.updatedAt ? 1 : -1);
    });
  const tags = tagCounts(files);
  let lastProject = null;

  return html`<aside class="sidebar" aria-label="Files">
    <div class="sidebar-top">
      <${ScopeBar} scope=${settings.projectScope} projects=${projects} onChange=${(scope) => saveSettings({ projectScope: scope })} />
      <div class="sidebar-filter">
        <${Icon} name="search" size=${15} />
        <input value=${filter} onInput=${(e) => setFilter(e.currentTarget.value)} placeholder=${`Filter ${files.length} file${files.length === 1 ? '' : 's'}`} aria-label="Filter files" />
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
          <button type="button" key=${f.id} class="file-row ${activeKey === fileKey(f.id) ? 'active' : ''}" onClick=${() => actions.openFile(f.id)} title=${f.name}>
            <span class="file-row-main">
              <span class="file-name">${f.name}</span>
              ${(f.dirty || f.pending) && html`<span class="tab-dot" title="Not synced yet" />`}
            </span>
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
      html`<p class="muted small empty-list">${files.length ? 'No files match.' : 'No files here yet.'}${
        settings.projectScope.length ? html` <button type="button" class="btn link" onClick=${() => saveSettings({ projectScope: [] })}>Show all projects</button>` : ''
      }</p>`}
    </div>
    <div class="sidebar-foot">
      <button type="button" class="btn sm" onClick=${() => actions.newFile()}><${Icon} name="plus" size=${15} />New</button>
      <button type="button" class="btn sm" onClick=${() => actions.openFromDisk()}><${Icon} name="upload" size=${15} />Import</button>
    </div>
  </aside>`;
}
