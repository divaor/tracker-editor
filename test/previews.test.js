import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonProblem, parseDelimited, previewKind } from '../app/js/previews.js';

test('knows which files have a reading view', () => {
  assert.equal(previewKind('notes.md', 'Markdown'), 'markdown');
  assert.equal(previewKind('report.html', 'HTML'), 'html');
  assert.equal(previewKind('data.json', 'JSON'), 'json');
  assert.equal(previewKind('feed.xml', 'XML'), 'xml');
  assert.equal(previewKind('logo.svg', 'XML'), 'svg');
  assert.equal(previewKind('people.csv', 'Plain text'), 'csv');
  assert.equal(previewKind('people.tsv', ''), 'tsv');
  assert.equal(previewKind('new 3', 'JSON'), 'json', 'pasted text with a detected language');
  assert.equal(previewKind('script.py', 'Python'), '');
  assert.equal(previewKind('notes.txt', 'Plain text'), '');
});

test('reads CSV with quotes, commas and line breaks inside fields', () => {
  assert.deepEqual(parseDelimited('name,notes\nAna,"likes ""tea"", coffee"\nBo,"two\nlines"\r\nCy,\n'), [
    ['name', 'notes'],
    ['Ana', 'likes "tea", coffee'],
    ['Bo', 'two\nlines'],
    ['Cy', ''],
  ]);
  assert.deepEqual(parseDelimited('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
});

test('finds where invalid JSON breaks, in plain words', () => {
  assert.deepEqual(jsonProblem('{\n  "a": 1,\n  "b": ,\n}'), { message: 'Unexpected ","', line: 3, column: 8 });
  assert.deepEqual(jsonProblem('{"a": 1,}'), { message: 'Extra comma before "}"', line: 1, column: 9 });
  assert.deepEqual(jsonProblem('[1, 2,]'), { message: 'Extra comma before "]"', line: 1, column: 7 });
  assert.deepEqual(jsonProblem('{a: 1}'), { message: 'Expected a key in "quotes"', line: 1, column: 2 });
  assert.deepEqual(jsonProblem('{"a": [1, 2}'), { message: 'Expected "," or "]"', line: 1, column: 12 });
  assert.deepEqual(jsonProblem('{"a": "x'), { message: 'A string is not closed', line: 1, column: 9 });
  assert.deepEqual(jsonProblem('{"a": 1'), { message: '"}" is missing at the end', line: 1, column: 8 });
  assert.deepEqual(jsonProblem('{} x'), { message: 'Unexpected text after the end', line: 1, column: 4 });
  for (const ok of ['{"a": [1, -2.5e3, true, false, null, "q\\"x"], "b": {}}', '  []  ', '"just a string"', '0']) {
    assert.equal(jsonProblem(ok), null, ok);
    assert.doesNotThrow(() => JSON.parse(ok));
  }
});
