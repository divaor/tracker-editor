// Next-edit suggestions (nextEdits.js, pure; nextEditView.js's state): the edits made as small
// diffs, the request, the answer's edits placed, how each shows, which comes next, staleness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorView } from '../app/vendor/cm/codemirror.js';
import { afterChange, CURSOR, diffParts, editsText, editSummary, endAfter, FILE_CHARS, isNear, mapHistory, nextEditMessages, parseNextEdits, pickNext, placeEdit, recordEdit } from '../app/js/nextEdits.js';
import { nextEdits, nextEditsOf, withNextEdits } from '../app/js/nextEditView.js';

const SRC = ['def area(w, h):', '    count = w * h', '    print(count)', '    return count', ''].join('\n');

/** Types `text` at `pos` one character at a time (as a person would), recording each edit. */
function typeAt(state, history, pos, text, { del = 0 } = {}) {
  let s = state;
  let h = history;
  if (del) {
    const tr = s.update({ changes: { from: pos, to: pos + del }, userEvent: 'delete.forward' });
    h = recordEdit(h, { startDoc: tr.startState.doc, doc: tr.newDoc, changes: tr.changes });
    s = tr.state;
  }
  for (let i = 0; i < text.length; i++) {
    const tr = s.update({ changes: { from: pos + i, insert: text[i] }, userEvent: 'input.type' });
    h = recordEdit(h, { startDoc: tr.startState.doc, doc: tr.newDoc, changes: tr.changes });
    s = tr.state;
  }
  return { state: s, history: h };
}

test('the edits made: typing a word over another is one edit, shown as a small diff', () => {
  const start = EditorState.create({ doc: SRC });
  const at = SRC.indexOf('count');
  const { state, history } = typeAt(start, [], at, 'total', { del: 5 });
  assert.equal(history.length, 1, 'one edit for the whole word');
  assert.equal(history[0].before, '    count = w * h');
  assert.equal(state.doc.sliceString(history[0].from, history[0].to), '    total = w * h');
  assert.equal(editsText(history, state.doc), '@@ line 2 @@\n-    count = w * h\n+    total = w * h');
});

test('the edits made: lines apart are separate edits; the joined one becomes the latest; the last few kept', () => {
  let state = EditorState.create({ doc: 'a1\nb1\nc1\nd1\ne1\nf1\ng1\n' });
  let history = [];
  ({ state, history } = typeAt(state, history, 2, 'x')); // a1x
  ({ state, history } = typeAt(state, history, state.doc.line(3).to, 'y')); // c1y
  ({ state, history } = typeAt(state, history, state.doc.line(1).to, 'z')); // a1xz: joins the first
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((e) => e.before), ['c1', 'a1'], 'the line typed in again comes last, with what it said before any edit');
  assert.equal(editsText(history, state.doc), '@@ line 3 @@\n-c1\n+c1y\n@@ line 1 @@\n-a1\n+a1xz');
  for (const n of [4, 5, 6, 7]) ({ state, history } = typeAt(state, history, state.doc.line(n).to, '!'));
  assert.equal(recordEdit(history, { startDoc: state.doc, doc: state.doc, changes: state.update({}).changes }).length, history.length, 'no change, nothing new');
  assert.equal(history.length, 5, 'at most five');
  assert.ok(!history.some((e) => e.before === 'c1'), 'the oldest went');
});

test('the edits made: typed back to what it was, it goes; Enter makes a new line part of it; other changes move them', () => {
  let state = EditorState.create({ doc: 'one\ntwo\n' });
  let history = [];
  ({ state, history } = typeAt(state, history, 3, 'X'));
  const tr = state.update({ changes: { from: 3, to: 4 }, userEvent: 'delete.backward' });
  history = recordEdit(history, { startDoc: tr.startState.doc, doc: tr.newDoc, changes: tr.changes });
  state = tr.state;
  assert.deepEqual(history, [], 'back as it was');
  ({ state, history } = typeAt(state, history, 3, '\nnew'));
  assert.equal(editsText(history, state.doc), '@@ line 2 @@\n+new', 'lines the same at both ends left out');
  // A reload above (not the person's): the edit's lines move with the text.
  const reload = state.update({ changes: { from: 0, insert: 'zero\n' } });
  history = mapHistory(history, { doc: reload.newDoc, changes: reload.changes });
  assert.equal(editsText(history, reload.newDoc), '@@ line 3 @@\n+new');
});

test('the edits made: long lines are cut and many lines summed up', () => {
  const doc = EditorState.create({ doc: `${'x'.repeat(300)}\n${Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n')}` }).doc;
  const history = [{ from: 0, to: doc.length, before: 'short', at: 0 }];
  const text = editsText(history, doc, { maxLines: 4, maxChars: 50 });
  assert.match(text, /^\+x{50}…$/m);
  assert.match(text, /^\+… \(9 more lines\)$/m);
});

test('the request: the edits, the whole file with the cursor marked, JSON asked for', () => {
  const [system, user] = nextEditMessages({ name: 'area.py', language: 'Python', edits: '@@ line 2 @@\n-a\n+b', text: 'abc\ndef', cursor: 5 });
  assert.match(system.content, /"edits": \[\{"find"/);
  assert.match(system.content, /At most 3 edits/);
  assert.match(system.content, /occur only once/);
  assert.match(user.content, /^File: area\.py \(Python\)/);
  assert.match(user.content, /The edits just made, oldest first:\n@@ line 2 @@\n-a\n\+b/);
  assert.ok(user.content.includes(`(the whole file; ${CURSOR} marks the cursor)`));
  assert.ok(user.content.includes(`<<<\nabc\nd${CURSOR}ef\n>>>`));
});

test('the request: a long file goes as the lines around the cursor, saying which', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${'-'.repeat(20)}`);
  const text = lines.join('\n');
  assert.ok(text.length > FILE_CHARS);
  const cursor = text.indexOf('line 1500 ');
  const user = nextEditMessages({ edits: 'x', text, cursor })[1].content;
  const shown = user.slice(user.indexOf('<<<\n') + 4, user.lastIndexOf('\n>>>'));
  assert.ok(shown.length < 13000 && shown.length > 10000, `${shown.length}`);
  assert.ok(shown.includes(`${CURSOR}line 1500 `));
  const [, from, to] = /lines (\d+)–(\d+) of 3000/.exec(user);
  assert.ok(Number(from) > 1000 && Number(from) < 1500 && Number(to) > 1500 && Number(to) < 2000, `${from}–${to}`);
  assert.ok(shown.startsWith(`line ${from} `), 'whole lines');
});

test('the answer: JSON in any wrapping, placed in the text; what cannot be placed left out', () => {
  const text = SRC.replace('    count = w', '    total = w');
  const reply = 'Sure!\n```json\n{"edits": [{"find": "print(count)", "replace": "print(total)", "why": "rename count to total"}, {"find": "return count", "replace": "return total"}]}\n```';
  const edits = parseNextEdits(reply, text);
  assert.equal(edits.length, 2);
  assert.deepEqual(edits[0], { find: 'print(count)', replace: 'print(total)', why: 'rename count to total', from: text.indexOf('print(count)'), to: text.indexOf('print(count)') + 12 });
  assert.equal(parseNextEdits('[{"find": "return count", "replace": "return total"}]', text).length, 1, 'a bare list');
  assert.equal(parseNextEdits(`{"edits": [{"find": "return${CURSOR} count", "replace": "return total"}]}`, text).length, 1, 'the cursor mark copied in is taken out');
  assert.equal(parseNextEdits('{"edits": [{"find": "count", "replace": "total"}]}', text).length, 0, 'twice in the file');
  assert.equal(parseNextEdits('{"edits": [{"find": "nowhere", "replace": "x"}]}', text).length, 0, 'not in the file');
  assert.equal(parseNextEdits('{"edits": [{"find": "return count", "replace": "return count"}]}', text).length, 0, 'changes nothing');
  assert.equal(parseNextEdits('{"edits": [{"find": 3, "replace": "x"}, null, "x"]}', text).length, 0, 'not edits');
  assert.equal(parseNextEdits('{"edits": [{"find": "print(count)\\n    return", "replace": "a"}, {"find": "return count", "replace": "b"}]}', text).length, 1, 'overlapping: the first kept');
  assert.equal(parseNextEdits('{"edits": []}', text).length, 0);
  assert.equal(parseNextEdits('I would rename the rest.', text).length, 0, 'prose');
  const many = '{"edits": [{"find": "area", "replace": "a"}, {"find": "w * h", "replace": "w*h"}, {"find": "print", "replace": "p"}, {"find": "return", "replace": "r"}]}';
  assert.equal(parseNextEdits(many, text).length, 3, 'three at most');
  assert.deepEqual(placeEdit('a\nb', { find: 'a\r\nb', replace: 'c\r\nd' }), { find: 'a\nb', replace: 'c\nd', why: '', from: 0, to: 3 }, 'the text is LF (CodeMirror): CRLF in an answer is made LF');
});

test('which comes next: the first at or after the cursor, wrapping around', () => {
  const edits = [{ from: 50, to: 60 }, { from: 10, to: 20 }, { from: 30, to: 40 }];
  assert.equal(pickNext(edits, 0).from, 10);
  assert.equal(pickNext(edits, 15).from, 10, 'the one the cursor is in');
  assert.equal(pickNext(edits, 25).from, 30);
  assert.equal(pickNext(edits, 70).from, 10, 'past the last: the first');
  assert.equal(pickNext([], 3), null);
});

test('near or far: within two lines of the cursor it shows in place', () => {
  assert.ok(isNear(5, 5, 5));
  assert.ok(isNear(3, 5, 6));
  assert.ok(isNear(8, 5, 6));
  assert.ok(!isNear(2, 5, 6));
  assert.ok(!isNear(9, 5, 6));
});

test('how it shows: word by word, what goes and what comes; a summary for its mark', () => {
  const e = { find: 'print(count, count)', replace: 'print(total, total)', from: 100, to: 119 };
  assert.deepEqual(diffParts(e), [
    { from: 106, to: 111, insert: 'total' },
    { from: 113, to: 118, insert: 'total' },
  ]);
  assert.equal(editSummary(e), 'count → total …');
  const added = { find: 'add(1, 2)', replace: 'add(1, 2, 3)', from: 0, to: 9 };
  assert.deepEqual(diffParts(added), [{ from: 8, to: 8, insert: ', 3' }]);
  assert.equal(editSummary(added), '+ , 3');
  assert.equal(editSummary({ find: 'a(x, y)', replace: 'a(x)', from: 0, to: 7 }), '− , y');
  assert.equal(endAfter({ find: 'print(count)', replace: 'print(total)', from: 10, to: 22 }), 21, 'the cursor after what changed');
  const long = { find: 'x '.repeat(300), replace: 'y '.repeat(300), from: 0, to: 600 };
  assert.equal(diffParts(long).length, 1, 'long ones as one part');
  assert.ok(editSummary({ find: 'a', replace: 'b'.repeat(80), from: 0, to: 1 }).length <= 40);
});

test('staleness: typing on makes it stale; other changes move it unless they touch it', () => {
  const state = EditorState.create({ doc: SRC });
  const from = SRC.indexOf('return count');
  const edit = { find: 'return count', replace: 'return total', why: '', from, to: from + 12 };
  const typed = state.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
  assert.equal(afterChange(edit, { typed: true, changes: typed.changes }), null);
  const above = state.update({ changes: { from: 0, insert: '# hi\n' } });
  assert.deepEqual(afterChange(edit, { changes: above.changes }), { ...edit, from: from + 5, to: from + 17 });
  const inside = state.update({ changes: { from: from + 2, to: from + 3, insert: 'X' } });
  assert.equal(afterChange(edit, { changes: inside.changes }), null);
  const next = state.update({ changes: { from: from + 12, insert: '!' } });
  assert.equal(afterChange(edit, { changes: next.changes }), null, 'right next to it counts as touching');
});

test('in the editor state: shown, kept through other changes, gone when the person types', () => {
  const ext = nextEdits({ ask: async () => '', enabled: () => false });
  let state = EditorState.create({ doc: SRC, extensions: ext });
  const edits = parseNextEdits('{"edits": [{"find": "return count", "replace": "return total"}]}', SRC);
  state = state.update({ effects: withNextEdits(edits) }).state;
  assert.equal(nextEditsOf(state).length, 1);
  // Far from the cursor (line 1 vs line 4): a mark at its line and a hint at the cursor's.
  const marks = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue;
    set.between(0, state.doc.length, (from, to, d) => void marks.push({ from, to, cls: d.spec.class ?? d.spec.widget?.className }));
  }
  assert.deepEqual(marks.map((m) => m.cls).sort(), ['cm-ne-hint', 'cm-ne-line', 'cm-ne-mark']);
  // The cursor near it: in place.
  state = state.update({ selection: { anchor: SRC.indexOf('print') } }).state;
  const near = [];
  for (const set of state.facet(EditorView.decorations)) {
    if (typeof set === 'function') continue;
    set.between(0, state.doc.length, (from, to, d) => void near.push({ from, to, cls: d.spec.class ?? d.spec.widget?.className, text: d.spec.widget?.text }));
  }
  const del = near.find((m) => m.cls === 'cm-ne-del');
  assert.equal(state.doc.sliceString(del.from, del.to), 'count');
  assert.equal(near.find((m) => m.cls === 'cm-ne-ins').text, 'total');
  // A change elsewhere that is not the person's (a reload): kept, moved.
  state = state.update({ changes: { from: 0, insert: '# hi\n' } }).state;
  assert.equal(state.doc.sliceString(nextEditsOf(state)[0].from, nextEditsOf(state)[0].to), 'return count');
  // The person types: stale.
  state = state.update({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' }).state;
  assert.equal(nextEditsOf(state), null);
});
