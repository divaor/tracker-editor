// How the Android app's page reaches the desktop main process's handlers when they run in
// the app's own Node.js: HTTP on 127.0.0.1 in place of Electron's IPC.
//   POST /invoke {channel, args}  → ipcMain.handle's handler: {ok, value} or {ok: false, error}
//   POST /send   {channel, args}  → ipcMain.on's listeners (no answer)
//   GET  /events                  → server-sent events: webContents.send(channel, …args)
//   POST /native {id, answer}     → the answer to a question asked of the phone (a picker, a
//                                   dialog); only the app's native side knows its token
// Every request carries the page's token (or the native one); other apps on the phone reach
// the port but not the handlers. Bytes (Buffers) travel as { __bytes: base64 }.
const crypto = require('node:crypto');
const http = require('node:http');

const MAX_BODY = 64 * 1024 * 1024;
const QUEUE = 500; // events kept while no page listens

/** Values for JSON: Buffers and typed arrays become { __bytes }. */
function pack(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return { __bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') };
  if (value instanceof ArrayBuffer) return { __bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(pack);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map || value instanceof Set) return pack([...value]);
  const out = {};
  for (const [k, v] of Object.entries(value)) if (typeof v !== 'function') out[k] = pack(v);
  return out;
}

/** The other way: { __bytes } back to Buffers. */
function unpack(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.__bytes === 'string' && Object.keys(value).length === 1) return Buffer.from(value.__bytes, 'base64');
  if (Array.isArray(value)) return value.map(unpack);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = unpack(v);
  return out;
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The server. `event` is what handlers get as their first argument (Electron's IpcMainEvent:
 * sender, senderFrame). Returns { handle, on, emit, ask, listen, close }.
 */
function createBridge({ token, nativeToken, origin = 'https://localhost', event = {} }) {
  const handlers = new Map();
  const listeners = new Map();
  const clients = new Set();
  const queued = [];
  const asked = new Map(); // id → resolve

  function emit(channel, ...args) {
    const data = `data: ${JSON.stringify({ channel, args: pack(args) })}\n\n`;
    if (!clients.size) {
      queued.push(data);
      if (queued.length > QUEUE) queued.shift();
      return;
    }
    for (const res of clients) res.write(data);
  }

  /** Asks the phone (through the page, answered by the native side): resolves with its answer. */
  function ask(kind, payload = {}) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      asked.set(id, resolve);
      emit('native:ask', { id, kind, payload });
    });
  }

  const cors = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
  };
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('Too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    const url = new URL(req.url, 'http://127.0.0.1');
    const given = req.headers['x-token'] ?? url.searchParams.get('token');
    if (url.pathname === '/native') {
      if (!same(given, nativeToken)) return reply(res, 403, { ok: false, error: 'Not allowed' });
      const { id, answer } = await readBody(req).catch(() => ({}));
      const resolve = asked.get(id);
      asked.delete(id);
      resolve?.(unpack(answer));
      return reply(res, 200, { ok: Boolean(resolve) });
    }
    if (!same(given, token)) return reply(res, 403, { ok: false, error: 'Not allowed' });
    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': hello\n\n');
      clients.add(res);
      for (const data of queued.splice(0)) res.write(data);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (url.pathname === '/ping') return reply(res, 200, { ok: true });
    if (req.method !== 'POST' || (url.pathname !== '/invoke' && url.pathname !== '/send')) return reply(res, 404, { ok: false, error: 'Not found' });
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return reply(res, 400, { ok: false, error: err.message });
    }
    const args = Array.isArray(body.args) ? unpack(body.args) : [];
    if (url.pathname === '/send') {
      for (const fn of listeners.get(body.channel) ?? []) {
        try {
          fn(event, ...args);
        } catch (err) {
          console.error(body.channel, err);
        }
      }
      return reply(res, 200, { ok: true });
    }
    const handler = handlers.get(body.channel);
    if (!handler) return reply(res, 200, { ok: false, error: `Not available on this device (${body.channel})` });
    try {
      reply(res, 200, { ok: true, value: pack(await handler(event, ...args)) });
    } catch (err) {
      reply(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
  });

  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
    on: (channel, fn) => listeners.set(channel, [...(listeners.get(channel) ?? []), fn]),
    emit,
    ask,
    /** Listens on 127.0.0.1 (a free port unless one is given); resolves with the port. */
    listen: (port = 0) => new Promise((resolve, reject) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)).once('error', reject)),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    channels: () => [...handlers.keys()],
  };
}

module.exports = { createBridge, pack, unpack };
