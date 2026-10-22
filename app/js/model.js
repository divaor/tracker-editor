// Editor data model: file records, the index document in the data repo,
// names and paths. Pure and DOM-free so the Node tests can import it.
import { bumpTime, cleanProjectName, cleanTags, newId, nowIso } from './tracker-model.js';

export { bumpTime, cleanTags, newId, nowIso };

export const SCHEMA_VERSION = 1;
// Everything the editor stores lives under this folder of the data repo.
export const EDITOR_DIR = 'editor';
export const INDEX_PATH = `${EDITOR_DIR}/index.json`;
export const FILES_DIR = `${EDITOR_DIR}/files`;
const TOMBSTONE_DAYS = 180;
const EPOCH = '1970-01-01T00:00:00.000Z';

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isoOr(value, fallback) {
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return fallback;
}

/** A name that is safe as the last part of a repo path (no slashes or control characters). */
export function safeName(name, fallback = 'untitled.txt') {
  const clean = text(name)
    .replace(/[\u0000-\u001f\u007f/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return clean || fallback;
}

export function splitName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' };
}

export const extensionOf = (name) => splitName(text(name)).ext.slice(1).toLowerCase();

/** Notepad++-style names for new tabs: "new 1", "new 2", … (the lowest free number). */
export function untitledName(existingNames) {
  const taken = new Set([...existingNames].map((n) => n.toLowerCase()));
  for (let i = 1; ; i++) if (!taken.has(`new ${i}`)) return `new ${i}`;
}

/** "notes.md" kept by another device in a conflict: "notes (from Phone, 2026-10-21 14.03).md". */
export function conflictName(name, device, iso) {
  const { base, ext } = splitName(name);
  const stamp = iso.slice(0, 16).replace('T', ' ').replace(':', '.');
  return `${base} (from ${device || 'another device'}, ${stamp})${ext}`;
}

export function normalizeFile(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const createdAt = isoOr(r.createdAt, EPOCH);
  const file = {
    id: text(r.id),
    name: safeName(r.name),
    project: cleanProjectName(r.project),
    tags: cleanTags(r.tags),
    language: text(r.language),
    // Content: tracked by its git blob sha, separately from the metadata
    // above, so an edit here never undoes a rename made on another device.
    sha: text(r.sha),
    size: Number.isFinite(r.size) && r.size >= 0 ? r.size : 0,
    modifiedAt: isoOr(r.modifiedAt, createdAt),
    modifiedBy: text(r.modifiedBy),
    createdAt,
    // Metadata (name, project, tags, language, deleted): newest edit wins.
    updatedAt: isoOr(r.updatedAt, createdAt),
    updatedBy: text(r.updatedBy),
  };
  if (r.deleted) file.deleted = true;
  // The text is stored encrypted in the repo (crypto.js); the metadata is not.
  if (r.encrypted) file.encrypted = true;
  // A snippet: text with {{fields}} to insert, copy or type (snippets.js).
  if (r.snippet) file.snippet = true;
  return file;
}

export function createFile(fields = {}, now = nowIso()) {
  return normalizeFile({ modifiedAt: now, ...fields, id: fields.id || newId(), createdAt: now, updatedAt: now });
}

/** Applies a metadata change (name, project, tags, language) and bumps updatedAt. */
export function applyFilePatch(file, patch, now = nowIso()) {
  return normalizeFile({ ...file, ...patch, id: file.id, createdAt: file.createdAt, updatedAt: bumpTime(file.updatedAt, now) });
}

export function tombstone(file, now = nowIso(), updatedBy = '') {
  return { ...normalizeFile(file), deleted: true, updatedAt: bumpTime(file.updatedAt, now), updatedBy };
}

/** Where a file's content lives in the data repo. The id folder keeps renames simple. */
export const contentPath = (file) => `${FILES_DIR}/${file.id}/${safeName(file.name)}`;

// Same rule as the tracker: the newest edit wins, deletions win ties, and the
// rest is decided deterministically so every device converges.
function wins(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return Boolean(a.deleted);
  return JSON.stringify(a) > JSON.stringify(b);
}

export function mergeFiles(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const file of list) {
      const current = byId.get(file.id);
      if (!current || wins(file, current)) byId.set(file.id, file);
    }
  }
  return [...byId.values()];
}

export function pruneTombstones(files, now = nowIso(), days = TOMBSTONE_DAYS) {
  const cutoff = new Date(Date.parse(now) - days * 86400000).toISOString();
  return files.filter((f) => !f.deleted || f.updatedAt >= cutoff);
}

const INDEX_KEYS = ['app', 'schema', 'updatedAt', 'files'];

/** The index of all files: stable output for clean diffs; unknown top-level fields are kept. */
export function serializeIndex(files, extra = {}) {
  const sorted = files.map(normalizeFile).sort((a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id));
  const updatedAt = sorted.reduce((max, f) => (f.updatedAt > max ? f.updatedAt : max), EPOCH);
  const rest = Object.fromEntries(Object.entries(extra ?? {}).filter(([k]) => !INDEX_KEYS.includes(k)));
  return `${JSON.stringify({ app: 'tracker-editor', schema: SCHEMA_VERSION, updatedAt, ...rest, files: sorted }, null, 2)}\n`;
}

export function parseIndex(source) {
  let data;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new Error(`The editor index is not valid JSON (${err.message})`);
  }
  if (!data || !Array.isArray(data.files)) throw new Error('The editor index has no "files" list');
  return {
    files: data.files.filter((f) => f && typeof f === 'object' && typeof f.id === 'string' && f.id).map(normalizeFile),
    extra: Object.fromEntries(Object.entries(data).filter(([k]) => !INDEX_KEYS.includes(k))),
  };
}

export const byteLength = (s) => new TextEncoder().encode(s).length;

/** Git's blob id for a text: SHA-1 of "blob <size>\0<content>". Lets the editor know a blob's sha without uploading it. */
export async function gitBlobSha(content) {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const bytes = new Uint8Array(header.length + body.length);
  bytes.set(header);
  bytes.set(body, header.length);
  const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Link that opens a file in the editor (web app). The tracker uses it to open files here. */
export function fileLink(appUrl, id) {
  return `${appUrl.replace(/\/?$/, '/')}#/file/${encodeURIComponent(id)}`;
}

/**
 * The tracker's attached files (proposals, artifacts, notes…), listed next to
 * the editor's own files. Each carries its item's title, project and tags; the
 * newest item wins when two items share a file.
 */
export function trackerDocs(items) {
  const byPath = new Map();
  for (const item of items ?? []) {
    if (!item || item.deleted) continue;
    for (const f of item.files ?? []) {
      if (!f?.path) continue;
      const doc = {
        path: f.path,
        name: f.name || f.path.split('/').pop(),
        sha: f.sha ?? '',
        size: f.size ?? 0,
        project: item.project ?? '',
        tags: item.tags ?? [],
        modifiedAt: item.updatedAt ?? '',
        item: { id: item.id, title: item.title ?? '' },
      };
      const seen = byPath.get(f.path);
      if (!seen || doc.modifiedAt > seen.modifiedAt) byPath.set(f.path, doc);
    }
  }
  return [...byPath.values()];
}

/** Parses "#/file/<id>" and "#/repo/<path>" (a file in the data repo, e.g. a tracker attachment). */
export function parseRoute(hash) {
  const clean = text(hash).replace(/^#\/?/, '');
  const [kind, ...rest] = clean.split('/');
  const value = rest.join('/');
  if (kind === 'file' && value) return { kind: 'file', id: decodeURIComponent(value) };
  if (kind === 'repo' && value) return { kind: 'repo', path: value.split('/').map(decodeURIComponent).join('/') };
  // [[links]] in the preview (editor only; the tracker never builds these).
  if (kind === 'link' && value) return { kind: 'link', name: decodeURIComponent(value) };
  return { kind: 'none' };
}
