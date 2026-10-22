import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanModelName, isUntitled, nameFromHeading, namingMessages, uniqueName } from '../app/js/naming.js';

test('only untitled tabs are named', () => {
  assert.ok(isUntitled('new 1') && isUntitled('new 12'));
  assert.ok(!isUntitled('new notes.md') && !isUntitled('plan.md') && !isUntitled('new'));
});

test('a heading on the first line names the file', () => {
  assert.equal(nameFromHeading('\n# Database override guide\n\nText'), 'Database override guide.md');
  assert.equal(nameFromHeading('## **Plan** for `v2` ##\n'), 'Plan for v2.md');
  assert.equal(nameFromHeading('Some text\n# Heading later'), '');
  assert.equal(nameFromHeading('def f():\n    pass'), '');
  assert.equal(nameFromHeading('#hashtag not a heading'), '');
});

test('the model’s reply becomes a safe, complete file name', () => {
  assert.equal(cleanModelName('Retry decorator.py'), 'Retry decorator.py');
  assert.equal(cleanModelName('"Deploy runbook.md"\n\nThis name fits because…'), 'Deploy runbook.md');
  assert.equal(cleanModelName('File name: `slow queries`', 'sql'), 'slow queries.sql');
  assert.equal(cleanModelName('Plan v2.1', 'md'), 'Plan v2.1.md');
  assert.equal(cleanModelName('notes/2026: plan?.MD'), 'notes 2026 plan.md');
  assert.equal(cleanModelName('Guía de la base de datos'), 'Guía de la base de datos.txt');
  assert.equal(cleanModelName(''), '');
  assert.equal(cleanModelName('new 3'), '');
});

test('names do not clash with other files', () => {
  assert.equal(uniqueName('Plan.md', ['notes.md']), 'Plan.md');
  assert.equal(uniqueName('Plan.md', ['plan.md', 'Plan (2).md']), 'Plan (3).md');
});

test('the prompt carries the text and the detected language', () => {
  const [system, user] = namingMessages('select * from t'.repeat(400), 'sql');
  assert.match(system.content, /only a file name/);
  assert.ok(user.content.startsWith('The editor detected: .sql') && user.content.length < 3100);
});
