import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillSnippet, snippetFields, snippetNameFrom, usesBuiltin } from '../app/js/snippets.js';

test('fields are found once each, with their defaults, built-ins left out', () => {
  const text = 'ssh {{user:admin}}@{{server}} # {{date}}\nscp file {{user}}@{{ server }}:/tmp/{{cursor}}\n{{Note: none}}';
  assert.deepEqual(snippetFields(text), [{ name: 'user', default: 'admin' }, { name: 'server', default: '' }, { name: 'Note', default: 'none' }]);
  assert.deepEqual(snippetFields('no fields {{}} here {not}'), []);
  assert.deepEqual(snippetFields('{{país}} {{a:x}} {{A}}'), [{ name: 'país', default: '' }, { name: 'a', default: 'x' }]);
  assert.ok(usesBuiltin('x {{Clipboard}}', 'clipboard'));
  assert.ok(!usesBuiltin('x {{selection}}', 'clipboard'));
});

test('filling uses values, then defaults, and the built-ins', () => {
  const now = new Date(2026, 9, 22, 9, 5);
  const { text, cursor } = fillSnippet('SELECT * FROM {{table}} WHERE id = {{id:1}}; -- {{date}} {{time}}\n{{cursor}}-- {{clipboard}} / {{selection}}', { table: 'orders', ID: '' }, { now, clipboard: 'clip', selection: 'sel' });
  assert.equal(text, 'SELECT * FROM orders WHERE id = 1; -- 2026-10-22 09:05\n-- clip / sel');
  assert.equal(cursor, text.indexOf('-- clip'));
  assert.equal(fillSnippet('a {{x}} b', { X: 'y' }).text, 'a y b');
  assert.deepEqual(fillSnippet('plain'), { text: 'plain', cursor: 5 });
  assert.equal(fillSnippet('{{datetime}}', {}, { now }).text, '2026-10-22 09:05');
});

test('a name from the selection', () => {
  assert.equal(snippetNameFrom('  restart the   app pool on IIS\nthen check'), 'restart the app pool on IIS then check.txt');
  assert.equal(snippetNameFrom('a/b:c'), 'a b c.txt');
  assert.equal(snippetNameFrom(''), 'snippet.txt');
  assert.equal(snippetNameFrom('ssh {{user:admin}}@{{server}}'), 'ssh user@server.txt');
});
