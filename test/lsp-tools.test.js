// Language servers, the page's pure part (lspTools.js): file URIs, problems, places, edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTextEdits, changedLines, codeActionRows, editPlan, editsByFile, fileUri, locations, offsetOf, pathKey, progressText, rangesTouch, serverLabel, symbolRows, syncWait, textChanges, toProblems, uriPath, withWorkspaceFolder, languageOptions, changedLanguages, formatFirst } from '../app/js/lspTools.js';

test('paths as file URIs, the way servers write them, and back', () => {
  assert.equal(fileUri('/home/me/my app/x.ts'), 'file:///home/me/my%20app/x.ts');
  assert.equal(fileUri('C:\\Users\\Me\\app\\x.ts'), 'file:///c%3A/Users/Me/app/x.ts');
  assert.equal(fileUri('\\\\Server\\share\\x.py'), 'file://server/share/x.py');
  assert.equal(uriPath('file:///home/me/my%20app/x.ts'), '/home/me/my app/x.ts');
  assert.equal(uriPath('file:///c%3A/Users/Me/app/x.ts'), 'C:\\Users\\Me\\app\\x.ts');
  assert.equal(uriPath('file:///C:/Users/Me/x.ts'), 'C:\\Users\\Me\\x.ts');
  assert.equal(uriPath('file://server/share/x.py'), '\\\\server\\share\\x.py');
  assert.equal(uriPath('untitled:Untitled-1'), null);
  for (const p of ['/w/a.ts', 'C:\\w\\ä ö.py']) assert.equal(uriPath(fileUri(p)), p);
  // Windows paths compare without case.
  assert.equal(pathKey('C:\\Users\\Me\\X.ts'), pathKey('c:/users/me/x.ts'));
  assert.notEqual(pathKey('/w/X.ts'), pathKey('/w/x.ts'));
});

test('positions, and a server’s diagnostics as the editor’s problems', () => {
  const text = 'const a = 1;\nlet b: number = "x";\n';
  assert.equal(offsetOf(text, { line: 1, character: 4 }), 17);
  assert.equal(offsetOf(text, { line: 1, character: 99 }), null);
  assert.equal(offsetOf(text, { line: 9, character: 0 }), null);
  const problems = toProblems(
    [
      { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'.", source: 'ts', code: 2322 },
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, severity: 4, message: "'a' is declared but its value is never read." },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 2, message: 'Prefer let', code: { value: 'prefer-let' } },
      { range: { start: { line: 7, character: 0 }, end: { line: 7, character: 1 } }, message: 'About a line that is gone' },
    ],
    text,
  );
  // In order; hints left out; the code after the message; lines that are gone dropped.
  assert.deepEqual(problems, [
    { from: 0, to: 5, severity: 'warning', message: 'Prefer let (prefer-let)', source: '', line: 1, column: 1 },
    { from: 17, to: 18, severity: 'error', message: "Type 'string' is not assignable to type 'number'. (2322)", source: 'ts', line: 2, column: 5 },
  ]);
  assert.equal(toProblems([{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, severity: 4, message: 'x' }], text, { hints: true })[0].severity, 'hint');
});

test('places a server answers with', () => {
  const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } };
  assert.deepEqual(locations({ uri: 'file:///a.ts', range }), [{ uri: 'file:///a.ts', range }]);
  assert.deepEqual(locations([{ uri: 'file:///a.ts', range }, { uri: 'file:///b.ts', range }]).length, 2);
  assert.deepEqual(locations([{ targetUri: 'file:///c.ts', targetRange: range, targetSelectionRange: range }]), [{ uri: 'file:///c.ts', range }]);
  assert.deepEqual(locations(null), []);
});

test('a rename’s edits by file, applied to a text', () => {
  const r = (line, from, to) => ({ start: { line, character: from }, end: { line, character: to } });
  const edit = {
    changes: { 'file:///a.ts': [{ range: r(0, 9, 12), newText: 'sum' }] },
    documentChanges: [{ textDocument: { uri: 'file:///b.ts', version: 3 }, edits: [{ range: r(0, 16, 19), newText: 'sum' }] }, { kind: 'rename', oldUri: 'file:///x', newUri: 'file:///y' }],
  };
  assert.deepEqual(
    editsByFile(edit).map((f) => [f.uri, f.edits.length]),
    [['file:///a.ts', 1], ['file:///b.ts', 1]],
  );
  const text = 'import { add } from "./u";\nadd(1, add(2, 3));\n';
  const edits = [{ range: r(1, 7, 10), newText: 'sum' }, { range: r(0, 9, 12), newText: 'sum' }, { range: r(1, 0, 3), newText: 'sum' }];
  assert.equal(applyTextEdits(text, edits), 'import { sum } from "./u";\nsum(1, sum(2, 3));\n');
  // As CodeMirror changes, in order; edits that do not fit or overlap: null.
  assert.deepEqual(textChanges(text, edits).map((c) => c.from), [9, 27, 34]);
  assert.equal(textChanges(text, [{ range: r(5, 0, 1), newText: 'x' }]), null);
  assert.equal(applyTextEdits(text, [{ range: r(0, 0, 5), newText: 'a' }, { range: r(0, 3, 8), newText: 'b' }]), null);
});

test('what the status bar says', () => {
  assert.equal(progressText(new Map()), '');
  assert.equal(progressText(new Map([['t', { title: 'Indexing', percentage: 40.4 }]])), 'Indexing 40%');
  assert.equal(serverLabel({ server: 'TypeScript 7.0.2', state: 'running' }), 'TypeScript 7.0.2 · ready');
  assert.equal(serverLabel({ server: 'Pyright', state: 'running', progress: 'Indexing 40%' }), 'Pyright · Indexing 40%');
  assert.equal(serverLabel({ server: 'Pyright', state: 'starting' }), 'Pyright · starting…');
});

const range = (l1, c1, l2, c2) => ({ start: { line: l1, character: c1 }, end: { line: l2, character: c2 } });

test('a workspace edit: its files, new files, and what the editor does not do', () => {
  const plan = editPlan({
    documentChanges: [
      { kind: 'create', uri: 'file:///w/new.ts', options: { ignoreIfExists: true } },
      { textDocument: { uri: 'file:///w/new.ts', version: null }, edits: [{ range: range(0, 0, 0, 0), newText: 'export {};\n' }] },
      { textDocument: { uri: 'file:///w/a.ts', version: 3 }, edits: [] },
    ],
  });
  assert.deepEqual(plan.creates, [{ uri: 'file:///w/new.ts', overwrite: false, ignoreIfExists: true }]);
  assert.deepEqual(plan.files.map((f) => f.uri), ['file:///w/new.ts']);
  assert.deepEqual(plan.unsupported, []);
  assert.deepEqual(editPlan({ documentChanges: [{ kind: 'rename', oldUri: 'file:///a', newUri: 'file:///b' }, { kind: 'delete', uri: 'file:///c' }] }).unsupported, ['rename', 'delete']);
  assert.deepEqual(editPlan({ changes: { 'file:///w/b.ts': [{ range: range(0, 0, 0, 1), newText: 'x' }] } }).files.length, 1);
  assert.deepEqual(editPlan(null), { files: [], creates: [], unsupported: [] });
});

test('the lines a change touches, before and after (for the preview)', () => {
  const text = 'import a\nconst helper = 1\nuse(helper, helper)\nend\n';
  const rows = changedLines(text, [
    { range: range(1, 6, 1, 12), newText: 'assist' },
    { range: range(2, 4, 2, 10), newText: 'assist' },
    { range: range(2, 12, 2, 18), newText: 'assist' },
  ]);
  assert.deepEqual(rows, [
    { line: 2, before: ['const helper = 1'], after: ['const assist = 1'] },
    { line: 3, before: ['use(helper, helper)'], after: ['use(assist, assist)'] },
  ]);
  // A change across lines, and one adding lines.
  assert.deepEqual(changedLines('a\nb\nc', [{ range: range(0, 1, 2, 0), newText: '+' }]), [{ line: 1, before: ['a', 'b', 'c'], after: ['a+c'] }]);
  assert.deepEqual(changedLines('x\n', [{ range: range(0, 0, 0, 0), newText: 'import y\n' }]), [{ line: 1, before: [], after: ['import y'] }]);
  // A line removed; a new file's text: only what changes shows.
  assert.deepEqual(changedLines('a\nb\nc\n', [{ range: range(1, 0, 2, 0), newText: '' }]), [{ line: 2, before: ['b'], after: [] }]);
  assert.deepEqual(changedLines('', [{ range: range(0, 0, 0, 0), newText: 'print(1)\n' }]), [{ line: 1, before: [], after: ['print(1)'] }]);
  assert.equal(changedLines('x', [{ range: range(5, 0, 5, 1), newText: '' }]), null);
});

test('the workspace folder goes with initialize', () => {
  const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///home/me/my%20app', capabilities: {} } });
  assert.deepEqual(JSON.parse(withWorkspaceFolder(init)).params.workspaceFolders, [{ uri: 'file:///home/me/my%20app', name: 'my app' }]);
  const other = JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} });
  assert.equal(withWorkspaceFolder(other), other);
  // Several projects sharing a server: all of them.
  const two = [{ uri: 'file:///w/a', name: 'a' }, { uri: 'file:///w/b', name: 'b' }];
  assert.deepEqual(JSON.parse(withWorkspaceFolder(init, two)).params.workspaceFolders, two);
});

test('large files go to their server less often', () => {
  assert.equal(syncWait(10_000), 400);
  assert.equal(syncWait(200_000), 400);
  assert.equal(syncWait(700_000), 900);
  assert.equal(syncWait(50_000_000), 1500);
});

test('code actions: quick fixes first, the preferred on top, disabled ones last', () => {
  const rows = codeActionRows([
    { title: 'Extract to function', kind: 'refactor.extract.function' },
    { title: 'Organize imports', kind: 'source.organizeImports' },
    { title: 'Add import from "./util"', kind: 'quickfix', edit: {} },
    { title: 'Ignore this error', kind: 'quickfix', disabled: { reason: 'Not here' } },
    { title: 'Fix spelling', kind: 'quickfix', isPreferred: true },
    { title: 'Run the linter', command: 'lint.run', arguments: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.title), ['Fix spelling', 'Add import from "./util"', 'Ignore this error', 'Extract to function', 'Organize imports', 'Run the linter']);
  assert.deepEqual(rows.map((r) => r.group), ['Quick fix', 'Quick fix', 'Quick fix', 'Refactor', 'Source', 'Other']);
  assert.equal(rows[2].disabled, 'Not here');
  assert.equal(rows[5].item.command, 'lint.run');
  assert.deepEqual(codeActionRows(null), []);
  // Diagnostics that touch a range (an empty range at their edge too).
  assert.equal(rangesTouch(range(1, 0, 1, 5), range(1, 5, 1, 5)), true);
  assert.equal(rangesTouch(range(1, 0, 1, 5), range(2, 0, 2, 1)), false);
});

test('workspace symbols as rows', () => {
  const rows = symbolRows([
    { name: 'helper', kind: 12, containerName: 'util', location: { uri: 'file:///w/util.ts', range: range(4, 16, 4, 22) } },
    { name: 'Store', kind: 5, location: { uri: 'file:///w/store.ts' } },
    { name: 'broken' },
  ]);
  assert.deepEqual(rows, [
    { title: 'helper', kind: 'function', container: 'util', uri: 'file:///w/util.ts', line: 5, column: 17 },
    { title: 'Store', kind: 'class', container: '', uri: 'file:///w/store.ts', line: 1, column: 1 },
  ]);
});

test('each language in Settings: what the main process is told, what restarts, which formatter first', () => {
  const per = { python: { off: true }, typescript: { server: 'tls', formatter: 'builtin' }, go: { formatter: 'server' } };
  assert.deepEqual(languageOptions(per), { off: ['python'], prefer: { typescript: 'tls' } });
  assert.deepEqual(languageOptions(undefined), { off: [], prefer: {} });
  // Only turning on or off, or another server, starts servers again (not the formatter).
  assert.deepEqual(changedLanguages(per, { ...per, go: {} }), []);
  assert.deepEqual(changedLanguages(per, { typescript: { formatter: 'builtin' }, go: { formatter: 'server' } }).sort(), ['python', 'typescript']);
  assert.equal(formatFirst({ formatter: 'server', lspLanguages: per }, 'typescript'), 'builtin');
  assert.equal(formatFirst({ formatter: 'builtin', lspLanguages: per }, 'go'), 'server');
  assert.equal(formatFirst({ formatter: 'builtin', lspLanguages: per }, 'rust'), 'builtin');
  assert.equal(formatFirst({ lspLanguages: per }, ''), 'server');
});
