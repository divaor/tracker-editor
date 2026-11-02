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
 * What a content check is good for: both sides' size and date. A file changed since (another
 * size or date on either side) is checked again; the others keep what was found, so reading
 * both folders again after a copy does not make every same-size file "not known yet".
 */
export const checkKey = (l, r) => `${l?.size ?? '-'}:${l?.mtimeMs ?? '-'}|${r?.size ?? '-'}:${r?.mtimeMs ?? '-'}`;

/** What the content check found for `e`: true (same), false (different), undefined (not checked, or checked before it changed). */
function checkedOf(checked, e) {
  const c = checked[e.rel];
  if (typeof c === 'boolean') return c;
  return c && c.key === checkKey(e.left, e.right) ? c.same : undefined;
}

/**
 * `checked` with what a content check `found` ({ rel: true | false | null }) for `entries`,
 * each kept with the sizes and dates it was for (null, could not tell: different, to be
 * looked at). Only what is still listed in `entries` is kept.
 */
export function withChecks(checked = {}, entries, found = {}) {
  const out = {};
  for (const [rel, c] of Object.entries(checked)) if (entries.has(rel)) out[rel] = c;
  for (const [rel, same] of Object.entries(found)) {
    const e = entries.get(rel);
    if (e?.left && e.right) out[rel] = { key: checkKey(e.left, e.right), same: same === true };
  }
  return out;
}

/**
 * The entries of both listings, by relative path: { rel, name, parent, depth, dir, left, right,
 * state }. `checked` holds what the content checks found: { rel: { key, same } } (withChecks;
 * used while both sides' size and date are still `key`), or { rel: true (same) | false }.
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
    else {
      const same = checkedOf(checked, e);
      e.state = same === true ? 'same' : same === false ? 'changed' : 'unsure';
    }
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

/**
 * Whether an entry is shown for `show` (a folder: when something inside is). With `hidden`
 * (rel → true), the differences leave out those unsure files (their contents are being
 * checked: most turn out the same), and unsure folders show only for something else inside.
 */
const keeps = (show, hidden = null) => (e) => {
  if (show === 'all') return true;
  if (show !== 'diff') return e.state === show;
  if (e.state === 'same') return false;
  if (e.state === 'unsure' && hidden) return !e.dir && !hidden(e.rel);
  return true;
};

/**
 * The rows the tree shows, in order: the entries under open folders (`expanded`, a Set of
 * rels) that `show` keeps, each with its `depth`. A folder that differs but holds nothing
 * shown (only another kind of difference) is still listed, so its own state shows.
 * `hideUnsure` (true, or a Set of rels) leaves those unsure files out of the differences
 * while their contents are checked, so they never show all at once for a moment.
 */
export function treeRows(entries, { expanded = new Set(), show = 'diff', hideUnsure = null } = {}) {
  const kids = childrenOf(entries);
  const hidden = hideUnsure === true ? () => true : hideUnsure instanceof Set ? (rel) => hideUnsure.has(rel) : null;
  const keep = keeps(show, hidden);
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

// ---- Syncing: what goes which way -------------------------------------------------
// A sync works on units: each file that differs on both sides (or is not known yet, or is a
// folder on one side and a file on the other), and each file or folder on one side only (the
// top-most: a folder there goes whole). Folders on both sides are gone through, as copyPlan
// does. A unit's choice names the side made like the other: 'right' (→: the left's copy goes
// there, or what is only on the right is deleted there), 'left' (←), or 'skip'.

/** The ways to fill in every choice at once, in the order the menu lists them. */
export const SYNC_PRESETS = ['newer', 'right', 'left', 'mirror-right', 'mirror-left', 'skip'];
export const PRESET_LABELS = {
  newer: 'Newer replaces older',
  right: 'Everything to the right',
  left: 'Everything to the left',
  'mirror-right': 'Make the right exactly like the left',
  'mirror-left': 'Make the left exactly like the right',
  skip: 'Skip all',
};
export const PRESET_HINTS = {
  newer: 'Each different file goes from the newer side to the older one; what is on one side only is copied to the other',
  right: 'Copy every difference to the right; nothing is deleted',
  left: 'Copy every difference to the left; nothing is deleted',
  'mirror-right': 'Copy every difference to the right, and delete what is only on the right',
  'mirror-left': 'Copy every difference to the left, and delete what is only on the left',
  skip: 'Leave everything as it is, then pick what goes',
};

/** 'left' or 'right' for an entry on that side only, else null. */
const oneSide = (e) => (e?.left && !e.right ? 'left' : e?.right && !e.left ? 'right' : null);

/** The relative paths of the units (see above), in tree order. */
export function syncUnits(entries) {
  const out = [];
  for (const e of entries.values()) {
    if (e.state === 'same' || (!e.left && !e.right)) continue;
    // Inside a folder on one side, or a folder against a file: that one goes whole.
    const parent = e.parent ? entries.get(e.parent) : null;
    if (parent && (oneSide(parent) || parent.state === 'kind')) continue;
    if (e.left && e.right && e.dir && e.state !== 'kind') continue;
    out.push(e.rel);
  }
  return out.sort(byTreeOrder(entries));
}
// Folders first at each level, names in order (as the tree shows them).
const byTreeOrder = (entries) => (a, b) => {
  const pa = a.split('/');
  const pb = b.split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i += 1) {
    if (pa[i] === pb[i]) continue;
    const ea = entries.get(pa.slice(0, i + 1).join('/'));
    const eb = entries.get(pb.slice(0, i + 1).join('/'));
    return ea && eb ? byName(ea, eb) : pa[i].localeCompare(pb[i]);
  }
  return pa.length - pb.length;
};

/**
 * The choice "Newer replaces older" makes: a different file goes from the newer side to the
 * older one (the same date, or a folder against a file: skipped); what is on one side only is
 * copied to the other; a file not checked yet is skipped until it is.
 */
export function defaultChoice(e, slack = TIME_SLACK) {
  const one = oneSide(e);
  if (one) return one === 'left' ? 'right' : 'left';
  if (e.state !== 'changed' || e.left.dir || e.right.dir) return 'skip';
  const d = (e.left.mtimeMs ?? 0) - (e.right.mtimeMs ?? 0);
  return d > slack ? 'right' : d < -slack ? 'left' : 'skip';
}

/**
 * The choice a preset makes for a unit. Everything to one side copies only (what is only on
 * that side is skipped); making a side exactly like the other deletes that too. Files not
 * checked yet are skipped until they are.
 */
export function presetChoice(e, preset = 'newer') {
  if (preset === 'newer') return defaultChoice(e);
  if (preset === 'skip' || e.state === 'unsure') return 'skip';
  const to = preset === 'right' || preset === 'mirror-right' ? 'right' : 'left';
  const one = oneSide(e);
  if (!one || one !== to) return to;
  return preset.startsWith('mirror-') ? to : 'skip';
}

/** Every unit's choice (rel → choice): the preset's, with the person's own (`overrides`) on top. */
export function presetChoices(entries, preset = 'newer', overrides = new Map()) {
  const out = new Map();
  for (const rel of syncUnits(entries)) {
    const own = overrides.get(rel);
    out.set(rel, own === 'right' || own === 'left' || own === 'skip' ? own : presetChoice(entries.get(rel), preset));
  }
  return out;
}

/**
 * The person's choices (`overrides`, rel → choice) with `choice` set for `rels`: a unit takes
 * it, a folder on both sides gives it to every unit inside it. 'right' and 'left' copy: a
 * unit only on that side (which it would delete) is skipped instead. 'delete' deletes each
 * unit on one side, on its side (units on both sides stay as they were). 'skip' skips.
 */
export function setChoice(overrides, entries, rels, choice) {
  const next = new Map(overrides);
  const units = syncUnits(entries);
  const isUnit = new Set(units);
  const targets = new Set();
  for (const rel of rels) {
    if (isUnit.has(rel)) targets.add(rel);
    else if (entries.get(rel)?.dir) for (const u of units) if (u.startsWith(`${rel}/`)) targets.add(u);
  }
  for (const rel of targets) {
    const one = oneSide(entries.get(rel));
    if (choice === 'delete') {
      if (one) next.set(rel, one);
    } else if (choice === 'right' || choice === 'left' || choice === 'skip') next.set(rel, choice !== 'skip' && one === choice ? 'skip' : choice);
  }
  return next;
}

/**
 * Each folder's choice from the units inside it (folder rel → choice): 'right' or 'left' when
 * all that goes, goes that way (some may be skipped), 'skip' when nothing goes, 'mixed' when
 * some go each way. Folders with nothing inside to sync are not in it.
 */
export function folderChoices(choices) {
  const tally = new Map();
  for (const [rel, c] of choices) {
    for (let p = parentOf(rel); p; p = parentOf(p)) {
      const t = tally.get(p) ?? { right: 0, left: 0 };
      if (c === 'right') t.right += 1;
      else if (c === 'left') t.left += 1;
      tally.set(p, t);
    }
  }
  const out = new Map();
  for (const [p, t] of tally) out.set(p, t.right && t.left ? 'mixed' : t.right ? 'right' : t.left ? 'left' : 'skip');
  return out;
}

/** One folder's choice (see folderChoices), or null when nothing inside it is synced. */
export const folderChoice = (choices, rel) => folderChoices(choices).get(rel) ?? null;

/**
 * What the choices do, as top-most relative paths: `toRight` copied from the left
 * (`replaceRight` of them replace what is there), `toLeft` (`replaceLeft`), `deleteLeft`,
 * `deleteRight`; `skipped` counts the units left alone.
 */
export function choicePlan(entries, choices) {
  const plan = { toRight: [], toLeft: [], deleteLeft: [], deleteRight: [], replaceRight: 0, replaceLeft: 0, skipped: 0 };
  for (const rel of syncUnits(entries)) {
    const c = choices.get(rel);
    const one = oneSide(entries.get(rel));
    if (c !== 'right' && c !== 'left') plan.skipped += 1;
    else if (one === c) (c === 'left' ? plan.deleteLeft : plan.deleteRight).push(rel);
    else {
      (c === 'right' ? plan.toRight : plan.toLeft).push(rel);
      if (!one) plan[c === 'right' ? 'replaceRight' : 'replaceLeft'] += 1;
    }
  }
  return plan;
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
