// Git's merge conflicts in a text: the blocks between its markers, and what each one resolves to.
// Git writes a conflict as `<<<<<<< label` (the current side), the current lines, `||||||| label`
// and the base's lines (diff3 / zdiff3 only), `=======`, the incoming lines, `>>>>>>> label`;
// each marker is 7 characters at a line's start. Pure (no DOM): the editor's conflict bars
// (conflictView.js), the Git panel, the merge view and the model's merge use it.
import { codeFences } from './fences.js';

const START = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: (.*))?$/;
const SEP = /^={7}$/;
const END = /^>{7}(?: (.*))?$/;
const QUICK = /(?:^|\n)<{7}(?: |\r?\n|$)/;

/** Whether `text` holds a line that starts a conflict (quick; findConflicts tells the rest). */
export const hasConflictMarkers = (text) => QUICK.test(String(text ?? ''));

/**
 * The conflicts in `text`, in order: { conflicts: [{ index, start, end, ours, base, theirs,
 * labels: { ours, base, theirs }, lines: { start, base, sep, end } }], broken: [{ line, reason }] }.
 * `start`/`end` are the block's offsets (the start marker's line to just past the end marker's
 * line break); `ours`, `base` (null without diff3) and `theirs` are { from, to } of their lines,
 * each section's last line break included; `lines` are 1-based. A start marker inside a block,
 * or one never closed, is `broken` ('nested', 'unfinished'): not resolvable here. A lone
 * `=======` (a Markdown heading's underline) or `>>>>>>>` outside a block is plain text.
 */
export function findConflicts(text) {
  const src = String(text ?? '');
  const conflicts = [];
  const broken = [];
  if (!hasConflictMarkers(src)) return { conflicts, broken };
  let cur = null;
  let at = 0;
  let lineNo = 0;
  for (;;) {
    const nl = src.indexOf('\n', at);
    const lineEnd = nl === -1 ? src.length : nl;
    const next = nl === -1 ? src.length : nl + 1;
    const line = src.slice(at, lineEnd).replace(/\r$/, '');
    lineNo++;
    let m;
    if ((m = START.exec(line))) {
      if (cur) broken.push({ line: cur.lines.start, reason: 'nested' });
      cur = { start: at, stage: 'ours', labels: { ours: m[1] ?? '', base: '', theirs: '' }, lines: { start: lineNo, base: 0, sep: 0, end: 0 }, ours: { from: next, to: next }, base: null, theirs: null };
    } else if (cur && cur.stage === 'ours' && (m = BASE.exec(line))) {
      cur.ours.to = at;
      cur.base = { from: next, to: next };
      cur.labels.base = m[1] ?? '';
      cur.lines.base = lineNo;
      cur.stage = 'base';
    } else if (cur && (cur.stage === 'ours' || cur.stage === 'base') && SEP.test(line)) {
      if (cur.stage === 'ours') cur.ours.to = at;
      else cur.base.to = at;
      cur.theirs = { from: next, to: next };
      cur.lines.sep = lineNo;
      cur.stage = 'theirs';
    } else if (cur && cur.stage === 'theirs' && (m = END.exec(line))) {
      cur.theirs.to = at;
      cur.labels.theirs = m[1] ?? '';
      cur.lines.end = lineNo;
      const { stage, ...done } = cur;
      conflicts.push({ index: conflicts.length, ...done, end: next });
      cur = null;
    }
    if (nl === -1) break;
    at = next;
  }
  if (cur) broken.push({ line: cur.lines.start, reason: 'unfinished' });
  // A block a nested start marker cut off is left out: what it holds cannot be told apart.
  return { conflicts: broken.length ? conflicts.filter((c) => !broken.some((b) => b.line >= c.lines.start && b.line <= c.lines.end)) : conflicts, broken };
}

/** How many conflicts `text` holds. */
export const conflictCount = (text) => findConflicts(text).conflicts.length;

/** The ways to resolve a block. */
export const RESOLUTIONS = ['ours', 'theirs', 'both', 'both-theirs-first', 'base', 'none'];

/**
 * The text a block becomes, from its sections' texts ({ ours, base, theirs }): the current lines,
 * the incoming ones, both (in either order), the base's, or none. `finalNewline` false: the block
 * ended the text without a line break, and so does what replaces it.
 */
export function resolutionText({ ours = '', base = '', theirs = '' }, how, { finalNewline = true } = {}) {
  const joined = (a, b) => (a && b && !/\n$/.test(a) ? `${a}\n${b}` : a + b);
  const text = { ours, theirs, base: base ?? '', both: joined(ours, theirs), 'both-theirs-first': joined(theirs, ours), none: '' }[how];
  if (text === undefined) throw new Error(`Not a way to resolve a conflict: ${how}`);
  return finalNewline ? text : text.replace(/\r?\n$/, '');
}

/** The change resolving `conflict` (from findConflicts on `text`) as `how`: { from, to, insert }. */
export function resolveConflict(text, conflict, how) {
  const src = String(text ?? '');
  const part = (r) => (r ? src.slice(r.from, r.to) : '');
  const finalNewline = !(conflict.end === src.length && !/\n$/.test(src));
  return { from: conflict.start, to: conflict.end, insert: resolutionText({ ours: part(conflict.ours), base: part(conflict.base), theirs: part(conflict.theirs) }, how, { finalNewline }) };
}

/** `text` with every conflict resolved as `how` (the merge view's "all current" or "all incoming"). */
export function resolveAll(text, how) {
  const src = String(text ?? '');
  let out = '';
  let at = 0;
  for (const c of findConflicts(src).conflicts) {
    const change = resolveConflict(src, c, how);
    out += src.slice(at, change.from) + change.insert;
    at = change.to;
  }
  return out + src.slice(at);
}

/**
 * Words for the operation that stopped on the conflicts (git.cjs `in-progress`: merge, rebase,
 * cherry-pick, revert; or a stash put back, told by its labels): { title, current, incoming },
 * where `current` and `incoming` say what each side is. During a rebase, the current side is
 * the branch being rebased onto and the incoming one is your commit.
 */
export function conflictWords(op, labels = {}) {
  const stash = labels.theirs === 'Stashed changes' || labels.ours === 'Updated upstream';
  if (stash) return { title: 'Conflict with a stash put back', current: 'the files as they were', incoming: 'your stashed changes' };
  switch (op) {
    case 'rebase':
      return { title: 'Conflict while rebasing', current: 'the branch you are rebasing onto', incoming: 'your commit, being put on top' };
    case 'cherry-pick':
      return { title: 'Conflict while cherry-picking', current: 'your branch', incoming: 'the commit being picked' };
    case 'revert':
      return { title: 'Conflict while reverting', current: 'your branch', incoming: 'the commit being undone' };
    case 'merge':
      return { title: 'Merge conflict', current: 'your branch', incoming: 'the branch merged in' };
    default:
      return { title: 'Merge conflict', current: '', incoming: '' };
  }
}

// What each kind of conflict in `git status` (porcelain v2 'u' lines' XY) means, and the
// choices for the whole file.
export const CONFLICT_KINDS = {
  UU: { label: 'Changed on both sides', choices: ['ours', 'theirs'] },
  AA: { label: 'Added on both sides', choices: ['ours', 'theirs'] },
  DU: { label: 'Deleted on the current side, changed on the incoming', choices: ['keep', 'delete'] },
  UD: { label: 'Changed on the current side, deleted on the incoming', choices: ['keep', 'delete'] },
  AU: { label: 'Added on the current side only', choices: ['keep', 'delete'] },
  UA: { label: 'Added on the incoming side only', choices: ['keep', 'delete'] },
  DD: { label: 'Deleted on both sides', choices: ['delete'] },
};
export const conflictKind = (xy) => CONFLICT_KINDS[xy] ?? { label: 'In conflict', choices: ['ours', 'theirs'] };

// ---- The model merges one conflict ----

const CONTEXT_LINES = 12;
const MAX_SIDE = 12_000;
const cut = (s, max) => (s.length > max ? `${s.slice(0, max)}\n… (cut here)` : s);

/**
 * The messages asking a model to merge one conflict: the file's name, the operation, the lines
 * around the block, the current and incoming lines and the base's when known. The answer is the
 * merged lines alone, in one fenced block. The caller never sends an encrypted file.
 */
export function mergeMessages({ name = '', op = null, labels = {}, before = '', after = '', ours = '', base = null, theirs = '', language = '' }) {
  const words = conflictWords(op, labels);
  const fence = (s) => {
    const longest = Math.max(2, ...[...String(s).matchAll(/`{3,}/g)].map((m) => m[0].length));
    const f = '`'.repeat(longest + 1);
    return `${f}${language ? language.toLowerCase().replace(/\s+/g, '') : ''}\n${s.replace(/\n$/, '')}\n${f}`;
  };
  const lastLines = (s, n) => s.split('\n').slice(-n - 1).join('\n');
  const firstLines = (s, n) => s.split('\n').slice(0, n).join('\n');
  const parts = [
    `File: ${name || 'untitled'}`,
    `${words.title}.${words.current ? ` The current side (${labels.ours || 'HEAD'}) is ${words.current}; the incoming side (${labels.theirs || 'incoming'}) is ${words.incoming}.` : ''}`,
    before.trim() ? `Lines before the conflict:\n${fence(cut(lastLines(before, CONTEXT_LINES), MAX_SIDE))}` : '',
    `Current side (${labels.ours || 'HEAD'}):\n${fence(cut(ours, MAX_SIDE))}`,
    base != null ? `Common ancestor (${labels.base || 'base'}), what both sides changed from:\n${fence(cut(base, MAX_SIDE))}` : '',
    `Incoming side (${labels.theirs || 'incoming'}):\n${fence(cut(theirs, MAX_SIDE))}`,
    after.trim() ? `Lines after the conflict:\n${fence(cut(firstLines(after, CONTEXT_LINES), MAX_SIDE))}` : '',
    'Merge the two sides into the lines that should replace the whole conflict: keep what each side meant to do (both changes when they can live together; when they cannot, the one that fits the code around it, and say why after the block). Keep the file’s indentation and style. Answer with the merged lines in one fenced code block, without the conflict markers and without the lines before or after it.',
  ];
  return [
    { role: 'system', content: 'You resolve Git merge conflicts in code and text. You answer with the merged lines in one fenced code block, then at most two short sentences on what you kept.' },
    { role: 'user', content: parts.filter(Boolean).join('\n\n') },
  ];
}

/**
 * The merged lines in a model's answer to mergeMessages: { text, note } (its first fenced block,
 * read as fences.js reads them, with a line break at the end when the block it replaces had one;
 * `note`: what the model said after it), or null when there is no block or the block still holds
 * a conflict (a start and an end marker).
 */
export function mergedFromReply(reply, { finalNewline = true } = {}) {
  const src = String(reply ?? '');
  const block = codeFences(src)[0];
  if (!block) return null;
  let text = block.body.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (/^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text)) return null;
  if (finalNewline && text) text += '\n';
  return { text, note: src.slice(block.end).trim().slice(0, 400) };
}

/**
 * Where a conflict block's section is in one side's whole file (the merge view shows it there):
 * { from, to } of `section` in `text`, the match nearest `near` (how far through the file, 0–1)
 * when there are several; a section not found (or empty) is placed just after the last lines
 * `before` it; null when neither is there.
 */
export function sidePlace(text, section, { before = '', near = 0 } = {}) {
  const src = String(text ?? '');
  const target = near * src.length;
  const nearest = (needle) => {
    let best = null;
    for (let at = src.indexOf(needle), n = 0; at !== -1 && n < 200; at = src.indexOf(needle, at + 1), n++) if (best === null || Math.abs(at - target) < Math.abs(best - target)) best = at;
    return best;
  };
  if (section) {
    const at = nearest(section);
    if (at !== null) return { from: at, to: at + section.length };
  }
  // The last three lines before it, else two, else one.
  const lines = String(before).replace(/\n$/, '').split('\n');
  for (let k = Math.min(3, lines.length); k >= 1; k--) {
    const lead = `${lines.slice(-k).join('\n')}\n`;
    if (!lead.trim()) continue;
    const at = nearest(lead);
    if (at !== null) return { from: at + lead.length, to: at + lead.length };
  }
  return null;
}
