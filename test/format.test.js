import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, shortDate } from '../app/js/format.js';

test('shortDate: the time today, the day this year, else with the year', () => {
  const now = new Date(2026, 9, 29, 17, 30).getTime();
  const today = shortDate(new Date(2026, 9, 29, 9, 5).getTime(), now);
  assert.match(today, /9.05|09.05/);
  assert.doesNotMatch(today, /2026/);
  const thisYear = shortDate(new Date(2026, 2, 3, 12, 0).getTime(), now);
  assert.match(thisYear, /3/);
  assert.doesNotMatch(thisYear, /2026|12.00/);
  assert.match(shortDate(new Date(2024, 2, 3).getTime(), now), /2024/);
  assert.equal(shortDate(0, now), '');
  assert.equal(shortDate(undefined, now), '');
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536 * 1024), '1.5 MB');
});
