// Tab views: which group each open tab belongs to (a tracker project, a folder
// open in Folders, Notes or Other files), and which tabs a view of the tab bar
// shows (all groups, one, or several together). Pure, so the Node tests can import it.
import { baseName, isWithin, rootOf } from './folders.js';
import { compactName, defaultProjectColor, projectKey } from './tracker-model.js';

// Folder colors, apart from the colors of where files live (green, blue, amber, magenta).
export const FOLDER_COLORS = ['#4f46e5', '#0e8a8a', '#c2603c', '#8b4fd6', '#7a8a1f', '#5f6b7a', '#c23b6b'];

/** A folder's own color: the same each time (from its path), another when that one is taken. */
export function folderColor(path, taken = new Set()) {
  let hash = 0;
  for (const ch of path) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  for (let i = 0; i < FOLDER_COLORS.length; i++) {
    const color = FOLDER_COLORS[(hash + i) % FOLDER_COLORS.length];
    if (!taken.has(color)) return color;
  }
  return FOLDER_COLORS[hash % FOLDER_COLORS.length];
}

export const NOTES = 'notes';
export const OTHER = 'other';
export const PINNED = 'pinned';

const projectId = (name) => `p:${projectKey(name)}`;
export const folderId = (path) => `f:${path}`;

/**
 * The group of a tab ({ key, kind, project, path }): a tab moved by hand keeps
 * its group; a file in a folder belongs to the folder (the deepest one), or to
 * the project the folder is linked to; my files and tracker documents to their
 * project, else Notes; anything else on disk or a server to Other files.
 * `ctx`: { folders: [path], links: { path: project name }, assigned: { key: id } }.
 */
export function groupOf(tab, { folders = [], links = {}, assigned = {} } = {}) {
  if (assigned[tab.key]) return assigned[tab.key];
  if (tab.kind === 'disk' || tab.kind === 'remote') {
    const folder = tab.path && rootOf(tab.path, folders);
    if (!folder) return OTHER;
    return links[folder] ? projectId(links[folder]) : folderId(folder);
  }
  return tab.project ? projectId(tab.project) : NOTES;
}

/**
 * The groups of the open tabs, for the switcher and the bar: [{ id, kind, name,
 * color, path?, keys }] with Notes first, then projects and folders in the order
 * their first tab is open, then Other files. Names shared by two folders get
 * their parent's name. `projects`: [{ key, name, color }]; `colors`: { path: color };
 * `folderName(path)` names a folder (a server's top folder by the server).
 */
export function tabGroups(tabs, ctx = {}, { projects = [], colors = {}, folderName = baseName } = {}) {
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const groups = new Map();
  for (const tab of tabs) {
    const id = groupOf(tab, ctx);
    if (!groups.has(id)) groups.set(id, describe(id, tab, byKey, colors, ctx.links ?? {}, folderName));
    groups.get(id).keys.push(tab.key);
  }
  const list = [...groups.values()];
  // Folders without a color of their own: one no other group shows.
  const taken = new Set(list.filter((g) => g.color).map((g) => g.color));
  for (const g of list) {
    if (g.kind !== 'folder' || g.color) continue;
    g.color = folderColor(g.path, taken);
    taken.add(g.color);
  }
  const names = new Map();
  for (const g of list) if (g.kind === 'folder') names.set(g.name, (names.get(g.name) ?? 0) + 1);
  for (const g of list) if (g.kind === 'folder' && names.get(g.name) > 1) g.name = `${g.name} (${baseName(g.path.slice(0, g.path.length - baseName(g.path).length)) || g.path})`;
  return [...list.filter((g) => g.id === NOTES), ...list.filter((g) => g.kind === 'project' || g.kind === 'folder'), ...list.filter((g) => g.id === OTHER)];
}

function describe(id, tab, byKey, colors, links, folderName) {
  if (id === NOTES) return { id, kind: 'notes', name: 'Notes', color: null, keys: [] };
  if (id === OTHER) return { id, kind: 'other', name: 'Other files', color: null, keys: [] };
  if (id.startsWith('p:')) {
    const key = id.slice(2);
    const record = byKey.get(key);
    const linked = Object.keys(links).filter((path) => projectKey(links[path]) === key);
    const name = record?.name ?? (tab.project || links[linked[0]] || key);
    return { id, kind: 'project', name, color: record?.color || defaultProjectColor(key), folders: linked, keys: [] };
  }
  const path = id.slice(2);
  return { id, kind: 'folder', name: folderName(path) || baseName(path), path, color: colors[path] || null, keys: [] };
}

/** A view's id, for remembering its last tab: '' for all tabs. */
export const viewKey = (view) => (view?.length ? [...view].sort().join('|') : '');

/**
 * The tabs a view shows, in the bar's order: those of its groups, the pinned
 * ones (with `pinnedEverywhere`, or when the view has Pinned), and the open tab
 * (and the side view's) when it is from elsewhere: `guests`.
 */
export function viewTabs(open, view, groupOfKey, { pinned = [], pinnedEverywhere = true, active = null, side = null } = {}) {
  if (!view?.length) return { keys: open, guests: [] };
  const shows = (key) => view.includes(groupOfKey(key)) || (pinned.includes(key) && (pinnedEverywhere || view.includes(PINNED)));
  const keys = open.filter(shows);
  const guests = [active, side].filter((k, i, all) => k && open.includes(k) && !shows(k) && all.indexOf(k) === i);
  return { keys, guests };
}

/** "All tabs", "Tracker Editor", "Notes + tracking_app", "Notes + 2". */
export function viewLabel(view, groups, nameOf = groupName) {
  if (!view?.length) return 'All tabs';
  const names = view.map((id) => (id === PINNED ? 'Pinned' : (groups.find((g) => g.id === id)?.name ?? nameOf(id)))).filter(Boolean);
  if (!names.length) return 'All tabs';
  return names.length <= 2 ? names.join(' + ') : `${names[0]} + ${names.length - 1}`;
}

/** A group's name from its id alone (when none of its tabs is open). */
export function groupName(id, { projects = [], folderName = baseName } = {}) {
  if (id === NOTES) return 'Notes';
  if (id === OTHER) return 'Other files';
  if (id === PINNED) return 'Pinned';
  if (id.startsWith('p:')) return projects.find((p) => p.key === id.slice(2))?.name ?? id.slice(2);
  if (id.startsWith('f:')) return folderName(id.slice(2)) || baseName(id.slice(2));
  return '';
}

/** The view with one group added or taken out (none left: all tabs). */
export function toggleInView(view, id) {
  const list = view ?? [];
  const next = list.includes(id) ? list.filter((g) => g !== id) : [...list, id];
  return next.length ? next : null;
}

/** The next group's view from this one (one group at a time, then all tabs, around). */
export function stepView(view, groups, step) {
  const ids = [null, ...groups.map((g) => g.id)];
  const at = view?.length === 1 ? ids.indexOf(view[0]) : 0;
  const next = ids[((at === -1 ? 0 : at) + step + ids.length) % ids.length];
  return next ? [next] : null;
}

/** The project a folder's name suggests linking it to: "tracker-editor" → "Tracker Editor". */
export function suggestedProject(path, projects) {
  const name = compactName(baseName(path));
  return (name && projects.find((p) => compactName(p.name) === name)) || null;
}

/** Whether a path is one of the folders, or inside one. */
export const inFolders = (path, folders) => folders.some((f) => isWithin(path, f));
