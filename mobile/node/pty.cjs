// node-pty's face (what electron/localShell.cjs uses) for the Android app: the phone's shell
// in a pseudo-terminal, from the app's small native addon (android/app/src/main/cpp/pty.c,
// libtrackerpty.so next to the app's other native libraries).
const { EventEmitter } = require('node:events');
const path = require('node:path');
const tty = require('node:tty');

let addon = null;
function native() {
  if (addon) return addon;
  const dir = globalThis.__trackerAndroid?.config?.nativeLibDir ?? process.env.TRACKER_NATIVE_LIB_DIR;
  const module = { exports: {} };
  process.dlopen(module, path.join(dir, 'libtrackerpty.so'));
  addon = module.exports;
  return addon;
}

function spawn(file, args = [], opts = {}) {
  const env = { ...(opts.env ?? process.env), TERM: opts.name ?? 'xterm-256color' };
  const pairs = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  const { pid, fd } = native().fork(file, [file, ...args], pairs, opts.cwd ?? '', opts.cols ?? 80, opts.rows ?? 24);
  const events = new EventEmitter();
  const socket = new tty.ReadStream(fd);
  socket.setEncoding('utf8');
  socket.on('data', (data) => events.emit('data', data));
  let ended = false;
  // The shell ended (reading the terminal fails): its exit code, once the system has it.
  const finish = () => {
    if (ended) return;
    ended = true;
    let tries = 0;
    const look = () => {
      const code = native().wait(pid);
      if (code === null && tries++ < 100) return setTimeout(look, 20);
      events.emit('exit', { exitCode: code ?? 0, signal: 0 });
    };
    look();
  };
  socket.on('error', finish);
  socket.on('close', finish);
  socket.on('end', finish);
  return {
    pid,
    process: file,
    onData: (cb) => (events.on('data', cb), { dispose: () => events.off('data', cb) }),
    onExit: (cb) => (events.on('exit', cb), { dispose: () => events.off('exit', cb) }),
    write: (data) => socket.write(data),
    resize: (cols, rows) => native().resize(fd, cols, rows),
    kill: (signal = 'SIGHUP') => {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    },
    pause: () => socket.pause(),
    resume: () => socket.resume(),
  };
}

module.exports = { spawn };
