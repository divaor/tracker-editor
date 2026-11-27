// 0.54: mirrors by hand. What an upload or a download would do to each file, from both sides and
// the mirror's state (mirrorCheck.js, pure): safe, at risk, the same, left alone; the words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPROX_SLACK, checkSentence, classify, countStates, leftText, needsBytes, needsDialog, noteKey, noteOf, stateWords, tickedAtFirst, transferable, transferredText, atRisk } from '../app/js/mirrorCheck.js';

const f = (size, mtimeMs) => ({ size, mtimeMs });
const T = 1_700_000_000_000;

test('with the state of the last time in step: ahead, behind, both, same', () => {
  const state = { l: f(10, T), r: f(10, T + 500) };
  // Nothing changed on either side.
  assert.equal(classify({ here: f(10, T), there: f(10, T + 500), state, direction: 'upload' }), 'same');
  // Changed here only: an upload is safe, a download would lose it.
  assert.equal(classify({ here: f(12, T + 9000), there: f(10, T + 500), state, direction: 'upload' }), 'ahead');
  assert.equal(classify({ here: f(12, T + 9000), there: f(10, T + 500), state, direction: 'download' }), 'behind');
  // Changed on the server only.
  assert.equal(classify({ here: f(10, T), there: f(11, T + 9000), state, direction: 'upload' }), 'behind');
  assert.equal(classify({ here: f(10, T), there: f(11, T + 9000), state, direction: 'download' }), 'ahead');
  // Both: at risk either way, unless the bytes say they are the same.
  assert.equal(classify({ here: f(12, T + 9000), there: f(11, T + 9000), state, direction: 'upload' }), 'both');
  assert.equal(classify({ here: f(12, T + 9000), there: f(12, T + 8000), state, direction: 'download', same: true }), 'same');
  // Within a second of the state is unchanged (as mirror.cjs's syncs see it).
  assert.equal(classify({ here: f(10, T + 999), there: f(10, T + 500), state, direction: 'upload' }), 'same');
});

test('without a state: newer and older by time (2 s, a minute for an FTP listing), the bytes for the rest', () => {
  assert.equal(classify({ here: f(5, T + 5000), there: f(6, T), direction: 'upload' }), 'newer');
  assert.equal(classify({ here: f(5, T + 5000), there: f(6, T), direction: 'download' }), 'older');
  assert.equal(classify({ here: f(5, T + 1500), there: f(6, T), direction: 'upload' }), 'differ', 'within the slack: no way to tell');
  assert.equal(classify({ here: f(5, T + 30000), there: f(6, T), direction: 'upload', approx: true }), 'differ', 'a listing to the minute');
  assert.equal(classify({ here: f(5, T + APPROX_SLACK + 1000), there: f(6, T), direction: 'upload', approx: true }), 'newer');
  // The same size: the bytes tell.
  assert.equal(classify({ here: f(5, T + 50000), there: f(5, T), direction: 'upload', same: true }), 'same');
  assert.equal(classify({ here: f(5, T + 1000), there: f(5, T), direction: 'upload', same: false }), 'differ');
  assert.equal(classify({ here: f(5, T + 1000), there: f(5, T), direction: 'upload' }), 'same', 'not compared (too big): same size and time');
  // A time not known (0) says nothing.
  assert.equal(classify({ here: f(5, T), there: f(7, 0), direction: 'upload' }), 'differ');
  // A half state (a copy kept for a conflict) counts as none.
  assert.equal(classify({ here: f(5, T + 5000), there: f(6, T), state: { l: f(5, T) }, direction: 'upload' }), 'newer');
});

test('one side only: new on the source, left alone on the destination', () => {
  assert.equal(classify({ here: f(1, T), there: null, direction: 'upload' }), 'new');
  assert.equal(classify({ here: f(1, T), there: null, direction: 'download' }), 'onlyThere');
  assert.equal(classify({ here: null, there: f(1, T), direction: 'download' }), 'new');
  assert.equal(classify({ here: null, there: null, direction: 'upload' }), null);
  assert.ok(!transferable('onlyThere') && !transferable('same') && transferable('new') && transferable('both'));
});

test('the bytes are compared only when the sizes match and the state cannot tell', () => {
  assert.equal(needsBytes({ here: f(3, T), there: f(3, T + 9000) }), true);
  assert.equal(needsBytes({ here: f(3, T), there: f(4, T) }), false, 'other sizes differ anyway');
  assert.equal(needsBytes({ here: f(3, T), there: f(3, T), state: { l: f(3, T), r: f(3, T) } }), false, 'unchanged since in step');
  assert.equal(needsBytes({ here: f(3, T + 9000), there: f(3, T), state: { l: f(3, T), r: f(3, T) } }), true, 'touched here: maybe the same');
  assert.equal(needsBytes({ here: f(6 * 1024 * 1024, T), there: f(6 * 1024 * 1024, T) }), false, 'too big');
  assert.equal(needsBytes({ here: null, there: f(3, T) }), false);
});

test('counts, at risk, the dialog only when needed, what is ticked at first', () => {
  const rows = ['ahead', 'ahead', 'new', 'behind', 'same', 'onlyThere', 'older', 'differ', 'both', 'newer'].map((state, i) => ({ rel: `f${i}`, state }));
  const counts = countStates(rows);
  assert.equal(counts.ahead, 2);
  assert.equal(counts.transferable, 8);
  assert.equal(counts.risky, 4);
  assert.deepEqual(['behind', 'both', 'older', 'differ'].map(atRisk), [true, true, true, true]);
  assert.deepEqual(['ahead', 'new', 'newer', 'same'].map(atRisk), [false, false, false, false]);
  assert.equal(needsDialog(rows), true);
  const safe = rows.filter((r) => !atRisk(r.state));
  assert.equal(needsDialog(safe), false, 'nothing at risk: no question');
  assert.equal(needsDialog(safe, 'always'), true, 'unless the setting says always');
  assert.equal(needsDialog(rows.filter((r) => r.state === 'same' || r.state === 'onlyThere'), 'always'), false, 'nothing to copy: never');
  assert.deepEqual(rows.filter(tickedAtFirst).map((r) => r.state), ['ahead', 'ahead', 'new', 'newer']);
});

test('the words: a sentence, what is left alone, each row, the note over a tab', () => {
  const counts = countStates([...Array(8)].map(() => ({ state: 'ahead' })).concat([...Array(3)].map(() => ({ state: 'new' })), [{ state: 'behind' }], [{ state: 'same' }, { state: 'same' }], [{ state: 'onlyThere' }]));
  assert.equal(checkSentence(counts, 'upload', 'web-1'), '12 differ: 8 newer here, 3 only here, 1 newer on web-1');
  assert.equal(checkSentence(counts, 'download', 'web-1'), '12 differ: 1 newer here, 3 only on web-1, 8 newer on web-1');
  assert.equal(leftText(counts, 'upload', 'web-1'), '2 the same (skipped) · 1 only on web-1 (left alone)');
  assert.equal(checkSentence(countStates([{ state: 'same' }]), 'upload'), 'The same on both sides');
  assert.equal(stateWords('behind', 'upload', 'web-1'), 'Changed on web-1 since the last time in step');
  assert.equal(stateWords('older', 'download', 'web-1'), 'Newer here');
  const when = (ms) => (ms === T ? '13:50' : '14:05');
  const size = (n) => `${(n / 1024).toFixed(1)} KB`;
  const note = noteOf({ state: 'behind', here: f(3000, T), there: f(3277, T + 900000) }, { server: 'web-1', when, size });
  assert.deepEqual(note, { tone: 'warn', text: 'web-1’s copy is newer (14:05, 3.2 KB; here 13:50)', offer: ['compare', 'download'] });
  assert.deepEqual(noteOf({ state: 'ahead', here: f(1, T), there: f(1, T) }, { server: 'web-1' }).offer, ['upload', 'compare']);
  assert.equal(noteOf({ state: 'same' }), null);
  assert.equal(noteOf(null), null);
  // Dismissed for those two versions: another version on either side shows it again.
  const a = { state: 'behind', here: f(1, T), there: f(2, T) };
  assert.equal(noteKey(a), noteKey({ ...a }));
  assert.notEqual(noteKey(a), noteKey({ ...a, there: f(2, T + 1) }));
  assert.equal(transferredText(['a', 'b', 'c'], 'upload', 'web-1'), 'Uploaded 3 files to web-1');
  assert.equal(transferredText(['notes.md'], 'download', 'web-1', 'notes.md'), 'Downloaded notes.md from web-1');
});
