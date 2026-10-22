import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter, hiddenRuns, isBigText } from '../app/js/logtools.js';

const LOG = ['10:00 INFO start', '10:01 ERROR disk full', '10:02 INFO retry', '10:03 info done', '10:04 ERROR again', '10:05 DEBUG x'];
const at = (n) => LOG[n - 1];

test('show only matching lines, or hide them', () => {
  const error = compileFilter({ pattern: 'error' });
  assert.deepEqual(hiddenRuns(LOG.length, at, error, 'show'), { runs: [[1, 1], [3, 4], [6, 6]], shown: 2 });
  assert.deepEqual(hiddenRuns(LOG.length, at, error, 'hide'), { runs: [[2, 2], [5, 5]], shown: 4 });
  const caseInfo = compileFilter({ pattern: 'INFO', caseSensitive: true });
  assert.equal(hiddenRuns(LOG.length, at, caseInfo, 'show').shown, 2);
  assert.deepEqual(hiddenRuns(LOG.length, at, compileFilter({ pattern: 'nothing' }), 'show'), { runs: [[1, 6]], shown: 0 });
});

test('plain text is literal, regexes are checked', () => {
  assert.ok(compileFilter({ pattern: 'a.b' }).test('xa.by'));
  assert.ok(!compileFilter({ pattern: 'a.b' }).test('axb'));
  assert.ok(compileFilter({ pattern: '^10:0[14]', regex: true }).test('10:04 ERROR'));
  assert.throws(() => compileFilter({ pattern: '(', regex: true }), /Not a valid pattern/);
});

test('large files', () => {
  assert.equal(isBigText('small\ntext'), false);
  assert.equal(isBigText('x\n'.repeat(70000)), true);
  assert.equal(isBigText('x'.repeat(3_000_001)), true);
});
