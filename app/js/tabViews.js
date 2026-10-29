// Tab views in the page: the facts of each open tab (where it lives, its project),
// the folders that make tab groups (the picked folder behind each folder shown in
// Folders, earlier ones while their tabs are open, folders linked to a project),
// and what the bar shows. The rules themselves are in tabGroups.js.
import { getSettings } from './settings.js';
import { parseKey, store } from './store.js';
import { isWithin, rootOf, withCurrent } from './folders.js';
import { projectList } from './tracker-model.js';
import { isRemotePath, kindOfKey, remoteParts, remoteRoot } from './where.js';
import { server } from './servers.js';
import { folderColor, groupName, groupOf, tabGroups, viewKey, viewLabel, viewTabs } from './tabGroups.js';

let roots = null; // the folders picked in the open dialog (desktop)

/** Reads the picked folders again (after a pick, or the folders shown changing). */
export async function loadRoots() {
  const next = (await window.desktop?.folders?.roots?.().catch(() => null)) ?? null;
  const changed = (next ?? []).join('\n') !== (roots ?? []).join('\n');
  roots = next;
  return changed;
}

/** The folder each section of Folders stands for: the picked folder it is in; a server's top folder. */
export function sectionFolders(settings = getSettings()) {
  if (!window.desktop?.folders) return [];
  const list = withCurrent(settings.folderSections, settings.folder).map((s) => (isRemotePath(s) ? remoteRoot(remoteParts(s).id) : (roots && rootOf(s, roots)) || s));
  return [...new Set(list)];
}

/** { key, kind, project, path } of an open tab. */
export function tabFacts(key) {
  const k = parseKey(key);
  // A comparison goes with its left side (else its right): the folder or file it is about.
  if (k?.kind === 'compare') {
    const c = store.compare(k.id);
    const side = [c?.left, c?.right].find((s) => s?.path || s?.key);
    if (side?.path) return { key, kind: isRemotePath(side.path) ? 'remote' : 'disk', project: '', path: side.path };
    return side?.key ? { ...tabFacts(side.key), key } : { key, kind: 'disk', project: '', path: '' };
  }
  const kind = kindOfKey(key);
  if (k?.kind === 'file') return { key, kind, project: store.get(k.id)?.project ?? '' };
  if (k?.kind === 'disk') return { key, kind, project: '', path: k.path };
  return { key, kind, project: k ? (store.doc(k.path)?.project ?? '') : '' };
}

export function groupContext(settings = getSettings()) {
  const links = Object.fromEntries(Object.entries(settings.folderProjects ?? {}).filter(([, project]) => project));
  const folders = [...new Set([...sectionFolders(settings), ...store.session.groupFolders, ...Object.keys(links)])];
  return { folders, links, assigned: store.session.assigned };
}

const folderName = (path) => (isRemotePath(path) && remoteParts(path).path === '/' ? server(remoteParts(path).id)?.name : '');

/**
 * Everything the bar and the actions need now: the groups of the open tabs, the
 * group of a key, and the tabs the view shows ({ keys, guests }).
 */
export function tabViewState(settings = getSettings()) {
  const { session } = store;
  const ctx = groupContext(settings);
  const facts = session.open.map(tabFacts);
  const ids = new Map(facts.map((f) => [f.key, groupOf(f, ctx)]));
  const groupOfKey = (key) => ids.get(key) ?? groupOf(tabFacts(key), ctx);
  const projects = projectList(store.live(), store.projects());
  const groups = tabGroups(facts, ctx, { projects, colors: settings.folderColors ?? {}, folderName });
  const view = session.view;
  const shown = viewTabs(session.open, view, groupOfKey, { pinned: session.pinned, pinnedEverywhere: settings.pinnedEverywhere !== false, active: session.active, side: session.side });
  // A group of the view with none of its tabs open still has a name.
  const nameOf = (id) => groupName(id, { projects, folderName });
  return { ctx, groups, groupOfKey, view, nameOf, label: viewLabel(view, groups, nameOf), ...shown };
}

/** The open tab for a view: the one it had last, else its first tab (null: none). */
export function activeFor(view, state, settings = getSettings()) {
  const { session } = store;
  const next = viewTabs(session.open, view, state.groupOfKey, { pinned: session.pinned, pinnedEverywhere: settings.pinnedEverywhere !== false });
  if (session.active && next.keys.includes(session.active)) return session.active;
  const last = session.viewActive[viewKey(view)];
  if (last && next.keys.includes(last)) return last;
  return next.keys.find((k) => k !== session.side && !session.pinned.includes(k)) ?? next.keys.find((k) => k !== session.side) ?? null;
}

/** The tab group a folder shown in Folders makes: { id, folder, name, color, kind }. */
export function folderGroupOf(section, settings = getSettings()) {
  const folder = sectionFolders({ ...settings, folderSections: [section], folder: section })[0] ?? section;
  const ctx = { ...groupContext(settings), folders: [folder] };
  const tab = { key: '', kind: isRemotePath(folder) ? 'remote' : 'disk', path: folder };
  // As the tab bar has it when its tabs are open (the same color), else on its own.
  const now = tabViewState(settings).groups;
  const open = now.find((g) => g.id === groupOf(tab, ctx));
  if (open) return { ...open, folder };
  const [group] = tabGroups([tab], ctx, { projects: projectList(store.live(), store.projects()), colors: settings.folderColors ?? {}, folderName });
  if (group.kind === 'folder' && !settings.folderColors?.[folder]) group.color = folderColor(folder, new Set(now.map((g) => g.color).filter(Boolean)));
  return { ...group, folder };
}

/** Keeps the folders whose tabs are still open as groups, when Folders shows others. */
export function rememberFolders(settings = getSettings()) {
  const disk = store.session.open.filter((k) => k.startsWith('d:')).map((k) => k.slice(2));
  store.rememberFolders(sectionFolders(settings), (folder) => disk.some((p) => isWithin(p, folder)));
}
