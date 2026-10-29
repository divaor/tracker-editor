// Two folders compared (the folder comparison tab): their listings, as the main process
// gives them ({ rel: { dir, size, mtimeMs } } per side, `rel` with / between names), become
// one aligned tree: each entry is on the left, the right or both, and is the same, changed,
// only on one side, or not known yet (same size, another date: its contents are compared in
// the background). Folders take the state of what is inside them. Pure, so the tests import it.

/** Within this much, two dates are the same (FTP gives minutes; copies round to seconds). */
export const TIME_SLACK = 2000;

/**
 * What can be shown: everything, the differences (the default), only what is on the
 * left, or on the right.
 */
export const SHOW = ['diff', 'all', 'left', 'right'];
export const SHOW_LABELS = { diff: 'Differences', all: 'Everything', left: 'Only on the left', right: 'Only on the right' };

/** A row's state, for its mark and its words. */
export const STATE_LABELS = {
  same: 'The same',
  changed: 'Different',
  left: 'Only on the left',
  right: 'Only on the right',
  unsure: 'Same size, another date: checking the contents…',
  kind: 'A folder on one side, a file on the other',
};

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const nameOf = (rel) => rel.slice(rel.lastIndexOf('/') + 1);

/**
 * The entries of both listings, by relative path: { rel, name, parent, depth, dir, left, right,
 * state }. `checked` holds what the content checks found ({ rel: true (same) | false }).
 */
export function compareListings(left = {}, right = {}, { checked = {}, slack = TIME_SLACK } = {}) {
  const entries = new Map();
  const add = (rel) => {
    if (entries.has(rel)) return;
    const l = left[rel] ?? null;
    const r = right[rel] ?? null;
    const parent = parentOf(rel);
    entries.set(rel, { rel, name: nameOf(rel), parent, depth: rel.split('/').length - 1, dir: Boolean((l ?? r).dir), left: l, right: r, state: 'same' });
    // Listings name every folder on the way; a stray name without its folder still gets one.
    if (parent) add(parent);
  };
  for (const rel of Object.keys(left)) add(rel);
  for (const rel of Object.keys(right)) add(rel);
  // Files first, then folders from the deepest up (they take their contents' state).
  for (const e of entries.values()) {
    if (!e.left && !e.right) {
      // A folder made up for a stray name: there on the side its contents are.
      e.dir = true;
      continue;
    }
    if (!e.left) e.state = 'right';
    else if (!e.right) e.state = 'left';
    else if (e.left.dir !== e.right.dir) e.state = 'kind';
    else if (e.dir) e.state = 'same';
    else if (e.left.size !== e.right.size) e.state = 'changed';
    else if (Math.abs((e.left.mtimeMs ?? 0) - (e.right.mtimeMs ?? 0)) <= slack) e.state = 'same';
    else if (checked[e.rel] === true) e.state = 'same';
    else if (checked[e.rel] === false) e.state = 'changed';
    else e.state = 'unsure';
  }
  const folders = [...entries.values()].filter((e) => e.dir && e.state !== 'kind').sort((a, b) => b.depth - a.depth);
  const kids = childrenOf(entries);
  for (const f of folders) {
    if (!f.left && !f.right) {
      const states = new Set((kids.get(f.rel) ?? []).map((c) => c.state));
      f.state = states.has('left') && !states.has('right') ? 'left' : states.has('right') && !states.has('left') ? 'right' : 'changed';
      continue;
    }
    if (f.state === 'left' || f.state === 'right') continue;
    const inside = kids.get(f.rel) ?? [];
    f.state = inside.some((c) => c.state === 'unsure') && inside.every((c) => c.state === 'same' || c.state === 'unsure') ? 'unsure' : inside.every((c) => c.state === 'same') ? 'same' : 'changed';
  }
  return entries;
}

/** Each folder's entries (rel '' = the top), names in order: folders first. */
export function childrenOf(entries) {
  const kids = new Map();
  for (const e of entries.values()) {
    if (!kids.has(e.parent)) kids.set(e.parent, []);
    kids.get(e.parent).push(e);
  }
  for (const list of kids.values()) list.sort(byName);
  return kids;
}
const byName = (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Whether an entry is shown for `show` (a folder: when something inside is). */
const keeps = (show) => (e) => (show === 'all' ? true : show === 'diff' ? e.state !== 'same' : e.state === show);

/**
 * The rows the tree shows, in order: the entries under open folders (`expanded`, a Set of
 * rels) that `show` keeps, each with its `depth`. A folder that differs but holds nothing
 * shown (only another kind of difference) is still listed, so its own state shows.
 */
export function treeRows(entries, { expanded = new Set(), show = 'diff' } = {}) {
  const kids = childrenOf(entries);
  const keep = keeps(show);
  // Folders with something kept inside (at any depth).
  const holds = new Map();
  const holdsKept = (e) => {
    if (holds.has(e.rel)) return holds.get(e.rel);
    const any = (kids.get(e.rel) ?? []).some((c) => keep(c) || (c.dir && holdsKept(c)));
    holds.set(e.rel, any);
    return any;
  };
  const rows = [];
  const walk = (parent) => {
    for (const e of kids.get(parent) ?? []) {
      const inside = e.dir && holdsKept(e);
      if (!keep(e) && !inside) continue;
      rows.push(e);
      if (e.dir && expanded.has(e.rel) && (inside || show === 'all')) walk(e.rel);
    }
  };
  walk('');
  return rows;
}

/**
 * Counts by state: files, and a folder only on one side once (not its files); folders on
 * both sides count through their files. { same, changed, left, right, unsure, kind }.
 */
export function countStates(entries) {
  const counts = { same: 0, changed: 0, left: 0, right: 0, unsure: 0, kind: 0 };
  const oneSided = (e) => Boolean(e) && Boolean(e.left) !== Boolean(e.right);
  for (const e of entries.values()) {
    if (oneSided(e.parent && entries.get(e.parent))) continue;
    if (e.dir && !oneSided(e) && e.state !== 'kind') continue;
    counts[e.state] += 1;
  }
  return counts;
}

/** The files whose contents need comparing: same size, another date (biggest last), up to `max` bytes each. */
export function toCheck(entries, { max = 20 * 1024 * 1024 } = {}) {
  return [...entries.values()].filter((e) => e.state === 'unsure' && !e.dir && e.left.size <= max).sort((a, b) => a.left.size - b.left.size).map((e) => e.rel);
}

/** The next (or previous, `step` -1) differing file after `rel` among `rows`, wrapping; null when none. */
export function nextDifference(rows, rel, step = 1) {
  const files = rows.filter((e) => !e.dir || e.state === 'kind' || e.state === 'left' || e.state === 'right');
  const diffs = files.filter((e) => e.state !== 'same');
  if (!diffs.length) return null;
  const at = files.findIndex((e) => e.rel === rel);
  if (at === -1) return (step > 0 ? diffs[0] : diffs.at(-1)).rel;
  for (let i = 1; i <= files.length; i += 1) {
    const e = files[(at + step * i + files.length * 2) % files.length];
    if (e.state !== 'same') return e.rel;
  }
  return null;
}

/** Whether `rel` is inside one of `rels` (or is one of them). */
const within = (rel, rels) => rels.some((r) => rel === r || rel.startsWith(`${r}/`));

/**
 * What copying `rels` from the side `from` ('left' | 'right') to the other does: `copy`, the
 * paths copied whole (a file, or a folder the other side lacks); folders on both sides are
 * gone through, so files that are the same are left alone. `same` counts those left alone,
 * `missing` the picked ones not on the `from` side.
 */
export function copyPlan(entries, rels, from) {
  const kids = childrenOf(entries);
  const copy = [];
  let same = 0;
  let missing = 0;
  const visit = (e) => {
    if (!e[from]) {
      missing += 1;
      return;
    }
    const to = from === 'left' ? 'right' : 'left';
    if (e.state === 'same' && !e.dir) {
      same += 1;
      return;
    }
    // A folder on both sides: what differs inside it; else the whole thing.
    if (e[from].dir && e[to]?.dir) {
      for (const c of kids.get(e.rel) ?? []) visit(c);
      return;
    }
    copy.push(e.rel);
  };
  const top = [...new Set(rels)].filter((r) => entries.has(r)).filter((r, _, all) => !all.some((o) => o !== r && r.startsWith(`${o}/`)));
  for (const r of top) visit(entries.get(r));
  return { copy, same, missing };
}

/**
 * Making the side `to` like the other one: what to copy there (everything different or
 * missing, as copyPlan), and what is only on `to` (`extra`: the top-most paths), which goes
 * only when the person ticks it.
 */
export function syncPlan(entries, to) {
  const from = to === 'right' ? 'left' : 'right';
  const tops = (childrenOf(entries).get('') ?? []).map((e) => e.rel);
  const { copy } = copyPlan(entries, tops.filter((r) => entries.get(r)[from]), from);
  const onlyThere = [...entries.values()].filter((e) => e[to] && !e[from]).map((e) => e.rel);
  const extra = onlyThere.filter((r) => !within(r, onlyThere.filter((o) => o !== r)));
  // A file there where a folder is here (or the other way): replaced, so not "extra" too.
  return { copy, extra: extra.filter((r) => !copy.includes(r)).sort() };
}

/** The entries of a listing under `rel` (a folder): for a copy's progress or a delete's words. */
export function filesUnder(entries, rel) {
  return [...entries.values()].filter((e) => !e.dir && (e.rel === rel || e.rel.startsWith(`${rel}/`)));
}

/** A comparison's name for its tab: "site ↔ site", with where each one is when the names match. */
export function compareTitle(left, right) {
  if (!left || !right) return left || right || 'Comparison';
  return `${left} ↔ ${right}`;
}

/** A relative path made of plain names (never .., never empty parts): what the main process may join. */
export const safeRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length < 4096 && rel.split('/').every((p) => p && p !== '.' && p !== '..' && !/[\\\0]/.test(p));

/** `rel` inside the folder `root`, as the app addresses files: on a server (remote://…, with /) or here (\ in Windows paths). */
export function childPath(root, rel) {
  if (root.startsWith('remote://')) return `${root.replace(/\/+$/, '')}/${rel}`;
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
}
