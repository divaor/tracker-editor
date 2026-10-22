import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanModelName, filingMessages, isUntitled, nameFromHeading, namingMessages, parseFiling, uniqueName } from '../app/js/naming.js';

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

const PROJECTS = [
  { name: 'Platform', area: 'work' },
  { name: 'Home', area: 'personal' },
];

test('filing asks for a project from the list and tags, and a name only when needed', () => {
  const [system, user] = filingMessages('Notes about the cache', { ext: 'md', projects: PROJECTS, tags: ['sql', 'Reports'] });
  assert.match(system.content, /"name"/);
  assert.match(system.content, /Never invent a project/);
  assert.match(user.content, /- Platform \(work\)\n- Home \(personal\)/);
  assert.match(user.content, /Existing tags: sql, Reports/);
  assert.match(user.content, /detected: \.md/);
  const [plain] = filingMessages('x', { name: false });
  assert.doesNotMatch(plain.content, /"name"/);
  assert.match(filingMessages('x')[1].content, /Projects:\n\(none\)/);
});

test('a filing reply is checked against your projects and tags', () => {
  const opts = { projects: PROJECTS, tags: ['sql', 'Reports'], ext: 'md' };
  assert.deepEqual(parseFiling('{"name": "Cache plan", "project": "platform", "tags": ["SQL", "#reports", "Query Tuning", "extra", "more"]}', opts), {
    name: 'Cache plan.md',
    project: 'Platform',
    tags: ['sql', 'Reports', 'query-tuning'],
  });
  // Wrapped in a code block, with a made-up project and repeated tags.
  assert.deepEqual(parseFiling('```json\n{"project": "Garden", "tags": ["sql", "sql"]}\n```', opts), { name: '', project: '', tags: ['sql'] });
  assert.deepEqual(parseFiling('{"project": "", "tags": "not a list"}', opts), { name: '', project: '', tags: [] });
  assert.equal(parseFiling('Platform, #sql', opts), null);
  assert.equal(parseFiling('{not json}', opts), null);
  // Accents survive in tags.
  assert.deepEqual(parseFiling('{"tags": ["Facturación 2026"]}', opts).tags, ['facturación-2026']);
});
