// Mirrors by hand (0.54): before an upload or a download, each file is looked at on both
// sides, with what the mirror knew of it the last time the two were in step (its state, as
// mirror.cjs keeps it: { l, r }, each { size, mtimeMs }). So the person sees what a transfer
// would lose before it does: a file the other side changed since, one changed on both sides,
// one that is newer there. Pure: the main process (mirrorTransfer.cjs) and the page use it.

/** Two times this close are the same time, for files the mirror has no state for. */
export const TIME_SLACK = 2000;
/** An FTP listing's time (no MDTM) is to the minute: that close is the same time. */
export const APPROX_SLACK = 61000;
/** A side unchanged since the state: as mirror.cjs's same() (size, and the time within a second). */
export const STATE_SLACK = 1000;
/** Files up to this size with the same size on both sides are compared byte for byte. */
export const COMPARE_MAX = 5 * 1024 * 1024;

/**
 * What a file is, for a transfer from one side (the source) to the other (the destination):
 * - same: the same on both sides (nothing to do);
 * - ahead: the source changed since the two were last in step, the destination did not (safe);
 * - behind: the destination changed since then and the source did not (the transfer would lose that);
 * - both: both changed since then;
 * - new: only on the source;
 * - onlyThere: only on the destination (never deleted by an upload or a download: left alone);
 * - newer / older: no state, the source's time is later / earlier than the destination's;
 * - differ: no state, not the same, and the times say nothing (equal, or not known).
 */
export const STATES = ['same', 'ahead', 'behind', 'both', 'new', 'onlyThere', 'newer', 'older', 'differ'];
const RISKY = new Set(['behind', 'both', 'older', 'differ']);

export const sameStat = (a, b, slack = STATE_SLACK) => Boolean(a && b && a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < slack);
/** The state's letters for a direction's source and destination. */
export const sidesOf = (direction) => (direction === 'upload' ? { from: 'l', to: 'r' } : { from: 'r', to: 'l' });
/** In step at the last sync or transfer: the state has both sides. */
const known = (s) => Boolean(s?.l && s?.r);

/**
 * Whether the bytes should be compared before `classify` can tell: both sides there with the
 * same size (up to COMPARE_MAX), unless the state says neither changed.
 */
export function needsBytes({ here, there, state }) {
  if (!here || !there || here.size !== there.size || here.size > COMPARE_MAX) return false;
  return !(known(state) && sameStat(here, state.l) && sameStat(there, state.r));
}

/**
 * One file's state for a transfer. `here` and `there`: { size, mtimeMs } or null (not on that
 * side); `state`: the mirror's { l, r } for it (or nothing); `direction` 'upload' | 'download';
 * `same`: the bytes compared (true / false; undefined when not compared); `approx`: the server's
 * time is only to the minute. Null when it is on neither side.
 */
export function classify({ here, there, state, direction, same, approx = false }) {
  const { from, to } = sidesOf(direction);
  const src = from === 'l' ? here : there;
  const dst = from === 'l' ? there : here;
  if (!src && !dst) return null;
  if (!src) return 'onlyThere';
  if (!dst) return 'new';
  if (same === true) return 'same';
  if (known(state)) {
    const srcChanged = !sameStat(src, state[from]);
    const dstChanged = !sameStat(dst, state[to]);
    if (!srcChanged && !dstChanged) return 'same';
    if (srcChanged && !dstChanged) return 'ahead';
    if (!srcChanged) return 'behind';
    return 'both';
  }
  // No state: the times say which is newer (a time not known, 0, says nothing).
  if (src.mtimeMs && dst.mtimeMs) {
    const slack = approx ? APPROX_SLACK : TIME_SLACK;
    if (src.mtimeMs - dst.mtimeMs > slack) return 'newer';
    if (dst.mtimeMs - src.mtimeMs > slack) return 'older';
  }
  return src.size === dst.size && same !== false ? 'same' : 'differ';
}

/** A transfer would lose something on the destination (or cannot tell that it would not). */
export const atRisk = (state) => RISKY.has(state);
/** Something to copy: neither the same, nor only on the destination. */
export const transferable = (state) => Boolean(state) && state !== 'same' && state !== 'onlyThere';

/** How many of each state, and how many could go / are at risk. */
export function countStates(rows) {
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of rows) if (r?.state in counts) counts[r.state]++;
  counts.total = rows.length;
  counts.transferable = rows.filter((r) => transferable(r.state)).length;
  counts.risky = rows.filter((r) => atRisk(r.state)).length;
  return counts;
}

/** Whether to ask before transferring: something at risk, or always when the setting says so ('risky' | 'always'). */
export function needsDialog(rows, confirm = 'risky') {
  const going = rows.filter((r) => transferable(r.state));
  if (!going.length) return false;
  return confirm === 'always' || going.some((r) => atRisk(r.state));
}

/** Ticked at first in the dialog: what is safe; never what is at risk. */
export const tickedAtFirst = (row) => transferable(row.state) && !atRisk(row.state);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The counts in a sentence: "12 differ: 8 newer here, 3 only here, 1 newer on web-1".
 * `server`: the server's name.
 */
export function checkSentence(counts, direction, server = 'the server') {
  const up = direction === 'upload';
  const hereNewer = up ? counts.ahead + counts.newer : counts.behind + counts.older;
  const thereNewer = up ? counts.behind + counts.older : counts.ahead + counts.newer;
  const differ = counts.ahead + counts.behind + counts.both + counts.new + counts.newer + counts.older + counts.differ;
  if (!differ) return counts.same ? (counts.same === 1 ? 'The same on both sides' : `All ${counts.same} the same on both sides`) : 'Nothing to compare';
  const parts = [
    hereNewer && `${hereNewer} newer here`,
    counts.new && `${counts.new} only ${up ? 'here' : `on ${server}`}`,
    thereNewer && `${thereNewer} newer on ${server}`,
    counts.both && `${counts.both} changed on both sides`,
    counts.differ && `${counts.differ} different (no way to tell which is newer)`,
  ].filter(Boolean);
  return `${differ} ${differ === 1 ? 'differs' : 'differ'}: ${parts.join(', ')}`;
}

/** What is left as it is: "4 the same (skipped) · 2 only on web-1 (left alone)". */
export function leftText(counts, direction, server = 'the server') {
  const up = direction === 'upload';
  return [counts.same && `${counts.same} the same (skipped)`, counts.onlyThere && `${counts.onlyThere} only ${up ? `on ${server}` : 'here'} (left alone)`].filter(Boolean).join(' · ');
}

/** One file's state in a few words, for the dialog's rows. */
export function stateWords(state, direction, server = 'the server') {
  const up = direction === 'upload';
  const src = up ? 'here' : `on ${server}`;
  const dst = up ? `on ${server}` : 'here';
  return {
    same: 'The same',
    ahead: `Changed ${src} since the last time in step`,
    behind: `Changed ${dst} since the last time in step`,
    both: 'Changed on both sides since the last time in step',
    new: `Only ${src}`,
    onlyThere: `Only ${dst} (left alone)`,
    newer: `Newer ${src}`,
    older: `Newer ${dst}`,
    differ: 'Different; no way to tell which is newer',
  }[state] ?? '';
}

/**
 * The note over a mirrored file's tab, from a check of it as an upload: null when there is
 * nothing to say; else { tone ('warn' | 'info'), text, offer: ['download' | 'upload' | 'compare', …] }.
 * `when(ms)` and `size(bytes)` word a time and a size.
 */
export function noteOf(row, { server = 'the server', when = (ms) => new Date(ms).toLocaleTimeString(), size = (n) => `${n} bytes` } = {}) {
  if (!row || row.state === 'same' || row.state === 'onlyThere') return null;
  const there = row.there && `${when(row.there.mtimeMs)}, ${size(row.there.size)}`;
  const here = row.here && when(row.here.mtimeMs);
  switch (row.state) {
    case 'behind':
    case 'older':
      return { tone: 'warn', text: `${server}’s copy is newer (${there}; here ${here})`, offer: ['compare', 'download'] };
    case 'both':
      return { tone: 'warn', text: `Changed here and on ${server} since they were last in step`, offer: ['compare', 'download', 'upload'] };
    case 'differ':
      return { tone: 'warn', text: `Not the same as ${server}’s copy (${there}), and no way to tell which is newer`, offer: ['compare', 'download', 'upload'] };
    case 'ahead':
      return { tone: 'info', text: `Changed here since the last upload to ${server}`, offer: ['upload', 'compare'] };
    case 'newer':
      return { tone: 'info', text: `Newer here than ${server}’s copy (${there})`, offer: ['upload', 'compare'] };
    case 'new':
      return { tone: 'info', text: `Not on ${server} yet`, offer: ['upload'] };
    default:
      return null;
  }
}

/** The two versions a note was about: dismissing it holds until either changes. */
export const noteKey = (row) => (row ? `${row.state}:${row.here?.size ?? '-'}:${row.here?.mtimeMs ?? '-'}:${row.there?.size ?? '-'}:${row.there?.mtimeMs ?? '-'}` : '');

/** "Uploaded 3 files to web-1", "Downloaded notes.md from web-1". */
export function transferredText(done, direction, server = 'the server', name = '') {
  const what = done.length === 1 && name ? name : plural(done.length, 'file');
  return direction === 'upload' ? `Uploaded ${what} to ${server}` : `Downloaded ${what} from ${server}`;
}
