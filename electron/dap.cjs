// Debugging (desktop): the debug adapters, spoken to with the Debug Adapter Protocol (the same
// framing as the language servers'). The page names a file, never a program: this module
// picks the adapter by the file's type and finds what runs it on the computer, and builds the
// launch configuration itself (debugTools.js), so a `launch` or `attach` the page sends is
// filled in here (as are the child sessions js-debug asks for):
// - Python through debugpy: the project's Python (a .venv or venv next to the file or above it,
//   up to the folder the person picked; else python3 or python on PATH and the login shell's
//   PATH), one that imports debugpy; `python -m debugpy.adapter` over stdio.
// - JavaScript and TypeScript through js-debug's standalone DAP server (dapDebugServer.js of a
//   pinned js-debug-dap release, in <userData>/debuggers/js-debug/), run on the editor's own
//   Node.js (Electron's, ELECTRON_RUN_AS_NODE) on 127.0.0.1 at a free port and reached over
//   TCP; the programs run on the person's own `node`. Its startDebugging requests (each process
//   is a child session) open another connection to the same server.
// What is missing comes back as commands to type into a terminal (nothing is downloaded or
// installed here). A page reloaded or closed ends its sessions (main.cjs).
const { spawn: spawnProcess, execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { frame, createReader, findRoot, searchPath, searchEnv, serverEnv, shellPath } = require('./lsp.cjs');

const APP_DIR = path.join(__dirname, '..', 'app');
const loadTools = () => import(pathToFileURL(path.join(APP_DIR, 'js', 'debugTools.js')).href);

/** The js-debug release the install command fetches (its standalone DAP server). */
const JS_DEBUG_VERSION = '1.97.1';
const jsDebugUrl = (version = JS_DEBUG_VERSION) => `https://github.com/microsoft/vscode-js-debug/releases/download/v${version}/js-debug-dap-v${version}.tar.gz`;
/** Where js-debug's server is once unpacked into `dir` (<userData>/debuggers). */
const jsDebugServer = (dir) => path.join(dir, 'js-debug', 'src', 'dapDebugServer.js');

// A copy of debugTools.js's map (the tests keep them equal): this module is CommonJS.
const EXT_ADAPTER = { py: 'python', pyw: 'python', js: 'node', mjs: 'node', cjs: 'node', ts: 'node', mts: 'node', cts: 'node' };
const adapterKindOf = (file) => EXT_ADAPTER[(/\.([^.\\/]+)$/.exec(String(file))?.[1] ?? '').toLowerCase()] ?? null;
const LABELS = { python: 'debugpy', node: 'js-debug' };
const LANGUAGES = { python: 'Python', node: 'JavaScript and TypeScript' };
const PY_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'pytest.ini', 'tox.ini', 'Pipfile', 'requirements.txt'];

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
const isInside = (parent, child, p = path) => {
  const rel = p.relative(p.resolve(parent), p.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
};

/**
 * The Pythons that may run a file, best first: the virtual environments (.venv, venv) in its
 * folder and those above it up to `stop` (the folder the person picked; only its own folder
 * without one), then python3 and python on `env`'s PATH (python first on Windows).
 */
function pythonCandidates(file, { stop = '', env = process.env, platform = process.platform, exists = isFile } = {}) {
  const out = [];
  // The platform's own paths (the tests ask for another platform's).
  const P = platform === 'win32' ? path.win32 : platform === process.platform ? path : path.posix;
  const bin = (venv) => (platform === 'win32' ? P.join(venv, 'Scripts', 'python.exe') : P.join(venv, 'bin', 'python'));
  const start = P.dirname(file);
  const limit = stop && isInside(stop, start, P) ? P.resolve(stop) : null;
  for (let dir = start; ; dir = P.dirname(dir)) {
    for (const name of ['.venv', 'venv']) {
      const p = bin(P.join(dir, name));
      if (exists(p) && !out.includes(p)) out.push(p);
    }
    if (!limit || dir === limit || P.dirname(dir) === dir) break;
  }
  for (const name of platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    const p = searchPath(name, { env, platform, exists });
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** Does `python` import `module`? (`-c "import debugpy"`.) */
function imports(python, module, { run = execFile, env = process.env } = {}) {
  return new Promise((resolve) => {
    try {
      run(python, ['-c', `import ${module}`], { timeout: 15000, windowsHide: true, env }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

// A word for a shell: as it is when plain, else quoted its way.
function quote(kind, s) {
  if (kind === 'powershell') return `'${String(s).replace(/'/g, "''")}'`;
  if (kind === 'cmd') return `"${String(s).replace(/"/g, '')}"`;
  return /^[\w./@:+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`;
}
/**
 * The command that installs debugpy for `python`, for each kind of shell ({ posix, powershell,
 * cmd }; Windows' Git Bash takes the posix one with forward slashes).
 */
function pipInstall(python, platform = process.platform) {
  const posix = platform === 'win32' ? python.replace(/\\/g, '/') : python;
  return { posix: `${quote('posix', posix)} -m pip install debugpy`, powershell: `& ${quote('powershell', python)} -m pip install debugpy`, cmd: `${quote('cmd', python)} -m pip install debugpy` };
}
/** The command that downloads the pinned js-debug and unpacks it into `dir`, for each kind of shell. */
function jsDebugInstall(dir, platform = process.platform, version = JS_DEBUG_VERSION) {
  const url = jsDebugUrl(version);
  if (platform === 'win32') {
    const fwd = dir.replace(/\\/g, '/');
    return {
      powershell: `New-Item -ItemType Directory -Force -Path ${quote('powershell', dir)} | Out-Null; curl.exe -fsSLo "$env:TEMP\\js-debug-dap.tar.gz" ${url}; tar -xzf "$env:TEMP\\js-debug-dap.tar.gz" -C ${quote('powershell', dir)}`,
      cmd: `mkdir ${quote('cmd', dir)} 2>nul & curl.exe -fsSLo "%TEMP%\\js-debug-dap.tar.gz" ${url} && tar -xzf "%TEMP%\\js-debug-dap.tar.gz" -C ${quote('cmd', dir)}`,
      posix: `mkdir -p ${quote('posix', fwd)} && curl -fsSL ${url} | tar --force-local -xz -C ${quote('posix', fwd)}`,
    };
  }
  return { posix: `mkdir -p ${quote('posix', dir)} && curl -fsSL ${url} | tar -xz -C ${quote('posix', dir)}` };
}

/** What is missing for Python, and how to install it. */
function missingPython(python, platform = process.platform, root = '') {
  const venv = platform === 'win32' ? '.venv\\Scripts\\python -m pip install debugpy' : '.venv/bin/python -m pip install debugpy';
  return {
    adapter: 'python',
    label: 'debugpy',
    language: 'Python',
    root,
    python,
    install: python ? [pipInstall(python, platform)] : [],
    note: python
      ? `${python} has no debugpy (the debugger Python programs run under). If pip refuses (an “externally managed” Python), make a virtual environment in the project first (${platform === 'win32' ? 'python' : 'python3'} -m venv .venv), then: ${venv}.`
      : `Python is not found on this computer: install it (python.org, or your system's packages), then debugpy with ${platform === 'win32' ? 'python' : 'python3'} -m pip install debugpy.`,
  };
}
/** What is missing for JavaScript and TypeScript: Node.js (the programs run on it) and js-debug. */
function missingJs({ node, server, dir, platform = process.platform, root = '' }) {
  return {
    adapter: 'node',
    label: 'js-debug',
    language: 'JavaScript and TypeScript',
    root,
    install: server ? [] : [jsDebugInstall(dir, platform)],
    note: [
      !node && 'Node.js is not found on this computer: install it from nodejs.org (the programs you debug run on it).',
      !server && `js-debug ${JS_DEBUG_VERSION} (VS Code’s JavaScript debugger, its standalone server; it runs on the editor’s own Node.js) goes in ${dir}: the command downloads it from GitHub and unpacks it there.`,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

/** A file under `start` or a folder above it, up to `stop`: the first found, or ''. */
function findUp(start, rel, { stop = '', exists = isFile } = {}) {
  const limit = stop && isInside(stop, start) ? path.resolve(stop) : null;
  for (let dir = start; ; dir = path.dirname(dir)) {
    const p = path.join(dir, rel);
    if (exists(p)) return p;
    if (!limit || dir === limit || path.dirname(dir) === dir) return '';
  }
}

/**
 * What debugs `file`: { kind, root, found, run } (`found`: what the launch configuration
 * needs; `run`: { transport 'stdio' | 'tcp', command or script (a Node script, run on the
 * editor's Node.js), args, env }), { kind, root, missing } or null (a type with no debugger).
 * `login: false` looks only on `env`'s PATH (the tests).
 */
async function locate(file, { stop = '', debuggersDir = '', env = process.env, platform = process.platform, login = true, run = execFile, exists = isFile } = {}) {
  const kind = adapterKindOf(file);
  if (!kind) return null;
  const searchIn = searchEnv(env, login ? await shellPath({ env, platform }) : '', platform, login);
  const programEnv = serverEnv(searchIn);
  if (kind === 'python') {
    const root = findRoot(file, PY_MARKERS, { stop });
    const pythons = pythonCandidates(file, { stop, env: searchIn, platform, exists });
    for (const python of pythons) {
      if (await imports(python, 'debugpy', { run, env: programEnv })) return { kind, root, found: { python }, run: { transport: 'stdio', command: python, args: ['-m', 'debugpy.adapter'], env: programEnv } };
    }
    return { kind, root, missing: missingPython(pythons[0] ?? null, platform, root) };
  }
  const root = findRoot(file, ['package.json'], { stop });
  const node = searchPath('node', { env: searchIn, platform, exists });
  const server = debuggersDir && exists(jsDebugServer(debuggersDir)) ? jsDebugServer(debuggersDir) : null;
  if (!node || !server) return { kind, root, missing: missingJs({ node, server, dir: debuggersDir, platform, root }) };
  const near = (rel) => findUp(root, rel, { stop, exists });
  const found = { node, tsx: Boolean(near(path.join('node_modules', 'tsx', 'package.json'))), programs: { vitest: near(path.join('node_modules', 'vitest', 'vitest.mjs')), jest: near(path.join('node_modules', 'jest', 'bin', 'jest.js')) } };
  return { kind, root, found, run: { transport: 'tcp', script: server, args: [], env: programEnv } };
}

/** A free port on 127.0.0.1 (js-debug's server is told to listen there). */
function pickPort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, host, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Connects to a server that is starting: tried again every `every` ms until `wait` passes or it ends. */
function connectWhenReady(port, { host = '127.0.0.1', connect = (p, h) => net.connect(p, h), alive = () => true, wait = 15000, every = 150 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      if (!alive()) return reject(new Error('it ended before it listened'));
      const socket = connect(port, host);
      const failed = () => {
        socket.destroy();
        if (Date.now() - started > wait) reject(new Error(`no answer on port ${port} after ${Math.round(wait / 1000)} s`));
        else setTimeout(attempt, every);
      };
      socket.once('error', failed);
      socket.once('connect', () => {
        socket.removeListener('error', failed);
        resolve(socket);
      });
    };
    attempt();
  });
}

const STDERR_LINES = 100;
const DISCONNECT_SEQ = 1_000_000_000; // ours, when the page cannot say it any more

/**
 * The running sessions. `send(sender, channel, payload)` reaches the page ('dap:message'
 * { id, data } with the adapter's message as text, 'dap:exit' { id, code, message }). The
 * others stand in for the real ones in the tests.
 */
function createDapHost({ send, spawn = spawnProcess, connect = (port, host) => net.connect(port, host), nodePath = process.execPath, locateAdapter = locate, tools = loadTools, freePort = pickPort, debuggersDir = '', graceMs = 1500 } = {}) {
  const sessions = new Map(); // id → session
  let nextId = 1;

  const info = (s) => ({ id: s.id, adapter: s.kind, label: LABELS[s.kind] ?? s.kind, file: s.file, cwd: s.cwd, name: s.launch.arguments?.name ?? '', parent: s.parent?.id ?? null, config: s.launch.arguments });

  function newSession(sender, fields) {
    const s = { id: nextId++, sender, children: new Set(), starts: new Map(), stderr: [], ended: false, write: null, proc: null, socket: null, ...fields };
    sessions.set(s.id, s);
    fields.parent?.children.add(s);
    return s;
  }
  const addStderr = (s, chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) s.stderr.push(line);
    if (s.stderr.length > STDERR_LINES) s.stderr.splice(0, s.stderr.length - STDERR_LINES);
  };

  // The adapter's messages: to the page as they are; a startDebugging request is noted (the
  // child it asks for is made from what the adapter said, not from what the page says).
  function reader(s) {
    return createReader(
      (text) => {
        try {
          const msg = JSON.parse(text);
          if (msg?.type === 'request' && msg.command === 'startDebugging') {
            s.starts.set(msg.seq, msg.arguments ?? {});
            if (s.starts.size > 50) s.starts.delete(s.starts.keys().next().value);
          }
        } catch {
          // not JSON: the page says so
        }
        send(s.sender, 'dap:message', { id: s.id, data: text });
      },
      (problem) => {
        addStderr(s, `[Tracker Editor] ${problem}`);
        end(s, null);
      },
    );
  }

  function wireSocket(s, socket) {
    s.socket = socket;
    s.write = (buf) => socket.write(buf);
    socket.setNoDelay?.(true);
    socket.on('data', reader(s));
    socket.on('error', (err) => addStderr(s, `[Tracker Editor] ${err.message}`));
    socket.on('close', () => end(s, null));
  }

  // The session ended (its process or its connection did): the page hears it once.
  function end(s, code) {
    if (s.ended) return;
    s.ended = true;
    sessions.delete(s.id);
    s.parent?.children.delete(s);
    send(s.sender, 'dap:exit', { id: s.id, code, message: s.stderr.slice(-8).join('\n') });
    for (const c of [...s.children]) close(c, { graceful: false });
    if (!s.parent) killLater(s);
  }

  function killLater(s, ms = 300) {
    const proc = s.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode) return;
    const t = setTimeout(() => {
      if (proc.exitCode === null && !proc.signalCode) proc.kill();
    }, ms);
    t.unref?.();
  }

  // Ends a session: `graceful` first asks the adapter to end the program (disconnect), for when
  // the page cannot any more (reloaded or closed).
  function close(s, { graceful = false } = {}) {
    if (s.ended) return;
    for (const c of [...s.children]) close(c, { graceful });
    const wait = graceful ? graceMs : 0;
    if (graceful && s.write) {
      try {
        s.write(frame(JSON.stringify({ seq: DISCONNECT_SEQ, type: 'request', command: 'disconnect', arguments: { terminateDebuggee: true } })));
      } catch {
        // gone already
      }
    }
    const finish = () => {
      try {
        s.socket?.end();
        s.proc?.stdin?.end();
      } catch {
        // gone already
      }
      if (!s.parent) killLater(s, 800);
      setTimeout(() => {
        s.socket?.destroy();
        end(s, null);
      }, 200).unref?.();
    };
    if (wait) setTimeout(finish, wait).unref?.();
    else finish();
  }

  function spawnAdapter(s, run, extraArgs = []) {
    const [command, args, env] = run.script ? [nodePath, [run.script, ...(run.args ?? []), ...extraArgs], { ...(run.env ?? {}), ELECTRON_RUN_AS_NODE: '1' }] : [run.command, [...(run.args ?? []), ...extraArgs], run.env ?? process.env];
    s.commandLine = [run.script ? 'node' : command, ...(run.script ? [run.script, ...(run.args ?? []), ...extraArgs] : args)].join(' ');
    const proc = spawn(command, args, { cwd: s.cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    s.proc = proc;
    proc.stderr?.on('data', (chunk) => addStderr(s, chunk.toString('utf8')));
    proc.stdin?.on('error', () => {});
    proc.on('error', (err) => {
      addStderr(s, `[Tracker Editor] ${err.message}`);
      end(s, null);
    });
    proc.on('exit', (code) => end(s, code));
    return proc;
  }

  /**
   * Starts debugging `file` (checked by main.cjs): { id, adapter, label, … } (the top session),
   * { missing }, { none } or { error }. `test`: { framework, target } (debugTools' cleanTest).
   */
  async function start(sender, file, { stop = '', test = null } = {}) {
    const found = await locateAdapter(file, { stop, debuggersDir });
    if (!found) return { none: 'Debugging works for Python, JavaScript and TypeScript files (.py, .js, .mjs, .cjs, .ts, .mts, .cts).' };
    if (found.missing) return { missing: found.missing };
    const t = await tools();
    const spec = test ? t.cleanTest(test) : null;
    if (test && (!spec || t.DEBUG_FRAMEWORKS[spec.framework] !== found.kind)) return { error: 'This test cannot be debugged here: pytest, unittest, node:test, Vitest and Jest tests can.' };
    const cwd = spec ? found.root : path.dirname(file);
    let config;
    try {
      config = t.launchConfig(found.kind, { file, cwd, ...found.found, test: spec });
    } catch (err) {
      return { error: err.message };
    }
    const s = newSession(sender, { kind: found.kind, file, cwd, launch: { command: 'launch', arguments: config }, parent: null });
    try {
      if (found.run.transport === 'tcp') {
        const port = await freePort();
        const proc = spawnAdapter(s, found.run, [String(port), '127.0.0.1']);
        proc.stdout?.on('data', (chunk) => addStderr(s, chunk.toString('utf8')));
        s.port = port;
        wireSocket(s, await connectWhenReady(port, { connect, alive: () => !s.ended && proc.exitCode === null }));
      } else {
        const proc = spawnAdapter(s, found.run);
        s.write = (buf) => proc.stdin.write(buf);
        proc.stdout.on('data', reader(s));
      }
    } catch (err) {
      const why = s.stderr.slice(-4).join('\n');
      close(s);
      return { error: `Could not start ${LABELS[found.kind]}: ${err.message}${why ? `\n${why}` : ''}` };
    }
    return info(s);
  }

  /**
   * A child session the adapter asked for (js-debug's startDebugging, request `seq` of session
   * `parentId`): another connection to the same server, launched or attached with what the
   * adapter gave. → its info, or { error }.
   */
  async function child(sender, parentId, seq) {
    const parent = sessions.get(parentId);
    if (!parent || parent.sender !== sender) return { error: 'That session has ended.' };
    const args = parent.starts.get(seq);
    let top = parent;
    while (top.parent) top = top.parent;
    if (!args || !top.port) return { error: 'The adapter did not ask for that session.' };
    parent.starts.delete(seq);
    const request = args.request === 'attach' ? 'attach' : 'launch';
    const s = newSession(sender, { kind: parent.kind, file: parent.file, cwd: parent.cwd, launch: { command: request, arguments: args.configuration ?? {} }, parent });
    try {
      wireSocket(s, await connectWhenReady(top.port, { connect, alive: () => !s.ended && !top.ended, wait: 5000 }));
    } catch (err) {
      close(s);
      return { error: `Could not reach ${LABELS[s.kind]}: ${err.message}` };
    }
    return info(s);
  }

  /**
   * A message from the page to a session. Launch and attach (and restart) carry the
   * configuration made here, whatever the page put in them.
   */
  function write(id, message, sender) {
    const s = sessions.get(id);
    if (!s || s.ended || (sender && s.sender !== sender) || !s.write) return false;
    let msg;
    try {
      msg = typeof message === 'string' ? JSON.parse(message) : message;
    } catch {
      return false;
    }
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'request') {
      if (msg.command === 'launch' || msg.command === 'attach') msg = { ...msg, command: s.launch.command, arguments: s.launch.arguments };
      else if (msg.command === 'restart') msg = { ...msg, arguments: { arguments: s.launch.arguments } };
      else if (msg.command === 'startDebugging' || msg.command === 'runInTerminal') return false;
    }
    try {
      s.write(frame(JSON.stringify(msg)));
    } catch {
      return false;
    }
    return true;
  }

  /** Ends a session (a top one with its children and its process). */
  function stop(id, sender) {
    const s = sessions.get(id);
    if (!s || (sender && s.sender !== sender)) return false;
    close(s);
    return true;
  }
  /** Ends a page's sessions (all of them without a page): the program is asked to end first. */
  function stopAll(sender) {
    for (const s of [...sessions.values()]) if (!s.parent && (!sender || s.sender === sender)) close(s, { graceful: true });
  }
  /** The adapters' processes ended now (the app is quitting: no time to ask). */
  function killAll() {
    for (const s of [...sessions.values()]) {
      try {
        s.socket?.destroy();
        if (s.proc && s.proc.exitCode === null && !s.proc.signalCode) s.proc.kill();
      } catch {
        // gone already
      }
    }
  }
  /** The sessions (for the tests). */
  function list(sender) {
    return [...sessions.values()].filter((s) => !sender || s.sender === sender).map((s) => ({ ...info(s), command: s.commandLine ?? '', stderr: [...s.stderr] }));
  }

  return { start, child, write, stop, stopAll, killAll, list };
}

module.exports = { JS_DEBUG_VERSION, jsDebugUrl, jsDebugServer, EXT_ADAPTER, adapterKindOf, pythonCandidates, imports, pipInstall, jsDebugInstall, missingPython, missingJs, locate, pickPort, connectWhenReady, createDapHost };
