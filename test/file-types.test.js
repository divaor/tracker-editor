// The type of a file for its icon in the lists: special names, extensions, then the language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileTypeOf, GLYPHS } from '../app/js/fileTypes.js';

const id = (name, language) => fileTypeOf(name, language).id;

test('by extension, any case, with dots in the name', () => {
  assert.equal(id('app.js'), 'js');
  assert.equal(id('Types.d.ts'), 'ts');
  assert.equal(id('REPORT.PDF'), 'pdf');
  assert.equal(id('docker-compose.yml'), 'docker');
  assert.equal(id('ci.yml'), 'yaml');
  assert.equal(id('runner-64127b1430ec.tar.gz'), 'archive');
  assert.equal(id('Tracker.Editor-0.16.1-portable.exe'), 'binary');
  assert.equal(id('phase6_image_probe.py'), 'py');
  assert.equal(id('manifest.json'), 'json');
  assert.equal(id('C:\\work\\query.SQL'), 'sql');
  assert.equal(id('/srv/site/index.html'), 'html');
});

test('special names say more than their extension', () => {
  assert.equal(id('Dockerfile'), 'docker');
  assert.equal(id('Dockerfile.prod'), 'docker');
  assert.equal(id('.gitignore'), 'git');
  assert.equal(id('package.json'), 'npm');
  assert.equal(id('package-lock.json'), 'lock');
  assert.equal(id('.env'), 'env');
  assert.equal(id('.env.local'), 'env');
  assert.equal(id('prod.env'), 'env');
  assert.equal(id('Makefile'), 'make');
  assert.equal(id('id_ed25519'), 'key');
  assert.equal(id('README'), 'txt');
});

test('without an extension: the language (a pasted note), else text', () => {
  assert.equal(id('new 1', 'JSON'), 'json');
  assert.equal(id('Deploy runbook', 'Markdown'), 'md');
  assert.equal(id('new 2', 'PostgreSQL'), 'sql');
  assert.equal(id('new 3', ''), 'txt');
  assert.equal(id('new 4'), 'txt');
  // An extension it does not know: a plain file (the language does not overrule a real extension).
  assert.equal(id('data.xyz', 'JSON'), 'file');
  assert.equal(id('.bashrc'), 'file');
});

test('each type has a label, a palette color and a glyph or 1–3 letters', () => {
  const colors = new Set(['yellow', 'orange', 'red', 'pink', 'purple', 'indigo', 'navy', 'blue', 'cyan', 'teal', 'green', 'brown', 'gray']);
  for (const name of ['a.js', 'a.ts', 'a.pdf', 'a.cpp', 'a.php', 'a.ttf', 'a.diff', 'a.json', 'a.png', 'a.zip', 'a.qq', 'a.cs', 'a.java']) {
    const t = fileTypeOf(name);
    assert.ok(t.label && colors.has(t.color), name);
    assert.ok(t.glyph ? GLYPHS.includes(t.glyph) : t.letters.length >= 1 && t.letters.length <= 3, name);
  }
  assert.equal(fileTypeOf('a.java').glyph, 'cup');
  assert.equal(fileTypeOf('a.cs').letters, 'C#');
});
