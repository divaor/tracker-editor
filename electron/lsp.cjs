// Language servers (desktop): the programs that understand code (TypeScript's, Pyright…),
// spoken to over stdio with the Language Server Protocol. This module finds them on the
// computer (CATALOG: what is on PATH or in the project, never a program the page names),
// picks the project folder, starts one per (server, folder), frames the messages and keeps
// the processes in check (four at most, restarted after a crash, stopped after three).
// The page's CodeMirror client (app/js/lsp.js) talks through main.cjs's lsp:* IPC.
const { spawn: spawnProcess, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- Messages: "Content-Length: n\r\n\r\n" then n bytes of JSON ----

const MAX_MESSAGE = 64 * 1024 * 1024;

/** A message with its header, ready for the server's stdin. */
function frame(text) {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Reads framed messages from the server's stdout, in whatever chunks they arrive (split
 * headers, several messages in one chunk, characters cut in two): `onMessage(text)` for each.
 * `onError(message)` when the stream is not LSP (the reader stops then).
 */
function createReader(onMessage, onError = () => {}) {
  let buffer = Buffer.alloc(0);
  let broken = false;
  return (chunk) => {
    if (broken) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > 8192) fail('A header without its end');
        return;
      }
      const header = buffer.subarray(0, end).toString('ascii');
      const m = /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
      if (!m) return fail(`Not a language server message: ${header.slice(0, 80)}`);
      const length = Number(m[1]);
      if (length > MAX_MESSAGE) return fail('A message too large');
      if (buffer.length < end + 4 + length) return;
      const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
      buffer = buffer.subarray(end + 4 + length);
      onMessage(body);
    }
  };
  function fail(message) {
    broken = true;
    buffer = Buffer.alloc(0);
    onError(message);
  }
}

// ---- Which server, and where it is ----

/**
 * The servers this app knows. `find(ctx)` looks for one on this computer (ctx: the project
 * folder and helpers) and says how to start it: { name, command, args } or, for a script
 * Node runs, { name, script, args } (run on Electron's own Node: no Node.js needed).
 */
const CATALOG = [
  {
    id: 'typescript',
    label: 'TypeScript',
    exts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    languageIds: { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact' },
    markers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    // TypeScript 7 has its language server built in (tsc --lsp).
    install: ['npm install -g typescript'],
    // Answers to workspace/configuration, by section: F2 renames the symbol everywhere rather
    // than giving an import a local alias (VS Code's default).
    settings: Object.fromEntries(['js/ts', 'typescript', 'javascript'].map((section) => [section, { preferences: { useAliasesForRenames: false } }])),
    async find(ctx) {
      // The project's own TypeScript first: 7 and later speak LSP themselves; older ones
      // through typescript-language-server (the project's, or one installed for everyone).
      const own = ctx.typescriptIn(ctx.root);
      if (own && own.major >= 7) return { name: `TypeScript ${own.version}`, ...own.server, args: ['--lsp', '--stdio'] };
      const tls = ctx.projectBin('typescript-language-server') ?? (await ctx.onPath('typescript-language-server'));
      const preferences = { useAliasesForRenames: false };
      if (own && tls) return { name: `TypeScript ${own.version}`, ...ctx.runnable(tls), args: ['--stdio'], init: { preferences } };
      const tsc = await ctx.onPath('tsc');
      const global = tsc && ctx.typescriptOf(tsc);
      if (global && global.major >= 7) return { name: `TypeScript ${global.version}`, ...global.server, args: ['--lsp', '--stdio'] };
      if (tls) {
        // An older TypeScript next to it (installed together for everyone).
        const fallback = global?.tsserver ?? ctx.siblingTsserver(tls);
        return { name: global ? `TypeScript ${global.version}` : 'typescript-language-server', ...ctx.runnable(tls), args: ['--stdio'], init: { preferences, ...(fallback ? { tsserver: { fallbackPath: fallback } } : {}) } };
      }
      return null;
    },
  },
  {
    id: 'python',
    label: 'Python (Pyright)',
    exts: ['.py', '.pyi'],
    languageIds: { '.py': 'python', '.pyi': 'python' },
    markers: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'setup.cfg', 'requirements.txt'],
    install: ['npm install -g pyright', 'pip install pyright'],
    async find(ctx) {
      for (const name of ['pyright-langserver', 'basedpyright-langserver']) {
        const found = ctx.projectBin(name) ?? (await ctx.onPath(name));
        if (found) return { name: name.startsWith('based') ? 'basedpyright' : 'Pyright', ...ctx.runnable(found), args: ['--stdio'] };
      }
      return null;
    },
  },
];

const catalogFor = (file) => {
  const ext = path.extname(String(file)).toLowerCase();
  return CATALOG.find((e) => e.exts.includes(ext)) ?? null;
};

/**
 * The project a file belongs to: the nearest folder up from it with one of `markers` (or a
 * .git), never above `stop` (the folder the person picked); else the file's own folder.
 */
function findRoot(file, markers, { stop = '', exists = fs.existsSync } = {}) {
  const start = path.dirname(file);
  const limit = stop && isInside(stop, start) ? path.resolve(stop) : null;
  let gitRoot = null;
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (markers.some((m) => exists(path.join(dir, m)))) return dir;
    if (!gitRoot && exists(path.join(dir, '.git'))) gitRoot = dir;
    if (!limit || dir === limit || path.dirname(dir) === dir) break;
  }
  return gitRoot ?? start;
}
const isInside = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** A program on PATH: the first folder holding `name` (on Windows, with PATHEXT's extensions). */
function searchPath(name, { env = process.env, platform = process.platform, exists = isFile } = {}) {
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  const exts = platform === 'win32' ? ['.cmd', '.exe', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter((e) => e && e !== '.cmd' && e !== '.exe'), ''] : [''];
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * How to run a program that was found: Node scripts (an npm link, or the script an npm
 * .cmd shim names) on Electron's own Node; anything else as it is.
 */
function runnable(found, { platform = process.platform, realpath = (p) => fs.realpathSync(p), read = (p) => fs.readFileSync(p, 'utf8').slice(0, 4096) } = {}) {
  let real = found;
  try {
    real = realpath(found);
  } catch {
    // keep the path as found
  }
  if (/\.(c|m)?js$/i.test(real)) return { script: real };
  if (platform === 'win32' && /\.cmd$/i.test(real)) {
    const shim = /"%~?dp0%?\\([^"]+)"\s+%\*/i.exec(safeRead(read, real));
    if (shim) return { script: path.win32.join(path.win32.dirname(real), shim[1]) };
    return { command: real, shell: true };
  }
  if (platform !== 'win32' && /^#!.*\bnode\b/.test(safeRead(read, real).split('\n')[0])) return { script: real };
  return { command: real };
}
const safeRead = (read, p) => {
  try {
    return read(p);
  } catch {
    return '';
  }
};

/**
 * The TypeScript in a folder's node_modules: { version, major, tsserver, server }. TypeScript 7
 * is a native program (`server`: its tsc, from the package for this platform, else the script
 * that starts it); older ones have tsserver.js, which typescript-language-server uses.
 */
function typescriptIn(dir, opts) {
  return typescriptPackage(path.join(dir, 'node_modules', 'typescript'), opts);
}
function typescriptPackage(dir, { read = (p) => fs.readFileSync(p, 'utf8'), exists = isFile, resolve = require.resolve, platform = process.platform, arch = process.arch } = {}) {
  try {
    const { version } = JSON.parse(read(path.join(dir, 'package.json')));
    const major = Number(String(version).split('.')[0]);
    const tsserver = path.join(dir, 'lib', 'tsserver.js');
    let server = null;
    if (major >= 7) {
      let exe = null;
      try {
        const pkg = resolve(`@typescript/typescript-${platform}-${arch}/package.json`, { paths: [dir] });
        exe = path.join(path.dirname(pkg), 'lib', platform === 'win32' ? 'tsc.exe' : 'tsc');
      } catch {
        // not installed for this platform: the script finds it, or says why
      }
      server = exe && exists(exe) ? { command: exe } : { script: path.join(dir, 'lib', 'tsc.js') };
    }
    return { version, major, tsserver: exists(tsserver) ? tsserver : null, server };
  } catch {
    return null;
  }
}

/** The PATH of a login shell (macOS and Linux): apps started from the dock or menu get less. */
let loginPath = null;
function shellPath({ env = process.env, platform = process.platform, run = execFile } = {}) {
  if (platform === 'win32') return Promise.resolve('');
  loginPath ??= new Promise((resolve) => {
    const shell = env.SHELL || '/bin/sh';
    run(shell, ['-ilc', 'printf "\\n__TE_PATH__%s\\n" "$PATH"'], { timeout: 4000, env: { ...env, TERM: 'dumb' } }, (_err, stdout) => {
      resolve(/__TE_PATH__(.*)/.exec(String(stdout ?? ''))?.[1]?.trim() ?? '');
    });
  });
  return loginPath;
}
/**
 * PATH with the login shell's folders (`extra`) and the usual install places (`known`) added
 * after the app's own.
 */
function searchEnv(env, extra, platform = process.platform, known = true) {
  const sep = platform === 'win32' ? ';' : ':';
  const home = os.homedir();
  const places = !known
    ? []
    : platform === 'win32'
      ? [env.APPDATA && path.win32.join(env.APPDATA, 'npm')]
      : [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  const dirs = [...String(env.PATH ?? env.Path ?? '').split(sep), ...String(extra || '').split(sep), ...places].filter(Boolean);
  const out = { ...env, PATH: [...new Set(dirs)].join(sep) };
  if (platform === 'win32' && env.Path !== undefined) delete out.Path;
  return out;
}

/** The server's environment: the app's, without Electron's variables (nor an AppImage's libraries). */
function serverEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null || /^(ELECTRON_|CHROME_)|^(APPIMAGE|APPDIR|ARGV0|OWD)$/.test(k)) continue;
    out[k] = v;
  }
  if (env.APPDIR && out.LD_LIBRARY_PATH) {
    const kept = out.LD_LIBRARY_PATH.split(':').filter((p) => p && !p.startsWith(env.APPDIR));
    if (kept.length) out.LD_LIBRARY_PATH = kept.join(':');
    else delete out.LD_LIBRARY_PATH;
  }
  return out;
}

/**
 * Looks for the server for a file's project: { entry, root, found, env } (found null when
 * missing). `login: false` looks only on `env`'s PATH (the tests).
 */
async function locate(file, { stop = '', env = process.env, platform = process.platform, login = true } = {}) {
  const entry = catalogFor(file);
  if (!entry) return null;
  const root = findRoot(file, entry.markers, { stop });
  const searchIn = searchEnv(env, login ? await shellPath({ env, platform }) : '', platform, login);
  const binIn = (dir, name) => {
    const bin = path.join(dir, 'node_modules', '.bin', name);
    for (const candidate of platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`] : [bin]) if (isFile(candidate)) return candidate;
    return null;
  };
  const ctx = {
    root,
    projectBin: (name) => binIn(root, name),
    onPath: async (name) => searchPath(name, { env: searchIn, platform }),
    runnable: (found) => runnable(found, { platform }),
    typescriptIn: (dir) => typescriptIn(dir),
    // `tsc` found on PATH → the TypeScript package it belongs to.
    typescriptOf: (tsc) => {
      const script = runnable(tsc, { platform }).script;
      return script ? typescriptPackage(path.resolve(path.dirname(script), '..')) : null;
    },
    // typescript-language-server installed for everyone → the TypeScript installed next to it.
    siblingTsserver: (tls) => {
      const script = runnable(tls, { platform }).script;
      const parts = script ? script.split(/[\\/]node_modules[\\/]/) : [];
      return parts.length > 1 ? (typescriptIn(parts.slice(0, -1).join(`${path.sep}node_modules${path.sep}`))?.tsserver ?? null) : null;
    },
  };
  const found = await entry.find(ctx);
  return { entry, root, found, env: searchIn };
}

// ---- Running them ----

const MAX_SERVERS = 4;
const STDERR_LINES = 200;
const CRASH_WINDOW = 5 * 60 * 1000;

/**
 * The running servers. `send(sender, channel, payload)` reaches the page; `spawn` and
 * `nodePath` (the program that runs Node scripts: Electron with ELECTRON_RUN_AS_NODE) stand in
 * for the real ones in the tests.
 */
function createLspHost({ send, spawn = spawnProcess, nodePath = process.execPath, env = process.env, platform = process.platform, now = Date.now, locateServer = locate } = {}) {
  const servers = new Map(); // id → server
  let nextId = 1;

  const status = (s, state, message = '') => {
    s.state = state;
    s.message = message;
    send(s.sender, 'lsp:status', { id: s.id, state, message, server: s.name, generation: s.generation });
  };

  function launch(s) {
    const { found } = s;
    const base = serverEnv(s.env);
    // A .cmd that is not an npm shim goes through cmd.exe (shell), its path quoted.
    const program = found.shell ? `"${found.command}"` : found.command;
    const [command, args, extraEnv] = found.script ? [nodePath, [found.script, ...found.args], { ELECTRON_RUN_AS_NODE: '1' }] : [program, found.args, {}];
    s.commandLine = [found.script ? 'node' : command, ...(found.script ? [found.script, ...found.args] : args)].join(' ');
    let proc;
    try {
      proc = spawn(command, args, { cwd: s.root, env: { ...base, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: Boolean(found.shell) });
    } catch (err) {
      status(s, 'stopped', `Could not start ${s.name}: ${err.message}`);
      return;
    }
    s.proc = proc;
    s.stopping = false;
    // Each start is a new process: the page connects to it again (initialize, open files).
    s.generation = (s.generation ?? 0) + 1;
    status(s, 'starting');
    const read = createReader(
      (text) => send(s.sender, 'lsp:message', { id: s.id, data: text }),
      (problem) => {
        addStderr(s, `[Tracker Editor] ${problem}`);
        proc.kill();
      },
    );
    proc.stdout.on('data', read);
    let partial = '';
    proc.stderr.on('data', (chunk) => {
      const lines = (partial + chunk.toString('utf8')).split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) addStderr(s, line);
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => {
      addStderr(s, `[Tracker Editor] ${err.message}`);
      exited(s, proc, null);
    });
    proc.on('exit', (code) => exited(s, proc, code));
  }

  function addStderr(s, line) {
    s.stderr.push(line);
    if (s.stderr.length > STDERR_LINES) s.stderr.splice(0, s.stderr.length - STDERR_LINES);
  }

  function exited(s, proc, code) {
    if (s.proc !== proc) return;
    s.proc = null;
    if (s.stopping || s.removed) {
      if (!s.removed) status(s, 'stopped', '');
      return;
    }
    const t = now();
    s.crashes = s.crashes.filter((c) => t - c < CRASH_WINDOW).concat(t);
    if (s.crashes.length >= 3) return status(s, 'stopped', `${s.name} stopped working (it ended ${s.crashes.length} times in 5 minutes${code != null ? `, last with code ${code}` : ''}). Restart it from the Language servers panel.`);
    const wait = 1000 * 2 ** (s.crashes.length - 1);
    status(s, 'restarting', `${s.name} ended${code != null ? ` (code ${code})` : ''}; starting it again…`);
    s.retry = setTimeout(() => {
      if (!s.removed && !s.proc) launch(s);
    }, wait);
    s.retry.unref?.();
  }

  function stopProcess(s) {
    clearTimeout(s.retry);
    const proc = s.proc;
    if (!proc) return;
    s.stopping = true;
    try {
      proc.stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', id: '__shutdown__', method: 'shutdown', params: null })));
      proc.stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: null })));
    } catch {
      // gone already
    }
    const kill = setTimeout(() => {
      if (s.proc === proc) proc.kill();
    }, 2000);
    kill.unref?.();
  }

  // The fifth server stops the one used longest ago.
  function makeRoom() {
    const live = [...servers.values()].filter((s) => !s.removed);
    if (live.length < MAX_SERVERS) return;
    const oldest = live.sort((a, b) => a.used - b.used)[0];
    stop(oldest.id, `${oldest.name} was stopped: at most ${MAX_SERVERS} language servers run at once.`);
  }

  async function start(sender, file, { stop: stopDir = '' } = {}) {
    const entry = catalogFor(file);
    if (!entry) return { none: true };
    const languageId = entry.languageIds[path.extname(file).toLowerCase()];
    const root = findRoot(file, entry.markers, { stop: stopDir });
    for (const s of servers.values()) {
      if (s.entry.id === entry.id && s.root === root && s.sender === sender && !s.removed) {
        s.used = now();
        // Stopped after crashes: Restart in the panel brings it back, not every file opened.
        return info(s, languageId);
      }
    }
    const located = await locateServer(file, { stop: stopDir, env, platform });
    if (!located?.found) return { missing: { id: entry.id, language: entry.label, install: entry.install, root } };
    makeRoom();
    const s = { id: `lsp${nextId++}`, entry, root, name: located.found.name, found: located.found, env: located.env ?? env, sender, stderr: [], crashes: [], used: now(), state: 'starting', message: '' };
    servers.set(s.id, s);
    launch(s);
    return info(s, languageId);
  }

  const info = (s, languageId) => ({ id: s.id, server: s.name, language: s.entry.label, root: s.root, languageId, init: s.found.init ?? null, settings: s.entry.settings ?? null, state: s.state, message: s.message, generation: s.generation ?? 0 });

  // `sender` (the page asking): only its own servers.
  const own = (id, sender) => {
    const s = servers.get(id);
    return s && (!sender || s.sender === sender) ? s : null;
  };

  function write(id, text, sender) {
    const s = own(id, sender);
    if (!s?.proc || typeof text !== 'string' || text.length > MAX_MESSAGE) return false;
    s.used = now();
    try {
      s.proc.stdin.write(frame(text));
      return true;
    } catch {
      return false;
    }
  }

  function stop(id, message = '', sender) {
    const s = own(id, sender);
    if (!s) return false;
    s.removed = true;
    stopProcess(s);
    servers.delete(id);
    send(s.sender, 'lsp:status', { id, state: 'removed', message, server: s.name });
    return true;
  }

  function restart(id, sender) {
    const s = own(id, sender);
    if (!s) return false;
    s.crashes = [];
    const relaunch = () => {
      if (!s.removed) launch(s);
    };
    if (s.proc) {
      const proc = s.proc;
      stopProcess(s);
      proc.once('exit', () => setTimeout(relaunch, 50));
    } else relaunch();
    return true;
  }

  const list = (sender) =>
    [...servers.values()]
      .filter((s) => !sender || s.sender === sender)
      .map((s) => ({ id: s.id, server: s.name, language: s.entry.label, root: s.root, state: s.state, message: s.message, command: s.commandLine, pid: s.proc?.pid ?? null, stderr: s.stderr.slice(-60) }));

  const stopAll = (sender) => {
    for (const s of [...servers.values()]) if (!sender || s.sender === sender) stop(s.id);
  };

  return { start, write, stop, restart, list, stopAll };
}

module.exports = { frame, createReader, CATALOG, catalogFor, findRoot, searchPath, runnable, typescriptIn, searchEnv, serverEnv, shellPath, locate, createLspHost, MAX_SERVERS };
