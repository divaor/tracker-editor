// 0.13: transfers to and from servers in the background, as the Transfers card words them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTransfer } from '../app/js/transfers.js';

const job = (patch = {}) => ({ id: 't1', op: 'copy-in', kind: 'upload', dir: '/srv/www', names: ['big.iso'], state: 'running', files: 1, filesDone: 0, total: 4 * 1024 * 1024, sent: 1024 * 1024, current: 'big.iso', startedAt: 0, endedAt: 0, result: null, error: '', ...patch });
const where = (dir) => dir.split('/').pop();

test('a running transfer: what, where to, percent, bytes, speed and which file', () => {
  const d = describeTransfer(job(), { where, now: 2000 });
  assert.equal(d.title, 'Uploading big.iso to www');
  assert.equal(d.percent, 25);
  assert.match(d.detail, /^25% · 1(\.0)? MB of 4(\.0)? MB · 512 KB\/s$/);
  const many = describeTransfer(job({ names: ['a', 'b', 'c'], files: 7, filesDone: 2, kind: 'download', op: 'copy' }), { where, now: 2000 });
  assert.equal(many.title, 'Downloading 3 items to www');
  assert.match(many.detail, /file 3 of 7$/);
  // Moves say so; while the files are counted there is no percent yet.
  const counting = describeTransfer(job({ op: 'move', files: 0, total: 0, sent: 0 }), { where, now: 10 });
  assert.equal(counting.title, 'Moving big.iso to www');
  assert.equal(counting.detail, 'Counting the files…');
  assert.equal(counting.percent, 0);
  // Empty files only: done when they are all there.
  assert.equal(describeTransfer(job({ total: 0, sent: 0, files: 2, filesDone: 2 }), { where }).percent, 100);
  assert.match(describeTransfer(job({ total: 5 * 1024 ** 3, sent: 1024 ** 3 }), { where, now: 1000 }).detail, /^20% · 1.00 GB of 5.00 GB · 1.00 GB\/s$/);
});

test('a finished transfer: done, stopped (what got there) or failed (why)', () => {
  const done = describeTransfer(job({ state: 'done', sent: 4 * 1024 * 1024, result: [{ from: '/a/big.iso', to: '/srv/www/big.iso' }] }), { where });
  assert.equal(done.title, 'Uploaded big.iso to www');
  assert.equal(done.percent, 100);
  assert.equal(describeTransfer(job({ state: 'done', op: 'move' }), { where }).title, 'Moved big.iso to www');
  const stopped = describeTransfer(job({ state: 'stopped', names: ['a', 'b'], result: [{ from: '/a', to: '/srv/www/a' }] }), { where });
  assert.equal(stopped.title, 'Stopped: 2 items to www');
  assert.match(stopped.detail, /^1 of 2 got there/);
  assert.equal(describeTransfer(job({ state: 'stopped', result: [] }), { where }).detail, 'Nothing got there.');
  const failed = describeTransfer(job({ state: 'failed', error: 'No space left on the server.', kind: 'download' }), { where });
  assert.equal(failed.title, 'Not downloaded: big.iso to www');
  assert.equal(failed.detail, 'No space left on the server.');
});
