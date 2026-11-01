// Find by asking in the editor (0.40): what it searches, as askFind.js sources (synced files, tracker
// documents, tracker items; the folders shown come from the main process, askFolders.cjs), and the
// picture the model plans with. Pure: the page gives the files, texts, documents and items.
// Encrypted files go by name only, even when this device can read them: their text never leaves.
import { isUntitled } from './naming.js';
import { liveComments, projectList } from './tracker-model.js';

/** The kinds of places the editor searches, for the plan (only those that have something). */
export const ASK_KINDS = {
  synced: 'My files: notes, snippets and drafts synced across devices',
  doc: 'Tracker documents: text files attached to tracker items',
  disk: 'Files in the folders shown in Folders (on this computer or a server)',
  item: 'Tracker items: tasks, ideas, Claude work and documents to read',
};
export const ITEM_TYPES = [
  { id: 'task', label: 'Tasks' },
  { id: 'idea', label: 'Ideas' },
  { id: 'claude', label: 'Claude work' },
  { id: 'doc', label: 'Documents to read' },
];

/** The editor's files: `textOf(id)` their text (never asked for encrypted ones). */
export function syncedSources(files, textOf) {
  return files
    .filter((f) => !f.deleted)
    .map((f) => ({
      id: `f:${f.id}`,
      kind: 'synced',
      name: f.name,
      place: f.project ? `My files · ${f.project}` : 'My files',
      project: f.project ?? '',
      tags: f.tags ?? [],
      date: f.modifiedAt || f.updatedAt || '',
      untitled: isUntitled(f.name),
      ...(f.encrypted ? { encrypted: true, text: '' } : { text: textOf(f.id) ?? '' }),
    }));
}

/** The tracker's documents (attached text files), with the text downloaded (`textOf(path)`, null when not yet). */
export function docSources(docs, textOf) {
  return docs.map((d) => ({
    id: `r:${d.path}`,
    kind: 'doc',
    name: d.name,
    place: d.item?.title ? `Tracker · ${d.item.title}` : 'Tracker',
    project: d.project ?? '',
    tags: d.tags ?? [],
    date: d.modifiedAt ?? '',
    text: textOf(d.path) ?? '',
  }));
}

/** The tracker's items (the other app's, D14): marked as the tracker's; they open there. */
export function itemSources(items) {
  return items
    .filter((i) => i && !i.deleted && i.title)
    .map((i) => ({
      id: `i:${i.id}`,
      itemId: i.id,
      kind: 'item',
      from: 'tracker',
      name: i.title,
      place: 'Tracker',
      project: i.project ?? '',
      tags: i.tags ?? [],
      type: i.type,
      status: i.status,
      date: i.updatedAt ?? '',
      text: [i.title, i.notes, i.feedback, ...liveComments(i).map((c) => c.text)].filter((t) => typeof t === 'string' && t.trim()).join('\n\n'),
    }));
}

/**
 * What the model plans with: today, the kinds that have something, the items' types, the projects,
 * the tags (not those only encrypted files have) and the folders' names.
 */
export function askPicture({ today, files = [], docs = [], items = [], trackerProjects = [], folders = [] }) {
  const live = files.filter((f) => !f.deleted);
  const liveItems = items.filter((i) => i && !i.deleted);
  const counts = new Map();
  for (const x of [...live.filter((f) => !f.encrypted), ...liveItems]) {
    for (const t of x.tags ?? []) {
      const key = t.toLowerCase();
      const entry = counts.get(key) ?? { tag: t, n: 0 };
      entry.n++;
      counts.set(key, entry);
    }
  }
  const kinds = [live.length && 'synced', docs.length && 'doc', folders.length && 'disk', liveItems.length && 'item'].filter(Boolean);
  return {
    today,
    about: kinds.map((k) => ASK_KINDS[k].split(':')[0]).join('; '),
    kinds: kinds.map((id) => ({ id, label: ASK_KINDS[id] })),
    types: liveItems.length ? ITEM_TYPES : [],
    projects: projectList([...live, ...liveItems], trackerProjects).map((p) => p.name),
    tags: [...counts.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).map((t) => t.tag),
    folders,
  };
}

/** Where a file in a folder is, for the results and the model: the folder's label and the folders inside it. */
export function diskPlace(entry, rootLabel) {
  const rel = String(entry.rel ?? '');
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  return dir ? `${rootLabel}/${dir}` : rootLabel;
}

/** The tracker's web address of an item (`base`: the setting trackerUrl). */
export const trackerItemUrl = (base, id) => `${String(base || 'https://divaor.github.io/tracking_app/').replace(/#.*$/, '').replace(/\/?$/, '/')}#/item/${encodeURIComponent(id)}`;

/** The tab a result opens as ('f:…', 'r:…', 'd:…'), or null (tracker items open in the tracker). */
export const tabKeyOf = (result) => (/^[frd]:/.test(result?.id ?? '') ? result.id : null);

/** A short label for the Found tab view: the question, cut. */
export const foundLabel = (question) => {
  const q = String(question ?? '').trim().replace(/\s+/g, ' ');
  return q.length > 32 ? `${q.slice(0, 31)}…` : q;
};

/** What the results say they searched: "12 files, 3 documents, 40 items and 1,200 files in 2 folders (cut short)". */
export function searchedWords({ files = 0, docs = 0, items = 0, folders = null }) {
  const parts = [];
  const n = (v, one, many = `${one}s`) => `${v.toLocaleString('en')} ${v === 1 ? one : many}`;
  if (files) parts.push(n(files, 'file'));
  if (docs) parts.push(n(docs, 'tracker document'));
  if (items) parts.push(n(items, 'tracker item'));
  if (folders) parts.push(`${n(folders.scanned, 'file')} in ${n(folders.roots, 'folder')}${folders.truncated || folders.stopped ? ' (cut short)' : ''}`);
  if (!parts.length) return 'nothing yet';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
