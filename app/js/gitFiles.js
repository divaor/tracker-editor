// The Git panel's picked files (pure): which ones a click, Shift+click or Ctrl+A picks, what
// can be done with them (stage, unstage, stash, discard, ignore, keep my changes out), and the
// ignore patterns that name them (in .gitignore, shared, or .git/info/exclude, this computer).
// Entries are [rel, code] as the panel lists them: a section's codes from gitStatus.js
// parseStatus (staged A M D R; changes M D U (not in Git yet) C (in conflict)).

/** A file of the repository as an ignore pattern that names it alone: "/src/a[1].txt" → "/src/a\[1\].txt". */
export function ignorePattern(rel, { folder = false } = {}) {
  const escaped = String(rel)
    .replace(/[\\*?[\]!#]/g, (c) => `\\${c}`)
    .replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '));
  return `/${escaped}${folder ? '/' : ''}`;
}

const folderOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const extOf = (rel) => {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : '';
};

/**
 * The ways to ignore these files: `files` (each one), `folders` (their folders, when none is the
 * repository's top), `ext` (every *.ext file, when they share one): each { patterns, label }.
 */
export function ignoreChoices(rels) {
  const list = [...new Set(rels)];
  const out = { files: { patterns: list.map((r) => ignorePattern(r)), label: list.length === 1 ? list[0].slice(list[0].lastIndexOf('/') + 1) : `these ${list.length} files` } };
  const folders = [...new Set(list.map(folderOf))];
  if (list.length && folders.every(Boolean)) out.folders = { patterns: folders.map((f) => ignorePattern(f, { folder: true })), label: folders.length === 1 ? `${folders[0]}/` : `their ${folders.length} folders` };
  const exts = [...new Set(list.map(extOf))];
  if (list.length && exts.length === 1 && exts[0]) out.ext = { patterns: [`*.${exts[0].replace(/[\\*?[\]]/g, (c) => `\\${c}`)}`], label: `every .${exts[0]} file` };
  return out;
}

/** The rels from `from` to `to` in the list's order (both included); just `to` when `from` is not there. */
export function rangeOf(rels, from, to) {
  const a = rels.indexOf(from);
  const b = rels.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [to];
  return rels.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/**
 * A click on a row's box or name: the picked set after it. `shift` picks the range from the
 * last one clicked (`anchor`), `toggle` (the box, Ctrl/Cmd+click) adds or takes out one.
 */
export function pickAfterClick(picked, rels, rel, { shift = false, anchor = null } = {}) {
  const next = new Set(picked);
  if (shift && anchor && rels.includes(anchor)) {
    const on = picked.has(anchor) || !picked.size;
    for (const r of rangeOf(rels, anchor, rel)) on ? next.add(r) : next.delete(r);
    return next;
  }
  next.has(rel) ? next.delete(rel) : next.add(rel);
  return next;
}

/** The picked ones still listed (after the panel reads Git again). Same set when nothing went. */
export function tidyPicked(picked, rels) {
  const here = new Set(rels);
  const next = new Set([...picked].filter((r) => here.has(r)));
  return next.size === picked.size ? picked : next;
}

/**
 * What can be done with the picked `entries` ([rel, code]) of a section ('staged' or
 * 'changes'): each action's files, or null where it does not apply.
 * - stage / unstage: the section's own move;
 * - stash: all but files in conflict (new files make it take untracked ones too: `untracked`);
 * - discard: changes only, not conflicts (tracked ones go back, new ones are deleted: `fresh`);
 * - ignore: new files only (Git ignores only what it does not follow);
 * - skip: changed tracked files (keep my changes out on this computer: skip-worktree);
 * - untrack: tracked files (out of Git, kept on disk: a deletion for everyone once committed);
 * - compare: one modified file.
 */
export function pickActions(section, entries) {
  const rels = (pred) => entries.filter(([, c]) => pred(c)).map(([r]) => r);
  const all = entries.map(([r]) => r);
  const usable = rels((c) => c !== 'C');
  const changes = section === 'changes';
  const fresh = changes ? rels((c) => c === 'U') : [];
  // Followed by Git and still on disk (a deletion has nothing to untrack).
  const tracked = changes ? rels((c) => c === 'M') : rels((c) => c === 'M' || c === 'R');
  const one = entries.length === 1 ? entries[0] : null;
  return {
    stage: changes && all.length ? all : null,
    unstage: !changes && all.length ? all : null,
    stash: usable.length ? { paths: usable, untracked: fresh.length > 0, left: all.length - usable.length } : null,
    discard: changes && usable.length ? { paths: usable, fresh: fresh.length, left: all.length - usable.length } : null,
    ignore: fresh.length ? fresh : null,
    skip: changes && rels((c) => c === 'M').length ? rels((c) => c === 'M') : null,
    untrack: tracked.length ? tracked : null,
    compare: one && one[1] === 'M' ? one[0] : null,
  };
}

/** "3 files" / "a.txt" — the picked ones in a few words. */
export function pickedWords(rels) {
  if (rels.length === 1) return rels[0].slice(rels[0].lastIndexOf('/') + 1);
  return `${rels.length} files`;
}

/** The names for a question, at most `max` of them ("a.txt, b.txt and 3 more"). */
export function namesList(rels, max = 5) {
  const names = rels.slice(0, max).map((r) => r.slice(r.lastIndexOf('/') + 1));
  return names.join(', ') + (rels.length > max ? ` and ${rels.length - max} more` : '');
}
