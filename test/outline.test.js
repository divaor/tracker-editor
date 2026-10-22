import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backlinks, currentEntry, linkName, outline, parseLinks, resolveLink } from '../app/js/outline.js';

test('Markdown headings, not those in code blocks', () => {
  const md = '# Plan\n\ntext\n## Steps ##\n```\n# not a heading\n```\n### **Done**\n#nospace';
  assert.deepEqual(outline(md, 'Markdown'), [
    { line: 1, level: 1, title: 'Plan' },
    { line: 4, level: 2, title: 'Steps' },
    { line: 8, level: 3, title: 'Done' },
  ]);
  assert.deepEqual(outline('plain text\nno headings', ''), []);
});

test('symbols of code', () => {
  const js = 'export class Store {\n  async load() {}\n}\nexport async function sync(a) {}\nconst run = async (x) => x;\nconst n = 5;\ninterface Opts {}';
  assert.deepEqual(outline(js, 'TypeScript').map((e) => e.title), ['Store', 'sync', 'run', 'Opts']);
  const py = 'class Job:\n    def run(self):\n        pass\ndef main():\n    pass';
  assert.deepEqual(outline(py, 'Python'), [
    { line: 1, level: 1, title: 'Job' },
    { line: 2, level: 2, title: 'run' },
    { line: 4, level: 1, title: 'main' },
  ]);
  const sql = 'CREATE TABLE dbo.Orders (id int);\ncreate or replace view v_orders as select 1;\nALTER PROCEDURE [dbo].[usp_Load] AS';
  assert.deepEqual(outline(sql, 'SQL').map((e) => e.title), ['TABLE dbo.Orders', 'VIEW v_orders', 'PROCEDURE [dbo].[usp_Load]']);
  assert.deepEqual(outline('[server]\nport=1\n[db]', 'Properties').map((e) => e.title), ['server', 'db']);
  assert.deepEqual(outline('{"a": 1}', 'JSON'), []);
});

test('[[links]], what they point to, and what links back', () => {
  const text = 'See [[Deploy runbook]] and [[notes.txt|the notes]], not [[ ]] or [[a\nb]].';
  assert.deepEqual(parseLinks(text).map(({ target, alias }) => [target, alias]), [['Deploy runbook', ''], ['notes.txt', 'the notes']]);
  const files = [{ id: '1', name: 'Deploy runbook.md' }, { id: '2', name: 'notes.txt' }, { id: '3', name: 'Plan.md' }];
  assert.equal(resolveLink('deploy RUNBOOK', files).id, '1');
  assert.equal(resolveLink('Deploy runbook.md', files).id, '1');
  assert.equal(resolveLink('notes', files), null);
  assert.equal(linkName('Plan.md'), 'Plan');
  assert.equal(linkName('a.sql'), 'a.sql');
  const texts = { 2: 'intro\nfollow [[deploy runbook]] here\n', 3: 'no links', 1: 'self [[Deploy runbook]]' };
  assert.deepEqual(backlinks(files[0], files, (f) => texts[f.id]), [{ file: files[1], line: 2, context: 'follow [[deploy runbook]] here' }]);
});

test('the section the cursor is in', () => {
  const entries = [{ line: 1 }, { line: 10 }, { line: 20 }];
  assert.equal(currentEntry(entries, 15), 1);
  assert.equal(currentEntry(entries, 20), 2);
  assert.equal(currentEntry([{ line: 5 }], 2), -1);
});
