// The debugger with the real adapters: debugpy (a Python that imports it: DEBUGPY_PYTHON, else
// python3 on PATH) and js-debug's standalone server (JS_DEBUG_DIR: the folder js-debug-dap was
// unpacked into, as the install command does). Each part is skipped when its adapter is not
// here, unless DAP_REAL_REQUIRED=1 (CI installs both: .github/workflows/ci.yml, job debuggers).
// Through the real host (dap.cjs: finding, launch made there) and the page's client (dap.js).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createDebugger } from '../app/js/dap.js';

const require = createRequire(import.meta.url);
const dap = require('../electron/dap.cjs');
const required = process.env.DAP_REAL_REQUIRED === '1';

const sep = process.platform === 'win32' ? ';' : ':';
// The Python with debugpy goes first on PATH, as a project's .venv would be found first.
const pyBin = process.env.DEBUGPY_PYTHON ? path.dirname(process.env.DEBUGPY_PYTHON) : '';
const env = { ...process.env, PATH: [pyBin, path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(sep) };
const python = process.env.DEBUGPY_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const has = (module) => {
  try {
    execFileSync(python, ['-c', `import ${module}`], { env, stdio: 'ignore', timeout: 20000 });
    return true;
  } catch {
    return false;
  }
};
const debugpy = has('debugpy');
const pytest = debugpy && has('pytest');
const jsDebugDir = process.env.JS_DEBUG_DIR ?? '';
const jsDebug = Boolean(jsDebugDir) && fs.existsSync(dap.jsDebugServer(jsDebugDir));
const skip = (ok, what) => (ok ? false : required ? false : `${what} is not installed here`);

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'te-dap-real-')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

// Whatever a failed test left running ends with the file.
const hosts = [];
after(() => hosts.forEach((h) => h.stopAll()));

function setup() {
  const listeners = { 'dap:message': new Set(), 'dap:exit': new Set() };
  const sender = { emit: (channel, payload) => setImmediate(() => listeners[channel].forEach((l) => l(payload))) };
  const host = dap.createDapHost({
    send: (s, channel, payload) => s.emit(channel, payload),
    nodePath: process.execPath,
    debuggersDir: jsDebugDir,
    locateAdapter: (file, opts) => dap.locate(file, { ...opts, env, login: false }),
  });
  hosts.push(host);
  const bridge = {
    start: (file, opts) => host.start(sender, file, { stop: path.dirname(file), test: opts?.test ?? null }),
    child: (parentId, seq) => host.child(sender, parentId, seq),
    send: (id, message) => host.write(id, message, sender),
    stop: async (id) => host.stop(id, sender),
    active: () => {},
    onMessage: (fn) => (listeners['dap:message'].add(fn), () => listeners['dap:message'].delete(fn)),
    onExit: (fn) => (listeners['dap:exit'].add(fn), () => listeners['dap:exit'].delete(fn)),
  };
  return { host, bridge };
}

/** Debugs `file` to its first stop: { dbg, stops, ended(), text() }. */
async function debugTo(file, marks, opts = {}) {
  const { host, bridge } = setup();
  const stops = [];
  let ended = null;
  const dbg = createDebugger({ bridge, breakpoints: () => marks, exceptions: () => ({ uncaught: true }), watches: () => ['total'], onStop: (s) => stops.push(s), onEnd: (r) => (ended = r), timeout: 20000 });
  const started = await dbg.start(file, opts);
  assert.ok(started.id, `the adapter started: ${JSON.stringify(started)}`);
  await until(() => dbg.paused() && stops.length, 60000, `the first stop in ${path.basename(file)}${dbg.run ? `\n${dbg.run.console.map((e) => e.text).join('')}` : ''}`);
  return { host, dbg, stops, ended: () => ended, text: () => dbg.run.console.map((e) => e.text).join('') };
}

const PY = ['def add(a, b):', '    total = a + b', '    return total', '', '', 'items = [1, 2, 3]', 'result = add(2, 3)', 'print("result", result)', 'for i in items:', '    result += i', 'print("done", result)', ''].join('\n');
const JS = ['function add(a, b) {', '  const total = a + b;', '  return total;', '}', '', 'const items = [1, 2, 3];', 'let result = add(2, 3);', "console.log('result', result);", 'for (const i of items) result += i;', "console.log('done', result);", ''].join('\n');

async function walkThrough(file, { name }) {
  const { host, dbg, stops, ended, text } = await debugTo(file, { [file]: [{ line: 2 }] });
  const first = stops[0];
  assert.equal(first.place.path, file);
  assert.equal(first.place.line, 2);
  assert.equal(dbg.run.reason, 'Paused on a breakpoint');
  // The stack: add (debugpy says add, js-debug global.add), called from the module's line 7.
  const frames = dbg.threads().find((t) => t.paused).frames;
  assert.match(frames[0].name, name);
  assert.equal(frames[0].line, 2);
  assert.ok(
    frames.slice(1).some((f) => f.line === 7 && f.source?.path === file),
    `the caller at line 7 in ${frames.map((f) => `${f.name} ${f.source?.path}:${f.line}`).join(', ')}`,
  );
  // The locals: a and b.
  await until(() => dbg.rows().some((r) => r.depth === 1 && r.name === 'b'), 20000, 'the locals');
  const rows = dbg.rows();
  assert.equal(rows.find((r) => r.depth === 1 && r.name === 'a').value, '2');
  assert.equal(rows.find((r) => r.depth === 1 && r.name === 'b').value, '3');
  // A step: the next line, where total is 5.
  await dbg.stepOver();
  await until(() => stops.length === 2 && dbg.paused(), 20000, 'the step');
  assert.equal(stops[1].place.line, 3);
  await until(() => dbg.run.watch.get('total')?.value === '5', 20000, 'the watch on total');
  await dbg.evaluate('a + b');
  assert.match(text(), /a \+ b\n5\n/);
  // On to the end: what it printed, its end.
  await dbg.continue();
  await until(() => ended(), 30000, 'the end');
  assert.match(text(), /result 5/);
  assert.match(text(), /done 11/);
  await until(() => host.list().length === 0, 10000, 'the adapter to end');
  dbg.dispose();
}

test('debugpy: a breakpoint, the stack, variables, a step, the console, to the end', { skip: skip(debugpy, 'debugpy'), timeout: 180000 }, async () => {
  const dir = tmp();
  const file = path.join(dir, 'prog.py');
  fs.writeFileSync(file, PY);
  await walkThrough(file, { name: /^add$/ });
});

test('debugpy: a pytest test at its breakpoint', { skip: skip(pytest, 'pytest (with debugpy)'), timeout: 180000 }, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  const file = path.join(dir, 'test_math.py');
  fs.writeFileSync(file, ['def test_add():', '    total = 2 + 3', '    assert total == 5', '', '', 'def test_other():', '    assert True', ''].join('\n'));
  const { host, dbg, stops, ended, text } = await debugTo(file, { [file]: [{ line: 3 }] }, { test: { framework: 'pytest', target: { title: 'test_add', kind: 'test' } } });
  assert.equal(stops[0].place.line, 3);
  await dbg.evaluate('total');
  assert.match(text(), /› total\n5\n/);
  await dbg.continue();
  await until(() => ended(), 30000, 'the end');
  assert.match(text(), /1 passed/);
  await until(() => host.list().length === 0, 10000, 'the adapter to end');
  dbg.dispose();
});

test('js-debug: a breakpoint (in its child session), the stack, variables, a step, the console, to the end', { skip: skip(jsDebug, 'js-debug'), timeout: 180000 }, async () => {
  const dir = tmp();
  const file = path.join(dir, 'prog.js');
  fs.writeFileSync(file, JS);
  await walkThrough(file, { name: /(^|\.)add$/ });
});

test('js-debug: a node:test test at its breakpoint', { skip: skip(jsDebug, 'js-debug'), timeout: 180000 }, async () => {
  const dir = tmp();
  const file = path.join(dir, 'math.test.mjs');
  fs.writeFileSync(file, ["import { test } from 'node:test';", "import assert from 'node:assert/strict';", '', "test('adds', () => {", '  const total = 2 + 3;', '  assert.equal(total, 5);', '});', "test('other', () => assert.ok(true));", ''].join('\n'));
  const { host, dbg, stops, ended, text } = await debugTo(file, { [file]: [{ line: 6 }] }, { test: { framework: 'node', target: { title: 'adds', kind: 'test' } } });
  assert.equal(stops[0].place.line, 6);
  await dbg.evaluate('total');
  assert.match(text(), /› total\n5\n/);
  await dbg.continue();
  await until(() => ended(), 30000, 'the end');
  assert.match(text(), /pass 1/);
  await until(() => host.list().length === 0, 10000, 'the adapter to end');
  dbg.dispose();
});
