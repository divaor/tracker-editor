// A shell on this computer for the terminal panel (desktop): the person's own shell in a
// pseudo-terminal (node-pty), with the face of a shell on a server (remote.cjs openShell):
// 'data', 'exit' and 'close' events, write, setWindow and close. The page cannot name the
// program or its arguments: it names one of the shells found here (listShells: PowerShell 7,
// Windows PowerShell, cmd, Git Bash and WSL on Windows; the person's own, zsh, bash, fish
// elsewhere), or gets the first, the default. Shells are started with shellHooks.cjs's
// integration, so they say their folder after each command.
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { integrate } = require('./shellHooks.cjs');

let pty = null;
function loadPty() {
  try {
    pty ??= require('@lydell/node-pty');
  } catch {
    throw new Error('The terminal for this computer is not available in this build.');
  }
  return pty;
}

// Where shells live elsewhere than on Windows, and the ones offered.
const POSIX_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin'];
const POSIX_SHELLS = [
  ['zsh', 'zsh'],
  ['bash', 'Bash'],
  ['fish', 'fish'],
  ['sh', 'sh'],
];

/**
 * The shells on this computer: [{ id, label, file, args, kind, integration }], the default
 * first. `kind` says how commands are quoted for it ('powershell', 'cmd', 'posix', 'wsl');
 * `integration` which startup hook says its folder ('bash', 'zsh', 'fish', 'powershell',
 * 'cmd', or null). `distros`: WSL's distributions (listWslDistros), each a shell of its own.
 */
function listShells({ platform = process.platform, env = process.env, exists = fs.existsSync, distros = [] } = {}) {
  if (platform === 'win32') {
    const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
    const onPath = (name) => dirs.map((d) => path.win32.join(d.replace(/^"|"$/g, ''), name)).find((p) => exists(p)) ?? null;
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    const out = [];
    const pwsh = onPath('pwsh.exe');
    if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell 7', file: pwsh, args: ['-NoLogo'], kind: 'powershell', integration: 'powershell' });
    out.push({ id: 'powershell', label: 'Windows PowerShell', file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'], kind: 'powershell', integration: 'powershell' });
    out.push({ id: 'cmd', label: 'Command Prompt', file: env.ComSpec || path.win32.join(root, 'System32', 'cmd.exe'), args: [], kind: 'cmd', integration: 'cmd' });
    // Git Bash: Git for Windows' bash, next to the git on PATH, or where it installs.
    const git = onPath('git.exe');
    const gitRoots = [git && path.win32.resolve(path.win32.dirname(git), '..'), env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Git'), env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git')].filter(Boolean);
    const bash = gitRoots.map((r) => path.win32.join(r, 'bin', 'bash.exe')).find((p) => exists(p));
    if (bash) out.push({ id: 'gitbash', label: 'Git Bash', file: bash, args: ['--login', '-i'], kind: 'posix', integration: 'bash' });
    // WSL: its own shell runs inside the distribution, which these hooks do not reach.
    const wsl = path.win32.join(root, 'System32', 'wsl.exe');
    if (exists(wsl)) {
      if (distros.length) for (const d of distros) out.push({ id: `wsl:${d}`, label: `WSL · ${d}`, file: wsl, args: ['-d', d], kind: 'wsl', distro: d, integration: null });
      else out.push({ id: 'wsl', label: 'WSL', file: wsl, args: [], kind: 'wsl', integration: null });
    }
    return out;
  }
  // Terminals on macOS start login shells (the profile sets PATH); elsewhere interactive ones.
  const login = platform === 'darwin';
  const out = [];
  const seen = new Set();
  const add = (id, label, file) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, label, file, args: login ? ['-l'] : [], kind: 'posix', integration: ['bash', 'zsh', 'fish'].includes(id) ? id : null });
  };
  const own = env.SHELL && exists(env.SHELL) ? env.SHELL : null;
  if (own) {
    const name = path.posix.basename(own);
    const known = POSIX_SHELLS.find(([id]) => id === name);
    add(known ? known[0] : 'own', known ? known[1] : name, own);
  }
  for (const [id, label] of POSIX_SHELLS) {
    const file = POSIX_DIRS.map((d) => path.posix.join(d, id)).find((p) => exists(p));
    if (file) add(id, label, file);
  }
  if (!out.length) add('sh', 'sh', platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  return out;
}

/** The shell to start when none is named: the first one found. */
function defaultShell(opts = {}) {
  const [first] = listShells(opts);
  return { file: first.file, args: first.args, kind: first.kind === 'wsl' ? 'posix' : first.kind };
}

/** WSL's distributions (Windows): `wsl.exe -l -q`, which answers in UTF-16; [] when there is none. */
function listWslDistros({ run = execFile, env = process.env } = {}) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return new Promise((resolve) => {
    run(path.win32.join(root, 'System32', 'wsl.exe'), ['-l', '-q'], { encoding: 'buffer', timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout?.length) return resolve([]);
      const buf = Buffer.from(stdout);
      const text = buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8');
      const names = text
        .split(/\r?\n/)
        .map((l) => l.replace(/\0/g, '').trim())
        .filter((l) => /^[\w.-]{1,64}$/.test(l));
      resolve([...new Set(names)]);
    });
  });
}

/** The shell's environment: the app's, without Electron's own variables (nor an AppImage's libraries). */
function shellEnv(env = process.env) {
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
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'TrackerEditor' };
}

/** The folder to start in: an existing absolute folder, else the home folder. */
function startDir(dir, { isDir = (p) => fs.statSync(p).isDirectory() } = {}) {
  if (typeof dir === 'string' && dir && path.isAbsolute(dir)) {
    try {
      if (isDir(dir)) return dir;
    } catch {
      // gone: home instead
    }
  }
  return os.homedir();
}

/**
 * Starts a shell: `shell`, an id from listShells (else the default), its integration's
 * scripts kept in `hooksDir`; `spawn` stands in for node-pty's in the tests. The stream says
 * which shell it is: `shell` (its kind), `profile` (its id), `distro` (WSL's).
 */
function openLocalShell({ cols = 100, rows = 24, cwd = '', shell = '', hooksDir = '', distros = [], spawn = (...a) => loadPty().spawn(...a), platform, env, exists } = {}) {
  const list = listShells({ platform, env, exists, distros });
  const chosen = list.find((s) => s.id === shell) ?? list[0];
  const start = integrate(chosen, shellEnv(env), hooksDir);
  const proc = spawn(chosen.file, start.args, { name: 'xterm-256color', cols, rows, cwd: startDir(cwd), env: start.env, useConpty: true });
  const stream = new EventEmitter();
  let closed = false;
  const end = () => {
    if (closed) return;
    closed = true;
    stream.emit('close');
  };
  proc.onData((data) => stream.emit('data', data));
  proc.onExit(({ exitCode }) => {
    stream.emit('exit', exitCode);
    end();
  });
  stream.shell = chosen.kind;
  stream.profile = chosen.id;
  stream.label = chosen.label;
  stream.distro = chosen.distro ?? '';
  stream.write = (data) => {
    if (!closed) proc.write(data);
  };
  stream.setWindow = (rows, cols) => {
    if (closed) return;
    try {
      proc.resize(cols, rows);
    } catch {
      // ended meanwhile
    }
  };
  stream.close = () => {
    if (closed) return;
    try {
      proc.kill();
    } catch {
      // already gone
    }
    // Some shells end without saying so after a kill (Windows).
    setTimeout(end, 2000).unref?.();
  };
  return stream;
}

module.exports = { defaultShell, listShells, listWslDistros, shellEnv, startDir, openLocalShell };
