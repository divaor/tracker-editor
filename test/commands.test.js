import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COMMAND_GROUPS, COMMAND_LIST, findCommands, groupsOf, keysFor } from '../app/js/commands.js';

test('every command in Help runs something the app has', async () => {
  const app = await readFile(new URL('../app/js/app.js', import.meta.url), 'utf8');
  const editor = await readFile(new URL('../app/js/editor.js', import.meta.url), 'utf8');
  const handled = new Set([...app.matchAll(/^\s{6}(?:'([\w-]+)'|(\w+)): (?:async )?\(/gm)].map((m) => m[1] ?? m[2]));
  const editing = new Set([...editor.slice(editor.indexOf('export const COMMANDS = {'), editor.indexOf('};', editor.indexOf('export const COMMANDS = {'))).matchAll(/^\s{2}(\w+)[:,]/gm)].map((m) => m[1]));
  for (const c of COMMAND_LIST.filter((x) => x.run !== false)) assert.ok(handled.has(c.id) || editing.has(c.id), `${c.id} is not handled`);
  assert.equal(new Set(COMMAND_LIST.map((c) => c.id)).size, COMMAND_LIST.length, 'ids are unique');
  assert.ok(COMMAND_LIST.every((c) => COMMAND_GROUPS.includes(c.group)));
});

test('keys as this computer shows them', () => {
  const find = COMMAND_LIST.find((c) => c.id === 'replace');
  assert.equal(keysFor(find), 'Ctrl+H');
  assert.equal(keysFor(find, { mac: true }), 'Cmd+Option+F');
  const close = COMMAND_LIST.find((c) => c.id === 'close-tab');
  assert.equal(keysFor(close), 'Alt+W');
  assert.equal(keysFor(close, { desktop: true }), 'Ctrl+W');
  assert.equal(keysFor(COMMAND_LIST.find((c) => c.id === 'format'), { mac: true }), 'Shift+Option+F');
});

test('finding commands by words or keys; desktop ones only there', () => {
  assert.deepEqual(findCommands('sort lines').map((c) => c.id), ['sortLines']);
  assert.ok(findCommands('ctrl+k').some((c) => c.id === 'ask-selection'));
  assert.ok(!findCommands('folders').some((c) => c.id === 'folders'));
  assert.ok(findCommands('folders', { desktop: true }).some((c) => c.id === 'folders'));
  assert.ok(findCommands('format').some((c) => c.id === 'format'));
});

test('while searching, label matches come first, and their group with them', () => {
  // "tab" is in many groups' words; the tab commands come first.
  const found = findCommands('close tab', { desktop: true });
  assert.equal(found[0].id, 'close-tab');
  assert.equal(groupsOf(found, true)[0], 'Files and tabs');
  assert.equal(findCommands('format')[0].id, 'format');
  assert.deepEqual(groupsOf(findCommands('', { desktop: true }), false), COMMAND_GROUPS);
});
