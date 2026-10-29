// Folder comparisons (the page's folder comparison tab): both folders listed as mirrors list
// them ({ rel: { dir, size, mtimeMs } }: this computer through fs, servers through
// remote.cjs), files compared byte for byte, and paths made from a folder and a relative
// path (plain names only). main.cjs checks the folders and does the copies. Tested.
const fs = require('node:fs');
const nodePath = require('node:path');
const { walkLocal } = require('./mirror.cjs');
const { SKIP_DIRS } = require('./findInFolder.cjs');

const MAX_ENTRIES = 50000;
const SAME_MAX = 20 * 1024 * 1024;

/** What a listing leaves out: `.git`, `node_modules`… unless `all`; dot names unless `hidden`; partial transfers. */
function skipper({ all = false, hidden = true } = {}) {
  return (rel) => {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (/\.part-[0-9a-f]{6}$/.test(name)) return true;
    if (!all && SKIP_DIRS.has(name)) return true;
    return !hidden && name.startsWith('.');
  };
}

/** A relative path made of plain names: never .., never empty parts, no backslashes. */
const safeRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length < 4096 && rel.split('/').every((p) => p && p !== '.' && p !== '..' && !/[\\\0]/.test(p));

/** `rel` inside `root`: a server's path (remote://…) or one here. */
function joinRel(root, rel, isRemote) {
  if (!safeRel(rel)) throw new Error('That is not a path inside the folder.');
  return isRemote(root) ? `${root.replace(/\/+$/, '')}/${rel}` : nodePath.join(root, ...rel.split('/'));
}

/** Everything under a folder, here or on a server, without what `skip` leaves out. */
async function listSide(root, { remote, isRemote, skip, max = MAX_ENTRIES }) {
  try {
    return isRemote(root) ? await remote.listTree(root, skip, max) : walkLocal(root, skip, max);
  } catch (err) {
    if (/^Too many files/.test(err.message)) throw new Error(`More than ${max.toLocaleString()} files and folders: compare a folder further down.`);
    throw err;
  }
}

async function readSide(file, { remote, isRemote, max }) {
  if (isRemote(file)) return remote.readBytes(file, max);
  if (fs.statSync(file).size > max) throw new Error('too large');
  return fs.readFileSync(file);
}

/** Whether two files hold the same bytes; null when one could not be read (or is larger than `max`). */
async function sameFiles(a, b, { remote, isRemote, max = SAME_MAX }) {
  try {
    const [x, y] = await Promise.all([readSide(a, { remote, isRemote, max }), readSide(b, { remote, isRemote, max })]);
    return Buffer.from(x).equals(Buffer.from(y));
  } catch {
    return null;
  }
}

/** Relative paths grouped by the folder they go into (its relative path; '' = the top). */
function byParent(rels) {
  const groups = new Map();
  for (const rel of rels) {
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(rel);
  }
  return groups;
}

module.exports = { skipper, safeRel, joinRel, listSide, sameFiles, byParent, MAX_ENTRIES, SAME_MAX };
