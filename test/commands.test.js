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

test('local mode (no GitHub): nothing about syncing in Help', () => {
  assert.equal(findCommands('save a file', { local: true }).find((c) => c.id === 'sync')?.label, 'Save a file from disk or a server');
  assert.ok(!findCommands('', { local: true }).some((c) => /sync/i.test(c.label)), 'no word about syncing');
});

// The Android app has some of the desktop's commands (0.48.1): Folders, servers, terminals, folder
// comparisons and Git on SSH servers. Help, the palette and the model's help list those there,
// and not what it lacks (Docker, debugging, running files, language servers).
test('the Android app lists the desktop commands it has, and only those', async () => {
  const { commandLines, helpContext } = await import('../app/js/editorHelp.js');
  for (const c of COMMAND_LIST.filter((x) => x.android)) assert.equal(c.only, 'desktop', `${c.id}: android marks a desktop-only command`);
  const ids = (opts) => findCommands('', opts).map((c) => c.id);
  const phone = ids({ android: true });
  for (const id of ['git-panel', 'git-blame-file', 'git-branch', 'git-push', 'folders', 'server-add', 'terminal', 'tasks', 'compare-folders', 'two-panes', 'project-settings']) assert.ok(phone.includes(id), id);
  for (const id of ['dockerize', 'docker-open', 'wsl-open', 'run-file', 'debug-file', 'quick-fix', 'language-servers', 'preview-scripts', 'type-out', 'screenshot-ocr']) assert.ok(!phone.includes(id), id);
  const browser = ids({});
  assert.ok(!browser.includes('git-panel') && !browser.includes('folders'), 'not in a browser');
  assert.ok(ids({ desktop: true }).includes('dockerize'));
  assert.match(commandLines('git panel commit', { android: true }), /Git panel.*\[desktop and Android apps\]/);
  assert.doesNotMatch(commandLines('dockerize docker image', { android: true }), /Dockerize/);
  assert.equal(helpContext('x', '', { android: true }).android, true);
});
