// Folders' list of places (0.54; ui/folderMenu.js, under Folders' ⋯) and the side-by-side dialog's
// "Add a folder" (ui/sideBySide.js): the folders shown now, favorites, the folders picked on this
// computer grouped by drive (C:, F:, a network share, the phone's storage; on macOS and Linux the
// home folder, a mounted volume or the top folder) and nested under their common parents, each
// server with the folders used there before, the recent ones and the saved folder comparisons.
// Pure, so the tests import it: names, colors and states come from the caller.
import { baseName, breadcrumbs, folderLabel, isWithin, nameMatcher, pathKey, samePath, topOf } from './folders.js';
import { folderColor } from './tabGroups.js';

const REMOTE = 'remote://';
const isRemote = (p) => typeof p === 'string' && p.startsWith(REMOTE);
const serverOf = (p) => p.slice(REMOTE.length).split('/')[0];
const VOLUME = /^(\/Volumes\/[^/]+|\/media\/[^/]+\/[^/]+|\/run\/media\/[^/]+\/[^/]+|\/mnt\/[^/]+)(\/|$)/;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The group a folder goes under: { key, path, label, kind } with kind 'drive' (C:), 'share'
 * (\\nas\share), 'storage' (the phone's, a memory card), 'home' (~), 'volume' (/Volumes/Data,
 * /media/me/usb), 'top' (/srv, or / itself) or 'server' (remote://id/).
 */
export function driveOf(p, { home = '' } = {}) {
  if (!p) return null;
  if (isRemote(p)) return { key: `remote:${serverOf(p)}`, path: `${REMOTE}${serverOf(p)}/`, label: '', kind: 'server', server: serverOf(p) };
  const top = topOf(p);
  if (/^[A-Z]:\\$/.test(top)) return { key: pathKey(top), path: top, label: top.slice(0, 2), kind: 'drive' };
  if (top.startsWith('\\\\')) return { key: pathKey(top), path: top, label: top, kind: 'share' };
  if (top !== '/') return { key: top, path: top, label: folderLabel(top), kind: 'storage' };
  const h = home && home !== '/' ? home.replace(/\/+$/, '') : '';
  if (h && isWithin(p, h)) return { key: h, path: h, label: 'Home', kind: 'home' };
  const volume = VOLUME.exec(p)?.[1];
  if (volume) return { key: volume, path: volume, label: baseName(volume), kind: 'volume' };
  const first = /^\/[^/]+/.exec(p)?.[0];
  return first ? { key: first, path: first, label: first, kind: 'top' } : { key: '/', path: '/', label: '/', kind: 'top' };
}

/**
 * Folders inside `top` nested under their common parents, where that saves reading: a folder of
 * the list holds those inside it, and a folder not in the list that holds two or more of them is
 * a line of its own (`junction`, "_worktrees" over its worktrees). A folder alone under its
 * parent keeps the way there as `prefix` ("ai-scaffold\scaffold-apps\" before "rag-pro"). →
 * { head (`top` itself is in the list), rows: [{ path, name, prefix, depth, junction }] } in
 * order of name.
 */
export function nestFolders(paths, top) {
  const sep = /^[A-Za-z]:|^\\\\/.test(top) ? '\\' : '/';
  const root = { children: new Map(), pick: false, path: top };
  for (const p of paths) {
    if (!p || !isWithin(p, top)) continue;
    let node = root;
    for (const crumb of breadcrumbs(p, top).slice(1)) {
      const key = sep === '\\' ? crumb.name.toLowerCase() : crumb.name;
      if (!node.children.has(key)) node.children.set(key, { name: crumb.name, children: new Map(), pick: false, path: crumb.path });
      node = node.children.get(key);
    }
    node.pick = true;
    node.original ??= p;
  }
  const rows = [];
  const walk = (node, depth) => {
    const kids = [...node.children.values()].sort((a, b) => collator.compare(a.name, b.name));
    for (const kid of kids) {
      let at = kid;
      const way = [kid.name];
      while (!at.pick && at.children.size === 1) {
        at = [...at.children.values()][0];
        way.push(at.name);
      }
      rows.push({ path: at.original ?? at.path, name: way.at(-1), prefix: way.length > 1 ? `${way.slice(0, -1).join(sep)}${sep}` : '', depth, junction: !at.pick });
      walk(at, depth + 1);
    }
  };
  walk(root, 0);
  return { head: root.pick, rows };
}

/** Whether a folder fits the list's filter: its name (text or a * ? pattern), or the text anywhere in its path or `also` (a server's name). */
export function fitsFilter(path, query, also = '') {
  const q = (query ?? '').trim();
  if (!q) return true;
  if (nameMatcher(q)(baseName(isRemote(path) ? path.slice(REMOTE.length).replace(/^[^/]*/, '') || '/' : path))) return true;
  if (/[*?]/.test(q)) return false;
  const low = q.toLowerCase();
  return path.toLowerCase().includes(low) || String(also).toLowerCase().includes(low);
}

/** Colors for the drives: one each, none used twice while there are colors left, the same for a drive each time it is the same list. */
export function driveColors(drives) {
  const taken = new Set();
  const out = new Map();
  for (const d of [...drives].sort((a, b) => collator.compare(a.path, b.path))) {
    const color = folderColor(d.path, taken);
    taken.add(color);
    out.set(d.key, color);
  }
  return out;
}

const unique = (list) => {
  const seen = new Set();
  return (list ?? []).filter((p) => p && !seen.has(pathKey(p)) && seen.add(pathKey(p)));
};

/**
 * The list's sections, in order, each { id, label, rows } (sections without rows left out):
 * - 'shown': the folders shown in Folders now (`current` marked);
 * - 'favorites';
 * - 'computer': the folders picked here (`roots`), by drive: a 'drive' row each (its `color`; `pick`
 *   when the drive's top itself was picked), then its folders nested (nestFolders);
 * - 'servers': a 'server' row per connection ({ id, label, detail, icon, state }), then the
 *   folders used there before (recent ones, not favorites);
 * - 'recent': the other recent folders here (not favorites, picked or shown);
 * - 'saved': saved folder comparisons and two panes ({ id, name, mode, left, right }).
 * Folder rows: { type: 'folder', key, path, name, prefix, depth, junction, shown, current,
 * favorite, picked, color, server }. `query` keeps what fits it (fitsFilter), nested again among
 * themselves. `colorOf(path)` gives a folder its color (its header's in the tree, its tabs'); `nameOf`
 * names a server's folder (its server for its top).
 */
export function folderListModel({ shown = [], current = '', roots = [], favorites = [], recent = [], servers = [], saved = [], home = '', query = '', colorOf = () => null, hereLabel = 'This computer' } = {}) {
  const q = (query ?? '').trim();
  const shownKeys = new Set(shown.filter(Boolean).map(pathKey));
  const favKeys = new Set((favorites ?? []).filter(Boolean).map(pathKey));
  const rootKeys = new Set(roots.filter(Boolean).map(pathKey));
  const serverName = (p) => servers.find((s) => s.id === serverOf(p))?.label ?? '';
  const fits = (p) => fitsFilter(p, q, isRemote(p) ? serverName(p) : '');
  const folder = (p, extra = {}) => ({
    type: 'folder',
    key: `${extra.section ?? ''}|${pathKey(p)}`,
    path: p,
    name: '',
    prefix: '',
    depth: 0,
    junction: false,
    shown: shownKeys.has(pathKey(p)),
    current: samePath(p, current),
    favorite: favKeys.has(pathKey(p)),
    picked: rootKeys.has(pathKey(p)),
    color: colorOf(p),
    server: isRemote(p) ? serverOf(p) : '',
    ...extra,
  });
  const sections = [];
  const add = (id, label, rows) => rows.length && sections.push({ id, label, rows });

  add('shown', 'Shown now', unique(shown).filter(fits).map((p) => folder(p, { section: 'shown' })));
  add('favorites', 'Favorites', unique(favorites).filter(fits).map((p) => folder(p, { section: 'favorites' })));

  // This computer: by drive, nested.
  const local = unique(roots).filter((p) => !isRemote(p) && fits(p));
  const drives = new Map();
  for (const p of local) {
    const d = driveOf(p, { home });
    if (!drives.has(d.key)) drives.set(d.key, { ...d, paths: [] });
    drives.get(d.key).paths.push(p);
  }
  const colors = driveColors([...drives.values()]);
  const computer = [];
  for (const d of [...drives.values()].sort((a, b) => (a.kind === 'home' ? -1 : b.kind === 'home' ? 1 : collator.compare(a.path, b.path)))) {
    const { head, rows } = nestFolders(d.paths, d.path);
    const color = colors.get(d.key);
    const own = d.paths.find((p) => samePath(p, d.path)) ?? d.path;
    // While filtering, a drive and a common parent are there for what they hold: Enter takes the first that fits itself (`match`).
    computer.push({ ...folder(own, { section: 'computer' }), type: 'drive', key: `drive|${d.key}`, name: d.label, kind: d.kind, pick: head, color, drive: d.key, count: d.paths.length, match: head && fits(own) });
    for (const r of rows) computer.push(folder(r.path, { section: 'computer', name: r.name, prefix: r.prefix, depth: r.depth + 1, junction: r.junction, drive: d.key, driveColor: color, ...(r.junction ? { color: null, picked: false, match: !q || fits(r.path) } : {}) }));
  }
  add('computer', hereLabel, computer);

  // Servers and places: each with the folders used there before.
  const used = unique(recent).filter((p) => isRemote(p) && !favKeys.has(pathKey(p)));
  const remote = [];
  for (const s of servers) {
    const own = used.filter((p) => serverOf(p) === s.id);
    const named = !q || fitsFilter(`${REMOTE}${s.id}/`, q, `${s.label} ${s.detail ?? ''}`);
    const mine = named ? own : own.filter(fits);
    if (!named && !mine.length) continue;
    const top = `${REMOTE}${s.id}/`;
    remote.push({ type: 'server', key: `server|${s.id}`, id: s.id, path: top, name: s.label, detail: s.detail ?? '', icon: s.icon ?? 'server', state: s.state ?? 'disconnected', place: Boolean(s.place), color: colorOf(top), shown: shown.some((p) => isRemote(p) && serverOf(p) === s.id), depth: 0, match: named });
    const { rows } = nestFolders(mine, top);
    for (const r of rows) remote.push(folder(r.path, { section: 'servers', name: r.name, prefix: r.prefix, depth: r.depth + 1, junction: r.junction, ...(r.junction ? { color: null, match: !q || fits(r.path) } : {}) }));
  }
  add('servers', 'Servers and places', remote);

  add(
    'recent',
    'Recent',
    unique(recent)
      .filter((p) => !isRemote(p) && !favKeys.has(pathKey(p)) && !rootKeys.has(pathKey(p)) && !shownKeys.has(pathKey(p)) && fits(p))
      .map((p) => folder(p, { section: 'recent' })),
  );

  const comparisons = (saved ?? []).filter((c) => (c.mode === 'folders' || c.mode === 'panes') && c.left?.path && c.right?.path);
  add(
    'saved',
    'Saved comparisons',
    comparisons
      .filter((c) => !q || fitsFilter(c.left.path, q, c.name ?? '') || fitsFilter(c.right.path, q))
      .map((c) => ({ type: 'saved', key: `saved|${c.id}`, id: c.id, saved: c, name: c.name ?? '', mode: c.mode, left: c.left.path, right: c.right.path, depth: 0 })),
  );
  return sections;
}

/**
 * The rows a click can take, in order: folders that are not junction lines (unless reachable),
 * drives whose top was picked, servers, saved comparisons. `matching`: only those that fit the
 * filter themselves (Enter's first: not a drive or a common parent shown for what it holds).
 */
export function openableRows(sections, { reachable = () => false, matching = false } = {}) {
  return sections
    .flatMap((s) => s.rows)
    .filter((r) => (r.type === 'drive' ? r.pick || reachable(r.path) : r.type === 'folder' ? !r.junction || reachable(r.path) : true))
    .filter((r) => !matching || r.match !== false);
}
