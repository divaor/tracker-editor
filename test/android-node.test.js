// The Android app's own Node.js: the bridge between the page and the desktop main process's
// handlers (mobile/node/bridge.cjs).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createBridge, pack, unpack } = require('../mobile/node/bridge.cjs');

async function started(options = {}) {
  const bridge = createBridge({ token: 'page-token', nativeToken: 'native-token', event: { sender: 'page' }, ...options });
  const port = await bridge.listen();
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, token = 'page-token') => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body) });
  return { bridge, base, post };
}

/** The first `count` server-sent events of /events. */
async function events(base, count, token = 'page-token') {
  const res = await fetch(`${base}/events?token=${token}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const out = [];
  let buf = '';
  while (out.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let at;
    while ((at = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, at);
      buf = buf.slice(at + 2);
      if (chunk.startsWith('data: ')) out.push(JSON.parse(chunk.slice(6)));
    }
  }
  await reader.cancel();
  return out;
}

test('bytes travel as base64 both ways', () => {
  const packed = pack({ name: 'a.png', bytes: Buffer.from([1, 2, 3]), list: [new Uint8Array([4, 5])], when: new Date(0), fn: () => {} });
  assert.deepEqual(packed, { name: 'a.png', bytes: { __bytes: 'AQID' }, list: [{ __bytes: 'BAU=' }], when: '1970-01-01T00:00:00.000Z' });
  const back = unpack(packed);
  assert.ok(Buffer.isBuffer(back.bytes));
  assert.deepEqual([...back.bytes], [1, 2, 3]);
  assert.deepEqual([...back.list[0]], [4, 5]);
  // An object that merely has the key stays as it is.
  assert.deepEqual(unpack({ __bytes: 'AQ==', more: 1 }), { __bytes: 'AQ==', more: 1 });
});

test('handlers answer with the page token only', async () => {
  const { bridge, base, post } = await started();
  try {
    bridge.handle('sum', (event, a, b) => ({ who: event.sender, sum: a + b }));
    bridge.handle('fails', () => {
      throw new Error('No such folder');
    });
    assert.deepEqual(await (await post('/invoke', { channel: 'sum', args: [2, 3] })).json(), { ok: true, value: { who: 'page', sum: 5 } });
    assert.deepEqual(await (await post('/invoke', { channel: 'fails', args: [] })).json(), { ok: false, error: 'No such folder' });
    assert.match((await (await post('/invoke', { channel: 'nope', args: [] })).json()).error, /Not available/);
    assert.equal((await post('/invoke', { channel: 'sum', args: [1, 1] }, 'wrong')).status, 403);
    assert.equal((await post('/invoke', { channel: 'sum', args: [1, 1] }, 'native-token')).status, 403);
    assert.equal((await fetch(`${base}/ping`)).status, 403);
    // The page's origin may call it (CORS), with the private network header Chrome asks for.
    const pre = await fetch(`${base}/invoke`, { method: 'OPTIONS' });
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  } finally {
    await bridge.close();
  }
});

test('messages reach the listeners, bytes as Buffers', async () => {
  const { bridge, post } = await started();
  try {
    const got = [];
    bridge.on('term:input', (event, id, data) => got.push([event.sender, id, data]));
    await post('/send', { channel: 'term:input', args: ['t1', { __bytes: 'aGk=' }] });
    assert.equal(got.length, 1);
    assert.equal(got[0][0], 'page');
    assert.equal(got[0][2].toString(), 'hi');
  } finally {
    await bridge.close();
  }
});

test('events wait until the page listens', async () => {
  const { bridge, base } = await started();
  try {
    bridge.emit('folder:changed', '/storage/emulated/0/Documents');
    bridge.emit('term:data', 't1', Buffer.from('ok'));
    const [first, second] = await events(base, 2);
    assert.deepEqual(first, { channel: 'folder:changed', args: ['/storage/emulated/0/Documents'] });
    assert.deepEqual(second, { channel: 'term:data', args: ['t1', { __bytes: 'b2s=' }] });
  } finally {
    await bridge.close();
  }
});

test('questions for the phone are answered by its native side alone', async () => {
  const { bridge, base, post } = await started();
  try {
    const answer = bridge.ask('open', { properties: ['openDirectory'] });
    const [asked] = await events(base, 1);
    assert.equal(asked.channel, 'native:ask');
    const { id, kind } = asked.args[0];
    assert.equal(kind, 'open');
    // The page cannot answer (it could pick any folder it liked).
    assert.equal((await post('/native', { id, answer: { paths: ['/'] } })).status, 403);
    assert.deepEqual(await (await post('/native', { id, answer: { paths: ['/storage/emulated/0/Documents'] } }, 'native-token')).json(), { ok: true });
    assert.deepEqual(await answer, { paths: ['/storage/emulated/0/Documents'] });
    // Once only.
    assert.deepEqual(await (await post('/native', { id, answer: { paths: ['/'] } }, 'native-token')).json(), { ok: false });
  } finally {
    await bridge.close();
  }
});

test('the Android app carries every page module the main process imports', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const listed = JSON.parse(/const PAGE_MODULES = (\[[^\]]*\])/.exec(read('scripts/android-node.js'))[1].replace(/'/g, '"'));
  const wanted = new Set();
  const add = (name) => {
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const [, dep] of read(`app/js/${name}`).matchAll(/from '\.\/([\w.-]+\.js)'/g)) add(dep);
  };
  for (const f of fs.readdirSync(new URL('../electron/', import.meta.url)).filter((f) => f.endsWith('.cjs'))) {
    for (const [, name] of read(`electron/${f}`).matchAll(/APP_DIR, 'js', '([\w.-]+\.js)'/g)) add(name);
  }
  assert.ok(wanted.size > 3);
  assert.deepEqual([...wanted].filter((name) => !listed.includes(name)), []);
});

test('what the phone’s Node.js lacks is filled in', async () => {
  const { Collator, strictUtf8Decoder, userInfoFallback, watchFallback } = require('../mobile/node/phone.cjs');
  // Folders' order: numbers as numbers, case ignored with 'base'.
  const names = ['file10.txt', 'File2.txt', 'file1.txt', 'b', 'A'];
  assert.deepEqual([...names].sort(new Collator(undefined, { numeric: true, sensitivity: 'base' }).compare), ['A', 'b', 'file1.txt', 'File2.txt', 'file10.txt']);
  assert.deepEqual(['b', 'a10', 'a9'].sort(new Collator().compare), ['a10', 'a9', 'b']);
  // UTF-8 checked strictly, as the desktop does to tell UTF-8 files from Latin-1 ones.
  class NoIcu extends TextDecoder {
    constructor(label, options = {}) {
      if (options.fatal) throw Object.assign(new TypeError('no ICU'), { code: 'ERR_NO_ICU' });
      super(label, options);
    }
  }
  const Strict = strictUtf8Decoder(NoIcu, (await import('node:buffer')).isUtf8);
  assert.equal(new Strict('utf-8', { fatal: true }).decode(Buffer.from('café', 'utf8')), 'café');
  assert.throws(() => new Strict('utf-8', { fatal: true }).decode(Buffer.from('caf\xe9', 'latin1')), TypeError);
  assert.equal(new Strict('utf-8').decode(Buffer.from('caf\xe9', 'latin1')), 'caf�');
  // An app's user has no passwd entry.
  const info = userInfoFallback(() => {
    throw new Error('uv_os_get_passwd returned ENOENT');
  })();
  assert.equal(typeof info.username, 'string');
  assert.ok(info.username.length > 0);
  // No recursive watching: the folder itself.
  const seen = [];
  const watch = watchFallback((file, options) => {
    seen.push(options.recursive);
    if (options.recursive) throw Object.assign(new TypeError('not on this platform'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
    return 'watcher';
  });
  assert.equal(watch('/x', { recursive: true }), 'watcher');
  assert.deepEqual(seen, [true, false]);
});
