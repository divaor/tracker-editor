import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { appendToInbox, findInbox, stamp } from '../app/js/capture.js';

const require = createRequire(import.meta.url);
const { addClip, removeClip, pinClip, clearClips, isConcealed, MAX_TEXT } = require('../electron/clipHistory.cjs');

test('captures go under their time at the end of the Inbox', () => {
  const at = new Date(2026, 9, 22, 9, 5);
  assert.equal(stamp(at), '2026-10-22 09:05');
  assert.equal(appendToInbox('', '  Call Ana  \n', at), '# Inbox\n\n## 2026-10-22 09:05\n\nCall Ana\n');
  const once = appendToInbox('# Inbox\n\nolder\n\n\n', 'Buy milk', at);
  assert.equal(once, '# Inbox\n\nolder\n\n## 2026-10-22 09:05\n\nBuy milk\n');
  assert.equal(findInbox([{ name: 'notes.md' }, { name: 'inbox.MD' }]).name, 'inbox.MD');
  assert.equal(findInbox([{ name: 'Inbox.txt' }]), null);
});

test('clipboard history: newest first, once each, capped except pinned', () => {
  let list = [];
  let n = 0;
  const add = (text, max = 3) => (list = addClip(list, text, { max, now: ++n, id: `id${n}` }));
  add('a');
  add('b');
  add('   ');
  assert.deepEqual(list.map((e) => e.text), ['b', 'a']);
  add('a');
  assert.deepEqual(list.map((e) => e.text), ['a', 'b'], 'copying again moves it up');
  assert.equal(list[0].id, 'id1', 'and keeps its id');
  const same = list;
  add('a');
  assert.equal(list, same, 'the newest again changes nothing');
  list = pinClip(list, 'id2', true);
  add('c');
  add('d');
  add('e');
  assert.deepEqual(list.map((e) => e.text), ['e', 'd', 'c', 'b'], 'the oldest goes; the pinned one stays');
  list = clearClips(list);
  assert.deepEqual(list.map((e) => e.text), ['b']);
  list = removeClip(list, 'id2');
  assert.deepEqual(list, []);
  assert.deepEqual(addClip([], 'x'.repeat(MAX_TEXT + 1)), [], 'very long copies are skipped');
});

test('copies a password manager marks as concealed are recognized', () => {
  const raw = (name) => `electron application/osclipboard;format="${name}"`;
  assert.equal(isConcealed(['text/plain', raw('UTF8_STRING')]), false);
  assert.equal(isConcealed(['text/plain', raw('x-kde-passwordManagerHint')]), true);
  assert.equal(isConcealed(['text/plain', raw('org.nspasteboard.ConcealedType')]), true);
  assert.equal(isConcealed([raw('ExcludeClipboardContentFromMonitorProcessing')]), true);
  assert.equal(isConcealed(['x-kde-passwordManagerHint']), true);
});
