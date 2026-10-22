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
const { checkName } = require('./folders.cjs');

const posix = nodePath.posix;
const SCHEME = 'remote://';
const PROTOCOLS = ['sftp', 'ftps', 'ftp'];
const DEFAULT_PORT = { sftp: 22, ftps: 21, ftp: 21 };
const MAX_COPY_ENTRIES = 10000;

const isRemote = (p) => typeof p === 'string' && p.startsWith(SCHEME);

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

class SftpSession {
  constructor(conn, { secret, verifyHost, onClose }) {
    this.conn = conn;
    this.secret = secret;
    this.verifyHost = verifyHost;
    this.onClose = onClose;
  }

  async open() {
    const { Client } = require('ssh2');
    const { conn } = this;
    const client = new Client();
    const options = {
      host: conn.host,
      port: conn.port,
      username: conn.user,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      hostVerifier: (key, verify) => {
        this.verifyHost(fingerprintOf(key)).then(verify, () => verify(false));
      },
    };
    if (conn.auth === 'password') options.password = this.secret('password');
    if (conn.auth === 'key') {
      options.privateKey = fs.readFileSync(conn.keyPath);
      const passphrase = this.secret('passphrase');
      if (passphrase) options.passphrase = passphrase;
    }
    if (conn.auth === 'agent') options.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
    await new Promise((resolve, reject) => {
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => this.secret('password'))));
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect(options);
    });
    this.client = client;
    this.sftp = await new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
    client.on('error', () => {});
    client.on('close', () => this.onClose());
    return this;
  }

  close() {
    this.client?.end();
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
      return { dir: s.isDirectory(), size: s.size, mtimeMs: s.mtime * 1000, mode: s.mode };
    } catch (err) {
      if (err.code === 2) return null;
      throw err;
    }
  }

  async list(dir) {
    const items = await this.call('readdir', dir);
    return Promise.all(
      items.map(async ({ filename, attrs }) => {
        let isDir = attrs.isDirectory();
        // A link: what it points at.
        if (attrs.isSymbolicLink()) isDir = Boolean((await this.stat(posix.join(dir, filename)).catch(() => null))?.dir);
        return { name: filename, path: posix.join(dir, filename), dir: isDir, size: isDir ? 0 : attrs.size, mtimeMs: attrs.mtime * 1000 };
      }),
    );
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

class FtpSession {
  constructor(conn, { secret, onClose }) {
    this.conn = conn;
    this.secret = secret;
    this.onClose = onClose;
    this.queue = Promise.resolve();
  }

  async open() {
    const ftp = require('basic-ftp');
    const { conn } = this;
    this.client = new ftp.Client(30000);
    await this.client.access({
      host: conn.host,
      port: conn.port,
      user: conn.user || 'anonymous',
      password: this.secret('password'),
      secure: conn.protocol === 'ftps',
      secureOptions: { rejectUnauthorized: !conn.allowSelfSigned, servername: require('node:net').isIP(conn.host) ? undefined : conn.host },
    });
    this.client.ftp.socket.on('close', () => this.onClose());
    return this;
  }

  close() {
    this.client?.close();
  }

  // One command at a time on an FTP control connection.
  run(fn) {
    const next = this.queue.then(() => {
      if (this.client.closed) throw Object.assign(new Error('The connection was closed.'), { code: 'ECONNRESET' });
      return fn(this.client);
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
    return { dir: hit.isDirectory, size: hit.isDirectory ? 0 : hit.size, mtimeMs };
  }

  async list(dir) {
    const listing = await this.run((c) => c.list(dir));
    return listing
      .filter((f) => f.name !== '.' && f.name !== '..')
      .map((f) => ({ name: f.name, path: posix.join(dir, f.name), dir: f.isDirectory, size: f.isDirectory ? 0 : f.size, mtimeMs: f.modifiedAt?.getTime?.() ?? 0 }));
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
function createRemote({ store, secrets, askHostKey, onStatus = () => {} }) {
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
    return {
      id: existing?.id ?? crypto.randomBytes(5).toString('hex'),
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
    };
  }

  async function open(conn, { probe = false } = {}) {
    const secret = (kind) => (probe && conn.draftSecrets?.[kind] !== undefined ? conn.draftSecrets[kind] : secrets.get(conn.id, kind));
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
      if (l?.session) {
        live.set(conn.id, { state: 'disconnected', error: '' });
        onStatus({ id: conn.id, state: 'disconnected', error: '' });
      }
    };
    const session = conn.protocol === 'sftp' ? new SftpSession(conn, { secret, verifyHost, onClose }) : new FtpSession(conn, { secret, onClose });
    try {
      return await session.open();
    } catch (err) {
      session.close();
      throw friendlyError(err, conn);
    }
  }

  /** The open session of a server, connecting when needed (one attempt at a time). */
  async function session(id) {
    const l = live.get(id);
    if (l?.session && l.state === 'connected') return l.session;
    if (l?.opening) return l.opening;
    const conn = find(id);
    setState(id, 'connecting');
    const opening = open(conn).then(
      (s) => {
        live.set(id, { session: s, state: 'connected', error: '' });
        onStatus({ id, state: 'connected', error: '' });
        return s;
      },
      (err) => {
        live.set(id, { state: 'error', error: err.message });
        onStatus({ id, state: 'error', error: err.message });
        throw err;
      },
    );
    live.set(id, { ...live.get(id), opening });
    return opening;
  }

  /** Runs `fn(session, path)` for a remote:// path, with friendly errors. */
  async function withPath(uri, fn) {
    const { id, path: p } = parseUri(uri);
    const conn = find(id);
    const s = await session(id);
    try {
      return await fn(s, p, id);
    } catch (err) {
      throw friendlyError(err, conn);
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

  // Files and folders under `p` (for copying between places), at most MAX_COPY_ENTRIES.
  async function walk(s, p, out = []) {
    const st = await s.stat(p);
    if (!st) throw Object.assign(new Error('Not found on the server.'), { notFound: true });
    out.push({ path: p, dir: st.dir });
    if (out.length > MAX_COPY_ENTRIES) throw new Error('Too many files to copy at once.');
    if (st.dir) for (const e of await s.list(p)) await walk(s, e.path, out);
    return out;
  }

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
      api.disconnect(id);
      const conn = data.connections.find((c) => c.id === id);
      data.connections = data.connections.filter((c) => c.id !== id);
      if (conn && !data.connections.some((c) => c.host === conn.host && c.port === conn.port)) delete data.knownHosts[`[${conn.host}]:${conn.port}`];
      save();
      secrets.set(id, 'password', '');
      secrets.set(id, 'passphrase', '');
      return true;
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
    isConnected: (id) => live.get(id)?.state === 'connected',
    /** A readable name for a path: "name: /path". */
    label(uri) {
      const { id, path: p } = parseUri(uri);
      const conn = data.connections.find((c) => c.id === id);
      return `${conn?.name ?? 'Server'}: ${p}`;
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
      }),
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
      }),
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
      }),
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
     * this computer (local paths). Returns [{ from, to }].
     */
    async copyInto(sources, dirUri, { sameNameAsCopy = true } = {}) {
      const { id, path: dir } = parseUri(dirUri);
      const done = [];
      for (const source of sources) {
        const name = isRemote(source) ? posix.basename(parseUri(source).path) : nodePath.basename(source);
        const same = isRemote(source) && parseUri(source).id === id && posix.dirname(parseUri(source).path) === dir;
        if (isRemote(source) && parseUri(source).id === id && (dir === parseUri(source).path || dir.startsWith(`${parseUri(source).path}/`))) throw new Error(`${name} cannot go inside itself.`);
        const target = await withPath(dirUri, (s) => freeRemotePath(s, dir, name, { copy: same && sameNameAsCopy }));
        const items = isRemote(source) ? await withPath(source, (s, p) => walk(s, p)) : localWalk(source);
        const root = isRemote(source) ? parseUri(source).path : source;
        for (const item of items) {
          const rel = isRemote(source) ? posix.relative(root, item.path) : nodePath.relative(root, item.path).split(nodePath.sep).join('/');
          const dest = rel ? posix.join(target, rel) : target;
          if (item.dir) await withPath(dirUri, (s) => s.mkdir(dest));
          else {
            const bytes = isRemote(source) ? await withPath(source, (s) => s.read(item.path)) : fs.readFileSync(item.path);
            await withPath(dirUri, (s) => s.write(dest, bytes));
          }
        }
        done.push({ from: source, to: toUri(id, target) });
      }
      return done;
    },
    /** Copies files and folders from a server into a folder on this computer. Returns [{ from, to }]. */
    async downloadInto(uris, localDir, freePath) {
      const done = [];
      for (const uri of uris) {
        const { path: root } = parseUri(uri);
        const target = freePath(localDir, posix.basename(root));
        for (const item of await withPath(uri, (s, p) => walk(s, p))) {
          const rel = posix.relative(root, item.path);
          const dest = rel ? nodePath.join(target, ...rel.split('/')) : target;
          if (item.dir) fs.mkdirSync(dest, { recursive: true });
          else fs.writeFileSync(dest, await withPath(uri, (s) => s.read(item.path)), { flag: 'wx' });
        }
        done.push({ from: uri, to: target });
      }
      return done;
    },
  };
  return api;
}

// Files and folders under a local path, for uploading.
function localWalk(p, out = []) {
  const st = fs.statSync(p);
  out.push({ path: p, dir: st.isDirectory() });
  if (out.length > MAX_COPY_ENTRIES) throw new Error('Too many files to copy at once.');
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) localWalk(nodePath.join(p, name), out);
  return out;
}

/** A temporary copy of a file on a server, to open with its program. */
function tempCopyPath(uri) {
  const dir = nodePath.join(os.tmpdir(), 'Tracker Editor remote', crypto.createHash('sha1').update(uri).digest('hex').slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  return nodePath.join(dir, posix.basename(parseUri(uri).path));
}

module.exports = { createRemote, isRemote, parseUri, toUri, fingerprintOf, friendlyError, tempCopyPath, SCHEME, PROTOCOLS, DEFAULT_PORT };
