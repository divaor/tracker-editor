// Git in the editor (0.48), on editor states without a screen: a change put back as it is at the
// last commit as one edit Ctrl+Z takes back, the next and previous change, the peek following, and
// blame moved by edits (an edited line is not committed yet until blame is asked again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, history, undo } from '../app/vendor/cm/codemirror.js';
import { changeAt, gitGutter, gitInfo, gotoChange, peekChange, peekLineOf, revertChange, setGitBase, showChange } from '../app/js/gitGutter.js';
import { blameAt, blameOf, blameState, setBlame } from '../app/js/gitBlame.js';
import { NOT_COMMITTED } from '../app/js/gitStatus.js';

// A view's face for the commands: the state and dispatch.
function editor(doc, base, { at = 0, readOnly = false } = {}) {
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(at), extensions: [history(), gitGutter, blameState, readOnly ? EditorState.readOnly.of(true) : []] }),
    dispatch(spec) {
      view.state = view.state.update(spec).state;
    },
  };
  if (base != null) view.dispatch({ effects: setGitBase.of(base) });
  return view;
}
const lineAt = (view) => view.state.doc.lineAt(view.state.selection.main.head).number;

test('the bar’s blocks, and a change reverted as one edit that Ctrl+Z takes back', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\n';
  const v = editor('ONE\ntwo\nthree\nfour\nfive\nsix\n', base);
  assert.deepEqual(gitInfo(v.state).changes, [{ kind: 'modified', from: 1, to: 1 }, { kind: 'added', from: 6, to: 6 }]);
  assert.equal(gitInfo(v.state).blocks.length, 2);
  assert.deepEqual(changeAt(v.state, 6), { index: 1, count: 2, block: { aFrom: 5, aTo: 5, bFrom: 5, bTo: 6 }, line: 6, kind: 'added', removed: 0, added: 1 });
  assert.equal(changeAt(v.state, 3), null);
  // Typing first, then reverting: Ctrl+Z takes back the revert alone.
  v.dispatch({ changes: { from: v.state.doc.line(3).to, insert: '!' }, userEvent: 'input.type' });
  const done = revertChange(v, 1);
  assert.deepEqual(done, { line: 1, kind: 'modified' });
  assert.equal(v.state.doc.toString(), 'one\ntwo\nthree!\nfour\nfive\nsix\n');
  assert.equal(gitInfo(v.state).changes.length, 2, 'the bar follows: line 3 changed, line 6 added');
  undo(v);
  assert.equal(v.state.doc.toString(), 'ONE\ntwo\nthree!\nfour\nfive\nsix\n', 'the revert undone, the typing kept');
  undo(v);
  assert.equal(v.state.doc.toString(), 'ONE\ntwo\nthree\nfour\nfive\nsix\n');
  // Added lines go; the cursor goes to where they were.
  assert.deepEqual(revertChange(v, 6), { line: 6, kind: 'added' });
  assert.equal(v.state.doc.toString(), 'ONE\ntwo\nthree\nfour\nfive\n');
  assert.equal(revertChange(v, 3), null, 'nothing changed there');
});

test('removed lines come back, at the start and at the end; read-only texts are left alone', () => {
  const base = 'one\ntwo\nthree\n';
  const top = editor('two\nthree\n', base);
  assert.equal(changeAt(top.state, 1).kind, 'deleted');
  assert.deepEqual(revertChange(top, 1), { line: 1, kind: 'deleted' });
  assert.equal(top.state.doc.toString(), base);
  const end = editor('one\ntwo', 'one\ntwo\nthree');
  assert.deepEqual(revertChange(end, 2), { line: 3, kind: 'deleted' }, 'the cursor on the line put back');
  assert.equal(end.state.doc.toString(), 'one\ntwo\nthree');
  const locked = editor('ONE\ntwo\nthree\n', base, { readOnly: true });
  assert.equal(revertChange(locked, 1), null);
  assert.equal(locked.state.doc.toString(), 'ONE\ntwo\nthree\n');
  // Without the text at the last commit: nothing to revert.
  assert.equal(revertChange(editor('a\n', null), 1), null);
});

test('the next and previous change, wrapping round; the peek follows and closes', () => {
  const base = 'a\nb\nc\nd\ne\nf\ng\n';
  const v = editor('A\nb\nc\nD\ne\nf\nG\n', base, { at: 0 });
  assert.deepEqual(gotoChange(v, 1), { index: 1, count: 3 });
  assert.equal(lineAt(v), 4);
  gotoChange(v, 1);
  assert.equal(lineAt(v), 7);
  gotoChange(v, 1);
  assert.equal(lineAt(v), 1, 'round to the first');
  gotoChange(v, -1);
  assert.equal(lineAt(v), 7, 'and back to the last');
  // The peek: on the change at line 4, then the next one, then closed.
  assert.equal(showChange(v, 4), true);
  assert.equal(peekLineOf(v.state), 4);
  assert.equal(lineAt(v), 4, 'the cursor goes to the change');
  gotoChange(v, 1);
  assert.equal(peekLineOf(v.state), 7);
  gotoChange(v, -1);
  assert.equal(peekLineOf(v.state), 4);
  // It moves with its line when lines are added above.
  v.dispatch({ changes: { from: 0, insert: 'new\n' } });
  assert.equal(peekLineOf(v.state), 5);
  v.dispatch({ effects: peekChange.of(null) });
  assert.equal(peekLineOf(v.state), 0);
  assert.equal(showChange(v, 3), false, 'no change on line 3');
  assert.equal(gotoChange(editor('a\n', 'a\n'), 1), null, 'nothing changed');
  // Reverting the change the peek shows closes it.
  showChange(v, 5);
  revertChange(v, 5);
  assert.equal(peekLineOf(v.state), 0);
});

test('lines removed before and after the first line share its mark: the peek reaches both', () => {
  const base = 'x\nkeep\ny\nrest\n';
  const v = editor('keep\nrest\n', base);
  assert.equal(gitInfo(v.state).blocks.length, 2);
  showChange(v, 1);
  assert.equal(changeAt(v.state, 1).index, 0);
  assert.deepEqual(gotoChange(v, 1), { index: 1, count: 2 }, 'the second, on the same line');
  assert.deepEqual(gotoChange(v, 1), { index: 0, count: 2 });
});

// A blame as git:blame answers (parseBlame's commits and lines, with who commits here).
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const raw = {
  commits: {
    [A]: { hash: A, author: 'Ana', mail: 'ana@example.org', time: 1767261600, summary: 'First lines', boundary: true, previous: null, filename: 'a.js', uncommitted: false },
    [B]: { hash: B, author: 'Bruno', mail: 'bruno@example.org', time: 1793347200, summary: 'Fix the parser', boundary: false, previous: { hash: A, filename: 'a.js' }, filename: 'a.js', uncommitted: false },
  },
  lines: [A, B, A, B],
  me: { name: 'Ana', email: 'ana@example.org' },
  head: B,
};
const owners = (v) => Array.from({ length: v.state.doc.lines }, (_, i) => blameAt(v.state, i + 1)?.hash ?? null);

test('blame follows edits: edited lines are not committed yet, the others keep their commit', () => {
  const v = editor('one\nTWO\nthree\nfour\n', null);
  v.dispatch({ effects: setBlame.of(raw) });
  assert.deepEqual(owners(v), [A, B, A, B, null], 'the last line break starts no line of its own');
  assert.equal(blameAt(v.state, 2).commit.author, 'Bruno');
  assert.equal(blameAt(v.state, 2).age, 1, 'the newest');
  assert.equal(blameAt(v.state, 1).age, 0);
  // Typing in line 3.
  v.dispatch({ changes: { from: v.state.doc.line(3).to, insert: '!' } });
  assert.deepEqual(owners(v), [A, B, NOT_COMMITTED, B, null]);
  assert.equal(blameAt(v.state, 3).commit.uncommitted, true);
  assert.equal(blameOf(v.state).mapped, true);
  // Enter at the end of line 1: a new line 2, the old one moves down with its commit.
  v.dispatch({ changes: { from: v.state.doc.line(1).to, insert: '\n' } });
  assert.deepEqual(owners(v), [A, NOT_COMMITTED, B, NOT_COMMITTED, B, null]);
  // A whole line deleted (line 3, Bruno's): the next one keeps its own.
  v.dispatch({ changes: { from: v.state.doc.line(3).from, to: v.state.doc.line(4).from } });
  assert.deepEqual(owners(v), [A, NOT_COMMITTED, NOT_COMMITTED, B, null]);
  // Lines pasted at a line's start: new, and the line keeps its commit.
  v.dispatch({ changes: { from: v.state.doc.line(1).from, insert: 'x\ny\n' } });
  assert.deepEqual(owners(v), [NOT_COMMITTED, NOT_COMMITTED, A, NOT_COMMITTED, NOT_COMMITTED, B, null]);
  // Two cursors on one line.
  v.dispatch({ changes: [{ from: v.state.doc.line(3).from, insert: '<' }, { from: v.state.doc.line(3).to, insert: '>' }] });
  assert.deepEqual(owners(v), [NOT_COMMITTED, NOT_COMMITTED, NOT_COMMITTED, NOT_COMMITTED, NOT_COMMITTED, B, null]);
  // Taken away.
  v.dispatch({ effects: setBlame.of(null) });
  assert.equal(blameOf(v.state), null);
});

test('blame of a new file, and of one too large', () => {
  const v = editor('a\nb\n', null);
  v.dispatch({ effects: setBlame.of({ untracked: true, me: raw.me, commits: {} }) });
  assert.deepEqual(owners(v), [NOT_COMMITTED, NOT_COMMITTED, null]);
  assert.equal(blameAt(v.state, 1).commit.uncommitted, true);
  v.dispatch({ effects: setBlame.of({ status: 'big', size: 3_000_000, max: 2_097_152 }) });
  assert.deepEqual(blameAt(v.state, 1), { status: 'big', size: 3_000_000, max: 2_097_152 });
  // Edits leave it as it is.
  v.dispatch({ changes: { from: 0, insert: 'x' } });
  assert.equal(blameOf(v.state).status, 'big');
});
