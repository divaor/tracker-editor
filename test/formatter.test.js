import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJson, formatText, formatXml, formatterFor, guessFormatter } from '../app/js/formatter.js';

test('one-line JSON comes out one value per line, its numbers and strings as written', () => {
  const text = '{"id":12345678901234567890,"name":"Ana, \\"Jr\\"","tags":["a","b"],"empty":{},"none":[],"nested":{"ok":true,"n":null,"x":-1.5e3}}';
  assert.equal(
    formatJson(text),
    ['{', '  "id": 12345678901234567890,', '  "name": "Ana, \\"Jr\\"",', '  "tags": [', '    "a",', '    "b"', '  ],', '  "empty": {},', '  "none": [],', '  "nested": {', '    "ok": true,', '    "n": null,', '    "x": -1.5e3', '  }', '}', ''].join('\n'),
  );
  assert.equal(formatJson('[1,[2,3]]', '\t'), '[\n\t1,\n\t[\n\t\t2,\n\t\t3\n\t]\n]\n');
  assert.equal(formatJson('  42  '), '42\n');
});

test('JSON with comments keeps them', () => {
  const out = formatJson('{// first\n"a":1,/* why */"b":2}');
  assert.equal(out, '{\n  // first\n  "a": 1,\n  /* why */ "b": 2\n}\n');
});

test('broken JSON says where', () => {
  assert.throws(() => formatJson('{"a":1 "b":2}'), /comma is missing.*line 1, column 8/);
  assert.throws(() => formatJson('{"a":[1,2}'), /Unexpected \}/);
  assert.throws(() => formatJson('{"a":1'), /\} is missing at the end/);
  assert.throws(() => formatJson('{"a":"x\ny"}'), /string is not closed.*line 1/);
});

test('XML one element per line, text kept with its element', () => {
  const xml = '<?xml version="1.0"?><root a="1"><item id="x>y">Hello <!-- c --></item><empty/><p>text</p><q></q><![CDATA[<raw>]]></root>';
  assert.equal(
    formatXml(xml),
    ['<?xml version="1.0"?>', '<root a="1">', '  <item id="x>y">', '    Hello', '    <!-- c -->', '  </item>', '  <empty/>', '  <p>text</p>', '  <q></q>', '  <![CDATA[<raw>]]>', '</root>', ''].join('\n'),
  );
  assert.throws(() => formatXml('<a><b></a>'), /does not close <b>/);
  assert.throws(() => formatXml('<a>'), /<a> is not closed/);
});

test('which formatter: by the language picked, then the name', () => {
  assert.equal(formatterFor('data.json').kind, 'json');
  assert.equal(formatterFor('app.config').kind, 'xml');
  assert.equal(formatterFor('q.sql').dialect, 'sql');
  assert.equal(formatterFor('q.txt', 'PostgreSQL').dialect, 'postgresql');
  assert.equal(formatterFor('Main.TSX').kind, 'typescript');
  assert.equal(formatterFor('notes.md').label, 'Markdown');
  assert.equal(formatterFor('script.py'), null);
  assert.equal(formatterFor('new 1', ''), null);
  assert.equal(guessFormatter('  {"a":1}').kind, 'json');
  assert.equal(guessFormatter('<?xml version="1.0"?><a/>').kind, 'xml');
  assert.equal(guessFormatter('<!DOCTYPE html><html></html>'), null);
  assert.equal(guessFormatter('plain words'), null);
});

test('code through Prettier and SQL through sql-formatter (loaded when needed)', async () => {
  assert.equal(await formatText('const a={b:1,c:[1,2]};function f(x){return x*2}', formatterFor('a.js')), 'const a = { b: 1, c: [1, 2] };\nfunction f(x) {\n  return x * 2;\n}\n');
  assert.equal(await formatText('let n:number=1', formatterFor('a.ts'), { tabSize: 4 }), 'let n: number = 1;\n');
  assert.equal(await formatText('a{color:red;margin:0}', formatterFor('a.css')), 'a {\n  color: red;\n  margin: 0;\n}\n');
  assert.equal(await formatText('a:   1\nb:\n    - x', formatterFor('a.yaml')), 'a: 1\nb:\n  - x\n');
  assert.equal(await formatText('select a, b from t where x = 1 and y = 2', formatterFor('q.sql')), 'select\n  a,\n  b\nfrom\n  t\nwhere\n  x = 1\n  and y = 2\n');
  await assert.rejects(formatText('function (', formatterFor('a.js')), /line 1/);
});
