// A shell on this computer for the terminal panel (desktop): the person's own shell in a
// pseudo-terminal (node-pty), with the face of a shell on a server (remote.cjs openShell):
// 'data', 'exit' and 'close' events, write, setWindow and close. The page cannot name the
// program or its arguments: it gets the default shell, in a folder.
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let pty = null;
function loadPty() {
  try {
    pty ??= require('@lydell/node-pty');
  } catch {
    throw new Error('The terminal for this computer is not available in this build.');
  }
  return pty;
}

/** The shell to start: PowerShell 7 when installed, else Windows PowerShell; $SHELL elsewhere. */
function defaultShell({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform === 'win32') {
    const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
    const pwsh = dirs.map((d) => path.win32.join(d, 'pwsh.exe')).find((p) => exists(p));
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], kind: 'powershell' };
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    return { file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'], kind: 'powershell' };
  }
  const file = env.SHELL && exists(env.SHELL) ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : exists('/bin/bash') ? '/bin/bash' : '/bin/sh';
  // Terminals on macOS start login shells (the profile sets PATH); elsewhere an interactive one.
  return { file, args: platform === 'darwin' ? ['-l'] : [], kind: 'posix' };
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

/** Starts the shell; `spawn` stands in for node-pty's in the tests. */
function openLocalShell({ cols = 100, rows = 24, cwd = '', spawn = (...a) => loadPty().spawn(...a), platform, env } = {}) {
  const shell = defaultShell({ platform, env });
  const proc = spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd: startDir(cwd), env: shellEnv(env), useConpty: true });
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
  stream.shell = shell.kind;
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

module.exports = { defaultShell, shellEnv, startDir, openLocalShell };
