// One sync round with the data repo: read the editor index (and tracker.json)
// at the branch head, merge this device's files, and write everything that
// changed — new and edited files, renames, deletions, the index, tracker.json
// — as one commit. If another device committed in between, the round starts
// over from the new head. Text is never lost: when two devices edited the same
// file, ours stays in the file and theirs is kept as a copy next to it.
import { documentKind } from './docTypes.js';
import {
  INDEX_PATH,
  byteLength,
  conflictName,
  contentPath,
  createFile,
  gitBlobSha,
  mergeFiles,
  normalizeFile,
  nowIso,
  parseIndex,
  pruneTombstones,
  serializeIndex,
  splitName,
} from './model.js';
import { applyPatch, isTextAttachment, parseData, serializeDocument } from './tracker-model.js';

const LOCAL_FIELDS = ['baseSha', 'dirty', 'pending'];
const strip = (file) => normalizeFile(Object.fromEntries(Object.entries(file).filter(([k]) => !LOCAL_FIELDS.includes(k))));
const isRace = (err) => err?.status === 422 || err?.status === 409;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Branch head { branch, commit, tree }; creates the branch from the default one when missing. */
async function resolveHead(client, branch) {
  const repo = branch ? null : await client.getRepo();
  const name = branch || repo.default_branch;
  let commit = await client.getBranchHead(name);
  if (!commit && branch) {
    const base = await client.getBranchHead((await client.getRepo()).default_branch);
    if (base) {
      await client.createBranch(name, base);
      commit = base;
    }
  }
  return commit ? { branch: name, commit, tree: await client.getCommitTree(commit) } : { branch: name, commit: null };
}

function commitMessage(device, counts) {
  const parts = [];
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.updated) parts.push(`${counts.updated} updated`);
  if (counts.renamed) parts.push(`${counts.renamed} renamed`);
  if (counts.deleted) parts.push(`${counts.deleted} deleted`);
  if (counts.conflicts) parts.push(`${counts.conflicts} kept as ${counts.conflicts === 1 ? 'a copy' : 'copies'}`);
  if (counts.tracker) parts.push('tracker updated');
  return `Editor: sync from ${device}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/**
 * @param files     this device's file records, with `baseSha` (content sha at
 *                  the last sync) and `dirty` (edited since then)
 * @param texts     Map id → text for the dirty files (a snapshot)
 * @param repoEdits edits to other files in the repo, e.g. tracker attachments:
 *                  [{ path, text, baseSha }]
 * @param trackerChange optional ({ items, projects }) => { items, projects }
 *                  applied to tracker.json in the same commit
 * @param encode    optional async (file, text) => what to store in the repo for
 *                  it (the ciphertext of an encrypted file); decode the reverse,
 *                  for texts downloaded. Both get the merged record.
 */
export async function syncOnce({
  client,
  branch = '',
  files = [],
  texts = new Map(),
  repoEdits = [],
  trackerPath = 'tracker.json',
  trackerChange = null,
  device = 'unknown device',
  now = nowIso,
  maxAttempts = 4,
  encode = async (_file, text) => text,
  decode = async (_file, text) => text,
}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let head = await resolveHead(client, branch);
    if (!head.commit) {
      // Empty repository: the first commit has to go through the Contents API.
      await client.putFile(INDEX_PATH, { text: serializeIndex([]), branch: branch || undefined, message: `Editor: start (from ${device})` });
      head = await resolveHead(client, branch);
    }
    const stamp = now();
    const indexFile = await client.getFile(INDEX_PATH, head.commit);
    const remote = indexFile ? parseIndex(indexFile.text) : { files: [], extra: {} };
    const remoteById = new Map(remote.files.map((f) => [f.id, f]));
    const localById = new Map(files.map((f) => [f.id, f]));
    const merged = pruneTombstones(mergeFiles(remote.files, files.map(strip)), stamp);

    const changes = new Map(); // path → { path, content } | { path, sha } (sha null deletes)
    const put = (change) => changes.set(change.path, change);
    const fetchShas = new Map(); // id → sha whose text this device needs
    const counts = { added: 0, updated: 0, renamed: 0, deleted: 0, conflicts: 0 };
    const conflicts = [];
    const extra = [];

    for (const [index, m] of merged.entries()) {
      const r = remoteById.get(m.id);
      const l = localById.get(m.id);
      const live = r && !r.deleted && r.sha;
      const dirty = Boolean(l?.dirty && !l.deleted && texts.has(m.id));

      if (m.deleted) {
        if (live) {
          put({ path: contentPath(r), sha: null });
          counts.deleted++;
        }
        if (dirty && !l.deleted) {
          // Deleted elsewhere while edited here: keep the edits as a new file.
          const text = texts.get(m.id);
          const draft = createFile({ ...m, deleted: false, id: '', modifiedAt: l.modifiedAt, modifiedBy: device, updatedBy: device }, stamp);
          const stored = await encode(draft, text);
          const copy = { ...draft, sha: await gitBlobSha(stored), size: byteLength(stored) };
          put({ path: contentPath(copy), content: stored });
          extra.push({ file: copy, text });
          conflicts.push({ id: copy.id, name: copy.name, reason: 'deleted' });
          counts.conflicts++;
        }
        continue;
      }

      let content;
      if (dirty) {
        const text = await encode(m, texts.get(m.id));
        const sha = await gitBlobSha(text);
        if (live && r.sha !== l.baseSha && r.sha !== sha) {
          // Both sides changed the text: ours stays, theirs becomes a copy.
          const copy = createFile(
            { name: conflictName(m.name, r.modifiedBy, stamp), project: m.project, tags: m.tags, language: m.language, encrypted: r.encrypted, sha: r.sha, size: r.size, modifiedAt: r.modifiedAt, modifiedBy: r.modifiedBy, updatedBy: device },
            stamp,
          );
          put({ path: contentPath(copy), sha: r.sha });
          fetchShas.set(copy.id, r.sha);
          extra.push({ file: copy });
          conflicts.push({ id: copy.id, name: copy.name, reason: 'edited' });
          counts.conflicts++;
        }
        content = { sha, size: byteLength(text), modifiedAt: l.modifiedAt, modifiedBy: l.modifiedBy || device };
        if (!live || r.sha !== sha || contentPath(r) !== contentPath(m)) {
          put({ path: contentPath(m), content: text });
          if (live) counts.updated++;
          else counts.added++;
        }
      } else if (live) {
        content = { sha: r.sha, size: r.size, modifiedAt: r.modifiedAt, modifiedBy: r.modifiedBy };
        if (r.sha !== l?.baseSha) fetchShas.set(m.id, r.sha);
        if (contentPath(r) !== contentPath(m)) put({ path: contentPath(m), sha: r.sha });
      } else {
        content = { sha: m.sha, size: m.size, modifiedAt: m.modifiedAt, modifiedBy: m.modifiedBy };
      }
      if (live && contentPath(r) !== contentPath(m)) {
        put({ path: contentPath(r), sha: null });
        counts.renamed++;
      }
      merged[index] = normalizeFile({ ...m, ...content });
    }
    for (const { file } of extra) merged.push(file);

    // Edits to other repo files (tracker attachments opened here).
    const repoResults = [];
    const trackerFiles = new Map(); // path → { sha, size } to record on tracker items
    for (const edit of repoEdits) {
      // Text is never written over a picture, PDF or other file that is not text.
      if (!isTextAttachment({ path: edit.path }) || documentKind(edit.path)) continue;
      const current = await client.getFile(edit.path, head.commit);
      const sha = await gitBlobSha(edit.text);
      if (current && current.sha !== edit.baseSha && current.sha !== sha) {
        // Changed elsewhere (e.g. Claude sent a new version): keep ours as an editor file.
        const { base, ext } = splitName(edit.path.split('/').pop());
        const copy = createFile({ name: `${base} (your edits)${ext}`, sha, size: byteLength(edit.text), modifiedBy: device, updatedBy: device }, stamp);
        put({ path: contentPath(copy), content: edit.text });
        extra.push({ file: copy, text: edit.text });
        merged.push(copy);
        conflicts.push({ id: copy.id, name: copy.name, reason: 'repo', path: edit.path });
        counts.conflicts++;
        repoResults.push({ path: edit.path, conflict: true, copyId: copy.id, sha: current.sha, text: current.text });
        continue;
      }
      if (!current || current.sha !== sha) {
        put({ path: edit.path, content: edit.text });
        trackerFiles.set(edit.path, { sha, size: byteLength(edit.text) });
        counts.updated++;
      }
      repoResults.push({ path: edit.path, sha });
    }

    // tracker.json: read for its projects; written only when something changes it.
    const trackerFile = trackerPath ? await client.getFile(trackerPath, head.commit) : null;
    let trackerDoc = trackerFile ? parseData(trackerFile.text) : { items: [], projects: [], extra: {} };
    if (trackerPath && (trackerChange || trackerFiles.size)) {
      let next = { items: trackerDoc.items, projects: trackerDoc.projects };
      if (trackerFiles.size) {
        next.items = next.items.map((item) =>
          item.files.some((f) => trackerFiles.has(f.path))
            ? applyPatch(item, { files: item.files.map((f) => (trackerFiles.has(f.path) ? { ...f, ...trackerFiles.get(f.path) } : f)), updatedBy: device }, stamp)
            : item,
        );
      }
      if (trackerChange) next = trackerChange(next) ?? next;
      const out = serializeDocument(next.items, next.projects, trackerDoc.extra);
      if (!trackerFile || out !== trackerFile.text) {
        put({ path: trackerPath, content: out });
        counts.tracker = true;
        trackerDoc = { ...trackerDoc, ...next };
      }
    }

    // No index yet and nothing to put in it: nothing to write.
    const indexText = serializeIndex(merged, remote.extra);
    if (indexFile ? indexText !== indexFile.text : merged.length > 0) put({ path: INDEX_PATH, content: indexText });

    let commit = null;
    if (changes.size) {
      const tree = await client.createTree(head.tree, [...changes.values()]);
      commit = await client.createCommit(commitMessage(device, counts), tree, [head.commit]);
      try {
        await client.updateBranch(head.branch, commit);
      } catch (err) {
        if (!isRace(err) || attempt === maxAttempts) throw err;
        lastError = err;
        continue;
      }
    }

    const records = new Map([...merged, ...extra.map((e) => e.file)].map((f) => [f.id, f]));
    const downloaded = await mapLimit([...fetchShas], 6, async ([id, sha]) => [id, await decode(records.get(id), await client.getBlobText(sha))]);
    const newTexts = new Map(downloaded);
    for (const { file, text } of extra) if (text !== undefined) newTexts.set(file.id, text);
    return {
      files: merged.map((f) => ({ ...f, baseSha: f.sha, dirty: false })),
      texts: newTexts,
      conflicts,
      repoResults,
      projects: trackerDoc.projects,
      trackerItems: trackerDoc.items,
      commit,
      counts,
    };
  }
  throw lastError;
}
