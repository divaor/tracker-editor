// A stand-in SSH server for the tests and end-to-end checks (ssh2's own Server: no sshd needed).
// Password sign-in for one user; each exec request runs here as sshd runs it, with the user's
// login shell: `<shell> -c <command>` in the home folder, with the environment a session gets,
// its stdin, stdout and stderr on the channel, then its exit status (or the signal that ended
// it); signals asked for are passed on, and a channel closed by the client ends its command.
// Terminals (a pty, then a shell or a command) run in a pseudo-terminal through node-pty. The
// sftp subsystem is OpenSSH's sftp-server when it is installed (Folders and tabs work through it);
// without it a small one answers what opening a session needs (realpath, stat). `dropAll()` cuts
// every connection at once, as a server that goes away does; `execs` lists the commands run.
//
// Run by itself (end-to-end checks): node ssh-server.cjs <port> [user] [password] [shell] prints
// "listening <port>" and serves until killed; SSH_STANDIN_PATH sets the PATH its commands get.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server, utils } = require('ssh2');

const SFTP_SERVERS = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server', '/usr/libexec/sftp-server'];
let ptyLib = null;
try {
  ptyLib = require('@lydell/node-pty');
} catch {
  // terminals without it: a plain shell
}

/** Answers REALPATH and STAT; the rest is not supported (the tests only open the session). */
function miniSftp(sftp, home) {
  const { STATUS_CODE } = utils.sftp;
  const resolve = (p) => path.posix.resolve(home, p || '.');
  sftp.on('REALPATH', (id, p) => {
    const full = resolve(p);
    sftp.name(id, [{ filename: full, longname: full, attrs: {} }]);
  });
  for (const op of ['STAT', 'LSTAT']) {
    sftp.on(op, (id, p) => {
      try {
        const st = fs.statSync(resolve(p));
        sftp.attrs(id, { mode: st.mode, uid: st.uid, gid: st.gid, size: st.size, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
      } catch {
        sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
      }
    });
  }
  for (const op of ['OPEN', 'READ', 'WRITE', 'FSTAT', 'FSETSTAT', 'CLOSE', 'OPENDIR', 'READDIR', 'REMOVE', 'RMDIR', 'MKDIR', 'RENAME', 'READLINK', 'SYMLINK', 'SETSTAT']) {
    sftp.on(op, (id) => sftp.status(id, STATUS_CODE.OP_UNSUPPORTED));
  }
}

/**
 * A host key ssh2 can read. Its generateKeyPairSync drops an ed25519 public key's leading zero byte
 * (about one key in 220 comes out 31 bytes long), and its own parser then refuses the key with
 * "Malformed OpenSSH private key": the test that failed now and then until 0.48.1 (a dozen servers
 * start in a run). The app never makes keys; only this stand-in does.
 */
function hostKeyPair() {
  for (let tries = 1; ; tries++) {
    const key = utils.generateKeyPairSync('ed25519').private;
    if (!(utils.parseKey(key) instanceof Error) || tries >= 50) return key;
  }
}

/**
 * Starts the server on 127.0.0.1 (`port` 0: any free one). `env` is added to what each command
 * gets (`PATH` replaces the usual one); `shell` is the user's login shell. Resolves { port, user,
 * password, execs, close(), dropAll() }.
 */
function startSshServer({ port = 0, user = 'tester', password = 'secret', shell = '/bin/sh', home = os.homedir(), env = {}, sftpServer = SFTP_SERVERS.find((p) => fs.existsSync(p)) ?? null } = {}) {
  const hostKey = hostKeyPair();
  const execs = [];
  const clients = new Set();
  const children = new Set();
  const sessionEnv = (extra = {}) => ({ HOME: home, USER: user, LOGNAME: user, SHELL: shell, PATH: env.PATH ?? process.env.PATH, LANG: 'C.UTF-8', ...env, ...extra });

  function runCommand(channel, command, pty, signals) {
    execs.push(command);
    const args = command === null ? ['-l'] : ['-c', command];
    if (pty && ptyLib) {
      const proc = ptyLib.spawn(shell, args, { name: pty.term || 'xterm', cols: pty.cols || 80, rows: pty.rows || 24, cwd: home, env: sessionEnv({ TERM: pty.term || 'xterm' }) });
      signals.current = (name) => proc.kill(`SIG${name}`);
      signals.resize = (cols, rows) => proc.resize(cols, rows);
      proc.onData((d) => channel.write(d));
      channel.on('data', (d) => proc.write(d.toString()));
      proc.onExit(({ exitCode }) => {
        channel.exit(exitCode ?? 0);
        channel.end();
      });
      channel.on('close', () => proc.kill());
      return;
    }
    const child = spawn(shell, args, { cwd: home, env: sessionEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    signals.current = (name) => child.kill(`SIG${name}`);
    channel.pipe(child.stdin);
    child.stdin.on('error', () => {});
    child.stdout.pipe(channel, { end: false });
    child.stderr.pipe(channel.stderr, { end: false });
    child.on('error', (err) => {
      channel.stderr.write(`${err.message}\n`);
      channel.exit(127);
      channel.end();
    });
    child.on('close', (code, signal) => {
      children.delete(child);
      if (code !== null) channel.exit(code);
      else channel.exit(String(signal || 'KILL').replace(/^SIG/, ''), false, '');
      channel.end();
    });
    // The client closed the channel: its command ends, as with sshd (no one reads its output).
    channel.on('close', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGHUP');
    });
  }

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === user && ctx.password === password) return ctx.accept();
      if (ctx.method === 'none') return ctx.reject(['password']);
      ctx.reject();
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        let pty = null;
        const signals = { current: null, resize: null };
        session.on('pty', (ok, _no, info) => {
          pty = info;
          ok?.();
        });
        session.on('window-change', (ok, _no, info) => {
          signals.resize?.(info.cols, info.rows);
          ok?.();
        });
        // As many servers do: no variables from the client (AcceptEnv off).
        session.on('env', (_ok, no) => no?.());
        session.on('signal', (ok, _no, { name }) => {
          signals.current?.(name);
          ok?.();
        });
        session.on('exec', (ok, _no, { command }) => runCommand(ok(), command, pty, signals));
        session.on('shell', (ok) => runCommand(ok(), null, pty, signals));
        if (sftpServer) {
          session.on('subsystem', (ok, no, { name }) => {
            if (name !== 'sftp') return no?.();
            const channel = ok();
            const child = spawn(sftpServer, [], { cwd: home, env: sessionEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
            channel.pipe(child.stdin);
            child.stdin.on('error', () => {});
            child.stdout.pipe(channel);
            child.on('close', () => channel.end());
            channel.on('close', () => child.kill());
          });
        } else {
          session.on('sftp', (ok) => miniSftp(ok(), home));
        }
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        user,
        password,
        execs,
        sftp: Boolean(sftpServer),
        /** Cuts every connection at once (no goodbye), and ends what they ran. */
        dropAll() {
          for (const c of clients) c._sock?.destroy();
          for (const child of children) child.kill('SIGKILL');
        },
        close() {
          for (const c of clients) c._sock?.destroy();
          for (const child of children) child.kill('SIGKILL');
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = { startSshServer, hostKeyPair, SFTP_SERVERS };

if (require.main === module && process.argv.length > 2) {
  const [port, user = 'tester', password = 'secret', shell = '/bin/sh'] = process.argv.slice(2);
  const env = process.env.SSH_STANDIN_PATH ? { PATH: process.env.SSH_STANDIN_PATH } : {};
  startSshServer({ port: Number(port) || 0, user, password, shell, env }).then((s) => {
    process.stdout.write(`listening ${s.port}${s.sftp ? '' : ' (no sftp-server: a small one)'}\n`);
  });
}
