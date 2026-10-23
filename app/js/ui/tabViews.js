// Tab views: the switcher at the left of the tab bar (which groups the bar shows:
// one, several, or all), moving a tab to another group, and a folder's group
// (linked to a tracker project, its color).
import { html, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { Icon } from './icons.js';
import { Modal } from './components.js';
import { Menu } from './menu.js';
import { getSettings, saveSettings } from '../settings.js';
import { store } from '../store.js';
import { folderColor, PINNED, toggleInView } from '../tabGroups.js';
import { projectList } from '../tracker-model.js';
import { baseName } from '../folders.js';

export const COLOR_MODES = [
  ['auto', 'When 2+ groups show'],
  ['always', 'Always'],
  ['off', 'Off'],
];

const KIND_ICON = { pinned: 'pin', notes: 'cloud', other: 'disk' };

/**
 * The view switcher's popover at `at`. A group's name shows only it, its box adds
 * or takes it out (several together); type to filter, Enter picks the first.
 * With `moving` ({ key, name } of a tab) it moves that tab to the group picked instead.
 */
export function TabViewMenu({ state, at, onClose, owner, actions, moving = null }) {
  const ref = useRef(null);
  const input = useRef(null);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const [rowMenu, setRowMenu] = useState(null); // { group, at }
  const settings = getSettings();
  const { session } = store;
  const view = state.view ?? [];
  const current = moving ? state.groupOfKey(moving.key) : null;
  const all = [...(session.pinned.length && !moving ? [{ id: PINNED, kind: 'pinned', name: 'Pinned', color: null, keys: session.pinned }] : []), ...state.groups];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = all.filter((g) => words.every((w) => g.name.toLowerCase().includes(w)));
  useLayoutEffect(() => {
    const el = ref.current;
    const r = el.getBoundingClientRect();
    const x = at.right ? at.x - r.width : at.x;
    setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) });
    input.current?.focus();
    // A click on its row menus is inside; on the button that opened it, left to the button.
    const onDown = (e) => !el.contains(e.target) && !e.target.closest?.('.menu') && !owner?.current?.contains(e.target) && onClose();
    const onKey = (e) => {
      // Escape closes a group's menu first, then this.
      if (e.key === 'Escape' && !document.querySelector('.menu:not(.tab-views)')) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = [...el.querySelectorAll('.view-pick')];
        const i = buttons.indexOf(document.activeElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);
  const pick = (id) => {
    onClose();
    if (moving) actions.moveToGroup(moving.key, id === current ? null : id);
    else actions.setTabView(id ? [id] : null);
  };
  const toggle = (id) => actions.setTabView(toggleInView(state.view, id));
  const count = (g) => g.keys.length;
  const colorMode = settings.tabColors ?? 'auto';
  const nextMode = COLOR_MODES[(COLOR_MODES.findIndex(([m]) => m === colorMode) + 1) % COLOR_MODES.length][0];
  const rowItems = (g) => [
    { label: `Only the ${g.name} tabs`, icon: 'eye', run: () => actions.setTabView([g.id]) },
    { label: 'Close its tabs', icon: 'x', run: () => actions.closeMany(g.keys.filter((k) => !session.pinned.includes(k))) },
    g.kind === 'folder' && { separator: true },
    g.kind === 'folder' && { label: 'Link to a project or set its color…', icon: 'folder', run: () => (onClose(), actions.folderGroup(g.path)) },
    g.kind === 'project' && g.folders?.length && { separator: true },
    ...(g.kind === 'project' ? (g.folders ?? []).map((path) => ({ key: path, label: `Folder ${baseName(path)}: link or unlink…`, icon: 'folder', run: () => (onClose(), actions.folderGroup(path)) })) : []),
  ];
  return html`<div class="menu tab-views" role="dialog" aria-label=${moving ? 'Move the tab to a group' : 'Which tabs show'} ref=${ref} style=${{ left: `${pos.left}px`, top: `${pos.top}px` }}>
    ${moving && html`<div class="menu-heading">Move “${moving.name}” to</div>`}
    <input class="view-filter" ref=${input} value=${query} placeholder=${moving ? 'Group…' : 'Show only… (type a name)'} aria-label="Group name" spellcheck="false"
      onInput=${(e) => setQuery(e.currentTarget.value)}
      onKeyDown=${(e) => {
        // Enter: the first group found; with nothing typed, all tabs.
        if (e.key === 'Enter') {
          e.preventDefault();
          if (query && rows[0]) pick(rows[0].id);
          else if (!query && !moving) pick(null);
        }
      }} />
    ${!moving &&
    !query &&
    html`<div class="view-row ${view.length ? '' : 'on'}">
      <span class="view-check-space" />
      <button type="button" class="view-pick" aria-pressed=${!view.length} onClick=${() => pick(null)}>
        <${Icon} name="list" size=${15} /><span class="view-name">All tabs</span><span class="view-count">${session.open.length}</span>
      </button>
    </div>`}
    ${(!moving && !query) || rows.length ? html`<div class="menu-separator" role="separator" />` : ''}
    ${rows.map((g) => {
      const on = moving ? g.id === current : view.includes(g.id);
      return html`<div class="view-row ${on ? 'on' : ''}" key=${g.id}>
        ${moving
          ? html`<span class="view-check-space" />`
          : html`<button type="button" class="view-check" role="checkbox" aria-checked=${on} aria-label=${`${on ? 'Hide' : 'Also show'} ${g.name}`} title=${on ? 'Take it out of the view' : 'Add it to the view'} onClick=${() => toggle(g.id)}>
              ${on && html`<${Icon} name="check" size=${13} />`}
            </button>`}
        <button type="button" class="view-pick" aria-pressed=${on} title=${moving ? `Move the tab to ${g.name}` : `Show only the ${g.name} tabs`} onClick=${() => pick(g.id)}>
          ${g.color ? html`<span class="view-dot" style=${{ '--gc': g.color }} />` : html`<${Icon} name=${KIND_ICON[g.kind] ?? 'folder'} size=${14} />`}
          <span class="view-name">${g.name}</span>${g.kind === 'project' && g.folders?.length ? html`<span class="view-hint">project + folder</span>` : g.kind === 'folder' ? html`<span class="view-hint">folder</span>` : ''}
          <span class="view-count">${count(g)}</span>
        </button>
        ${!moving && g.id !== PINNED &&
        html`<button type="button" class="icon-btn sm view-more" aria-label=${`More for ${g.name}`} aria-haspopup="menu"
          onClick=${(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setRowMenu({ group: g, at: { x: r.right, y: r.bottom + 2, right: true } });
          }}><${Icon} name="more" size=${14} /></button>`}
      </div>`;
    })}
    ${moving && session.assigned[moving.key] && html`<div class="menu-separator" role="separator" />
      <button type="button" class="menu-item" onClick=${() => (onClose(), actions.moveToGroup(moving.key, null))}><${Icon} name="rotate" size=${15} /><span>Back to its own group</span></button>`}
    ${!moving &&
    html`<div class="menu-separator" role="separator" />
      <button type="button" class="menu-item" role="menuitemcheckbox" aria-checked=${settings.pinnedEverywhere !== false} onClick=${() => saveSettings({ pinnedEverywhere: getSettings().pinnedEverywhere === false })}>
        <${Icon} name="pin" size=${15} /><span>Pinned tabs in every view</span>${settings.pinnedEverywhere !== false && html`<${Icon} name="check" size=${14} />`}
      </button>
      <button type="button" class="menu-item" title="A line in the group's color under each tab" onClick=${() => saveSettings({ tabColors: nextMode })}>
        <span class="view-dot sample" /><span>Color tabs by group</span><span class="menu-hint">${COLOR_MODES.find(([m]) => m === colorMode)?.[1]}</span>
      </button>
      <button type="button" class="menu-item" role="menuitemcheckbox" aria-checked=${Boolean(settings.groupTabs)} onClick=${() => saveSettings({ groupTabs: !getSettings().groupTabs })}>
        <${Icon} name="columns" size=${15} /><span>Group headers in the tab bar</span>${settings.groupTabs && html`<${Icon} name="check" size=${14} />`}
      </button>`}
    ${rowMenu && html`<${Menu} items=${rowItems(rowMenu.group)} at=${rowMenu.at} label=${rowMenu.group.name} onClose=${() => setRowMenu(null)} />`}
  </div>`;
}

/** A folder as a tab group: linked to a tracker project (its tabs then go with the project's), or its own color. */
export function FolderGroupDialog({ path, onClose }) {
  const settings = getSettings();
  const projects = projectList(store.live(), store.projects());
  const [project, setProject] = useState(settings.folderProjects?.[path] ?? '');
  const [color, setColor] = useState(settings.folderColors?.[path] || folderColor(path));
  const save = (e) => {
    e.preventDefault();
    const s = getSettings();
    saveSettings({ folderProjects: { ...s.folderProjects, [path]: project }, folderColors: { ...s.folderColors, [path]: color } });
    onClose();
  };
  return html`<${Modal} title=${`Tabs of ${baseName(path)}`} onClose=${onClose}
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="submit" form="folder-group" class="btn primary">Save</button>`}>
    <form id="folder-group" onSubmit=${save}>
      <p class="muted small">${path}</p>
      <label class="field"><span class="field-label">Project</span>
        <select value=${project} onChange=${(e) => setProject(e.currentTarget.value)}>
          <option value="">None: the folder is a group of its own</option>
          ${projects.map((p) => html`<option value=${p.name}>${p.name}</option>`)}
        </select>
      </label>
      <p class="muted small">Linked to a project, the folder’s tabs show together with the project’s notes and tracker documents, in its color.</p>
      ${!project &&
      html`<label class="field"><span class="field-label">Color</span>
        <input type="color" value=${color} onInput=${(e) => setColor(e.currentTarget.value)} />
      </label>`}
    </form>
  </${Modal}>`;
}
