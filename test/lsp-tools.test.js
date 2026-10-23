// Language servers, the page's pure part (lspTools.js): file URIs, problems, places, edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTextEdits, editsByFile, fileUri, locations, offsetOf, pathKey, progressText, serverLabel, textChanges, toProblems, uriPath } from '../app/js/lspTools.js';

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
