// 0.49: Git's conflict blocks in the editor (conflictView.js), without a view: the blocks found as
// the text changes, the edits that resolve them (one undo step each), next and previous, the
// problems, what the bars and marker lines say, and the merged lines the model answers with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorView, Decoration, history, undo } from '../app/vendor/cm/codemirror.js';
import {
  conflictAt,
  conflictInfoOf,
  conflictLabels,
  conflictLintActions,
  conflictProblems,
  conflictResolution,
  conflictStep,
  conflictTexts,
  conflictView,
  conflictsIn,
  hasConflictBlocks,
  setConflictInfo,
} from '../app/js/conflictView.js';
import { mergedFromReply, sidePlace } from '../app/js/gitConflicts.js';

const TWO = 'top\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\nmiddle\n<<<<<<< HEAD\nx\n||||||| base\ny\n=======\nz\n>>>>>>> feature\nend\n';
const make = (doc, extra = []) => EditorState.create({ doc, extensions: [conflictView, ...extra] });
const apply = (state, spec) => state.update(spec).state;

test('the blocks are found when the text is made, and again as it changes', () => {
  let s = make(TWO);
  assert.equal(conflictsIn(s).length, 2);
  assert.equal(conflictsIn(s)[1].base !== null, true, 'diff3: the base is known');
  // An edit outside the blocks: found again, in their new places.
  s = apply(s, { changes: { from: 0, insert: 'new first line\n' } });
  assert.equal(conflictsIn(s).length, 2);
  assert.equal(s.sliceDoc(conflictsIn(s)[0].start, conflictsIn(s)[0].start + 7), '<<<<<<<');
  // A text without markers stays without, until a start marker is typed (or pasted).
  let plain = make('one\ntwo\n');
  assert.equal(conflictsIn(plain).length, 0);
  plain = apply(plain, { changes: { from: 4, insert: 'x' } });
  assert.equal(conflictsIn(plain).length, 0);
  plain = apply(plain, { changes: { from: 0, insert: '<<<<<<< a\nq\n=======\nr\n>>>>>>> b\n' } });
  assert.equal(conflictsIn(plain).length, 1);
  // A block cut short (its end marker deleted) is broken: no bar, still a problem.
  const c = conflictsIn(plain)[0];
  const end = plain.doc.lineAt(c.end - 1);
  const cut = apply(plain, { changes: { from: end.from, to: end.to + 1 } });
  assert.equal(conflictsIn(cut).length, 0);
  assert.equal(hasConflictBlocks(cut), true);
  assert.match(conflictProblems(cut)[0].message, /never ends/);
});

test('resolving a block is one edit, its own step to undo; the cursor goes to it', () => {
  let s = make(TWO, [history()]);
  // Typing first: the resolution is not joined to it.
  s = apply(s, { changes: { from: 3, insert: '!' }, userEvent: 'input.type' });
  const typed = s.doc.toString();
  const ours = conflictResolution(s, 0, 'ours');
  s = apply(s, ours);
  assert.equal(s.doc.toString(), typed.replace('<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> feature\n', 'mine\n'));
  assert.equal(s.selection.main.head, ours.changes.from);
  assert.equal(conflictsIn(s).length, 1);
  let back = s;
  undo({ state: back, dispatch: (tr) => (back = tr.state) });
  assert.equal(back.doc.toString(), typed, 'Ctrl+Z brings the block back, the typing stays');
  // Theirs, both, the base, none.
  const take = (how, i = 0) => apply(make(TWO), conflictResolution(make(TWO), i, how)).doc.toString();
  assert.match(take('theirs'), /^top\ntheirs\nmiddle\n/);
  assert.match(take('both'), /^top\nmine\ntheirs\nmiddle\n/);
  assert.match(take('both-theirs-first'), /^top\ntheirs\nmine\nmiddle\n/);
  assert.match(take('base', 1), /\nmiddle\ny\nend\n$/);
  assert.match(take('none', 1), /\nmiddle\nend\n$/);
  // A block ending the text without a line break: none after what replaces it either.
  const last = make('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x');
  assert.equal(apply(last, conflictResolution(last, 0, 'theirs')).doc.toString(), 'a\nc');
  // Read-only: nothing to resolve.
  assert.equal(conflictResolution(make(TWO, [EditorState.readOnly.of(true)]), 0, 'ours'), null);
  assert.equal(conflictResolution(make(TWO), 5, 'ours'), null);
});

test('next and previous go round the blocks from the cursor', () => {
  const s = make(TWO);
  const [a, b] = conflictsIn(s);
  const at = (pos) => s.update({ selection: { anchor: pos } }).state;
  assert.equal(conflictStep(at(0), 1).index, 0);
  assert.equal(conflictStep(at(a.start), 1).index, 1);
  assert.equal(conflictStep(at(b.start), 1).index, 0, 'past the last: the first again');
  assert.equal(conflictStep(at(s.doc.length), -1).index, 1);
  assert.equal(conflictStep(at(b.start), -1).index, 0);
  assert.equal(conflictStep(at(0), -1).index, 1, 'before the first: the last');
  assert.equal(conflictStep(at(a.start + 3), -1).index, 0, 'inside one: its own start');
  assert.deepEqual(conflictStep(at(0), 1).spec.selection, { anchor: a.start });
  assert.equal(conflictStep(make('no markers'), 1), null);
  // The block at a place, and its texts.
  assert.equal(conflictAt(s, a.start).index, 0);
  assert.equal(conflictAt(s, b.end - 1).index, 1);
  assert.equal(conflictAt(s, 1), null);
  const t = conflictTexts(s, b, 2);
  assert.deepEqual([t.ours, t.base, t.theirs, t.line], ['x\n', 'y\n', 'z\n', 8]);
  assert.equal(t.before, '>>>>>>> feature\nmiddle\n', 'the two lines before it');
  assert.equal(t.after, 'end\n');
});

test('the blocks are warnings for the problems, with ways out in their tooltip', () => {
  const s = make(TWO);
  const problems = conflictProblems(s);
  assert.equal(problems.length, 2);
  assert.ok(problems.every((p) => p.severity === 'warning' && p.source === 'Git'));
  assert.match(problems[0].message, /^Conflict 1 of 2: keep the current change \(HEAD\), the incoming one \(feature\) or both/);
  assert.equal(problems[0].from, conflictsIn(s)[0].start);
  assert.deepEqual(conflictLintActions(s, problems[0].from).map((a) => a.name), ['Accept current', 'Accept incoming', 'Accept both']);
  assert.equal(conflictLintActions(s, 0), undefined, 'not in a block');
  assert.equal(conflictLintActions(make(TWO, [EditorState.readOnly.of(true)]), problems[0].from), undefined);
  assert.deepEqual(conflictProblems(make('plain')), []);
  // A start marker inside a block: what it cut off is left out, and said.
  const nested = make('<<<<<<< a\nx\n<<<<<<< b\ny\n=======\nz\n>>>>>>> c\n');
  assert.match(conflictProblems(nested).find((p) => /inside another/.test(p.message)).message, /by hand/);
});

test('what the bars and marker lines say: the labels, the operation, a rebase’s swap', () => {
  const merge = conflictLabels('merge', { ours: 'HEAD', theirs: 'feature' });
  assert.equal(merge.title, 'Merge conflict');
  assert.equal(merge.current, 'Current change · HEAD · your branch');
  assert.equal(merge.incoming, 'Incoming change · feature · the branch merged in');
  assert.doesNotMatch(merge.tip, /swap/);
  const rebase = conflictLabels('rebase', { ours: 'HEAD', theirs: 'abc123 (fix)' });
  assert.equal(rebase.title, 'Conflict while rebasing');
  assert.match(rebase.current, /the branch you are rebasing onto/);
  assert.match(rebase.incoming, /your commit, being put on top/);
  assert.match(rebase.tip, /During a rebase the sides swap/);
  assert.match(conflictLabels(null, { ours: 'Updated upstream', theirs: 'Stashed changes' }).incoming, /your stashed changes/);
  assert.equal(conflictLabels(null, {}).current, 'Current change · HEAD');
  // What the app tells a tab: merged into what it knew.
  let s = make(TWO);
  assert.deepEqual(conflictInfoOf(s), { op: null, compare: true, mergeView: false, model: false });
  s = apply(s, { effects: setConflictInfo.of({ mergeView: true, model: true }) });
  s = apply(s, { effects: setConflictInfo.of({ op: 'rebase' }) });
  assert.deepEqual(conflictInfoOf(s), { op: 'rebase', compare: true, mergeView: true, model: true });
});

test('the decorations: a bar over each block, its lines tinted, notes on the markers', () => {
  const s = make(TWO);
  const marks = [];
  for (const deco of s.facet(EditorView.decorations)) {
    const set = typeof deco === 'function' ? null : deco;
    set?.between(0, s.doc.length, (from, _to, value) => {
      marks.push({ line: s.doc.lineAt(from).number, block: Boolean(value.spec.block), cls: value.spec.class ?? '', note: value.spec.attributes?.['data-note'] ?? '' });
    });
  }
  assert.deepEqual(marks.filter((m) => m.block).map((m) => m.line), [2, 8], 'a bar over each start marker');
  const cls = (name) => marks.filter((m) => m.cls.split(' ').includes(name)).map((m) => m.line);
  assert.deepEqual(cls('cm-conflict-ours'), [3, 9]);
  assert.deepEqual(cls('cm-conflict-theirs'), [5, 13]);
  assert.deepEqual(cls('cm-conflict-base'), [11]);
  assert.deepEqual(cls('cm-conflict-sep'), [4, 12]);
  assert.deepEqual(cls('cm-conflict-basemark'), [10]);
  assert.equal(marks.find((m) => m.line === 2 && m.note).note, 'Current change · HEAD');
  assert.equal(marks.find((m) => m.line === 10 && m.note).note, 'Common ancestor · base · what both changed from');
  assert.equal(marks.find((m) => m.line === 14 && m.note).note, 'Incoming change · feature');
  assert.equal(Decoration.none.size, 0);
});

test('the model’s merge: the first fenced block, line break as the block had it; never markers', () => {
  assert.deepEqual(mergedFromReply('Merged:\n```js\nconst a = 1;\nconst b = 2;\n```\nKept both changes.'), { text: 'const a = 1;\nconst b = 2;\n', note: 'Kept both changes.' });
  assert.deepEqual(mergedFromReply('```\nx\n```', { finalNewline: false }), { text: 'x', note: '' });
  // A longer fence holding a shorter one (a README's code), read as CommonMark reads it.
  assert.equal(mergedFromReply('````md\n# Use\n```sh\nnpm i\n```\n````').text, '# Use\n```sh\nnpm i\n```\n');
  assert.deepEqual(mergedFromReply('```\n```'), { text: '', note: '' }, 'an empty merge: the block goes');
  assert.equal(mergedFromReply('Just words, no block.'), null);
  assert.equal(mergedFromReply('```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n```'), null, 'still a conflict');
  assert.equal(mergedFromReply('```md\nTitle\n=======\n```').text, 'Title\n=======\n', 'a heading’s underline is not a marker');
});

test('where a block’s section is in one side’s file (the merge view outlines it there)', () => {
  const side = 'a\nb\nport = 1\nc\nport = 1\nd\n';
  assert.deepEqual(sidePlace(side, 'port = 1\n'), { from: 4, to: 13 });
  assert.deepEqual(sidePlace(side, 'port = 1\n', { near: 0.9 }), { from: 15, to: 24 }, 'the match nearest where the block is');
  // Not found (or empty): just after the lines before it, fewer of them when needed.
  assert.deepEqual(sidePlace(side, 'gone\n', { before: 'x\nb\nport = 1\n' }), { from: 13, to: 13 });
  assert.deepEqual(sidePlace(side, '', { before: 'zzz\nc\n' }), { from: 15, to: 15 });
  assert.equal(sidePlace(side, 'gone\n', { before: '' }), null);
});
