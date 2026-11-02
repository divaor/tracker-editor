// 0.45: the text's right-click menu by the kind of file, and where Ctrl+click goes to a definition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeMenuItems, definesNames, EDIT_KEYS, fileKind } from '../app/js/codeMenu.js';

const ids = (items) => items.map((i) => (i.separator ? '|' : i.id)).join(' ');

test('the kind of a file: programs, data, prose; Ctrl+click goes to definitions in programs only', () => {
  for (const l of ['JavaScript', 'TypeScript', 'Python', 'PHP', 'C#', 'Java', 'Go', 'Rust', 'C++', 'Shell', 'HTML', 'CSS']) assert.equal(fileKind(l), 'code', l);
  for (const l of ['JSON', 'YAML', 'TOML', 'XML']) assert.equal(fileKind(l), 'data', l);
  for (const l of ['', 'Plain text', 'Markdown', 'CSV']) assert.equal(fileKind(l), 'prose', l);
  assert.equal(definesNames('Python'), true);
  assert.equal(definesNames('Markdown'), false);
  assert.equal(definesNames('JSON'), false);
});

test('a program: what IDEs offer, in their order, only what applies', () => {
  const full = codeMenuItems({ language: 'Python', onName: true, server: { attached: true, organizeImports: true }, runs: true, debugs: true, tests: true, files: true });
  assert.equal(ids(full), 'definition references rename symbol | quick-fix organize format | cut copy paste select-all | comment breakpoint | run-file debug-file test-at-cursor debug-test | ask files');
  assert.ok(full.every((i) => i.separator || (i.label && i.command)));
  // No server, nothing to run, no model that changes files: those go, the rest stays.
  const plain = codeMenuItems({ language: 'JavaScript', onName: true });
  assert.equal(ids(plain), 'definition references rename symbol | format | cut copy paste select-all | comment | ask');
  // Not on a name: the name's items are there, but off.
  const space = codeMenuItems({ language: 'JavaScript' });
  assert.deepEqual(space.filter((i) => i.disabled).map((i) => i.id), ['definition', 'references', 'rename']);
  // A selection: Format selection, Ask about the selection.
  const sel = codeMenuItems({ language: 'Go', onName: true, hasSelection: true });
  assert.equal(sel.find((i) => i.id === 'format').label, 'Format selection');
  assert.equal(sel.find((i) => i.id === 'ask').label, 'Ask the model about the selection…');
  // Read-only: nothing that changes the text.
  const ro = codeMenuItems({ language: 'Python', onName: true, readOnly: true, server: { attached: true, organizeImports: true }, debugs: true });
  assert.equal(ids(ro), 'definition references symbol | copy select-all | breakpoint | debug-file | ask');
});

test('data and prose: shorter menus', () => {
  assert.equal(ids(codeMenuItems({ language: 'YAML', onName: true })), 'format | cut copy paste select-all | comment | ask');
  assert.equal(ids(codeMenuItems({ language: 'JSON' })), 'format | cut copy paste select-all | ask', 'JSON has no comments');
  assert.equal(ids(codeMenuItems({ language: 'Markdown', onName: true, runs: true })), 'cut copy paste select-all | find | ask');
  assert.equal(ids(codeMenuItems({ language: 'Plain text', model: false })), 'cut copy paste select-all | find');
  assert.deepEqual(Object.keys(EDIT_KEYS), ['cut', 'copy', 'paste', 'select-all']);
});
