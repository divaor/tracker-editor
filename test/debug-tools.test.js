import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  ADAPTERS,
  addToConsole,
  allOff,
  breakpointNote,
  breakpointRows,
  cleanBreakpoints,
  cleanList,
  cleanTest,
  cleanWatches,
  consoleOutput,
  debugAdapterFor,
  exceptionFilters,
  firstOpen,
  focusFrame,
  framePlace,
  launchConfig,
  MAX_BREAKPOINT_FILES,
  movedBreakpoints,
  pytestId,
  refsToLoad,
  setAllEnabled,
  shortValue,
  sourceBreakpoints,
  stopReason,
  toggleBreakpoint,
  unittestId,
  updateBreakpoint,
  variableRows,
  withBreakpoints,
} from '../app/js/debugTools.js';

const require = createRequire(import.meta.url);

test('the adapter by file type; the main process keeps the same map', () => {
  assert.equal(debugAdapterFor('/p/app.py'), 'python');
  assert.equal(debugAdapterFor('C:\\p\\main.PY'), 'python');
  for (const name of ['a.js', 'a.mjs', 'a.cjs', 'a.ts', 'a.mts', 'a.cts']) assert.equal(debugAdapterFor(name), 'node', name);
  for (const name of ['a.jsx', 'a.tsx', 'a.go', 'README', 'a.json']) assert.equal(debugAdapterFor(name), null, name);
  const dap = require('../electron/dap.cjs');
  for (const ext of Object.keys(dap.EXT_ADAPTER)) assert.equal(debugAdapterFor(`x.${ext}`), dap.EXT_ADAPTER[ext]);
  assert.equal(dap.adapterKindOf('/p/x.ts'), 'node');
  assert.equal(ADAPTERS.python.label, 'debugpy');
  assert.equal(ADAPTERS.node.label, 'js-debug');
});

test('launch configurations: a file, with what the main process found', () => {
  const py = launchConfig('python', { file: '/p/src/app.py', cwd: '/p/src', python: '/p/.venv/bin/python' });
  assert.deepEqual(py, { type: 'python', request: 'launch', name: 'Debug app.py', cwd: '/p/src', console: 'internalConsole', justMyCode: true, subProcess: false, showReturnValue: true, python: '/p/.venv/bin/python', program: '/p/src/app.py' });
  const js = launchConfig('node', { file: '/p/index.js', cwd: '/p', node: '/usr/bin/node' });
  assert.equal(js.type, 'pwa-node');
  assert.equal(js.program, '/p/index.js');
  assert.equal(js.runtimeExecutable, '/usr/bin/node');
  assert.equal(js.console, 'internalConsole');
  assert.equal(js.outputCapture, 'std');
  assert.deepEqual(js.env, { ELECTRON_RUN_AS_NODE: null });
  assert.equal(js.runtimeArgs, undefined);
  // TypeScript through the project's tsx when it has one (else Node's own type stripping).
  assert.deepEqual(launchConfig('node', { file: '/p/a.ts', cwd: '/p', node: 'node', tsx: true }).runtimeArgs, ['--import', 'tsx']);
  assert.equal(launchConfig('node', { file: '/p/a.ts', cwd: '/p', node: 'node' }).runtimeArgs, undefined);
  assert.throws(() => launchConfig('go', { file: '/p/a.go', cwd: '/p' }), /Python, JavaScript and TypeScript/);
});

test('launch configurations: one test, or the file’s tests', () => {
  const t = (title, extra = {}) => ({ title, kind: 'test', chain: [], cls: '', ...extra });
  // pytest: the node id, from the project folder.
  assert.deepEqual(launchConfig('python', { file: '/p/tests/test_math.py', cwd: '/p', python: 'py', test: { framework: 'pytest', target: t('test_add', { cls: 'TestMath' }) } }).args, ['tests/test_math.py::TestMath::test_add']);
  assert.equal(launchConfig('python', { file: '/p/tests/test_math.py', cwd: '/p', python: 'py', test: { framework: 'pytest', target: null } }).module, 'pytest');
  assert.equal(pytestId('/p/test_x.py', '/p', { title: 'TestX', kind: 'suite' }), 'test_x.py::TestX');
  assert.equal(pytestId('C:\\p\\tests\\test_x.py', 'C:\\p', null), 'tests/test_x.py');
  // unittest: dotted.
  assert.deepEqual(launchConfig('python', { file: '/p/pkg/test_x.py', cwd: '/p', python: 'py', test: { framework: 'unittest', target: t('test_a', { cls: 'TestX' }) } }).args, ['-v', 'pkg.test_x.TestX.test_a']);
  assert.equal(unittestId('/p/pkg/test_x.py', '/p', null), 'pkg.test_x');
  // Names that are not Python names never reach the command line (no options slipped in).
  assert.throws(() => pytestId('/p/test_x.py', '/p', t('-p evil')), /Not a Python test name/);
  assert.throws(() => unittestId('/p/test-x.py', '/p', null), /Not a Python module/);
  // node:test: the file in its own process, the name pattern.
  const nodeTest = launchConfig('node', { file: '/p/a.test.mjs', cwd: '/p', node: 'node', test: { framework: 'node', target: t('adds (1+1)') } });
  assert.equal(nodeTest.program, '/p/a.test.mjs');
  assert.deepEqual(nodeTest.runtimeArgs, ['--test-name-pattern=adds \\(1\\+1\\)']);
  // Vitest and Jest: their scripts, the pattern as testRun.js runs it.
  const vitest = launchConfig('node', { file: '/p/src/a.test.ts', cwd: '/p', node: 'node', programs: { vitest: '/p/node_modules/vitest/vitest.mjs' }, test: { framework: 'vitest', target: t('adds', { chain: ['math'] }) } });
  assert.equal(vitest.program, '/p/node_modules/vitest/vitest.mjs');
  assert.deepEqual(vitest.args, ['run', 'src/a.test.ts', '--testNamePattern=^math( > | )adds$']);
  const jest = launchConfig('node', { file: '/p/a.test.js', cwd: '/p', node: 'node', programs: { jest: '/p/node_modules/jest/bin/jest.js' }, test: { framework: 'jest', target: { title: 'math', kind: 'suite', chain: [] } } });
  assert.deepEqual(jest.args, ['--runInBand', '--watchAll=false', 'a.test.js', '--testNamePattern=^math']);
  assert.throws(() => launchConfig('node', { file: '/p/a.test.js', cwd: '/p', node: 'node', test: { framework: 'vitest', target: null } }), /Vitest is not installed/);
  assert.throws(() => launchConfig('node', { file: '/p/a.test.js', cwd: '/p', node: 'node', test: { framework: 'mocha', target: null } }), /cannot be debugged here/);
});

test('a test from the page: only names and kinds', () => {
  assert.equal(cleanTest(null), null);
  assert.equal(cleanTest({ framework: 'go' }), null);
  assert.deepEqual(cleanTest({ framework: 'pytest', target: { title: 'test_a', kind: 'test', cls: 'TestA', chain: ['x', 3], program: '/bin/sh' }, python: '/bin/sh' }), { framework: 'pytest', target: { title: 'test_a', kind: 'test', cls: 'TestA', chain: ['x'] } });
  assert.deepEqual(cleanTest({ framework: 'jest', target: { title: '' } }), { framework: 'jest', target: null });
});

test('breakpoints: toggled, changed, kept clean per file', () => {
  let list = toggleBreakpoint([], 5);
  assert.deepEqual(list, [{ line: 5 }]);
  list = toggleBreakpoint(list, 2);
  assert.deepEqual(list, [{ line: 2 }, { line: 5 }]);
  list = updateBreakpoint(list, 5, { condition: 'x > 3', enabled: false });
  assert.deepEqual(list, [{ line: 2 }, { line: 5, enabled: false, condition: 'x > 3' }]);
  list = updateBreakpoint(list, 5, { condition: '', enabled: true, logMessage: 'x is {x}' });
  assert.deepEqual(list, [{ line: 2 }, { line: 5, logMessage: 'x is {x}' }]);
  list = updateBreakpoint(list, 9, { hitCondition: '3' }); // made when there is none
  assert.deepEqual(list.at(-1), { line: 9, hitCondition: '3' });
  assert.deepEqual(toggleBreakpoint(list, 2).map((b) => b.line), [5, 9]);
  assert.deepEqual(cleanList([{ line: 3 }, { line: 3, condition: 'a' }, { line: 0 }, { line: 'x' }, { line: 1.7 }]), [{ line: 1 }, { line: 3 }]);
  // What the adapter gets: the ones on, with what the adapter can do.
  assert.deepEqual(sourceBreakpoints([{ line: 1 }, { line: 2, enabled: false }, { line: 3, condition: 'a', hitCondition: '2', logMessage: 'm' }]), [{ line: 1 }, { line: 3, condition: 'a', hitCondition: '2', logMessage: 'm' }]);
  assert.deepEqual(sourceBreakpoints([{ line: 3, condition: 'a', logMessage: 'm' }], { supportsConditionalBreakpoints: false, supportsLogPoints: false }), [{ line: 3 }]);
});

test('breakpoints across files: the settings, moves, the panel’s list', () => {
  let all = withBreakpoints({}, '/p/b.py', [{ line: 4 }]);
  all = withBreakpoints(all, '/p/a.py', [{ line: 9, condition: 'n == 2' }, { line: 1 }]);
  assert.deepEqual(Object.keys(all), ['/p/b.py', '/p/a.py']);
  assert.deepEqual(withBreakpoints(all, '/p/b.py', []), { '/p/a.py': [{ line: 1 }, { line: 9, condition: 'n == 2' }] });
  assert.deepEqual(
    breakpointRows(all).map((r) => `${r.name}:${r.line}`),
    ['a.py:1', 'a.py:9', 'b.py:4'],
  );
  assert.equal(breakpointNote({ condition: 'n == 2', hitCondition: '3', logMessage: 'hi {n}' }), 'when n == 2 · hit 3 · logs hi {n}');
  // Renamed files and folders take theirs along.
  assert.deepEqual(Object.keys(movedBreakpoints(all, [{ from: '/p', to: '/q' }])), ['/q/b.py', '/q/a.py']);
  assert.deepEqual(Object.keys(movedBreakpoints(all, [{ from: '/p/a.py', to: '/p/c.py' }])), ['/p/b.py', '/p/c.py']);
  // All off, all on.
  assert.equal(allOff(all), false);
  const off = setAllEnabled(all, false);
  assert.equal(allOff(off), true);
  assert.equal(allOff(setAllEnabled(off, true)), false);
  // At most MAX_BREAKPOINT_FILES files: the oldest go.
  let many = {};
  for (let i = 0; i <= MAX_BREAKPOINT_FILES; i++) many = withBreakpoints(many, `/f${i}.py`, [{ line: 1 }]);
  assert.equal(Object.keys(many).length, MAX_BREAKPOINT_FILES);
  assert.ok(!('/f0.py' in many));
  assert.deepEqual(cleanBreakpoints({ '/x.py': 'nope', '': [{ line: 1 }], '/y.py': [{ line: 2 }] }), { '/y.py': [{ line: 2 }] });
});

test('what the adapters say: exception filters, places, reasons, output', () => {
  const debugpy = { exceptionBreakpointFilters: [{ filter: 'raised' }, { filter: 'uncaught' }, { filter: 'userUnhandled' }] };
  const jsDebug = { exceptionBreakpointFilters: [{ filter: 'all' }, { filter: 'uncaught' }] };
  assert.deepEqual(exceptionFilters(debugpy, { uncaught: true }), ['uncaught']);
  assert.deepEqual(exceptionFilters(debugpy, { uncaught: true }, { test: true }), ['uncaught', 'userUnhandled']);
  assert.deepEqual(exceptionFilters(debugpy, { uncaught: true, all: true }), ['uncaught', 'raised']);
  assert.deepEqual(exceptionFilters(jsDebug, { uncaught: false, all: true }), ['all']);
  assert.deepEqual(exceptionFilters({}, { uncaught: true }), []);
  // Frames: a file of the person's, or nothing to open.
  assert.deepEqual(framePlace({ line: 3, column: 5, source: { path: '/p/a.py' } }), { path: '/p/a.py', line: 3, column: 5 });
  assert.deepEqual(framePlace({ line: 3, source: { path: 'C:\\p\\a.js' } }), { path: 'C:\\p\\a.js', line: 3, column: 1 });
  assert.equal(framePlace({ line: 1, source: { path: 'node:internal/main', sourceReference: 4 } }), null);
  assert.equal(framePlace({ line: 1, source: { name: '<runner>', sourceReference: 7 } }), null);
  const frames = [
    { id: 1, name: 'internal', source: { path: 'node:events' } },
    { id: 2, name: 'lib', source: { path: '/p/node_modules/x.js' }, presentationHint: 'deemphasize' },
    { id: 3, name: 'mine', source: { path: '/p/a.js' } },
  ];
  assert.equal(focusFrame(frames).id, 3);
  assert.equal(focusFrame(frames.slice(0, 2)).id, 2);
  assert.equal(focusFrame([]), null);
  assert.equal(stopReason({ reason: 'breakpoint' }), 'Paused on a breakpoint');
  assert.equal(stopReason({ reason: 'step' }), 'Paused after a step');
  assert.equal(stopReason({ reason: 'exception', text: 'ValueError: boom\n  more' }), 'Paused on an exception: ValueError: boom');
  assert.equal(stopReason({ reason: 'pause' }), 'Paused');
  assert.equal(shortValue('a\nb'), 'a ⏎ b');
  assert.equal(shortValue('x'.repeat(10), 5), 'xxxx…');
  assert.deepEqual(consoleOutput({ category: 'stdout', output: 'hi\n' }), { kind: 'stdout', text: 'hi\n' });
  assert.equal(consoleOutput({ category: 'telemetry', output: '{}' }), null);
  assert.deepEqual(consoleOutput({ output: 'x' }), { kind: 'console', text: 'x' });
  // Pieces of a line join; a new line of another kind does not.
  let c = addToConsole([], { kind: 'stdout', text: 'res' });
  c = addToConsole(c, { kind: 'stdout', text: 'ult 5\n' });
  c = addToConsole(c, { kind: 'stderr', text: 'oops\n' });
  assert.deepEqual(c, [{ kind: 'stdout', text: 'result 5\n' }, { kind: 'stderr', text: 'oops\n' }]);
  assert.equal(addToConsole(Array.from({ length: 5 }, (_, i) => ({ kind: 'result', text: `${i}\n` })), { kind: 'result', text: 'x\n' }, 5).length, 5);
  assert.deepEqual(cleanWatches([' x ', 'x', '', 3, 'y']), ['x', 'y']);
});

test('the variables tree: scopes, open rows, what to load', () => {
  const scopes = [
    { name: 'Locals', variablesReference: 1, expensive: false },
    { name: 'Globals', variablesReference: 2, expensive: true },
  ];
  assert.deepEqual(firstOpen(scopes), ['Locals']);
  const children = new Map([[1, [{ name: 'n', value: '3', type: 'int', variablesReference: 0 }, { name: 'items', value: '[1, 2]', type: 'list', variablesReference: 10 }]]]);
  let open = new Set(['Locals']);
  let rows = variableRows(scopes, children, open);
  assert.deepEqual(rows.map((r) => [r.path, r.depth, r.open, r.loading]), [
    ['Locals', 0, true, false],
    ['Locals/n', 1, false, false],
    ['Locals/items', 1, false, false],
    ['Globals', 0, false, false],
  ]);
  assert.deepEqual(refsToLoad(rows, children), []);
  open = new Set(['Locals', 'Locals/items', 'Globals']);
  rows = variableRows(scopes, children, open);
  assert.deepEqual(refsToLoad(rows, children), [10, 2]);
  assert.ok(rows.find((r) => r.path === 'Locals/items').loading);
  children.set(10, [{ name: '0', value: '1', variablesReference: 0 }]);
  children.set(2, null); // loading
  rows = variableRows(scopes, children, open);
  assert.deepEqual(rows.find((r) => r.path === 'Locals/items/0'), { path: 'Locals/items/0', depth: 2, name: '0', value: '1', type: '', ref: 0, open: false, loading: false });
  assert.deepEqual(refsToLoad(rows, children), []);
  assert.ok(rows.find((r) => r.path === 'Globals').loading);
});
