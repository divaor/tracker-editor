// Mirrors by hand (0.54, desktop and the Android app): Upload, Download and Undo for files
// inside a mirror, as an IDE's deployment does, on top of the mirror's state (mirror.cjs).
//
// - check(): each file of what the person picked looked at on both sides, with the state of
//   the last time the two were in step (mirrorCheck.js classifies it), so the page can warn
//   before a transfer loses a change made on the other side.
// - transfer(): each file checked again against what the check saw (`expect`), the
//   destination's old version kept in the history first, then copied (through a .part name),
//   then the state for it updated: a later sync, or the next check, sees the two in step.
// - undo(): a transfer's files put back as they were, only while the destination still holds
//   what the transfer wrote; what it made new is removed (here to the Recycle Bin, on the
//   server for good).
//
// The page names a mirror by its id and files by paths inside it (here or remote://); they
// are turned into relative paths of plain names (relsOf), and every file here is reached
// through mirror.cjs's localPathIn (real paths: never through a link out of the folder).

const crypto = require('node:crypto');
const fs = require('node:fs');
const nodePath = require('node:path');
const { excluder, walkLocal, localPathIn, readJsonFile } = require('./mirror.cjs');

const posix = nodePath.posix;
const HISTORY_ENTRIES = 200;
const HISTORY_DAYS = 30;
const HISTORY_BYTES = 1024 ** 3;
/** A destination's old version over this is not kept (Undo cannot bring it back). */
const KEEP_MAX = 100 * 1024 * 1024;
const CHECK_MAX = 20000;
const ROWS_MAX = 5000;
/** Bytes compared in one check (both sides read): the rest is told apart by size and time. */
const BYTES_BUDGET = 64 * 1024 * 1024;
const TRANSFER_MAX = 20000;
const DAY = 24 * 60 * 60 * 1000;

const safeRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length < 4096 && rel.split('/').every((p) => p && p !== '.' && p !== '..' && !/[\\\0]/.test(p));
const sameStat = (a, b) => Boolean(a && b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1000);
const plainStat = (st) => st && { dir: false, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
const notInside = () => new Error('That is not inside the mirror.');
const hex = () => crypto.randomBytes(3).toString('hex');
const errText = (err) => String(err?.message ?? err).replace(/^Error: /, '');
/** The two folders a mirror keeps: a transfer's Undo needs the same ones. */
const pairOfMirror = (m) => ({ local: nodePath.resolve(m.local), conn: m.conn, remote: posix.normalize(m.remote) });

/**
 * What the history keeps within its limits, newest first: entries past `maxEntries` or older
 * than `maxAge` go (with their kept files); then, newest first, files whose kept copy no longer
 * fits in `maxBytes` lose it (`notKept`). Returns { keep, removeDirs: [id], dropBlobs: [[id, blob]] }.
 */
function pruneHistory(list, { now = Date.now(), maxEntries = HISTORY_ENTRIES, maxAge = HISTORY_DAYS * DAY, maxBytes = HISTORY_BYTES } = {}) {
  const sorted = [...list].filter((e) => e && typeof e.id === 'string').sort((a, b) => b.at - a.at);
  const keep = sorted.filter((e, i) => i < maxEntries && now - e.at <= maxAge);
  const removeDirs = sorted.filter((e) => !keep.includes(e)).map((e) => e.id);
  const dropBlobs = [];
  let bytes = 0;
  for (const e of keep) {
    for (const f of e.files ?? []) {
      if (!f.before?.blob) continue;
      if (bytes + f.before.size > maxBytes) {
        dropBlobs.push([e.id, f.before.blob]);
        f.before = { size: f.before.size, mtimeMs: f.before.mtimeMs };
        f.notKept = true;
      } else bytes += f.before.size;
    }
  }
  return { keep, removeDirs, dropBlobs };
}

/**
 * `remote` (remote.cjs), `toUri`/`parseUri`/`isRemote` (its paths), `historyDir` (the kept
 * versions, one folder per transfer) and `historyFile` (the entries), `statePath(m)` (the
 * mirror's state, shared with mirror.cjs's syncs), `check` (app/js/mirrorCheck.js), `trash(path)`
 * (the Recycle Bin here), `mirrorOf(id)` (the mirror for undo), `busy(m)` (a sync is running).
 */
function createMirrorTransfers({ remote, toUri, parseUri, isRemote, historyDir, historyFile, statePath, check, trash, mirrorOf = () => null, busy = () => false, now = Date.now }) {
  // One transfer, undo or state write of a mirror at a time.
  const queues = new Map();
  const exclusive = (id, fn) => {
    const run = (queues.get(id) ?? Promise.resolve()).then(fn, fn);
    queues.set(id, run.catch(() => {}));
    return run;
  };

  const readState = (m) => {
    const s = readJsonFile(statePath(m)) ?? {};
    return { ...s, files: s.files ?? {}, dirs: s.dirs ?? [] };
  };
  // Written whole, then renamed into place: a crash halfway never leaves a state that cannot be read.
  const writeState = (m, state) => {
    fs.mkdirSync(nodePath.dirname(statePath(m)), { recursive: true });
    const tmp = `${statePath(m)}.tmp-${hex()}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, statePath(m));
  };
  const readHistory = () => {
    const list = readJsonFile(historyFile);
    return Array.isArray(list) ? list : [];
  };
  const writeHistory = (list) => {
    fs.mkdirSync(nodePath.dirname(historyFile), { recursive: true });
    const tmp = `${historyFile}.tmp-${hex()}`;
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, historyFile);
  };
  const entryDir = (id) => nodePath.join(historyDir, id);
  const isId = (id) => typeof id === 'string' && /^[0-9a-f]{12}$/.test(id);

  /** The history within its limits; kept files of what went, and folders no entry names, removed. */
  function prune(list = readHistory()) {
    const { keep, removeDirs, dropBlobs } = pruneHistory(list, { now: now() });
    for (const id of removeDirs) if (isId(id)) fs.rmSync(entryDir(id), { recursive: true, force: true });
    for (const [id, blob] of dropBlobs) if (isId(id)) fs.rmSync(nodePath.join(entryDir(id), String(blob)), { force: true });
    try {
      const named = new Set(keep.map((e) => e.id));
      for (const d of fs.readdirSync(historyDir)) if (isId(d) && !named.has(d)) fs.rmSync(entryDir(d), { recursive: true, force: true });
    } catch {
      // no history folder yet
    }
    writeHistory(keep);
    return keep;
  }

  // ---- Paths: inside the mirror, as relative paths ----

  const remoteRoot = (m) => posix.normalize(m.remote).replace(/(.)\/+$/, '$1');
  /** The relative paths (with /, '' for the mirror's folder itself) of paths on either side; the topmost ones. */
  function relsOf(m, paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > TRANSFER_MAX) throw new Error('Nothing to do.');
    const out = new Set();
    for (const p of paths) {
      if (typeof p !== 'string' || !p) throw notInside();
      let rel;
      if (isRemote(p)) {
        const { id, path: rp } = parseUri(p);
        const root = remoteRoot(m);
        const norm = posix.normalize(rp).replace(/(.)\/+$/, '$1');
        if (id !== m.conn) throw notInside();
        if (norm === root) rel = '';
        else if (norm.startsWith(root === '/' ? '/' : `${root}/`)) rel = norm.slice(root === '/' ? 1 : root.length + 1);
        else throw notInside();
      } else {
        const base = nodePath.resolve(m.local);
        const full = nodePath.resolve(p);
        if (full === base) rel = '';
        else if (full.startsWith(base + nodePath.sep)) rel = full.slice(base.length + 1).split(nodePath.sep).join('/');
        else throw notInside();
      }
      if (rel && !safeRel(rel)) throw notInside();
      out.add(rel);
    }
    const list = [...out].sort();
    return list.filter((r) => !list.some((o) => o !== r && (o === '' || r.startsWith(`${o}/`))));
  }
  const localOf = (m, rel) => (rel ? localPathIn(m.local, rel) : nodePath.resolve(m.local));
  const remoteOf = (m, rel) => toUri(m.conn, rel ? posix.join(remoteRoot(m), rel) : remoteRoot(m));
  /** A file here: { size, mtimeMs }, null when missing, { dir } / { link } / { other } for the rest. */
  const localStat = (m, rel) => {
    let p;
    try {
      p = localOf(m, rel);
    } catch {
      return { link: true };
    }
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) return null;
    if (st.isSymbolicLink()) return { link: true };
    if (st.isDirectory()) return { dir: true };
    return st.isFile() ? plainStat(st) : { other: true };
  };
  const remoteStat = async (m, rel) => {
    const e = await remote.entry(remoteOf(m, rel));
    return e && (e.dir ? { dir: true } : { dir: false, size: e.size, mtimeMs: Math.round(e.mtimeMs ?? 0) });
  };
  // An FTP listing's time without MDTM is to the minute.
  const approxOn = (m, st) => Boolean(st && remote.isFtp?.(remoteOf(m, '')) && st.mtimeMs % 60000 === 0);

  /** Both sides of what `rels` name: { here, there } (files: rel → { size, mtimeMs }), dirs on each, and what is left out. */
  async function gather(m, rels, { exclude = true } = {}) {
    const skip = exclude ? excluder(m.exclude) : () => false;
    const here = {};
    const there = {};
    const hereDirs = new Set();
    const thereDirs = new Set();
    const left = [];
    if (!fs.existsSync(m.local)) throw new Error(`The folder ${m.local} is not there. Nothing was changed.`);
    for (const top of rels) {
      const L = top ? localStat(m, top) : { dir: true };
      const R = await remoteStat(m, top);
      if (L?.link || L?.other) {
        left.push({ rel: top, why: L.link ? 'a link here: left alone' : 'not a file here' });
        continue;
      }
      if (L && R && Boolean(L.dir) !== Boolean(R.dir)) {
        left.push({ rel: top, why: 'a folder on one side, a file on the other' });
        continue;
      }
      if (!L?.dir && !R?.dir) {
        if (L) here[top] = L;
        if (R) there[top] = R;
        continue;
      }
      const at = (r) => (top ? `${top}/${r}` : r);
      if (L?.dir) {
        hereDirs.add(top);
        for (const [r, e] of Object.entries(walkLocal(localOf(m, top), skip, CHECK_MAX))) {
          if (e.dir) hereDirs.add(at(r));
          else here[at(r)] = { size: e.size, mtimeMs: e.mtimeMs };
        }
      }
      if (R?.dir) {
        thereDirs.add(top);
        for (const [r, e] of Object.entries(await remote.listTree(remoteOf(m, top), skip, CHECK_MAX))) {
          if (/\.part-[0-9a-f]{6}$/.test(r)) continue;
          if (e.dir) thereDirs.add(at(r));
          else there[at(r)] = { size: e.size, mtimeMs: Math.round(e.mtimeMs) };
        }
      }
    }
    // A file on one side where the other has a folder: left alone.
    for (const rel of Object.keys(here)) if (thereDirs.has(rel)) (delete here[rel], delete there[rel], left.push({ rel, why: 'a folder on one side, a file on the other' }));
    for (const rel of Object.keys(there)) if (hereDirs.has(rel)) (delete here[rel], delete there[rel], left.push({ rel, why: 'a folder on one side, a file on the other' }));
    return { here, there, hereDirs, thereDirs, left };
  }

  const sameBytes = async (m, rel) => fs.readFileSync(localOf(m, rel)).equals(await remote.readBytes(remoteOf(m, rel), check.COMPARE_MAX + 1));

  /**
   * What an upload or a download of `paths` would do: { direction, counts, files (the rows that
   * are not the same: { rel, state, here, there, approx }), more, left, tooBig? }. Files found the
   * same byte for byte are noted in the state as in step (cheaper next time).
   */
  async function checkMirror(m, paths, direction, { onProgress = () => {} } = {}) {
    if (!['upload', 'download'].includes(direction)) throw new Error('Upload or download?');
    const rels = relsOf(m, paths);
    let sides;
    try {
      sides = await gather(m, rels);
    } catch (err) {
      if (/Too many files/.test(errText(err))) return { direction, tooBig: true, counts: check.countStates([]), files: [], left: [] };
      throw err;
    }
    const { here, there, left } = sides;
    const all = [...new Set([...Object.keys(here), ...Object.keys(there)])].sort();
    if (all.length > CHECK_MAX) return { direction, tooBig: true, total: all.length, counts: check.countStates([]), files: [], left };
    const state = readState(m).files;
    const rows = [];
    const inStep = [];
    let budget = BYTES_BUDGET;
    for (const [i, rel] of all.entries()) {
      const h = here[rel] ?? null;
      const t = there[rel] ?? null;
      const s = state[rel];
      let same;
      if (check.needsBytes({ here: h, there: t, state: s }) && budget >= h.size) {
        budget -= h.size;
        same = await sameBytes(m, rel).catch(() => undefined);
      }
      const approx = approxOn(m, t);
      const st = check.classify({ here: h, there: t, state: s, direction, same, approx });
      if (!st) continue;
      rows.push({ rel, state: st, here: h, there: t, ...(approx ? { approx } : {}) });
      if (same === true) inStep.push({ rel, l: h, r: t });
      if (i % 20 === 0) onProgress({ done: i, total: all.length });
    }
    if (inStep.length && !busy(m)) {
      await exclusive(m.id, () => {
        const doc = readState(m);
        for (const { rel, l, r } of inStep) doc.files[rel] = { l: { dir: false, ...l }, r: { dir: false, ...r } };
        writeState(m, doc);
      });
    }
    const differ = rows.filter((r) => r.state !== 'same');
    return { direction, counts: check.countStates(rows), files: differ.slice(0, ROWS_MAX), more: differ.length > ROWS_MAX, left };
  }

  // ---- Copying one file ----

  /**
   * A file here put on the server at `uri`: under a .part name, then in place of the old one.
   * `mtimeMs`: its time set back to that where the server lets it (Undo).
   */
  async function putRemote(localFile, uri, exists, { mtimeMs } = {}) {
    const { id, path: p } = parseUri(uri);
    const name = posix.basename(p);
    const part = toUri(id, posix.join(posix.dirname(p), `.${name}.part-${hex()}`));
    await remote.uploadFile(localFile, part);
    let removed = false;
    try {
      if (exists) {
        await remote.remove([uri]);
        removed = true;
      }
      await remote.rename(part, name);
    } catch (err) {
      // The name refused by the server's rules, or the rename failed: written in place.
      await remote.remove([part]).catch(() => {});
      if (!removed && exists) throw err;
      await remote.uploadFile(localFile, uri);
    }
    if (mtimeMs) await remote.setTime?.(uri, mtimeMs).catch(() => false);
    const st = await remote.stat(uri);
    return { size: st?.size ?? 0, mtimeMs: Math.round(st?.mtimeMs ?? 0) };
  }
  /**
   * `fill(part)` writes a file next to `target` here, then it takes its place, unless `target`
   * changed from `expected` meanwhile. `oldToBin`: the old one goes to the Recycle Bin first
   * (one too large for the history is never just written over).
   */
  async function putLocal(target, fill, expected, { mtimeMs, oldToBin = false } = {}) {
    fs.mkdirSync(nodePath.dirname(target), { recursive: true });
    const part = `${target}.part-${hex()}`;
    try {
      await fill(part);
      if (mtimeMs) fs.utimesSync(part, new Date(), new Date(mtimeMs));
      const nowSt = fs.statSync(target, { throwIfNoEntry: false });
      if (expected === null ? nowSt : !nowSt || !sameStat(plainStat(nowSt), expected)) throw new Error('changed here meanwhile, so it was left as it is');
      if (oldToBin && nowSt) await trash(target);
      fs.renameSync(part, target);
    } finally {
      fs.rmSync(part, { force: true });
    }
    return plainStat(fs.statSync(target));
  }

  async function transferOne(m, item, direction, dir, n, doc) {
    const { rel } = item;
    const up = direction === 'upload';
    const lp = localOf(m, rel);
    const ru = remoteOf(m, rel);
    const hereNow = localStat(m, rel);
    if (hereNow && (hereNow.dir || hereNow.link || hereNow.other)) return { skipped: hereNow.dir ? 'a folder here' : 'a link here: left alone' };
    const thereNow = await remoteStat(m, rel);
    if (thereNow?.dir) return { skipped: 'a folder on the server' };
    const src = up ? hereNow : thereNow;
    const dst = up ? thereNow : hereNow;
    if (!src) return { skipped: up ? 'not here any more' : 'not on the server any more' };
    // What the check saw of the destination: changed since, it is left for the person to look at again.
    if (item.expect !== undefined) {
      const moved = item.expect ? !dst || !sameStat(dst, item.expect) : Boolean(dst);
      if (moved) return { skipped: up ? 'changed on the server since it was checked' : 'changed here since it was checked' };
    }
    const known = doc.files[rel] ? JSON.parse(JSON.stringify(doc.files[rel])) : null;
    // The destination's version is kept first (Undo puts it back).
    let before = null;
    if (dst) {
      before = { size: dst.size, mtimeMs: dst.mtimeMs };
      if (dst.size <= KEEP_MAX) {
        fs.mkdirSync(dir, { recursive: true });
        const blob = String(n);
        if (up) await remote.downloadFile(ru, nodePath.join(dir, blob));
        else fs.copyFileSync(lp, nodePath.join(dir, blob));
        before.blob = blob;
      }
    }
    const after = up
      ? await putRemote(lp, ru, Boolean(dst))
      : await putLocal(lp, (part) => remote.downloadFile(ru, part), dst ? { size: dst.size, mtimeMs: dst.mtimeMs } : null, { oldToBin: Boolean(dst && !before.blob) });
    // In step now: the source as it was looked at (a change made meanwhile is seen next time), the destination as written.
    doc.files[rel] = up ? { l: { dir: false, ...src }, r: { dir: false, ...after } } : { l: { dir: false, ...after }, r: { dir: false, ...src } };
    return { file: { rel, before, after, known, ...(dst && !before.blob ? { notKept: true } : {}) } };
  }

  /**
   * Copies files one way: `items` [{ rel, expect, size }] (`expect`: the destination as the check
   * saw it, null for none; left out: not checked). Returns { entry (the history's id, or null),
   * done, skipped [{ rel, why }], notKept, errors [{ rel, why }] }. `job` (main.cjs's transfers)
   * shows the progress and can stop it between files.
   */
  function transfer(m, items, direction, { job = null } = {}) {
    if (!['upload', 'download'].includes(direction)) throw new Error('Upload or download?');
    if (!Array.isArray(items) || !items.length || items.length > TRANSFER_MAX) throw new Error('Nothing to do.');
    const list = items.filter((i) => i && safeRel(i.rel));
    if (!list.length) throw new Error('Nothing to do.');
    return exclusive(m.id, async () => {
      if (busy(m)) throw new Error('That mirror is syncing. Try again when it is done.');
      const id = crypto.randomBytes(6).toString('hex');
      const dir = entryDir(id);
      const doc = readState(m);
      const entry = { id, at: now(), mirror: m.id, pair: pairOfMirror(m), direction, files: [] };
      const out = { entry: null, done: [], skipped: [], notKept: [], errors: [] };
      job?.plan(list.map((i) => ({ path: i.rel, size: Number(i.size) || 0 })));
      for (const [n, item] of list.entries()) {
        if (job?.signal.aborted) {
          out.errors.push({ rel: item.rel, why: 'stopped' });
          continue;
        }
        const progress = { path: item.rel, size: Number(item.size) || 0 };
        job?.start(progress);
        try {
          const r = await transferOne(m, item, direction, dir, n, doc);
          if (r.skipped) out.skipped.push({ rel: item.rel, why: r.skipped });
          else {
            entry.files.push(r.file);
            out.done.push(item.rel);
            if (r.file.notKept) out.notKept.push(item.rel);
          }
        } catch (err) {
          out.errors.push({ rel: item.rel, why: errText(err) });
          // The server gone: the rest waits (the state keeps what got there).
          if (!remote.isConnected(m.conn)) {
            for (const rest of list.slice(n + 1)) out.errors.push({ rel: rest.rel, why: 'not done: the server disconnected' });
            break;
          }
        }
        job?.fileDone(progress);
      }
      writeState(m, doc);
      if (entry.files.length) {
        prune([entry, ...readHistory()]);
        out.entry = id;
      } else fs.rmSync(dir, { recursive: true, force: true });
      return out;
    });
  }

  /**
   * Copies from a folder comparison between a mirror's two sides (compare:copy): `rels` inside
   * `base` (the comparison's folders, as a path inside the mirror), folders taken whole, without
   * a check (the person chose each in the comparison). As transfer().
   */
  async function copyFromCompare(m, direction, base, rels, { job = null } = {}) {
    const inMirror = rels.map((r) => (base ? `${base}/${r}` : r));
    if (!inMirror.every(safeRel)) throw notInside();
    const { here, there, hereDirs, thereDirs } = await gather(m, inMirror, { exclude: false });
    const up = direction === 'upload';
    const files = Object.keys(up ? here : there).sort();
    const sizes = up ? here : there;
    // Folders only on the source (empty ones too) are made on the other side.
    for (const d of [...(up ? hereDirs : thereDirs)].filter((d) => d && !(up ? thereDirs : hereDirs).has(d)).sort()) {
      if (up) await remote.mkdirp(remoteOf(m, d));
      else fs.mkdirSync(localOf(m, d), { recursive: true });
    }
    if (!files.length) return { entry: null, done: [], skipped: [], notKept: [], errors: [] };
    return transfer(m, files.map((rel) => ({ rel, size: sizes[rel]?.size ?? 0 })), direction, { job });
  }

  // ---- Undo ----

  const restoreState = (doc, f, restored, direction) => {
    const to = direction === 'upload' ? 'r' : 'l';
    if (!f.known) delete doc.files[f.rel];
    else if (restored && sameStat(f.known[to], f.before)) doc.files[f.rel] = { ...f.known, [to]: { dir: false, ...restored } };
    else doc.files[f.rel] = f.known;
  };

  /**
   * Puts a transfer's files back: each only while the destination still holds what it wrote.
   * Returns { restored, removed, left [{ rel, why }] }.
   */
  async function undo(entryId) {
    const entry = readHistory().find((e) => e.id === entryId);
    if (!entry) throw new Error('That transfer is not in the history any more.');
    if (entry.undone) throw new Error('That transfer was undone already.');
    const m = mirrorOf(entry.mirror);
    if (!m) throw new Error('That mirror is not set up here any more.');
    // Its folders changed since: the relative paths would name other files.
    if (entry.pair && JSON.stringify(entry.pair) !== JSON.stringify(pairOfMirror(m))) throw new Error('That mirror keeps other folders now: this transfer cannot be undone.');
    return exclusive(m.id, async () => {
      if (busy(m)) throw new Error('That mirror is syncing. Try again when it is done.');
      const up = entry.direction === 'upload';
      const doc = readState(m);
      const out = { restored: [], removed: [], left: [] };
      for (const f of [...entry.files].reverse()) {
        try {
          const lp = localOf(m, f.rel);
          const ru = remoteOf(m, f.rel);
          const current = up ? await remoteStat(m, f.rel) : localStat(m, f.rel);
          if (!current || current.dir || current.link || !sameStat(current, f.after)) {
            out.left.push({ rel: f.rel, why: current ? 'changed since; left as it is' : 'not there any more' });
            continue;
          }
          if (!f.before) {
            if (up) await remote.remove([ru]);
            else await trash(lp);
            out.removed.push(f.rel);
            restoreState(doc, f, null, entry.direction);
            continue;
          }
          const blob = f.before.blob && nodePath.join(entryDir(entry.id), String(f.before.blob));
          if (!blob || !fs.existsSync(blob)) {
            out.left.push({ rel: f.rel, why: 'its old version was not kept' });
            continue;
          }
          const restored = up ? await putRemote(blob, ru, true, { mtimeMs: f.before.mtimeMs }) : await putLocal(lp, async (part) => fs.copyFileSync(blob, part), current, { mtimeMs: f.before.mtimeMs });
          out.restored.push(f.rel);
          restoreState(doc, f, restored, entry.direction);
        } catch (err) {
          out.left.push({ rel: f.rel, why: errText(err) });
        }
      }
      writeState(m, doc);
      const list = readHistory();
      const saved = list.find((e) => e.id === entry.id);
      if (saved) {
        saved.undone = now();
        saved.left = out.left;
        // Nothing left to look at: its kept versions go.
        if (!out.left.length) {
          fs.rmSync(entryDir(entry.id), { recursive: true, force: true });
          for (const f of saved.files) if (f.before?.blob) f.before = { size: f.before.size, mtimeMs: f.before.mtimeMs, gone: true };
        }
        writeHistory(list);
      }
      return out;
    });
  }

  /** The history, newest first (one mirror's, or all): what the page shows. */
  function history(mirrorId = null) {
    return readHistory()
      .filter((e) => !mirrorId || e.mirror === mirrorId)
      .sort((a, b) => b.at - a.at)
      .map((e) => ({
        id: e.id,
        at: e.at,
        mirror: e.mirror,
        direction: e.direction,
        undone: e.undone ?? null,
        left: e.left ?? [],
        files: (e.files ?? []).map((f) => ({ rel: f.rel, before: f.before ? { size: f.before.size, mtimeMs: f.before.mtimeMs, kept: Boolean(f.before.blob) } : null, after: f.after, notKept: Boolean(f.notKept) })),
      }));
  }
  /** A kept old version's bytes (up to `max`), or null. */
  function keptBytes(entryId, rel, max = 5 * 1024 * 1024) {
    const entry = readHistory().find((e) => e.id === entryId);
    const f = entry?.files?.find((x) => x.rel === rel);
    if (!f?.before?.blob || !isId(entry.id)) return null;
    const file = nodePath.join(entryDir(entry.id), String(f.before.blob));
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st || st.size > max) return null;
    return fs.readFileSync(file);
  }

  /** A mirror whose two sides `from` and `to` are (counterparts, same place inside it): { m, direction, base }, or null. */
  function pairOf(mirrors, from, to) {
    for (const m of mirrors) {
      for (const [a, b, direction] of [
        [from, to, 'upload'],
        [to, from, 'download'],
      ]) {
        if (isRemote(a) || !isRemote(b)) continue;
        try {
          const [la] = relsOf(m, [a]);
          const [rb] = relsOf(m, [b]);
          if (la === rb) return { m, direction, base: la };
        } catch {
          // not this mirror
        }
      }
    }
    return null;
  }

  /** Settles when no transfer or undo of the mirror is running (a sync waits for it). */
  const idle = (id) => queues.get(id) ?? Promise.resolve();

  return { relsOf, check: checkMirror, transfer, copyFromCompare, undo, history, keptBytes, pairOf, prune, readState, idle };
}

module.exports = { createMirrorTransfers, pruneHistory, KEEP_MAX, HISTORY_ENTRIES, HISTORY_DAYS, HISTORY_BYTES, CHECK_MAX };
