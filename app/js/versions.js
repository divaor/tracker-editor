// A file's earlier versions, from the data repo's history: every sync is a
// commit, so each commit that changed the file is a version. Editor files are
// followed by their folder (editor/files/<id>/), so renames keep their history.
import { FILES_DIR } from './model.js';

/** Who made a commit and what it was, from its message: { who, what }. */
export function describeCommit(message = '') {
  const first = message.split('\n')[0].trim();
  const who = /\(from ([^)]+)\)/.exec(first)?.[1] ?? /\bsync from (.+?)(?:\s+\(|$)/.exec(first)?.[1] ?? (/\bclaude\b/i.test(first) ? 'Claude' : '');
  return { who: who.trim(), what: first };
}

/**
 * The versions of an editor file (by id) or of any file in the repo (by path),
 * newest first: [{ sha, date, who, what, load }]. load() resolves to
 * { text, name } for that version, or null where the file did not exist.
 */
export async function fileVersions(client, { branch, id, path, limit = 50 }) {
  const target = id ? `${FILES_DIR}/${id}` : path;
  const commits = await client.listCommits({ path: target, branch, perPage: limit });
  return commits.map((c) => ({
    sha: c.sha,
    date: c.date,
    ...describeCommit(c.message),
    async load() {
      if (!id) {
        const file = await client.getFile(path, c.sha);
        return file && { text: file.text, name: path.split('/').pop() };
      }
      const entries = await client.listDir(target, c.sha);
      const file = entries?.find((e) => e.type === 'file');
      return file ? { text: await client.getBlobText(file.sha), name: file.name } : null;
    },
  }));
}

const pad = (n) => String(n).padStart(2, '0');

/** A name for a copy of an old version: "plan (2026-10-21 14.03).md" (local time). */
export function versionName(name, iso) {
  const d = new Date(iso);
  const stamp = Number.isNaN(d.getTime()) ? 'old version' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${stamp})${name.slice(dot)}` : `${name} (${stamp})`;
}
