// Files on servers (desktop): SFTP (ssh2) and FTP/FTPS (basic-ftp) behind one
// interface. A file on a server is addressed as remote://<connection id>/<path>,
// so the editor's files-on-disk code (tabs, saving, reloading, following, the
// folders view) works with it through main.cjs. Connections are kept in
// remote.json; passwords and key passphrases go through the keychain store in
// main.cjs and never reach the page. SSH host keys are trusted on first use,
// after the person confirms the fingerprint, and a changed key is refused.
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const disk = require('./diskFiles.cjs');
const { checkName, dirMode, fileMode } = require('./folders.cjs');
const { parseHop } = require('./sshConfig.cjs');

const posix = nodePath.posix;
const SCHEME = 'remote://';
const PROTOCOLS = ['sftp', 'ftps', 'ftp'];
const DEFAULT_PORT = { sftp: 22, ftps: 21, ftp: 21 };
const MAX_COPY_ENTRIES = 10000;
// Transfers with progress (putFile/getFile): requests in flight at once, and their size.
const XFER_PARALLEL = 32;
const XFER_CHUNK = 32 * 1024;
const stoppedError = () => Object.assign(new Error('Stopped.'), { stopped: true });

const isRemote = (p) => typeof p === 'string' && p.startsWith(SCHEME);
// A name a server lists that cannot be a file's own name (it would lead elsewhere): left out.
const listable = (name) => Boolean(name) && name !== '.' && name !== '..' && !/[/\u0000]/.test(name);
/** A path under `root` here for a relative path from a server, refused when it would lead outside. */
function localUnder(root, rel) {
  const parts = rel.split('/');
  const full = nodePath.resolve(root, ...parts);
  if (parts.some((p) => !p || p === '.' || p === '..') || !(full + nodePath.sep).startsWith(nodePath.resolve(root) + nodePath.sep)) throw new Error(`${rel}: that name from the server cannot be a file here.`);
  return full;
}
const protocolLabel = (protocol) => ({ sftp: 'SFTP', ftps: 'FTPS', ftp: 'FTP' })[protocol] ?? protocol;

/** remote://<id>/<path> → { id, path } (the path absolute, '/' at least). */
function parseUri(uri) {
  if (!isRemote(uri)) throw new Error('Not a file on a server.');
  const rest = uri.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  const id = slash === -1 ? rest : rest.slice(0, slash);
  const p = posix.normalize(slash === -1 ? '/' : rest.slice(slash) || '/');
  if (!/^[a-z0-9-]{4,40}$/.test(id)) throw new Error('Unknown server.');
  return { id, path: p.length > 1 ? p.replace(/\/+$/, '') : '/' };
}
const toUri = (id, p) => `${SCHEME}${id}${p.startsWith('/') ? p : `/${p}`}`;

/** OpenSSH's fingerprint of a host key: SHA256:<base64, no padding>. */
const fingerprintOf = (key) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** Messages a person can act on, for the usual network and login errors. */
function friendlyError(err, conn) {
  const where = conn ? `${conn.host}:${conn.port}` : 'the server';
  const code = err?.code ?? '';
  const msg = String(err?.message ?? err);
  if (code === 'ECONNREFUSED') return new Error(`Nothing answers at ${where}. Check the host and the port.`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new Error(`Cannot find ${conn?.host ?? 'the server'}. Check the host name and your network.`);
  if (code === 'ETIMEDOUT' || /Timed out while waiting for handshake/i.test(msg)) return new Error(`${where} did not answer in time.`);
  if (code === 'ECONNRESET') return new Error(`${where} closed the connection.`);
  if (/All configured authentication methods failed/i.test(msg) || /^530/.test(msg)) return new Error('The server did not accept the user name and password (or key).');
  if (/Cannot parse privateKey|Encrypted private key detected|bad passphrase/i.test(msg)) return new Error('The key file could not be read: check the file and its passphrase.');
  if (/self[- ]signed|unable to verify|certificate/i.test(msg)) return new Error(`The server's certificate is not trusted (${msg}). For a server with its own certificate, turn on "Allow self-signed certificates".`);
  if (code === 2 || /No such file/i.test(msg) || /^550/.test(msg)) return Object.assign(new Error('Not found on the server.'), { notFound: true });
  if (code === 3 || /Permission denied/i.test(msg)) return new Error('The server refused: permission denied.');
  return err instanceof Error ? err : new Error(msg);
}

const collect = () => {
  const chunks = [];
  const sink = new Writable({
    write(chunk, _enc, done) {
      chunks.push(chunk);
      done();
    },
  });
  return { sink, buffer: () => Buffer.concat(chunks) };
};

// ---- SFTP ---------------------------------------------------------------------

const agentSocket = () => process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
// The order sign-in methods are tried in, for each way of signing in; the server
// may ask for a second one after the first (a code after the key, for example).
const AUTH_ORDER = {
  password: ['password', 'keyboard-interactive'],
  key: ['publickey', 'keyboard-interactive', 'password'],
  agent: ['agent', 'keyboard-interactive', 'password'],
};
const PASSWORD_PROMPT = /password|contraseña|senha|kennwort|mot de passe/i;
/** A path quoted for a POSIX shell. */
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * A timer that stops while the person is asked something (a host key, a code),
 * so the 20 seconds are for the server, not for reading a fingerprint.
 */
function pausableTimeout(ms, onTimeout) {
  let timer = null;
  let waiting = 0;
  let over = false; // cleared for good (signed in or failed): an answer coming later does not arm it again
  const arm = () => {
    clearTimeout(timer);
    timer = waiting || over ? null : setTimeout(onTimeout, ms);
  };
  return {
    arm,
    clear: () => {
      over = true;
      clearTimeout(timer);
    },
    async whileAsking(fn) {
      waiting++;
      clearTimeout(timer);
      try {
        return await fn();
      } finally {
        waiting--;
        arm();
      }
    },
  };
}

class SftpSession {
  /**
   * `secret(kind)` gives a saved password or passphrase, `ask(question)` asks the
   * person ({ answers, remember } or null), `remember(kind, value)` saves one,
   * `through()` gives a stream through a jump host (or null).
   */
  constructor(conn, { secret, verifyHost, onClose, ask = async () => undefined, remember = () => {}, through = async () => null }) {
    this.conn = conn;
    this.secret = secret;
    this.verifyHost = verifyHost;
    this.onClose = onClose;
    this.ask = ask;
    this.remember = remember;
    this.through = through;
  }

  async open() {
    const { Client, utils } = require('ssh2');
    const { conn } = this;
    const client = new Client();
    this.client = client;
    const who = `${conn.user}@${conn.host}`;
    let cancelled = false;
    let offered = null; // the methods the server accepts
    let passwordTries = 0;
    let keyboardTries = 0;
    let savedPasswordUsed = false;
    let failure = null; // why it failed, when we know better than ssh2
    const tried = new Set();
    const timeout = pausableTimeout(20000, () => {
      failure = Object.assign(new Error(`${conn.host}:${conn.port} did not answer in time.`), { code: 'ETIMEDOUT' });
      client.destroy();
    });

    const asking = (question) =>
      timeout.whileAsking(async () => {
        const answer = await this.ask({ host: conn.host, port: conn.port, user: conn.user, ...question });
        // null: the person cancelled; undefined: there was no one to ask (the server's refusal stands).
        if (answer === null) cancelled = true;
        return answer ?? null;
      });
    const password = async () => {
      const saved = this.secret('password');
      passwordTries++;
      if (saved && passwordTries === 1) {
        savedPasswordUsed = true;
        return saved;
      }
      const answer = await asking({
        kind: 'password',
        title: 'Password',
        instructions: passwordTries > 1 || saved ? 'The server did not accept the password. Type it again.' : '',
        prompts: [{ prompt: `Password for ${who}`, echo: false }],
      });
      if (!answer) return null;
      if (answer.remember) this.remember('password', answer.answers[0]);
      return answer.answers[0];
    };
    const privateKey = async () => {
      const bytes = fs.readFileSync(conn.keyPath);
      let passphrase = this.secret('passphrase');
      for (let round = 0; round < 3; round++) {
        let key = utils.parseKey(bytes, passphrase || undefined);
        if (Array.isArray(key)) [key] = key;
        if (!(key instanceof Error)) return key;
        if (!/passphrase|encrypted|decrypt/i.test(key.message)) throw new Error('The key file could not be read: check the file and its passphrase.');
        const answer = await asking({
          kind: 'passphrase',
          title: 'Key passphrase',
          instructions: passphrase ? 'That passphrase does not open the key. Type it again.' : '',
          prompts: [{ prompt: `Passphrase for ${nodePath.basename(conn.keyPath)}`, echo: false }],
        });
        if (!answer) return null;
        passphrase = answer.answers[0];
        if (answer.remember) this.remember('passphrase', passphrase);
      }
      throw new Error('The key file could not be read: check the file and its passphrase.');
    };
    // Questions from the server (a password, a one-time code…); a lone password question is answered with the saved password once.
    const keyboard = (name, instructions, _lang, prompts, finish) => {
      if (!prompts.length) return finish([]);
      const saved = this.secret('password');
      const lonePassword = prompts.length === 1 && !prompts[0].echo && PASSWORD_PROMPT.test(prompts[0].prompt);
      if (conn.auth === 'password' && saved && !savedPasswordUsed && lonePassword) {
        savedPasswordUsed = true;
        return finish([saved]);
      }
      const again = lonePassword && savedPasswordUsed ? 'The server did not accept the password. Type it again.' : '';
      asking({
        kind: 'interactive',
        title: name || 'Sign in',
        instructions: [instructions, again].filter(Boolean).join('\n'),
        prompts: prompts.map((p) => ({ prompt: String(p.prompt ?? '').trim(), echo: Boolean(p.echo) })),
        // A one-time code is never kept; a password asked this way may be.
        canRemember: lonePassword && conn.auth === 'password',
      }).then(
        (answer) => {
          if (answer?.remember && lonePassword) this.remember('password', answer.answers[0]);
          finish(answer ? answer.answers : prompts.map(() => ''));
        },
        () => finish(prompts.map(() => '')),
      );
    };
    const authHandler = (methodsLeft, _partial, next) => {
      // First: no credentials, to learn what the server accepts.
      if (methodsLeft === null) return next({ type: 'none', username: conn.user });
      offered = methodsLeft;
      (async () => {
        for (const method of AUTH_ORDER[conn.auth] ?? AUTH_ORDER.password) {
          if (cancelled) return false;
          const name = method === 'agent' ? 'publickey' : method;
          if (!methodsLeft.includes(name)) continue;
          if (method === 'password' && passwordTries < 3) {
            const pw = await password();
            return pw === null ? false : { type: 'password', username: conn.user, password: pw };
          }
          if (method === 'keyboard-interactive' && keyboardTries < 3) {
            keyboardTries++;
            return { type: 'keyboard-interactive', username: conn.user, prompt: keyboard };
          }
          if (tried.has(method)) continue;
          tried.add(method);
          if (method === 'publickey') {
            const key = await privateKey();
            return key ? { type: 'publickey', username: conn.user, key } : false;
          }
          if (method === 'agent') {
            if (agentSocket()) return { type: 'agent', username: conn.user, agent: agentSocket() };
            failure = new Error('No SSH agent is running on this computer. Start it (on Windows: the OpenSSH Authentication Agent service) or sign in with a key file.');
          }
        }
        return false;
      })().then(next, (err) => {
        failure = err;
        next(false);
      });
    };
    const sock = await this.through();
    const options = {
      host: conn.host,
      port: conn.port,
      username: conn.user,
      readyTimeout: 0, // ours, which waits while the person is asked
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      authHandler,
      hostVerifier: (key, verify) => {
        timeout.whileAsking(() => this.verifyHost(fingerprintOf(key))).then(verify, () => verify(false));
      },
      ...(sock ? { sock } : {}),
    };
    try {
      await new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.once('close', () => reject(failure ?? Object.assign(new Error('The server closed the connection.'), { code: 'ECONNRESET' })));
        timeout.arm();
        client.connect(options);
      });
    } catch (err) {
      if (failure) throw failure;
      if (cancelled) throw Object.assign(new Error('Sign-in cancelled.'), { cancelled: true });
      if (/All configured authentication methods failed/i.test(err.message) && offered?.length && !(AUTH_ORDER[conn.auth] ?? []).some((m) => offered.includes(m === 'agent' ? 'publickey' : m))) {
        throw new Error(`The server only accepts ${offered.join(', ')}. Edit the server and choose another way to sign in.`);
      }
      throw err;
    } finally {
      timeout.clear();
    }
    client.removeAllListeners('error');
    client.removeAllListeners('close');
    client.on('error', () => {});
    this.sftp = await new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
    client.on('close', () => {
      this.closed = true;
      this.onClose();
    });
    return this;
  }

  /** Whether the connection still works. */
  get alive() {
    return Boolean(this.client) && !this.closed;
  }

  close() {
    this.client?.end();
  }

  /** A connection to `host:port` made by the server (for a server reached through this one). */
  forward(host, port) {
    return new Promise((resolve, reject) => this.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream))));
  }

  /** Whether the server runs Windows (SFTP gives its paths as /C:/…). */
  async windows() {
    this.isWindows ??= /^\/[A-Za-z]:/.test(await this.home().catch(() => ''));
    return this.isWindows;
  }

  /** A terminal on the server: a login shell, in `cwd` when given. Resolves with the channel (a duplex stream). */
  async shell({ cols = 80, rows = 24, cwd = '' } = {}) {
    const pty = { term: 'xterm-256color', cols, rows };
    const windows = await this.windows();
    return new Promise((resolve, reject) => {
      const done = (err, stream) => (err ? reject(err) : resolve(stream));
      if (cwd && !windows) this.client.exec(`cd -- ${shellQuote(cwd)} 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`, { pty }, done);
      else this.client.shell(pty, done);
    });
  }

  call(method, ...args) {
    return new Promise((resolve, reject) => this.sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result))));
  }

  async home() {
    return this.call('realpath', '.');
  }

  async stat(p) {
    try {
      const s = await this.call('stat', p);
      return { dir: s.isDirectory(), size: s.size, mtimeMs: s.mtime * 1000, mode: s.mode & 0o7777, uid: s.uid, gid: s.gid };
    } catch (err) {
      if (err.code === 2) return null;
      throw err;
    }
  }

  async list(dir) {
    const items = (await this.call('readdir', dir)).filter((item) => listable(item.filename));
    return Promise.all(
      items.map(async ({ filename, longname, attrs }) => {
        let isDir = attrs.isDirectory();
        // A link: what it points at.
        if (attrs.isSymbolicLink()) isDir = Boolean((await this.stat(posix.join(dir, filename)).catch(() => null))?.dir);
        // "-rw-r--r--  1 owner group …": the names of the owner and the group.
        const [, , owner = '', group = ''] = String(longname ?? '').split(/\s+/);
        return { name: filename, path: posix.join(dir, filename), dir: isDir, size: isDir ? 0 : attrs.size, mtimeMs: attrs.mtime * 1000, mode: attrs.mode & 0o7777, owner, group, link: attrs.isSymbolicLink() };
      }),
    );
  }

  async chmod(p, mode) {
    await this.call('chmod', p, mode);
  }

  // Whole files to and from this computer, streamed (for mirrors).
  async downloadTo(p, localPath) {
    await this.call('fastGet', p, localPath, {});
  }

  async uploadFrom(localPath, p) {
    await this.call('fastPut', localPath, p, {});
  }

  /**
   * A file here written to `p`, many requests at a time (as fastPut does), reporting
   * the bytes sent so far (`onBytes`); when `signal` aborts it stops and throws.
   */
  async putFile(localPath, p, { onBytes = () => {}, signal } = {}) {
    const size = fs.statSync(localPath).size;
    const fd = fs.openSync(localPath, 'r');
    let handle = null;
    try {
      handle = await this.call('open', p, 'w');
      await new Promise((resolve, reject) => {
        let pos = 0;
        let sent = 0;
        let inFlight = 0;
        let error = null;
        // Stopped or failed: settled once the requests already sent have come back.
        const settle = () => !inFlight && reject(error);
        const stop = (err) => ((error ??= err), settle());
        const pump = () => {
          if (error) return settle();
          if (signal?.aborted) return stop(stoppedError());
          if (pos >= size && !inFlight) return resolve();
          while (inFlight < XFER_PARALLEL && pos < size) {
            const at = pos;
            const len = Math.min(XFER_CHUNK, size - at);
            pos += len;
            const buf = Buffer.allocUnsafe(len);
            fs.readSync(fd, buf, 0, len, at);
            inFlight++;
            this.sftp.write(handle, buf, 0, len, at, (err) => {
              inFlight--;
              if (err) return stop(err);
              if (error) return settle();
              sent += len;
              onBytes(sent);
              pump();
            });
          }
        };
        pump();
      });
    } finally {
      fs.closeSync(fd);
      if (handle) await this.call('close', handle).catch(() => {});
    }
  }

  /** A file on the server written to `localPath` here, like putFile the other way. */
  async getFile(p, localPath, { onBytes = () => {}, signal } = {}) {
    const size = (await this.call('stat', p)).size;
    const handle = await this.call('open', p, 'r');
    const fd = fs.openSync(localPath, 'wx');
    try {
      await new Promise((resolve, reject) => {
        let pos = 0;
        let got = 0;
        let inFlight = 0;
        let error = null;
        // Stopped or failed: settled once the reads already asked for have come back, so
        // none of them writes to the file after it is closed.
        const settle = () => !inFlight && reject(error);
        const stop = (err) => ((error ??= err), settle());
        // A read that comes back short is asked again for the rest.
        const request = (at, len) => {
          inFlight++;
          const buf = Buffer.allocUnsafe(len);
          this.sftp.read(handle, buf, 0, len, at, (err, n) => {
            inFlight--;
            if (err) return stop(err);
            if (error) return settle();
            if (n > 0) {
              try {
                fs.writeSync(fd, buf, 0, n, at);
              } catch (writeErr) {
                return stop(writeErr);
              }
              got += n;
              onBytes(got);
              if (n < len) request(at + n, len - n);
            }
            pump();
          });
        };
        const pump = () => {
          if (error) return settle();
          if (signal?.aborted) return stop(stoppedError());
          if (pos >= size && !inFlight) return resolve();
          while (inFlight < XFER_PARALLEL && pos < size) {
            const len = Math.min(XFER_CHUNK, size - pos);
            request(pos, len);
            pos += len;
          }
        };
        pump();
      });
    } finally {
      fs.closeSync(fd);
      await this.call('close', handle).catch(() => {});
    }
  }

  async rmdir(p) {
    await this.call('rmdir', p);
  }

  async read(p) {
    return this.call('readFile', p);
  }

  async readRange(p, start, length) {
    const handle = await this.call('open', p, 'r');
    try {
      const buf = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const read = await new Promise((resolve, reject) => this.sftp.read(handle, buf, done, length - done, start + done, (err, n) => (err ? reject(err) : resolve(n))));
        if (!read) break;
        done += read;
      }
      return buf.subarray(0, done);
    } finally {
      await this.call('close', handle).catch(() => {});
    }
  }

  async write(p, data) {
    await this.call('writeFile', p, data);
  }

  async mkdir(p) {
    await this.call('mkdir', p);
  }

  async rename(from, to) {
    await this.call('rename', from, to);
  }

  async remove(p) {
    const s = await this.call('lstat', p);
    if (!s.isDirectory()) return this.call('unlink', p);
    for (const item of await this.call('readdir', p)) await this.remove(posix.join(p, item.filename));
    return this.call('rmdir', p);
  }
}

// ---- FTP and FTPS ---------------------------------------------------------------

// Unix permissions and owners from an FTP listing, when the server gives them.
function ftpPermissions(f) {
  const p = f.permissions;
  return {
    ...(p ? { mode: (p.user << 6) | (p.group << 3) | p.world } : {}),
    ...(f.user ? { owner: f.user } : {}),
    ...(f.group ? { group: f.group } : {}),
  };
}

class FtpSession {
  constructor(conn, { secret, onClose, ask = async () => undefined, remember = () => {} }) {
    this.conn = conn;
    this.secret = secret;
    this.onClose = onClose;
    this.ask = ask;
    this.remember = remember;
    this.queue = Promise.resolve();
  }

  async open() {
    const ftp = require('basic-ftp');
    const { conn } = this;
    const user = conn.user || 'anonymous';
    const options = (password) => ({
      host: conn.host,
      port: conn.port,
      user,
      password,
      secure: conn.protocol === 'ftps',
      secureOptions: { rejectUnauthorized: !conn.allowSelfSigned, servername: require('node:net').isIP(conn.host) ? undefined : conn.host },
    });
    // No saved password (or not accepted): asked, twice at most. Anonymous FTP needs none.
    // undefined when there is no one to ask.
    const askPassword = async (retry) => {
      const answer = await this.ask({ kind: 'password', title: 'Password', instructions: retry ? 'The server did not accept the password. Type it again.' : '', prompts: [{ prompt: `Password for ${user}@${conn.host}`, echo: false }] });
      if (answer === null) throw Object.assign(new Error('Sign-in cancelled.'), { cancelled: true });
      if (answer?.remember) this.remember('password', answer.answers[0]);
      return answer?.answers[0];
    };
    let password = this.secret('password');
    if (!password && user !== 'anonymous') password = (await askPassword(false)) ?? '';
    for (let round = 0; ; round++) {
      this.client = new ftp.Client(30000);
      try {
        await this.client.access(options(password));
        this.access = options(password);
        break;
      } catch (err) {
        this.client.close();
        if (!/^530/.test(err.message) || user === 'anonymous' || round >= 2) throw err;
        password = await askPassword(true);
        if (password === undefined) throw err;
      }
    }
    this.client.ftp.socket.on('close', () => this.lost());
    return this;
  }

  /**
   * Whether the control connection still works. basic-ftp closes it by itself on a timeout or
   * when the server hangs up (an idle timeout), and removes our listeners first: so it is asked.
   */
  get alive() {
    return Boolean(this.client) && !this.client.closed;
  }

  // Gone (the server hung up, a timeout): the session is given up, once.
  lost() {
    if (this.gone) return;
    this.gone = true;
    this.onClose();
  }

  close() {
    this.client?.close();
  }

  // One command at a time on an FTP control connection.
  run(fn) {
    const next = this.queue.then(async () => {
      if (!this.alive) {
        this.lost();
        throw Object.assign(new Error('The connection was closed.'), { code: 'ECONNRESET' });
      }
      try {
        return await fn(this.client);
      } finally {
        if (!this.alive) this.lost();
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async home() {
    return this.run((c) => c.pwd());
  }

  async stat(p) {
    if (p === '/') return { dir: true, size: 0, mtimeMs: 0 };
    const listing = await this.run((c) => c.list(posix.dirname(p))).catch((err) => {
      if (/^550/.test(err.message)) return [];
      throw err;
    });
    const hit = listing.find((f) => f.name === posix.basename(p));
    if (!hit) return null;
    let mtimeMs = hit.modifiedAt?.getTime?.() ?? 0;
    if (!hit.isDirectory) {
      const exact = await this.run((c) => c.lastMod(p)).catch(() => null);
      if (exact) mtimeMs = exact.getTime();
    }
    return { dir: hit.isDirectory, size: hit.isDirectory ? 0 : hit.size, mtimeMs, ...ftpPermissions(hit) };
  }

  async list(dir) {
    const listing = await this.run((c) => c.list(dir));
    return listing
      .filter((f) => listable(f.name))
      .map((f) => ({ name: f.name, path: posix.join(dir, f.name), dir: f.isDirectory, size: f.isDirectory ? 0 : f.size, mtimeMs: f.modifiedAt?.getTime?.() ?? 0, ...ftpPermissions(f), link: f.isSymbolicLink }));
  }

  async downloadTo(p, localPath) {
    await this.run((c) => c.downloadTo(localPath, p));
  }

  /**
   * putFile and getFile as for SFTP: the bytes so far from basic-ftp's progress. They go
   * on a connection of their own, so the folder can be browsed meanwhile and stopping
   * closes only that one; a server that allows only one connection gets them in turn.
   */
  async putFile(localPath, p, opts = {}) {
    return this.transfer((c) => c.uploadFrom(localPath, p), opts);
  }

  async getFile(p, localPath, opts = {}) {
    return this.transfer((c) => c.downloadTo(fs.createWriteStream(localPath, { flags: 'wx' }), p), opts);
  }

  async transfer(fn, { onBytes = () => {}, signal } = {}) {
    if (signal?.aborted) throw stoppedError();
    const ftp = require('basic-ftp');
    const own = new ftp.Client(30000);
    try {
      await own.access(this.access);
    } catch {
      own.close();
      return this.run((c) => this.transferOn(c, fn, { onBytes, signal, own: false }));
    }
    return this.transferOn(own, fn, { onBytes, signal, own: true });
  }

  async transferOn(c, fn, { onBytes, signal, own }) {
    // Stopped: a connection of its own is closed (the main one is left for the rest).
    const onAbort = () => own && c.close();
    signal?.addEventListener('abort', onAbort);
    c.trackProgress((info) => {
      onBytes(info.bytes);
      if (signal?.aborted && !own) c.close();
    });
    try {
      await fn(c);
    } catch (err) {
      throw signal?.aborted ? stoppedError() : err;
    } finally {
      c.trackProgress();
      signal?.removeEventListener('abort', onAbort);
      if (own) c.close();
    }
    if (signal?.aborted) throw stoppedError();
  }

  /** A file's time by MDTM (for listings without MLSD), or 0. */
  async lastMod(p) {
    return (await this.run((c) => c.lastMod(p)).catch(() => null))?.getTime() ?? 0;
  }

  async uploadFrom(localPath, p) {
    await this.run((c) => c.uploadFrom(localPath, p));
  }

  async rmdir(p) {
    await this.run((c) => c.send(`RMD ${p}`));
  }

  // SITE CHMOD: most Unix FTP servers take it; others say they do not.
  async chmod(p, mode) {
    try {
      await this.run((c) => c.send(`SITE CHMOD ${mode.toString(8).padStart(3, '0')} ${p}`));
    } catch (err) {
      if (/^5(00|02|04)/.test(err.message)) throw new Error('This FTP server does not change permissions.');
      throw err;
    }
  }

  async read(p, start = 0) {
    const { sink, buffer } = collect();
    await this.run((c) => c.downloadTo(sink, p, start));
    return buffer();
  }

  async readRange(p, start, length) {
    return (await this.read(p, start)).subarray(0, length);
  }

  async write(p, data) {
    await this.run((c) => c.uploadFrom(Readable.from([data]), p));
  }

  async mkdir(p) {
    await this.run((c) => c.send(`MKD ${p}`));
  }

  async rename(from, to) {
    await this.run((c) => c.rename(from, to));
  }

  async remove(p) {
    const s = await this.stat(p);
    if (!s) return;
    await this.run((c) => (s.dir ? c.removeDir(p) : c.remove(p)));
  }
}

// ---- Connections ------------------------------------------------------------------

/**
 * The servers: `store` reads and writes remote.json ({ connections, knownHosts, keys }),
 * `secrets` gets and sets a connection's password or passphrase, `askHostKey`
 * asks the person about an unknown or changed host key, `onStatus` reports
 * connecting / connected / disconnected / error.
 */
function createRemote({ store, secrets, askHostKey, askPrompt = async () => undefined, onStatus = () => {} }) {
  let data = { connections: [], knownHosts: {}, keys: [], ...store.read() };
  const save = () => store.write(data);
  const live = new Map(); // id → { session, opening, state, error }

  const find = (id) => {
    const conn = data.connections.find((c) => c.id === id);
    if (!conn) throw new Error('That server is not set up here any more.');
    return conn;
  };
  const status = (id) => {
    const l = live.get(id);
    return { id, state: l?.state ?? 'disconnected', error: l?.error ?? '' };
  };
  const setState = (id, state, error = '') => {
    const l = live.get(id) ?? {};
    live.set(id, { ...l, state, error });
    onStatus({ id, state, error });
  };

  /** A connection's settings as the page sees them: no secrets, whether they are saved. */
  const publicConn = (c) => ({ ...c, hasPassword: Boolean(secrets.get(c.id, 'password')), hasPassphrase: Boolean(secrets.get(c.id, 'passphrase')), ...status(c.id) });

  function clean(input, existing) {
    const protocol = PROTOCOLS.includes(input.protocol) ? input.protocol : 'sftp';
    const host = String(input.host ?? '').trim();
    if (!host || /[\s/@]/.test(host)) throw new Error('Type the server name or address, without spaces, slashes or @.');
    const port = Number(input.port) || DEFAULT_PORT[protocol];
    if (port < 1 || port > 65535) throw new Error('The port is a number from 1 to 65535.');
    const auth = protocol === 'sftp' && ['password', 'key', 'agent'].includes(input.auth) ? input.auth : 'password';
    const keyPath = auth === 'key' ? String(input.keyPath ?? '') : '';
    // A key file only from the file picker (remote:pick-key), so the page cannot point at other files.
    if (auth === 'key' && !data.keys.includes(keyPath)) throw new Error('Choose the key file with "Choose…".');
    const start = String(input.path ?? '').trim();
    const id = existing?.id ?? crypto.randomBytes(5).toString('hex');
    const jump = protocol === 'sftp' && input.jump ? String(input.jump) : '';
    if (jump) {
      // Another SFTP server set up here, and no loop (a jump host reached through this one).
      const seen = new Set([id]);
      for (let at = jump; at; at = data.connections.find((c) => c.id === at)?.jump) {
        const via = data.connections.find((c) => c.id === at);
        if (!via) throw new Error('The jump host is not set up here any more.');
        if (via.protocol !== 'sftp') throw new Error(`${via.name} is not an SFTP server, so it cannot be a jump host.`);
        if (seen.has(at)) throw new Error(`${via.name} is reached through this server, so it cannot be its jump host.`);
        seen.add(at);
      }
    }
    return {
      id,
      name: String(input.name ?? '').trim().slice(0, 60) || host,
      protocol,
      host,
      port,
      user: String(input.user ?? '').trim(),
      auth,
      keyPath,
      path: start ? posix.normalize(start.startsWith('/') ? start : `/${start}`) : '',
      autoSave: Boolean(input.autoSave),
      allowSelfSigned: protocol === 'ftps' && Boolean(input.allowSelfSigned),
      jump,
    };
  }

  async function open(conn, { probe = false, depth = 0 } = {}) {
    const secret = (kind) => (probe && conn.draftSecrets?.[kind] !== undefined ? conn.draftSecrets[kind] : secrets.get(conn.id, kind));
    // Questions for the person (a password not saved, a one-time code); a test from the dialog does not save answers.
    const ask = (question) => askPrompt({ id: conn.id, name: conn.name, ...question, canRemember: !probe && (question.canRemember ?? true) });
    const remember = (kind, value) => {
      if (!probe && typeof value === 'string' && value) secrets.set(conn.id, kind, value);
    };
    // Through a jump host: another SFTP server here, connected first, opens the way.
    const through = async () => {
      if (!conn.jump) return null;
      if (depth > 4) throw new Error('Too many jump hosts in a row.');
      const jump = find(conn.jump);
      const via = await session(conn.jump, { depth: depth + 1 });
      if (!(via instanceof SftpSession)) throw new Error(`${jump.name} is not an SFTP server, so it cannot be a jump host.`);
      return via.forward(conn.host, conn.port).catch((err) => {
        throw new Error(`${jump.name} could not reach ${conn.host}:${conn.port} (${err.message}).`);
      });
    };
    const hostKey = `[${conn.host}]:${conn.port}`;
    const verifyHost = async (fingerprint) => {
      const known = data.knownHosts[hostKey];
      if (known === fingerprint) return true;
      const ok = await askHostKey({ id: conn.id, name: conn.name, host: conn.host, port: conn.port, fingerprint, previous: known ?? '' });
      if (ok) {
        data.knownHosts[hostKey] = fingerprint;
        save();
      }
      return ok;
    };
    const onClose = () => {
      if (probe) return;
      const l = live.get(conn.id);
      // Only when this is the session in use (one given up while connecting closes on its own).
      if (l?.session && l.session === opened) {
        live.set(conn.id, { state: 'disconnected', error: '' });
        onStatus({ id: conn.id, state: 'disconnected', error: '' });
      }
    };
    const opened = conn.protocol === 'sftp' ? new SftpSession(conn, { secret, verifyHost, onClose, ask, remember, through }) : new FtpSession(conn, { secret, onClose, ask, remember });
    try {
      return await opened.open();
    } catch (err) {
      opened.close();
      throw friendlyError(err, conn);
    }
  }

  /** A session that died without a word (an FTP server's idle timeout) is given up, and the page told. */
  function checkAlive(id) {
    const l = live.get(id);
    if (!l?.session || l.state !== 'connected' || l.session.alive !== false) return;
    live.set(id, { state: 'disconnected', error: '' });
    onStatus({ id, state: 'disconnected', error: '' });
  }

  /** The open session of a server, connecting when needed (one attempt at a time). */
  async function session(id, { depth = 0 } = {}) {
    checkAlive(id);
    const l = live.get(id);
    if (l?.session && l.state === 'connected') return l.session;
    if (l?.opening) return l.opening;
    const conn = find(id);
    setState(id, 'connecting');
    const opening = open(conn, { depth }).then(
      (s) => {
        // Disconnected (or changed) while it was connecting: this one is not used.
        if (live.get(id)?.opening !== opening) {
          s.close();
          throw new Error('Disconnected.');
        }
        live.set(id, { session: s, state: 'connected', error: '' });
        onStatus({ id, state: 'connected', error: '' });
        return s;
      },
      (err) => {
        if (live.get(id)?.opening === opening) {
          live.set(id, { state: 'error', error: err.message });
          onStatus({ id, state: 'error', error: err.message });
        }
        throw err;
      },
    );
    live.set(id, { ...live.get(id), opening });
    return opening;
  }

  /**
   * Runs `fn(session, path)` for a remote:// path, with friendly errors. With `again` (reads
   * only), a connection found dead on the way is replaced and `fn` runs once more.
   */
  async function withPath(uri, fn, { again = false } = {}) {
    const { id, path: p } = parseUri(uri);
    const conn = find(id);
    const s = await session(id);
    try {
      return await fn(s, p, id);
    } catch (err) {
      if (!again || s.alive !== false) throw friendlyError(err, conn);
      try {
        return await fn(await session(id), p, id);
      } catch (retried) {
        throw friendlyError(retried, conn);
      }
    }
  }

  async function freeRemotePath(s, dir, name, { copy = false } = {}) {
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    const taken = new Set((await s.list(dir)).map((e) => e.name));
    for (let n = 1; n < 10000; n++) {
      const candidate = copy ? `${base} - Copy${n > 1 ? ` (${n})` : ''}${ext}` : n > 1 ? `${base} (${n})${ext}` : name;
      if (!taken.has(candidate)) return posix.join(dir, candidate);
    }
    throw new Error(`No free name for ${name}.`);
  }

  // A folder and what is in it, links left out: [{ path, dir, mode }], the folder first.
  async function walkNoLinks(s, p) {
    const st = await s.stat(p);
    if (!st) throw Object.assign(new Error('Not found on the server.'), { notFound: true });
    const out = [{ path: p, dir: st.dir, mode: st.mode }];
    const pending = st.dir ? [p] : [];
    while (pending.length) {
      for (const e of await s.list(pending.shift())) {
        if (e.link) continue;
        out.push({ path: e.path, dir: e.dir, mode: e.mode });
        if (out.length > MAX_COPY_ENTRIES) throw new Error('Too many files at once (more than 10,000).');
        if (e.dir) pending.push(e.path);
      }
    }
    return out;
  }

  // A folder and the ones above it, where missing.
  async function mkdirp(s, p) {
    if (p === '/' || p === '.' || !p) return;
    if (await s.stat(p)) return;
    await mkdirp(s, posix.dirname(p));
    await s.mkdir(p).catch(async (err) => {
      if (!(await s.stat(p))) throw err;
    });
  }

  // Files and folders under `p` (for copying between places), at most MAX_COPY_ENTRIES.
  async function walk(s, p, out = []) {
    const st = await s.stat(p);
    if (!st) throw Object.assign(new Error('Not found on the server.'), { notFound: true });
    out.push({ path: p, dir: st.dir, mode: st.mode, size: st.dir ? 0 : st.size });
    if (out.length > MAX_COPY_ENTRIES) throw new Error('Too many files at once (more than 10,000).');
    if (st.dir) for (const e of await s.list(p)) await walk(s, e.path, out);
    return out;
  }

  // A hidden name beside `dest` that a transfer writes to before taking the real name, so a
  // stopped or failed one never leaves half a file under it.
  const partOf = (dest, join = posix.join, dirname = posix.dirname, basename = posix.basename) => join(dirname(dest), `.${basename(dest)}.part-${crypto.randomBytes(3).toString('hex')}`);

  const api = {
    isRemote,
    parseUri,
    toUri,

    // ---- Settings ----
    connections: () => data.connections.map(publicConn),
    saveConnection(input, { password, passphrase } = {}) {
      const existing = input.id ? data.connections.find((c) => c.id === input.id) : null;
      const conn = clean(input, existing);
      // Connection details changed: the old session goes.
      api.disconnect(conn.id);
      data.connections = existing ? data.connections.map((c) => (c.id === conn.id ? conn : c)) : [...data.connections, conn];
      save();
      if (typeof password === 'string') secrets.set(conn.id, 'password', password);
      if (typeof passphrase === 'string') secrets.set(conn.id, 'passphrase', passphrase);
      return publicConn(conn);
    },
    deleteConnection(id) {
      const through = data.connections.filter((c) => c.jump === id);
      if (through.length) throw new Error(`${through.map((c) => c.name).join(', ')} ${through.length === 1 ? 'is' : 'are'} reached through this server. Change ${through.length === 1 ? 'its' : 'their'} jump host first.`);
      api.disconnect(id);
      const conn = data.connections.find((c) => c.id === id);
      data.connections = data.connections.filter((c) => c.id !== id);
      if (conn && !data.connections.some((c) => c.host === conn.host && c.port === conn.port)) delete data.knownHosts[`[${conn.host}]:${conn.port}`];
      save();
      secrets.set(id, 'password', '');
      secrets.set(id, 'passphrase', '');
      return true;
    },
    /**
     * Sets up hosts from an SSH config (parseSshConfig) as servers: `aliases` the
     * ones picked. Their jump hosts (ProxyJump) come too. A key named by
     * IdentityFile (or a default key) is used when it exists, else the agent when
     * one runs, else a password (asked when connecting). Servers already set up
     * (same host, port and user) are reused. Returns { made, reused } (ids).
     */
    importSsh(hosts, aliases, { home = os.homedir(), exists = fs.existsSync, agent = Boolean(agentSocket()) } = {}) {
      const byAlias = new Map(hosts.map((h) => [h.alias, h]));
      const made = [];
      const reused = [];
      const authFor = (identityFiles) => {
        const defaults = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((n) => nodePath.join(home, '.ssh', n));
        const file = identityFiles.find((f) => exists(f)) ?? (identityFiles.length || agent ? undefined : defaults.find((f) => exists(f)));
        if (file) {
          api.allowKey(file);
          return { auth: 'key', keyPath: file };
        }
        return { auth: agent ? 'agent' : 'password' };
      };
      const upsert = (entry) => {
        const same = data.connections.find((c) => c.protocol === 'sftp' && c.host.toLowerCase() === entry.host.toLowerCase() && c.port === entry.port && c.user === entry.user);
        if (same) {
          if (!reused.includes(same.id) && !made.includes(same.id)) reused.push(same.id);
          return same.id;
        }
        const conn = clean({ protocol: 'sftp', ...entry }, null);
        data.connections = [...data.connections, conn];
        save();
        made.push(conn.id);
        return conn.id;
      };
      const importAlias = (alias, seen) => {
        if (seen.has(alias)) throw new Error(`${alias}: its jump hosts lead back to it.`);
        const h = byAlias.get(alias);
        if (!h) throw new Error(`${alias} is not in the SSH config any more.`);
        let jump = '';
        // "a,b": b is reached through a, and the host through b.
        for (const hop of h.proxyJump ? h.proxyJump.split(',').map((x) => x.trim()) : []) {
          if (byAlias.has(hop)) jump = importAlias(hop, new Set([...seen, alias]));
          else {
            const at = parseHop(hop);
            if (!at) throw new Error(`${alias}: the jump host "${hop}" could not be read.`);
            jump = upsert({ name: at.host, host: at.host, port: at.port, user: at.user || h.user, ...authFor([]), jump });
          }
        }
        return upsert({ name: alias, host: h.host, port: h.port, user: h.user, ...authFor(h.identityFiles), jump });
      };
      for (const alias of aliases) importAlias(alias, new Set());
      return { made, reused };
    },
    allowKey(keyPath) {
      if (!data.keys.includes(keyPath)) data.keys = [...data.keys, keyPath].slice(-50);
      save();
    },
    forgetHostKey(id) {
      const conn = find(id);
      delete data.knownHosts[`[${conn.host}]:${conn.port}`];
      save();
      return true;
    },
    /** Tries a connection's settings (saved or not) and returns its start folder. */
    async test(input, draftSecrets = {}) {
      const existing = input.id ? data.connections.find((c) => c.id === input.id) : null;
      const conn = { ...clean(input, existing), draftSecrets };
      const s = await open(conn, { probe: true });
      try {
        const start = conn.path || (await s.home());
        const entries = await s.list(start);
        return { ok: true, path: start, entries: entries.length };
      } catch (err) {
        throw friendlyError(err, conn);
      } finally {
        s.close();
      }
    },

    // ---- Connecting ----
    status,
    async connect(id) {
      const s = await session(id);
      const conn = find(id);
      return { ...status(id), root: toUri(id, conn.path || (await s.home().catch(() => '/'))) };
    },
    disconnect(id) {
      const l = live.get(id);
      if (!l) return;
      live.delete(id);
      l.session?.close();
      onStatus({ id, state: 'disconnected', error: '' });
    },
    disconnectAll() {
      for (const id of [...live.keys()]) api.disconnect(id);
    },
    isConnected: (id) => (checkAlive(id), live.get(id)?.state === 'connected'),
    /** Whether a path is on an FTP or FTPS server (one command at a time there). */
    isFtp: (uri) => data.connections.find((c) => c.id === parseUri(uri).id)?.protocol !== 'sftp',
    /** A readable name for a path: "name: /path". */
    label(uri) {
      const { id, path: p } = parseUri(uri);
      const conn = data.connections.find((c) => c.id === id);
      return `${conn?.name ?? 'Server'}: ${p}`;
    },

    /** A terminal on an SFTP (SSH) server, in `cwd`: resolves with its channel. */
    async openShell(id, { cols, rows, cwd } = {}) {
      const conn = find(id);
      if (conn.protocol !== 'sftp') throw new Error(`${conn.name} is an ${protocolLabel(conn.protocol)} server; a terminal needs SSH (SFTP).`);
      const s = await session(id);
      try {
        return await s.shell({ cols, rows, cwd });
      } catch (err) {
        throw friendlyError(err, conn);
      }
    },

    // ---- Files (as diskFiles.cjs does for files on disk) ----
    read: (uri) =>
      withPath(uri, async (s, p) => {
        const st = await s.stat(p);
        if (!st) throw Object.assign(new Error('Not found on the server.'), { notFound: true });
        if (st.dir) throw new Error(`${posix.basename(p)} is a folder.`);
        const truncated = st.size > disk.MAX_FULL;
        const buf = truncated ? await s.readRange(p, st.size - disk.TAIL, disk.TAIL) : await s.read(p);
        const decoded = disk.decode(buf);
        if (truncated) decoded.text = decoded.text.slice(decoded.text.indexOf('\n') + 1);
        return { path: uri, name: posix.basename(p), ...decoded, mtimeMs: st.mtimeMs, size: st.size, truncated };
      }, { again: true }),
    write: (uri, text, { eol, bom, encoding, expectedMtime, expectedSize, force = false } = {}) =>
      withPath(uri, async (s, p) => {
        if (!force && expectedMtime !== undefined) {
          const now = await s.stat(p);
          // Changed on the server since it was read here (FTP servers may not give a time: the size then).
          if (now && (Math.abs(now.mtimeMs - expectedMtime) > 1 || (expectedSize !== undefined && now.size !== expectedSize))) return { conflict: true, mtimeMs: now.mtimeMs };
        }
        await s.write(p, disk.encode(text, { eol, bom, encoding }));
        const st = await s.stat(p);
        return { mtimeMs: st?.mtimeMs ?? Date.now(), size: st?.size ?? 0 };
      }),
    stat: (uri) =>
      withPath(uri, async (s, p) => {
        const st = await s.stat(p);
        return st && { mtimeMs: st.mtimeMs, size: st.size };
      }, { again: true }),
    readAppended: (uri, offset, { encoding = 'utf-8' } = {}) =>
      withPath(uri, async (s, p) => {
        const st = await s.stat(p);
        if (!st) throw Object.assign(new Error('Not found on the server.'), { notFound: true });
        if (st.size < offset) return { reset: true, size: st.size, mtimeMs: st.mtimeMs };
        const length = Math.min(st.size - offset, 2 * 1024 * 1024);
        const start = st.size - length;
        const buf = length ? await s.readRange(p, start, length) : Buffer.alloc(0);
        const text = (encoding === 'latin1' ? buf.toString('latin1') : buf.toString('utf8')).replace(/\r\n?/g, '\n');
        return { text, size: st.size, mtimeMs: st.mtimeMs, skipped: start - offset };
      }),
    readBytes: (uri, max) =>
      withPath(uri, async (s, p) => {
        const st = await s.stat(p);
        if (!st || st.dir) throw new Error('Not found on the server.');
        if (st.size > max) throw new Error(`${posix.basename(p)} is too large.`);
        return s.read(p);
      }),

    // ---- Folders (as the folders view does on disk) ----
    list: (uri) =>
      withPath(uri, async (s, p, id) => {
        const entries = await s.list(p);
        return { dir: uri, entries: entries.map((e) => ({ ...e, path: toUri(id, e.path), hidden: e.name.startsWith('.') })), truncated: false };
      }, { again: true }),
    newFile: (dirUri, name, { text = '', unique = false } = {}) =>
      withPath(dirUri, async (s, dir, id) => {
        const clean = checkName(name);
        const target = unique ? await freeRemotePath(s, dir, clean) : posix.join(dir, clean);
        if (!unique && (await s.stat(target))) throw new Error(`${clean} already exists here.`);
        await s.write(target, Buffer.from(text, 'utf8'));
        return toUri(id, target);
      }),
    newFolder: (dirUri, name) =>
      withPath(dirUri, async (s, dir, id) => {
        const clean = checkName(name);
        const target = posix.join(dir, clean);
        if (await s.stat(target)) throw new Error(`${clean} already exists here.`);
        await s.mkdir(target);
        return toUri(id, target);
      }),
    rename: (uri, name) =>
      withPath(uri, async (s, p, id) => {
        const clean = checkName(name);
        const target = posix.join(posix.dirname(p), clean);
        if (target === p) return uri;
        if ((await s.stat(target)) && target.toLowerCase() !== p.toLowerCase()) throw new Error(`${clean} already exists here.`);
        await s.rename(p, target);
        return toUri(id, target);
      }),
    /** Moves within one server (a rename). Returns [{ from, to }]. */
    async moveWithin(uris, dirUri) {
      const { id, path: dir } = parseUri(dirUri);
      const done = [];
      for (const uri of uris) {
        const from = parseUri(uri);
        if (from.id !== id) throw new Error('Moving between servers goes through Copy.');
        if (posix.dirname(from.path) === dir) continue;
        if (dir === from.path || dir.startsWith(`${from.path}/`)) throw new Error(`${posix.basename(from.path)} cannot go inside itself.`);
        const to = await withPath(dirUri, async (s) => {
          const target = await freeRemotePath(s, dir, posix.basename(from.path));
          await s.rename(from.path, target);
          return toUri(id, target);
        });
        done.push({ from: uri, to });
      }
      return done;
    },
    /** What Properties shows for a file or folder on a server. */
    properties: (uri) =>
      withPath(uri, async (s, p) => {
        const st = await s.stat(p);
        if (!st) throw Object.assign(new Error('Not found on the server.'), { notFound: true });
        // The owner's and the group's names come with the listing of the folder above.
        const entry = p === '/' ? null : ((await s.list(posix.dirname(p)).catch(() => [])).find((e) => e.name === posix.basename(p)) ?? null);
        return {
          name: posix.basename(p) || '/',
          path: uri,
          dir: st.dir,
          link: Boolean(entry?.link),
          size: st.size,
          mtimeMs: st.mtimeMs,
          mode: st.mode ?? entry?.mode ?? null,
          owner: entry?.owner || (st.uid !== undefined ? String(st.uid) : ''),
          group: entry?.group || (st.gid !== undefined ? String(st.gid) : ''),
        };
      }),
    /** Sets permissions (`mode`, e.g. 0o644); `recursive` also inside folders, where folders keep their x for every r. */
    async chmod(uris, mode, { recursive = false } = {}) {
      let changed = 0;
      for (const uri of uris) {
        await withPath(uri, async (s, p) => {
          // The one asked for gets `mode`; inside it, folders dirMode and files fileMode. Links are
          // left alone (chmod on one changes what it points at, anywhere on the server).
          const items = recursive ? await walkNoLinks(s, p) : [{ path: p }];
          for (const [i, item] of items.entries()) {
            await s.chmod(item.path, i === 0 ? mode : item.dir ? dirMode(mode) : fileMode(mode, item.mode ?? 0));
            changed++;
          }
        });
      }
      return changed;
    },
    /** The size of a folder and what is in it: { size, files, folders, truncated }. */
    folderSize: (uri) =>
      withPath(uri, async (s, p) => {
        const out = { size: 0, files: 0, folders: 0, truncated: false };
        const pending = [p];
        const until = Date.now() + 60000;
        while (pending.length) {
          if (out.files + out.folders > 200000 || Date.now() > until) {
            out.truncated = true;
            break;
          }
          for (const e of await s.list(pending.shift()).catch(() => [])) {
            if (e.dir && !e.link) {
              out.folders++;
              pending.push(e.path);
            } else if (!e.dir) {
              out.files++;
              out.size += e.size;
            }
          }
        }
        return out;
      }),
    // ---- Mirrors (mirror.cjs): whole folders and files ----
    /** Everything under a folder: { 'rel/path': { dir, size, mtimeMs } }, without what `skip(rel)` leaves out. */
    listTree: (uri, skip = () => false, max = 50000) =>
      withPath(uri, async (s, root) => {
        const out = {};
        const pending = [''];
        let count = 0;
        while (pending.length) {
          const rel = pending.shift();
          for (const e of await s.list(rel ? posix.join(root, rel) : root)) {
            const child = rel ? `${rel}/${e.name}` : e.name;
            if (skip(child) || e.link) continue;
            // FTP without MLSD lists no times: MDTM gives the one a transfer reports too.
            const mtimeMs = !e.dir && !e.mtimeMs && s.lastMod ? await s.lastMod(e.path) : e.mtimeMs;
            out[child] = { dir: e.dir, size: e.dir ? 0 : e.size, mtimeMs };
            if (++count > max) throw new Error(`Too many files to mirror (more than ${max.toLocaleString()}).`);
            if (e.dir) pending.push(child);
          }
        }
        return out;
      }),
    /** A file from a server written to a path here; returns its { size, mtimeMs } on the server. */
    downloadFile: (uri, localPath) =>
      withPath(uri, async (s, p) => {
        await s.downloadTo(p, localPath);
        const st = await s.stat(p);
        return { dir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 };
      }),
    /**
     * A file here written to a server (its folders made as needed); returns its
     * { size, mtimeMs } there. `expected` ({ size, mtimeMs } or null for none): the
     * file there as it was listed; when it changed since, nothing is written.
     */
    uploadFile: (localPath, uri, expected) =>
      withPath(uri, async (s, p) => {
        if (expected !== undefined) {
          const now = await s.stat(p);
          const changed = expected ? !now || now.size !== expected.size || Math.abs(now.mtimeMs - expected.mtimeMs) >= 1000 : Boolean(now);
          if (changed) throw new Error('changed on the server during the sync; it is looked at again next time.');
        }
        await mkdirp(s, posix.dirname(p));
        await s.uploadFrom(localPath, p);
        const st = await s.stat(p);
        return { dir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 };
      }),
    /** A folder and the ones above it, where missing. */
    mkdirp: (uri) => withPath(uri, (s, p) => mkdirp(s, p)),
    /** A folder removed only when it is empty. */
    removeEmptyDir: (uri) =>
      withPath(uri, async (s, p) => {
        if (p !== '/' && !(await s.list(p)).length) await s.rmdir(p);
      }),
    /** Deletes for good (servers have no Recycle Bin). */
    async remove(uris) {
      const done = [];
      for (const uri of uris) {
        await withPath(uri, (s, p) => {
          if (p === '/') throw new Error('The server\'s top folder cannot be deleted.');
          return s.remove(p);
        });
        done.push(uri);
      }
      return done;
    },
    /**
     * Copies into a folder on a server: from the same server, another one, or
     * this computer (local paths). Returns [{ from, to }]. With `job` (see main.cjs's
     * transfers) everything is listed first for the totals, files go through putFile
     * with progress, and when the job stops, what was done so far is on the error
     * (`done`).
     */
    async copyInto(sources, dirUri, { sameNameAsCopy = true, job = null } = {}) {
      const { id, path: dir } = parseUri(dirUri);
      const plans = [];
      for (const source of sources) {
        const name = isRemote(source) ? posix.basename(parseUri(source).path) : nodePath.basename(source);
        const same = isRemote(source) && parseUri(source).id === id && posix.dirname(parseUri(source).path) === dir;
        if (isRemote(source) && parseUri(source).id === id && (dir === parseUri(source).path || dir.startsWith(`${parseUri(source).path}/`))) throw new Error(`${name} cannot go inside itself.`);
        const items = isRemote(source) ? await withPath(source, (s, p) => walk(s, p)) : localWalk(source);
        plans.push({ source, name, same, items });
      }
      job?.plan(plans.flatMap((pl) => pl.items.filter((i) => !i.dir)));
      const done = [];
      try {
        for (const { source, name, same, items } of plans) {
          const target = await withPath(dirUri, (s) => freeRemotePath(s, dir, name, { copy: same && sameNameAsCopy }));
          const root = isRemote(source) ? parseUri(source).path : source;
          for (const item of items) {
            if (job?.signal.aborted) throw stoppedError();
            const rel = isRemote(source) ? posix.relative(root, item.path) : nodePath.relative(root, item.path).split(nodePath.sep).join('/');
            const dest = rel ? posix.join(target, rel) : target;
            if (item.dir) await withPath(dirUri, (s) => s.mkdir(dest));
            else if (!job) {
              const bytes = isRemote(source) ? await withPath(source, (s) => s.read(item.path)) : fs.readFileSync(item.path);
              await withPath(dirUri, (s) => s.write(dest, bytes));
            } else await sendFile(source, item, dirUri, dest, job);
          }
          done.push({ from: source, to: toUri(id, target) });
        }
      } catch (err) {
        throw Object.assign(err, { done });
      }
      return done;
    },
    /** Copies files and folders from a server into a folder on this computer. Returns [{ from, to }]; `job` as for copyInto. */
    async downloadInto(uris, localDir, freePath, { job = null } = {}) {
      const plans = [];
      for (const uri of uris) plans.push({ uri, items: await withPath(uri, (s, p) => walk(s, p)) });
      job?.plan(plans.flatMap((pl) => pl.items.filter((i) => !i.dir)));
      const done = [];
      try {
        for (const { uri, items } of plans) {
          const { path: root } = parseUri(uri);
          const target = freePath(localDir, posix.basename(root));
          for (const item of items) {
            if (job?.signal.aborted) throw stoppedError();
            const rel = posix.relative(root, item.path);
            const dest = rel ? localUnder(target, rel) : target;
            if (item.dir) fs.mkdirSync(dest, { recursive: true });
            else if (!job) fs.writeFileSync(dest, await withPath(uri, (s) => s.read(item.path)), { flag: 'wx' });
            else {
              const part = partOf(dest, nodePath.join, nodePath.dirname, nodePath.basename);
              job.start(item);
              try {
                await withPath(uri, (s) => s.getFile(item.path, part, { onBytes: (n) => job.bytes(n), signal: job.signal }));
                fs.renameSync(part, dest);
              } catch (err) {
                fs.rmSync(part, { force: true });
                throw err;
              }
              job.fileDone(item);
            }
          }
          done.push({ from: uri, to: target });
        }
      } catch (err) {
        throw Object.assign(err, { done });
      }
      return done;
    },
  };

  // One file to `dest` on a server, through a .part name, with progress: from this computer
  // with putFile; from a server through a temporary file here (or in memory when small).
  async function sendFile(source, item, dirUri, dest, job) {
    const part = partOf(dest);
    job.start(item);
    let temp = null;
    try {
      let from = item.path;
      if (isRemote(source)) {
        if (item.size <= 4 * 1024 * 1024) {
          const bytes = await withPath(source, (s) => s.read(item.path));
          job.bytes(Math.floor(bytes.length / 2));
          await withPath(dirUri, (s) => s.write(part, bytes));
        } else {
          temp = nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), 'tracker-editor-xfer-')), 'file');
          await withPath(source, (s) => s.getFile(item.path, temp, { onBytes: (n) => job.bytes(Math.floor(n / 2)), signal: job.signal }));
          from = temp;
        }
      }
      if (!isRemote(source) || temp) {
        const half = isRemote(source) ? Math.floor(item.size / 2) : 0;
        await withPath(dirUri, (s) => s.putFile(from, part, { onBytes: (n) => job.bytes(half + (isRemote(source) ? Math.floor(n / 2) : n)), signal: job.signal }));
      }
      await withPath(dirUri, (s) => s.rename(part, dest));
    } catch (err) {
      // What a stopped connection left behind goes too (once more a moment later, when an
      // FTP server's only connection was closed to stop it and opens again).
      const removePart = () => withPath(dirUri, (s) => s.remove(part));
      await removePart().catch(() => new Promise((r) => setTimeout(r, 300)).then(removePart)).catch(() => {});
      throw err;
    } finally {
      if (temp) fs.rmSync(nodePath.dirname(temp), { recursive: true, force: true });
    }
    job.fileDone(item);
  }
  return api;
}

// Files and folders under a local path, for uploading.
function localWalk(p, out = []) {
  const st = fs.statSync(p);
  out.push({ path: p, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size });
  if (out.length > MAX_COPY_ENTRIES) throw new Error('Too many files at once (more than 10,000).');
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) localWalk(nodePath.join(p, name), out);
  return out;
}

/** A temporary copy of a file on a server, to open with its program. */
function tempCopyPath(uri) {
  const dir = nodePath.join(os.tmpdir(), 'Tracker Editor remote', crypto.createHash('sha1').update(uri).digest('hex').slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  return nodePath.join(dir, posix.basename(parseUri(uri).path));
}

module.exports = { createRemote, isRemote, parseUri, toUri, fingerprintOf, friendlyError, tempCopyPath, localUnder, SCHEME, PROTOCOLS, DEFAULT_PORT };
