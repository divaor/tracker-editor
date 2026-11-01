// Find by asking in the folders shown in Folders (here and on servers): each text file is read and
// measured against the plan (askFind.js `measure`, given as `measure`: in the main process a worker
// thread runs it, so no file can freeze the window); only the files that match go back to the page,
// with how many passed the plan's filters (`total`, for the rarity of words). Folders like .git and
// node_modules are skipped, links are not followed, hidden names are left out unless `hidden`, and
// it stops at `maxFiles` files read or `timeLimit` ms (`truncated`).
const { SKIP_DIRS } = require('./findInFolder.cjs');

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const strings = (v, max, len) =>
  (Array.isArray(v) ? v : [])
    .filter((s) => typeof s === 'string' && s.trim() && s.length <= len)
    .slice(0, max)
    .map((s) => s.trim());
const day = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');

/**
 * A plan from the page, checked again (the page cannot send a pattern that runs away, or huge
 * lists): the same fields as askFind.js `parseFindPlan` gives. `patternProblem` is askFind.js's.
 */
function cleanPlan(plan, patternProblem) {
  const p = isObject(plan) ? plan : {};
  return {
    intent: p.intent === 'list' ? 'list' : 'find',
    terms: strings(p.terms, 12, 60),
    patterns: strings(p.patterns, 3, 160).filter((x) => !patternProblem(x)),
    names: strings(p.names, 6, 80),
    projects: strings(p.projects, 20, 200),
    tags: strings(p.tags, 20, 100),
    kinds: strings(p.kinds, 10, 40),
    types: strings(p.types, 10, 40),
    status: ['open', 'done', 'all'].includes(p.status) ? p.status : 'all',
    since: day(p.since),
    until: day(p.until),
    sort: ['recent', 'oldest'].includes(p.sort) ? p.sort : 'relevance',
    encrypted: p.encrypted === true,
    untitled: p.untitled === true,
    limit: Number.isInteger(p.limit) ? Math.min(Math.max(p.limit, 1), 50) : 20,
  };
}

const hasHit = (e) => e.counts.some((n) => n > 0) || e.inName.some(Boolean) || e.names > 0 || e.patterns.some((n) => n > 0);

/**
 * Walks `roots` breadth-first and measures their text files. `list(dir)` gives [{ name, path, dir,
 * size, mtimeMs, link }], `read(path)` the bytes, `decode(bytes)` the text (throws for binary files),
 * `isText(name)` whether a name can be text, `measure(source, plan)` (may be async) the entry or
 * null, `projectOf(root)` the project a folder is linked to, `relative(root, path)` the path inside
 * it. For a plan that only lists, the newest `maxListed` that pass come back. Returns { entries,
 * total, scanned, truncated, stopped }.
 */
async function askFolders({ roots, plan, list, read, decode, isText = () => true, measure, projectOf = () => '', relative = (root, p) => p, hidden = false, signal, maxFiles = 4000, maxSize = 1024 * 1024, timeLimit = 8000, concurrency = 4, maxListed = 300, now = Date.now }) {
  const ends = now() + timeLimit;
  const entries = [];
  const stats = { total: 0, scanned: 0, truncated: false, stopped: false };
  const pending = roots.map((root) => ({ root, dir: root }));
  const queue = [];
  const over = () => stats.stopped || signal?.aborted || stats.scanned >= maxFiles || now() > ends;
  const visit = async ({ root, dir }) => {
    let listed = [];
    try {
      listed = await list(dir);
    } catch {
      return; // unreadable: left out
    }
    for (const e of listed) {
      if (!hidden && e.name.startsWith('.')) continue;
      if (e.dir) {
        if (!e.link && !SKIP_DIRS.has(e.name)) pending.push({ root, dir: e.path });
      } else if (!e.link && isText(e.name) && (e.size ?? 0) <= maxSize) queue.push({ root, entry: e });
    }
  };
  const measureOne = async ({ root, entry }) => {
    stats.scanned++;
    let text;
    try {
      text = decode(await read(entry.path));
    } catch {
      return; // not text, or unreadable
    }
    if (signal?.aborted || stats.stopped) return;
    const mtime = entry.mtimeMs ?? (entry.mtime ? Date.parse(entry.mtime) : 0);
    const source = { id: `d:${entry.path}`, kind: 'disk', name: entry.name, root, rel: relative(root, entry.path), project: projectOf(root) || '', tags: [], date: mtime ? new Date(mtime).toISOString() : '', text };
    let measured;
    try {
      measured = await measure(source, plan);
    } catch (err) {
      // A file that takes too long stops the whole search (what was found so far comes back).
      if (err?.fatal) stats.stopped = true;
      return;
    }
    if (!measured) return;
    stats.total++;
    if (plan.intent === 'list' || hasHit(measured)) entries.push(measured);
  };
  while ((pending.length || queue.length) && !over()) {
    if (queue.length) {
      const batch = queue.splice(0, Math.min(concurrency, maxFiles - stats.scanned));
      await Promise.all(batch.map(measureOne));
    } else {
      await Promise.all(pending.splice(0, concurrency).map(visit));
    }
  }
  if (signal?.aborted) stats.stopped = true;
  stats.truncated = !stats.stopped && (pending.length > 0 || queue.length > 0);
  const kept = plan.intent === 'list' ? entries.sort((a, b) => (String(b.date) > String(a.date) ? 1 : String(b.date) < String(a.date) ? -1 : 0)).slice(0, maxListed) : entries;
  return { entries: kept, ...stats };
}

module.exports = { askFolders, cleanPlan, hasHit };
