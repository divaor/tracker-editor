// The debugger: dap.cjs's finding and installing (pure parts), its host with the fake adapter
// (test/helpers/fake-dap.cjs: stdio as debugpy, a server with child sessions as js-debug), and
// the page's client (app/js/dap.js) driving it through a bridge like the preload's.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createDebugger } from '../app/js/dap.js';

const require = createRequire(import.meta.url);
const dap = require('../electron/dap.cjs');
const FAKE = fileURLToPath(new URL('./helpers/fake-dap.cjs', import.meta.url));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'te-dap-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 8000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

// The fake in place of debugpy (stdio) and js-debug (a server).
const fakeLocate = async (file) => {
  const kind = dap.adapterKindOf(file);
  if (!kind) return null;
  if (kind === 'python') return { kind, root: path.dirname(file), found: { python: '/usr/bin/python3' }, run: { transport: 'stdio', command: process.execPath, args: [FAKE, '--stdio'], env: process.env } };
  return { kind, root: path.dirname(file), found: { node: process.execPath, programs: {} }, run: { transport: 'tcp', script: FAKE, args: ['--server'], env: process.env } };
};

// Whatever a failed test left running ends with the file.
const hosts = [];
after(() => hosts.forEach((h) => h.stopAll()));

function setup({ locateAdapter = fakeLocate } = {}) {
  const listeners = { 'dap:message': new Set(), 'dap:exit': new Set() };
  // Like IPC: each message on its own turn, in order.
  const sender = { emit: (channel, payload) => setImmediate(() => listeners[channel].forEach((l) => l(payload))) };
  const host = dap.createDapHost({ send: (s, channel, payload) => s.emit(channel, payload), locateAdapter, nodePath: process.execPath, graceMs: 100 });
  hosts.push(host);
  const active = [];
  const bridge = {
    start: (file, opts) => host.start(sender, file, { test: opts?.test ?? null }),
    child: (parentId, seq) => host.child(sender, parentId, seq),
    send: (id, message) => host.write(id, message, sender),
    stop: async (id) => host.stop(id, sender),
    active: (on) => active.push(on),
    onMessage: (fn) => (listeners['dap:message'].add(fn), () => listeners['dap:message'].delete(fn)),
    onExit: (fn) => (listeners['dap:exit'].add(fn), () => listeners['dap:exit'].delete(fn)),
  };
  return { host, sender, bridge, active, listeners };
}
const consoleText = (run) => run.console.map((e) => e.text).join('');

test('the Pythons that may run a file: its virtual environments, up to the folder picked, then PATH', () => {
  const have = new Set(['/w/proj/sub/.venv/bin/python', '/w/proj/venv/bin/python', '/w/.venv/bin/python', '/usr/bin/python3', '/usr/bin/python']);
  const exists = (p) => have.has(p);
  const env = { PATH: '/usr/bin' };
  assert.deepEqual(dap.pythonCandidates('/w/proj/sub/app.py', { stop: '/w/proj', env, platform: 'linux', exists }), ['/w/proj/sub/.venv/bin/python', '/w/proj/venv/bin/python', '/usr/bin/python3', '/usr/bin/python']);
  // Without a folder picked (a file opened alone): its own folder only.
  assert.deepEqual(dap.pythonCandidates('/w/proj/app.py', { stop: '', env, platform: 'linux', exists }), ['/w/proj/venv/bin/python', '/usr/bin/python3', '/usr/bin/python']);
});

test('finding debugpy: the first Python that imports it; else how to install it', async () => {
  const dir = tmp();
  const file = path.join(dir, 'app.py');
  fs.writeFileSync(file, 'x = 1\n');
  const win = process.platform === 'win32';
  const venvPy = win ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');
  fs.mkdirSync(path.dirname(venvPy), { recursive: true });
  fs.writeFileSync(venvPy, '');
  const asked = [];
  const run = (python, args, _opts, cb) => {
    asked.push([python, ...args]);
    cb(python === venvPy ? null : new Error('No module named debugpy'));
  };
  const found = await dap.locate(file, { stop: dir, env: { PATH: '' }, login: false, run });
  assert.equal(found.kind, 'python');
  assert.deepEqual(found.found, { python: venvPy });
  assert.deepEqual(found.run, { transport: 'stdio', command: venvPy, args: ['-m', 'debugpy.adapter'], env: found.run.env });
  assert.deepEqual(asked[0], [venvPy, '-c', 'import debugpy']);
  const missing = await dap.locate(file, { stop: dir, env: { PATH: '' }, login: false, run: (_p, _a, _o, cb) => cb(new Error('no')) });
  assert.equal(missing.missing.adapter, 'python');
  assert.equal(missing.missing.python, venvPy);
  assert.deepEqual(missing.missing.install, [dap.pipInstall(venvPy)]);
  assert.match(missing.missing.note, /externally managed/);
  assert.equal(await dap.locate(path.join(dir, 'a.go'), { login: false }), null);
});

test('finding js-debug: its server in the debuggers folder, Node.js on PATH; else the download', async () => {
  const dir = tmp();
  const file = path.join(dir, 'index.js');
  fs.writeFileSync(file, 'let a = 1;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'node'), '');
  const debuggers = path.join(dir, 'debuggers');
  let found = await dap.locate(file, { stop: dir, debuggersDir: debuggers, env: { PATH: binDir }, login: false });
  assert.equal(found.missing.adapter, 'node');
  assert.deepEqual(found.missing.install, [dap.jsDebugInstall(debuggers)]);
  assert.ok(found.missing.install[0].posix.includes(`/download/v${dap.JS_DEBUG_VERSION}/js-debug-dap-v${dap.JS_DEBUG_VERSION}.tar.gz`));
  assert.equal(dap.jsDebugInstall('/home/me/debuggers', 'linux').posix, `mkdir -p /home/me/debuggers && curl -fsSL ${dap.jsDebugUrl()} | tar -xz -C /home/me/debuggers`);
  assert.doesNotMatch(found.missing.note, /Node.js is not found/);
  const server = dap.jsDebugServer(debuggers);
  fs.mkdirSync(path.dirname(server), { recursive: true });
  fs.writeFileSync(server, '');
  fs.mkdirSync(path.join(dir, 'node_modules', 'jest', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'jest', 'bin', 'jest.js'), '');
  found = await dap.locate(file, { stop: dir, debuggersDir: debuggers, env: { PATH: binDir }, login: false });
  assert.deepEqual(found.found, { node: path.join(binDir, 'node'), tsx: false, programs: { vitest: '', jest: path.join(dir, 'node_modules', 'jest', 'bin', 'jest.js') } });
  assert.deepEqual({ transport: found.run.transport, script: found.run.script }, { transport: 'tcp', script: server });
  // No Node.js: said so (the programs run on it).
  found = await dap.locate(file, { stop: dir, debuggersDir: debuggers, env: { PATH: '' }, login: false });
  assert.match(found.missing.note, /Node.js is not found/);
  assert.deepEqual(found.missing.install, []);
});

test('install commands for each kind of shell', () => {
  const win = dap.pipInstall('C:\\Users\\me\\proj\\.venv\\Scripts\\python.exe', 'win32');
  assert.equal(win.powershell, "& 'C:\\Users\\me\\proj\\.venv\\Scripts\\python.exe' -m pip install debugpy");
  assert.equal(win.cmd, '"C:\\Users\\me\\proj\\.venv\\Scripts\\python.exe" -m pip install debugpy');
  assert.equal(win.posix, 'C:/Users/me/proj/.venv/Scripts/python.exe -m pip install debugpy');
  assert.equal(dap.pipInstall('/home/me/my proj/.venv/bin/python', 'linux').posix, "'/home/me/my proj/.venv/bin/python' -m pip install debugpy");
  const js = dap.jsDebugInstall('C:\\Users\\me\\AppData\\Roaming\\Tracker Editor\\debuggers', 'win32', '1.2.3');
  assert.match(js.powershell, /^New-Item -ItemType Directory -Force -Path 'C:\\Users\\me\\AppData\\Roaming\\Tracker Editor\\debuggers' \| Out-Null; curl\.exe -fsSLo "\$env:TEMP\\js-debug-dap\.tar\.gz" https:\/\/github\.com\/microsoft\/vscode-js-debug\/releases\/download\/v1\.2\.3\/js-debug-dap-v1\.2\.3\.tar\.gz; tar -xzf/);
  assert.match(js.cmd, /^mkdir "C:\\Users\\me\\AppData\\Roaming\\Tracker Editor\\debuggers" 2>nul & curl\.exe/);
  assert.match(js.posix, /tar --force-local -xz -C 'C:\/Users\/me\/AppData\/Roaming\/Tracker Editor\/debuggers'$/);
  assert.deepEqual(Object.keys(dap.jsDebugInstall('/home/me/.config/Tracker Editor/debuggers', 'linux')), ['posix']);
  assert.match(dap.missingPython(null, 'linux').note, /Python is not found/);
  assert.deepEqual(dap.missingPython(null, 'linux').install, []);
});

test('the host fills in the launch itself: what the page puts in it does not count', async () => {
  const dir = tmp();
  const file = path.join(dir, 'prog.py');
  fs.writeFileSync(file, "print('hi')\n");
  const { host, sender, listeners } = setup();
  const seen = [];
  listeners['dap:message'].add(({ data }) => seen.push(JSON.parse(data)));
  const info = await host.start(sender, file, {});
  assert.equal(info.adapter, 'python');
  assert.equal(info.label, 'debugpy');
  assert.equal(info.config.program, file);
  assert.equal(info.config.python, '/usr/bin/python3');
  host.write(info.id, JSON.stringify({ seq: 1, type: 'request', command: 'initialize', arguments: { adapterID: 'debugpy' } }), sender);
  host.write(info.id, JSON.stringify({ seq: 2, type: 'request', command: 'launch', arguments: { program: '/etc/passwd', python: '/bin/sh' } }), sender);
  // Another page's message, a terminal asked for: not passed on.
  assert.equal(host.write(info.id, JSON.stringify({ seq: 3, type: 'request', command: 'initialize' }), { emit() {} }), false);
  assert.equal(host.write(info.id, JSON.stringify({ seq: 3, type: 'request', command: 'runInTerminal' }), sender), false);
  const launched = await until(() => seen.find((m) => m.event === 'output' && /fake-dap: launch/.test(m.body.output)), 5000, 'the launch');
  const args = JSON.parse(launched.body.output.replace(/^fake-dap: launch /, ''));
  assert.equal(args.program, file);
  assert.equal(args.python, '/usr/bin/python3');
  assert.equal(args.console, 'internalConsole');
  host.stop(info.id, sender);
  await until(() => host.list().length === 0, 5000, 'the session to end');
  // Not a type it debugs; missing; a test it cannot debug.
  assert.match((await host.start(sender, path.join(dir, 'a.go'), {})).none, /Python, JavaScript and TypeScript/);
  const missingHost = setup({ locateAdapter: async () => ({ kind: 'python', root: dir, missing: dap.missingPython('/usr/bin/python3', 'linux', dir) }) }).host;
  assert.equal((await missingHost.start(sender, file, {})).missing.adapter, 'python');
  assert.match((await host.start(sender, file, { test: { framework: 'jest', target: null } })).error, /cannot be debugged here/);
  assert.match((await host.start(sender, file, { test: { framework: 'pytest', target: { title: 'not a name', kind: 'test' } } })).error, /Not a Python test name/);
});

test('debugging with the client (stdio, as debugpy): breakpoints, the stack, variables, watch, console, a step, the end', async () => {
  const dir = tmp();
  const file = path.join(dir, 'prog.py');
  fs.writeFileSync(file, ["x = 1", "items = [1, 2, 3]", "print('start', x)", 'y = x + 1', "print('y is', y)", 'z = 10', "print('end')", ''].join('\n'));
  const { host, bridge, active } = setup();
  const stops = [];
  let runs = 0;
  let ended = null;
  const dbg = createDebugger({
    bridge,
    breakpoints: () => ({ [file]: [{ line: 4 }, { line: 6, logMessage: 'z soon, y={y}' }] }),
    exceptions: () => ({ uncaught: true }),
    watches: () => ['x', 'nope'],
    onStop: (s) => stops.push(s),
    onRun: () => runs++,
    onEnd: (r) => (ended = r),
  });
  const started = await dbg.start(file);
  assert.ok(started.id);
  await until(() => dbg.paused() && stops.length, 8000, 'the breakpoint');
  const run = dbg.run;
  assert.equal(run.reason, 'Paused on a breakpoint');
  assert.deepEqual(stops[0].place, { path: file, line: 4, column: 1 });
  const threads = dbg.threads();
  assert.deepEqual(threads.map((t) => [t.name, t.paused, t.frames.map((f) => f.name)]), [['MainThread', true, ['main', 'runner']]]);
  // The locals are open at once; the globals (expensive) wait to be opened.
  await until(() => dbg.rows().some((r) => r.path === 'Locals/x'), 5000, 'the locals');
  assert.deepEqual(dbg.rows().map((r) => `${r.path}=${r.value}`), ['Locals=', 'Locals/x=1', 'Locals/items=[1, 2, 3]', 'Globals=']);
  dbg.toggle(dbg.rows().find((r) => r.path === 'Locals/items'));
  await until(() => dbg.rows().some((r) => r.path === 'Locals/items/2'), 5000, 'the list’s items');
  assert.equal(dbg.rows().find((r) => r.path === 'Locals/items/2').value, '3');
  // Watch expressions, evaluated in the frame.
  await until(() => run.watch.size === 2, 5000, 'the watch');
  assert.equal(run.watch.get('x').value, '1');
  assert.match(run.watch.get('nope').error, /name 'nope' is not defined/);
  await dbg.evaluate('x + 1');
  assert.match(consoleText(run), /› x \+ 1\n2\n/);
  // A step: the next line.
  await dbg.stepOver();
  await until(() => dbg.paused() && stops.length === 2, 5000, 'the step');
  assert.equal(run.reason, 'Paused after a step');
  assert.equal(stops[1].place.line, 5);
  // What was open is open again at the next stop.
  await until(() => dbg.rows().some((r) => r.path === 'Locals/items/0'), 5000, 'the open list again');
  await dbg.evaluate('y');
  assert.match(consoleText(run), /› y\n2\n/);
  // On to the end: the log point writes, the program's output, its exit.
  await dbg.continue();
  await until(() => ended, 8000, 'the end');
  const out = consoleText(run);
  assert.match(out, /start 1\n/);
  assert.match(out, /y is 2\n/);
  assert.match(out, /z soon, y=2\n/);
  assert.match(out, /end\n/);
  assert.match(out, /The program ended \(exit code 0\)/);
  assert.match(out, /fake-dap: launch .*"program"/);
  assert.equal(run.status, 'ended');
  assert.ok(runs >= 2);
  assert.deepEqual(active, [true, false]);
  await until(() => host.list().length === 0, 5000, 'the adapter to end');
  dbg.dispose();
});

test('debugging with the client (a server with child sessions, as js-debug)', async () => {
  const dir = tmp();
  const file = path.join(dir, 'prog.js');
  fs.writeFileSync(file, ['let a = 2;', "console.log('a is', a);", 'let b = a + 3;', "console.log('b is', b);", ''].join('\n'));
  const { host, bridge } = setup();
  const stops = [];
  let ended = null;
  const dbg = createDebugger({ bridge, breakpoints: () => ({ [file]: [{ line: 3 }] }), onStop: (s) => stops.push(s), onEnd: (r) => (ended = r) });
  await dbg.start(file);
  await until(() => dbg.paused() && stops.length, 8000, 'the breakpoint in the child session');
  const run = dbg.run;
  assert.equal(run.sessions.length, 2);
  assert.equal(stops[0].session.parent, run.top);
  assert.equal(stops[0].place.line, 3);
  assert.equal(dbg.threads()[0].sessionName, 'Child process');
  await dbg.evaluate('a');
  assert.match(consoleText(run), /› a\n2\n/);
  await dbg.stepInto();
  await until(() => stops.length === 2, 5000, 'the step');
  assert.equal(stops[1].place.line, 4);
  await dbg.continue();
  await until(() => ended, 8000, 'the end');
  assert.match(consoleText(run), /a is 2\n[\s\S]*b is 5\n/);
  assert.match(consoleText(run), /fake-dap: attach .*"__pendingTargetId":"T1"/);
  await until(() => host.list().length === 0, 5000, 'the server to end');
  dbg.dispose();
});

test('stopping while paused, exceptions, breakpoints changed while running', async () => {
  const dir = tmp();
  const file = path.join(dir, 'prog.py');
  fs.writeFileSync(file, ['n = 1', 'n = 2', 'sleep(400)', 'n = 3', "raise ValueError('boom')", "print('never')", ''].join('\n'));
  let marks = { [file]: [{ line: 2 }] };
  const { host, bridge } = setup();
  let ended = null;
  const stops = [];
  const dbg = createDebugger({ bridge, breakpoints: () => marks, exceptions: () => ({ uncaught: true }), onStop: (s) => stops.push(s), onEnd: (r) => (ended = r) });
  await dbg.start(file);
  await until(() => dbg.paused(), 8000, 'the breakpoint');
  // F5 right away (before the stack is read) still goes on; a breakpoint added meanwhile is sent at once.
  marks = { [file]: [{ line: 2 }, { line: 4, condition: 'n > 1' }] };
  await dbg.setBreakpoints(file);
  assert.equal(dbg.breakpointStates(file).get(4).verified, true);
  await dbg.continue();
  await until(() => stops.length === 2, 8000, 'the new breakpoint');
  assert.equal(stops[1].place.line, 4);
  await dbg.continue();
  await until(() => stops.length === 3, 8000, 'the exception');
  assert.equal(dbg.run.reason, 'Paused on an exception: ValueError(\'boom\')');
  await dbg.continue();
  await until(() => ended, 8000, 'the end');
  assert.match(consoleText(dbg.run), /Traceback/);
  assert.match(consoleText(dbg.run), /exit code 1/);
  assert.doesNotMatch(consoleText(dbg.run), /never/);
  // Stopped while paused: the adapter goes, nothing said about it ending by itself.
  ended = null;
  marks = { [file]: [{ line: 2 }] };
  await dbg.start(file);
  await until(() => dbg.paused(), 8000, 'the breakpoint again');
  await dbg.stop();
  assert.equal(dbg.run.status, 'ended');
  assert.ok(ended);
  assert.doesNotMatch(consoleText(dbg.run), /debugpy ended/);
  await until(() => host.list().length === 0, 5000, 'the adapter to end');
  // Paused, then a pause asked while it runs.
  await dbg.start(file);
  await until(() => dbg.paused(), 8000, 'the breakpoint once more');
  await dbg.continue();
  await sleep(50);
  await dbg.pause();
  await until(() => dbg.paused() && dbg.run.reason === 'Paused', 5000, 'the pause');
  await dbg.restart();
  await until(() => dbg.paused() && dbg.run.reason === 'Paused on a breakpoint', 8000, 'the breakpoint after a restart');
  await dbg.stop();
  await until(() => host.list().length === 0, 5000, 'the adapter to end after all');
  dbg.dispose();
});

test('a page reloaded or closed: its sessions end (the program asked to end first)', async () => {
  const dir = tmp();
  const file = path.join(dir, 'prog.py');
  fs.writeFileSync(file, ['n = 1', 'n = 2', ''].join('\n'));
  const { host, bridge, sender } = setup();
  const dbg = createDebugger({ bridge, breakpoints: () => ({ [file]: [{ line: 2 }] }) });
  await dbg.start(file);
  await until(() => dbg.paused(), 8000, 'the breakpoint');
  const other = { emit() {} };
  host.stopAll(other); // another page's: nothing of this one's
  assert.equal(host.list().length, 1);
  host.stopAll(sender);
  await until(() => host.list().length === 0, 5000, 'the sessions to end');
  await until(() => dbg.run.status === 'ended', 5000, 'the client to hear it');
  dbg.dispose();
});
