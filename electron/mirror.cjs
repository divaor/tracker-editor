// Mirrors (desktop): a folder on a server kept the same as a folder on this
// computer. Each side is compared with what it was at the last sync (the state),
// so a change on one side goes to the other, and a deletion too. When both sides
// changed a file, the one here keeps its name and the server's is kept next to
// it as a copy (on both sides after the sync). Deleting on this computer goes to
// the Recycle Bin; deleting on the server waits for the person to agree.
//
// planMirror is pure; runMirror does the work with the functions it is given.

const crypto = require('node:crypto');
const fs = require('node:fs');
const nodePath = require('node:path');

const posix = nodePath.posix;
const MODES = ['both', 'download', 'upload'];
const DEFAULT_EXCLUDE = '.git, node_modules, .DS_Store, Thumbs.db, desktop.ini, ~$*, *.tmp, *.swp';
const COMPARE_MAX = 5 * 1024 * 1024; // files up to this size are compared by content when both sides have one

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
/** What is left out: names matching a pattern (any part of the path). */
function excluder(spec = DEFAULT_EXCLUDE) {
  const res = String(spec)
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(globToRegExp);
  return (rel) => rel.split('/').some((part) => res.some((r) => r.test(part)));
}

const same = (a, b) => Boolean(a && b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000);

/** "report.pdf" → "report (server copy 2026-10-22 15.04).pdf". */
function conflictName(rel, when = new Date()) {
  const dir = posix.dirname(rel);
  const base = posix.basename(rel);
  const dot = base.lastIndexOf('.');
  const [name, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}.${pad(when.getMinutes())}`;
  const copy = `${name} (server copy ${stamp})${ext}`;
  return dir === '.' ? copy : `${dir}/${copy}`;
}

/**
 * What a sync does. `local` and `remote` map relative paths (with /) to
 * { dir, size, mtimeMs }; `state` is { files: { rel: { l, r } }, dirs: [rel] } from
 * the last sync. Returns { upload, download, deleteLocal, deleteRemote, conflicts,
 * compare, mkdirLocal, mkdirRemote, unchanged, error? }: files to compare by content
 * (both sides have them, nothing to tell them apart) are in `compare`.
 */
function planMirror({ state = { files: {}, dirs: [] }, local, remote, mode = 'both' }) {
  const plan = { upload: [], download: [], deleteLocal: [], deleteRemote: [], conflicts: [], compare: [], mkdirLocal: [], mkdirRemote: [], removeDirLocal: [], removeDirRemote: [], unchanged: [] };
  const files = state.files ?? {};
  const known = Object.keys(files).length;
  const count = (side) => Object.values(side).filter((e) => !e.dir).length;
  // A side that looks wiped out (a folder not mounted, the wrong server folder): nothing is done.
  if (known >= 3 && count(local) === 0 && mode !== 'download') plan.error = 'The folder on this computer is empty or missing. Nothing was changed: check it, or remove the mirror and set it up again.';
  if (known >= 3 && count(remote) === 0 && mode !== 'upload') plan.error = 'The folder on the server is empty or missing. Nothing was changed: check it, or remove the mirror and set it up again.';
  if (plan.error) return plan;

  const up = mode !== 'download';
  const down = mode !== 'upload';
  const rels = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(files)].filter((rel) => !local[rel]?.dir && !remote[rel]?.dir));
  for (const rel of [...rels].sort()) {
    const L = local[rel];
    const R = remote[rel];
    const S = files[rel];
    const changedL = Boolean(L) && !same(L, S?.l);
    const changedR = Boolean(R) && !same(R, S?.r);
    if (L && R) {
      if (!changedL && !changedR) plan.unchanged.push(rel);
      else if (changedL && !changedR) (up ? plan.upload : plan.unchanged).push(rel);
      else if (!changedL && changedR) (down ? plan.download : plan.unchanged).push(rel);
      // Both changed (or both new): the same content is no conflict.
      else if (L.size === R.size && L.size <= COMPARE_MAX) plan.compare.push(rel);
      else if (mode === 'both') plan.conflicts.push(rel);
      else (down ? plan.download : plan.upload).push(rel); // one way: that way wins
    } else if (L && !R) {
      if (S?.r && !changedL) (down ? plan.deleteLocal : plan.unchanged).push(rel); // deleted on the server
      else if (up) plan.upload.push(rel); // new here, or changed here after the server deleted it
    } else if (!L && R) {
      if (S?.l && !changedR) (up ? plan.deleteRemote : plan.unchanged).push(rel); // deleted here
      else if (down) plan.download.push(rel); // new there, or changed there after it was deleted here
    }
  }
  // Folders: made where they are missing; ones deleted on one side go on the other once empty.
  const knownDirs = new Set(state.dirs ?? []);
  const dirRels = new Set([...Object.keys(local).filter((r) => local[r].dir), ...Object.keys(remote).filter((r) => remote[r].dir)]);
  for (const rel of [...dirRels].sort()) {
    const inL = Boolean(local[rel]?.dir);
    const inR = Boolean(remote[rel]?.dir);
    if (inL && !inR) {
      if (knownDirs.has(rel) && down) plan.removeDirLocal.push(rel);
      else if (up) plan.mkdirRemote.push(rel);
    } else if (!inL && inR) {
      if (knownDirs.has(rel) && up) plan.removeDirRemote.push(rel);
      else if (down) plan.mkdirLocal.push(rel);
    }
  }
  // Deepest first, so a folder is empty when its turn comes.
  plan.removeDirLocal.sort((a, b) => b.length - a.length);
  plan.removeDirRemote.sort((a, b) => b.length - a.length);
  return plan;
}

/** How many changes a plan makes (what a sync says it did). */
const planSize = (p) => p.upload.length + p.download.length + p.deleteLocal.length + p.deleteRemote.length + p.conflicts.length + p.mkdirLocal.length + p.mkdirRemote.length;

/**
 * Runs a sync. `io` gives: listLocal() and listRemote() → maps as in planMirror;
 * readState() / writeState(state); upload(rel) / download(rel, asRel?) → { l, r }
 * (each side's { size, mtimeMs } after it); sameContent(rel) → boolean;
 * trashLocal(rel); removeRemote(rel); mkdirLocal(rel); mkdirRemote(rel);
 * removeDirLocal(rel) / removeDirRemote(rel) (only when empty); statLocal(rel) and
 * statRemote(rel). `confirmDeletes`: delete on the server; `restore`: files deleted
 * here to bring back from the server instead. Returns a summary; with deletions on
 * the server waiting, `waiting` lists them (the rest is done).
 */
async function runMirror(mirror, io, { confirmDeletes = false, restore = [], onProgress = () => {}, now = () => new Date() } = {}) {
  // `confirmDeletes`: true, or the list the person agreed to (only those are deleted on the server).
  const agreed = Array.isArray(confirmDeletes) ? new Set(confirmDeletes) : null;
  const state = (await io.readState()) ?? { files: {}, dirs: [] };
  state.files ??= {};
  state.dirs ??= [];
  const [local, remote] = await Promise.all([io.listLocal(), io.listRemote()]);
  const plan = planMirror({ state, local, remote, mode: mirror.mode });
  if (plan.error) throw new Error(plan.error);
  const summary = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [], waiting: [], errors: [] };
  const restoring = new Set(restore);
  const waiting = plan.deleteRemote.filter((rel) => !restoring.has(rel));
  for (const rel of plan.deleteRemote.filter((r) => restoring.has(r))) plan.download.push(rel);
  if (!confirmDeletes) {
    summary.waiting = waiting;
    plan.deleteRemote = [];
  } else {
    plan.deleteRemote = agreed ? waiting.filter((rel) => agreed.has(rel)) : waiting;
    summary.waiting = agreed ? waiting.filter((rel) => !agreed.has(rel)) : [];
  }

  const total = planSize(plan) + plan.compare.length;
  let done = 0;
  const step = async (label, rel, fn) => {
    onProgress({ done, total, current: rel, label });
    try {
      await fn();
    } catch (err) {
      // The server gone: the sync stops here (the state is not saved, so the next one redoes what is left).
      if (err.fatal) throw err;
      summary.errors.push(`${rel}: ${err.message}`);
    }
    done++;
  };
  const record = (rel, sides) => {
    state.files[rel] = { ...state.files[rel], ...sides };
  };

  for (const rel of plan.mkdirRemote) await step('Making a folder on the server', rel, () => io.mkdirRemote(rel));
  for (const rel of plan.mkdirLocal) await step('Making a folder here', rel, () => io.mkdirLocal(rel));
  for (const rel of plan.compare) {
    await step('Comparing', rel, async () => {
      if (await io.sameContent(rel)) record(rel, { l: local[rel], r: remote[rel] });
      else if (mirror.mode === 'both') plan.conflicts.push(rel);
      else if (mirror.mode === 'download') plan.download.push(rel);
      else plan.upload.push(rel);
    });
  }
  // What the other side was when listed: a change made there since stops that file's transfer.
  const theirs = (side, rel) => (side[rel] && !side[rel].dir ? { size: side[rel].size, mtimeMs: side[rel].mtimeMs } : null);
  for (const rel of plan.upload) await step('Uploading', rel, async () => record(rel, await io.upload(rel, theirs(remote, rel))));
  for (const rel of plan.download) await step('Downloading', rel, async () => record(rel, await io.download(rel, rel, theirs(local, rel))));
  // Both changed: the one here keeps the name, the server's is kept as a copy (here, and uploaded).
  for (const rel of plan.conflicts) {
    await step('Keeping both', rel, async () => {
      const copy = conflictName(rel, now());
      record(copy, await io.download(rel, copy));
      record(copy, await io.upload(copy));
      record(rel, await io.upload(rel));
      summary.conflicts.push({ rel, copy });
    });
  }
  for (const rel of plan.deleteLocal) {
    await step('Moving to the Recycle Bin', rel, async () => {
      await io.trashLocal(rel);
      delete state.files[rel];
      summary.deletedLocal++;
    });
  }
  for (const rel of plan.deleteRemote) {
    await step('Deleting on the server', rel, async () => {
      await io.removeRemote(rel);
      delete state.files[rel];
      summary.deletedRemote++;
    });
  }
  for (const rel of plan.removeDirLocal) await step('Removing a folder here', rel, () => io.removeDirLocal(rel));
  for (const rel of confirmDeletes && !summary.waiting.length ? plan.removeDirRemote : []) await step('Removing a folder on the server', rel, () => io.removeDirRemote(rel));
  summary.uploaded = plan.upload.length;
  summary.downloaded = plan.download.length;
  // Unchanged files keep their state; gone ones leave it (unless their deletion waits).
  for (const rel of plan.unchanged) if (local[rel] && remote[rel]) record(rel, { l: local[rel], r: remote[rel] });
  for (const rel of Object.keys(state.files)) if (!local[rel] && !remote[rel] && !summary.waiting.includes(rel)) delete state.files[rel];
  // Folders on both sides now (files keep what the transfers reported, so a change
  // made during the sync is still seen as one next time); a folder whose deletion on
  // the server waits stays known, so it is not made again here.
  const [localAfter, remoteAfter] = await Promise.all([io.listLocal(), io.listRemote()]);
  state.dirs = [...Object.keys(localAfter).filter((rel) => localAfter[rel].dir && remoteAfter[rel]?.dir), ...(confirmDeletes && !summary.waiting.length ? [] : plan.removeDirRemote)];
  await io.writeState(state);
  onProgress({ done: total, total, current: '', label: '' });
  summary.errors = summary.errors.slice(0, 20);
  return summary;
}

/** A folder here as planMirror wants it ({ rel: { dir, size, mtimeMs } }); links are not followed. */
function walkLocal(root, skip, max = 50000) {
  const out = {};
  const pending = [''];
  let count = 0;
  while (pending.length) {
    const rel = pending.shift();
    for (const e of fs.readdirSync(rel ? nodePath.join(root, ...rel.split('/')) : root, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (skip(child) || e.isSymbolicLink() || !(e.isFile() || e.isDirectory()) || /\.part-[0-9a-f]{6}$/.test(e.name)) continue;
      const st = fs.statSync(nodePath.join(root, ...child.split('/')));
      out[child] = { dir: e.isDirectory(), size: e.isFile() ? st.size : 0, mtimeMs: Math.round(st.mtimeMs) };
      if (++count > max) throw new Error(`Too many files to mirror (more than ${max.toLocaleString()}).`);
      if (e.isDirectory()) pending.push(child);
    }
  }
  return out;
}

const readJsonFile = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * What runMirror works with, for a mirror `m` ({ conn, remote, local, exclude }):
 * this computer through fs, the server through remote.cjs (`remote`, `toUri`),
 * the state in `statePath`, deletions here through `trash(path)` (the Recycle Bin).
 */
function createMirrorIo(m, { remote, toUri, statePath, trash, connected = () => true }) {
  const skip = excluder(m.exclude);
  const remoteUri = (rel) => toUri(m.conn, rel ? posix.join(m.remote, rel) : m.remote);
  // Relative paths come from the server's listing too: never outside the folder here,
  // neither by name nor through a link or junction on the way (real paths compared).
  const inside = (root, p) => (p + nodePath.sep).startsWith(root + nodePath.sep);
  const localPath = (rel) => {
    const parts = rel.split('/');
    const base = nodePath.resolve(m.local);
    const full = nodePath.resolve(base, ...parts);
    if (parts.some((p) => !p || p === '.' || p === '..') || !inside(base, full)) throw new Error('That name from the server cannot be a file here.');
    // The deepest part that is there, by its real path, inside the folder's real path; the file itself not a link.
    let at = full;
    while (at !== base && !fs.existsSync(at)) at = nodePath.dirname(at);
    if (at === full && fs.lstatSync(full).isSymbolicLink()) throw new Error('it is a link here, so it is left alone.');
    const root = fs.realpathSync(base);
    const real = fs.realpathSync(at);
    if (real !== root && !inside(root, real)) throw new Error('a link here leads outside the folder, so it is left alone.');
    return full;
  };
  // A file here that changed since it was listed is not written over (it is looked at again next time).
  const unchangedHere = (target, expected) => {
    const now = fs.existsSync(target) ? fs.statSync(target) : null;
    const changed = expected ? !now || now.size !== expected.size || Math.abs(Math.round(now.mtimeMs) - expected.mtimeMs) >= 1000 : Boolean(now);
    if (changed) throw new Error('changed here during the sync; it is looked at again next time.');
  };
  const localStat = (p) => {
    const st = fs.statSync(p);
    return { dir: false, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  };
  // During a sync the server is not connected again: when it goes away, the sync stops (fatal).
  const onServer = (fn) => async (...args) => {
    const gone = () => Object.assign(new Error('The server disconnected during the sync; it goes on when the server is back.'), { fatal: true });
    if (!connected()) throw gone();
    try {
      return await fn(...args);
    } catch (err) {
      if (!connected()) throw gone();
      throw err;
    }
  };
  const io = {
    listLocal: async () => {
      if (!fs.existsSync(m.local)) throw new Error(`The folder ${m.local} is not there. Nothing was changed.`);
      return walkLocal(m.local, skip);
    },
    listRemote: () => remote.listTree(remoteUri(''), skip),
    readState: async () => readJsonFile(statePath),
    writeState: async (state) => {
      fs.mkdirSync(nodePath.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state));
    },
    // `expected`: the other side as listed ({ size, mtimeMs }, or null when it had none);
    // when it changed since, the transfer is refused and the next sync sees both changes.
    upload: async (rel, expected) => ({ l: localStat(localPath(rel)), r: await remote.uploadFile(localPath(rel), remoteUri(rel), expected) }),
    // Downloaded next to it first, then put in its place.
    download: async (rel, as = rel, expected) => {
      const target = localPath(as);
      fs.mkdirSync(nodePath.dirname(target), { recursive: true });
      const part = `${target}.part-${crypto.randomBytes(3).toString('hex')}`;
      try {
        const r = await remote.downloadFile(remoteUri(rel), part);
        if (expected !== undefined) unchangedHere(target, expected);
        fs.renameSync(part, target);
        return as === rel ? { l: localStat(target), r } : { l: localStat(target) };
      } finally {
        fs.rmSync(part, { force: true });
      }
    },
    sameContent: async (rel) => fs.readFileSync(localPath(rel)).equals(await remote.readBytes(remoteUri(rel), COMPARE_MAX + 1)),
    trashLocal: (rel) => trash(localPath(rel)),
    removeRemote: (rel) => remote.remove([remoteUri(rel)]),
    mkdirLocal: async (rel) => fs.mkdirSync(localPath(rel), { recursive: true }),
    mkdirRemote: (rel) => remote.mkdirp(remoteUri(rel)),
    removeDirLocal: async (rel) => {
      if (!fs.readdirSync(localPath(rel)).length) fs.rmdirSync(localPath(rel));
    },
    removeDirRemote: (rel) => remote.removeEmptyDir(remoteUri(rel)),
  };
  for (const name of ['upload', 'download', 'sameContent', 'removeRemote', 'mkdirRemote', 'removeDirRemote']) io[name] = onServer(io[name]);
  return io;
}

module.exports = { planMirror, runMirror, createMirrorIo, walkLocal, conflictName, excluder, planSize, MODES, DEFAULT_EXCLUDE };
