// The preview server (previewServer.cjs): HTML projects served on 127.0.0.1 for Run and the
// preview's Run scripts. Only files the editor may open, inside their site, with the token and
// the site's id; the browser's live reload; the editor's unsaved text; a note as one page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ps = require('../electron/previewServer.cjs');
const folders = require('../electron/folders.cjs');

const tree = (files, base = mkdtempSync(path.join(tmpdir(), 'preview-'))) => {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(base, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return base;
};
// main.cjs's checkFile rule: a file picked alone, or inside a picked folder by real path.
const rule = (picked, files = []) => (file) => files.includes(file) || folders.allowedBy(picked, file);

function get(port, raw, { host = `127.0.0.1:${port}`, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: raw, method, headers: { Host: host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, body: bytes.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const pathOf = (url) => new URL(url).pathname;
/** Waits for "data: reload" on a site's event stream; resolves with the request to close. */
function listen(port, token, site) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/p/${token}/__reload?site=${encodeURIComponent(site)}`, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let text = '';
      let waiting = null;
      const reloads = () => text.split('data: reload').length - 1;
      res.on('data', (c) => {
        text += c;
        if (waiting && reloads() >= waiting.count) waiting.resolve();
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        reloads,
        next: (count = reloads() + 1, ms = 3000) =>
          new Promise((ok, fail) => {
            if (reloads() >= count) return ok();
            const t = setTimeout(() => fail(new Error(`no reload after ${ms} ms`)), ms);
            waiting = { count, resolve: () => (clearTimeout(t), ok()) };
          }),
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}
const tokenOf = (url) => pathOf(url).split('/')[2];
const siteOf = (url) => pathOf(url).split('/')[3];

test('the site of a page: the nearest folder with .git or package.json, else the highest with an index.html, never above the picked folder', () => {
  const root = tree({
    'proj/.git/HEAD': 'ref: refs/heads/main',
    'proj/docs/index.html': '<h1>docs</h1>',
    'proj/pages/about.html': '<h1>about</h1>',
    'web/index.html': '<h1>web</h1>',
    'web/pages/contact.html': '<h1>contact</h1>',
    'loose/page.html': '<h1>page</h1>',
    'npm/package.json': '{}',
    'npm/public/index.html': '<h1>npm</h1>',
  });
  assert.equal(ps.siteRoot(path.join(root, 'proj/docs/index.html'), [root]), path.join(root, 'proj'));
  assert.equal(ps.siteRoot(path.join(root, 'proj/pages/about.html'), [root]), path.join(root, 'proj'));
  assert.equal(ps.siteRoot(path.join(root, 'web/pages/contact.html'), [root]), path.join(root, 'web'));
  assert.equal(ps.siteRoot(path.join(root, 'loose/page.html'), [root]), path.join(root, 'loose'));
  assert.equal(ps.siteRoot(path.join(root, 'npm/public/index.html'), [root]), path.join(root, 'npm'));
  // Never above the picked folder that holds the file (the deepest one).
  assert.equal(ps.siteRoot(path.join(root, 'proj/pages/about.html'), [root, path.join(root, 'proj/pages')]), path.join(root, 'proj/pages'));
  // A file picked alone: its own folder.
  assert.equal(ps.siteRoot(path.join(root, 'proj/pages/about.html'), []), path.join(root, 'proj/pages'));
});

test('the page of a stylesheet or a script: an index.html in its folder or above, up to its site, that the editor may open', () => {
  const root = tree({ 'site/.git/HEAD': '', 'site/index.html': '<p>', 'site/css/style.css': 'p{}', 'site/js/deep/app.js': '', 'other/x.css': '' });
  assert.equal(ps.pageOf(path.join(root, 'site/css/style.css'), { tops: [root] }), path.join(root, 'site/index.html'));
  assert.equal(ps.pageOf(path.join(root, 'site/js/deep/app.js'), { tops: [root] }), path.join(root, 'site/index.html'));
  assert.equal(ps.pageOf(path.join(root, 'other/x.css'), { tops: [root] }), null);
  assert.equal(ps.pageOf(path.join(root, 'site/css/style.css'), { tops: [root], allowed: () => false }), null);
});

test('names in an address: no way out of the site, no dot names, nothing that is not a plain name', () => {
  assert.equal(ps.cleanName('index.html'), 'index.html');
  assert.equal(ps.cleanName('my%20page.html'), 'my page.html');
  assert.equal(ps.cleanName('.well-known'), '.well-known');
  for (const bad of ['..', '.', '%2e%2e', '..%2f', 'a%2fb', 'a%5cb', '.git', '.env', '%2eenv', 'a%00b', '%E0%A4%A']) assert.equal(ps.cleanName(bad), null, bad);
  assert.equal(ps.pageName('Notes/My page'), 'My page.html');
  assert.equal(ps.pageName('report.HTML'), 'report.HTML');
  assert.equal(ps.pageName('.hidden.html'), 'page.hidden.html');
  assert.equal(ps.pageName(''), 'page.html');
  assert.equal(ps.mimeOf('a.mjs'), 'text/javascript');
  assert.equal(ps.mimeOf('a.wasm'), 'application/wasm');
  assert.equal(ps.mimeOf('a.unknown'), 'application/octet-stream');
});

test('a site: its files with their types, never cached; index.html for a folder; no listings; the browser’s live reload only at the top of a window', async () => {
  const root = tree({
    'site/.git/HEAD': '',
    'site/index.html': '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><p>héllo</p></body></html>',
    'site/style.css': 'p { color: red }',
    'site/app.mjs': 'export const x = 1;',
    'site/data.json': '{"a":1}',
    'site/docs/index.html': '<h1>Docs</h1>',
    'site/empty/readme.txt': 'no index here',
    'site/pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 4, 5]),
    'site/latin.html': Buffer.from('<p>caf\xe9</p>', 'latin1'),
  });
  const server = ps.createPreviewServer({ allowed: rule([root]), tops: () => [root] });
  try {
    const { url, site } = await server.url(path.join(root, 'site/index.html'));
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/p\/[\w-]{24}\/site-[\w-]{12}\/index\.html$/);
    assert.equal(siteOf(url), site);
    const port = server.port;
    const base = pathOf(url).replace(/index\.html$/, '');

    const page = await get(port, pathOf(url));
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.match(page.body, /<p>héllo<\/p>/);
    // A browser page (no Sec-Fetch-Dest, or document): the live reload goes in before </body>.
    assert.match(page.body, new RegExp(`<script src="/p/${tokenOf(url)}/__live\\.js\\?site=${site}"></script></body>`));
    const top = await get(port, pathOf(url), { headers: { 'Sec-Fetch-Dest': 'document' } });
    assert.match(top.body, /__live\.js/);
    // The app's frame, and what a script fetches: the page as it is.
    const framed = await get(port, pathOf(url), { headers: { 'Sec-Fetch-Dest': 'iframe' } });
    assert.doesNotMatch(framed.body, /__live\.js/);
    assert.equal(framed.headers['content-length'], String(Buffer.byteLength('<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><p>héllo</p></body></html>')));
    assert.doesNotMatch((await get(port, pathOf(url), { headers: { 'Sec-Fetch-Dest': 'empty' } })).body, /__live\.js/);

    const css = await get(port, `${base}style.css`);
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(css.body, 'p { color: red }');
    assert.equal((await get(port, `${base}app.mjs`)).headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal((await get(port, `${base}data.json`)).headers['content-type'], 'application/json; charset=utf-8');
    const png = await get(port, `${base}pic.png`);
    assert.equal(png.headers['content-type'], 'image/png');
    assert.equal(png.bytes.length, 10);
    // Not UTF-8: no charset is claimed (the page's own <meta charset>, or the browser's guess).
    assert.equal((await get(port, `${base}latin.html`, { headers: { 'Sec-Fetch-Dest': 'iframe' } })).headers['content-type'], 'text/html');

    // A folder: its index.html; without the slash, sent to it first (so its links resolve); no listing.
    assert.match((await get(port, `${base}docs/`)).body, /<h1>Docs<\/h1>/);
    const bare = await get(port, `${base}docs?x=1`);
    assert.equal(bare.status, 307);
    assert.equal(bare.headers.location, `${base}docs/?x=1`);
    assert.equal((await get(port, `${base}empty/`)).status, 404);
    assert.match((await get(port, base)).body, /héllo/);
    const siteTop = await get(port, base.slice(0, -1));
    assert.equal(siteTop.status, 307);
    assert.equal(siteTop.headers.location, base);

    // HEAD: the same headers, no body.
    const head = await get(port, `${base}style.css`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '16');
    assert.equal(head.bytes.length, 0);
    // Byte ranges for pictures, sound and video.
    const part = await get(port, `${base}pic.png`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], 'bytes 2-5/10');
    assert.deepEqual([...part.bytes], [0x4e, 0x47, 0, 1]);
    assert.equal((await get(port, `${base}pic.png`, { headers: { Range: 'bytes=-3' } })).bytes.length, 3);
    assert.equal((await get(port, `${base}pic.png`, { headers: { Range: 'bytes=20-' } })).status, 416);

    // The live reload script names the site's event stream.
    const live = await get(port, `/p/${tokenOf(url)}/__live.js?site=${site}`);
    assert.equal(live.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.match(live.body, /new EventSource\(".*__reload\?site=/);
    assert.equal((await get(port, `/p/${tokenOf(url)}/__live.js?site=nope`)).status, 404);
  } finally {
    server.stop();
  }
});

test('refused: another Host, another token or site, other methods, paths that step out, dot names, files the editor may not open, links out', async () => {
  const outside = tree({ 'secret.txt': 'top secret', 'page.html': '<p>out</p>' });
  const root = tree({ 'site/.git/HEAD': '', 'site/index.html': '<p>in</p>', 'site/.env': 'KEY=1', 'site/sub/a.txt': 'a', 'other/b.txt': 'b' });
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'site/link.txt'));
  symlinkSync(path.join(root, 'other'), path.join(root, 'site/shared'));
  const server = ps.createPreviewServer({ allowed: rule([root]), tops: () => [root] });
  try {
    const { url } = await server.url(path.join(root, 'site/index.html'));
    const port = server.port;
    const token = tokenOf(url);
    const base = pathOf(url).replace(/index\.html$/, '');
    assert.equal((await get(port, pathOf(url))).status, 200);
    assert.equal((await get(port, pathOf(url), { host: `localhost:${port}` })).status, 200);
    // DNS rebinding: a page on another name that points here sends its own name.
    assert.equal((await get(port, pathOf(url), { host: `evil.example:${port}` })).status, 403);
    assert.equal((await get(port, pathOf(url), { host: '127.0.0.1' })).status, 403);
    assert.equal((await get(port, pathOf(url), { host: `127.0.0.1:${port + 1}` })).status, 403);
    // Without the token, or the site's id: nothing.
    assert.equal((await get(port, pathOf(url).replace(token, 'x'.repeat(24)))).status, 404);
    assert.equal((await get(port, pathOf(url).replace(siteOf(url), 'site-abcdefghijkl'))).status, 404);
    assert.equal((await get(port, '/index.html')).status, 404);
    assert.equal((await get(port, `/p/${token}/__reload?site=nope`)).status, 404);
    // GET and HEAD only.
    const post = await get(port, pathOf(url), { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, 'GET, HEAD');
    assert.equal((await get(port, pathOf(url), { method: 'PUT' })).status, 405);
    // Out of the site: .., encoded dots and slashes, absolute paths.
    for (const raw of [`${base}../other/b.txt`, `${base}%2e%2e/other/b.txt`, `${base}..%2fother%2fb.txt`, `${base}sub/..%5c..%5cother%5cb.txt`, `${base}${encodeURIComponent(path.join(outside, 'secret.txt'))}`]) {
      assert.equal((await get(port, raw)).status, 404, raw);
    }
    // Dot names, a link to a file outside, a link to a folder outside the site, a file the editor may not open.
    assert.equal((await get(port, `${base}.env`)).status, 404);
    assert.equal((await get(port, `${base}.git/HEAD`)).status, 404);
    assert.equal((await get(port, `${base}link.txt`)).status, 404);
    assert.equal((await get(port, `${base}shared/b.txt`)).status, 404);
    assert.equal((await get(port, `${base}sub/a.txt`)).status, 200);
  } finally {
    server.stop();
  }
  // A file picked alone: only it, not its neighbors.
  const lone = tree({ 'lone.html': '<p>lone</p>', 'style.css': 'p{}' });
  const alone = ps.createPreviewServer({ allowed: rule([], [path.join(lone, 'lone.html')]), tops: () => [] });
  try {
    const { url } = await alone.url(path.join(lone, 'lone.html'));
    assert.equal((await get(alone.port, pathOf(url))).status, 200);
    assert.equal((await get(alone.port, pathOf(url).replace('lone.html', 'style.css'))).status, 404);
  } finally {
    alone.stop();
  }
});

test('an address from the top of the site (/style.css, fetch("/data.json")) in a page served here goes to its site', async () => {
  const root = tree({ 'site/.git/HEAD': '', 'site/pages/about.html': '<p>about</p>', 'site/style.css': 'p{}', 'site/data.json': '[1]' });
  const server = ps.createPreviewServer({ allowed: rule([root]), tops: () => [root] });
  try {
    const { url } = await server.url(path.join(root, 'site/pages/about.html'));
    const port = server.port;
    const token = tokenOf(url);
    const site = siteOf(url);
    const referer = url;
    const css = await get(port, '/style.css?v=2', { headers: { Referer: referer } });
    assert.equal(css.status, 307);
    assert.equal(css.headers.location, `/p/${token}/${site}/style.css?v=2`);
    assert.equal((await get(port, css.headers.location)).body, 'p{}');
    // "../" past the site's top stops there, as on a web server.
    const up = await get(port, `/p/${token}/data.json`, { headers: { Referer: referer } });
    assert.equal(up.headers.location, `/p/${token}/${site}/data.json`);
    // Only with a page of a known site, on this server, as the referrer.
    assert.equal((await get(port, '/style.css')).status, 404);
    assert.equal((await get(port, '/style.css', { headers: { Referer: referer.replace(token, 'y'.repeat(24)) } })).status, 404);
    assert.equal((await get(port, '/style.css', { headers: { Referer: `https://example.com/p/${token}/${site}/` } })).status, 404);
    assert.equal((await get(port, '/style.css', { headers: { Referer: 'not a url' } })).status, 404);
  } finally {
    server.stop();
  }
});

test('the editor’s unsaved text is served instead of the file, and pages of its site reload (browser pages by their event stream, the app by onChange)', async () => {
  const root = tree({ 'site/package.json': '{}', 'site/index.html': '<p>saved</p>', 'site/style.css': 'p{}' });
  const changes = [];
  const server = ps.createPreviewServer({ allowed: rule([root]), tops: () => [root], onChange: (c) => changes.push(c) });
  try {
    const file = path.join(root, 'site/index.html');
    const { url, site } = await server.url(file);
    const port = server.port;
    const stream = await listen(port, tokenOf(url), site);
    assert.equal(stream.status, 200);
    assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
    // What the file holds already: nothing to reload.
    assert.equal(server.setText(file, '<p>saved</p>'), false);
    assert.equal(server.setText(file, '<p>typed</p>'), true);
    await stream.next(1);
    assert.deepEqual(changes.at(-1), { site, files: [file] });
    const served = await get(port, pathOf(url), { headers: { 'Sec-Fetch-Dest': 'iframe' } });
    assert.equal(served.body, '<p>typed</p>');
    assert.equal(served.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(server.setText(file, '<p>typed</p>'), false); // the same again
    // Back to the file: served from disk again, without reloading.
    assert.equal(server.setText(file, null), false);
    assert.equal((await get(port, pathOf(url), { headers: { 'Sec-Fetch-Dest': 'iframe' } })).body, '<p>saved</p>');
    // A file saved here (main.cjs's disk:write): its site's pages reload.
    server.changed(path.join(root, 'site/style.css'));
    await stream.next(2);
    assert.deepEqual(changes.at(-1).files, [path.join(root, 'site/style.css')]);
    // A file of another folder: nothing.
    const before = stream.reloads();
    server.changed(path.join(tmpdir(), 'elsewhere.css'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(stream.reloads(), before);
    // A page that went (reloaded, closed) takes its unsaved texts with it.
    server.setText(file, '<p>again</p>', 'page-1');
    server.forget('page-1');
    assert.equal((await get(port, pathOf(url), { headers: { 'Sec-Fetch-Dest': 'iframe' } })).body, '<p>saved</p>');
    stream.close();
  } finally {
    server.stop();
  }
});

test('a file a page loaded is watched: changed on disk, its pages reload', async () => {
  const root = tree({ 'site/.git/HEAD': '', 'site/index.html': '<link rel=stylesheet href=style.css>', 'site/style.css': 'p{}' });
  const server = ps.createPreviewServer({ allowed: rule([root]), tops: () => [root] });
  try {
    const { url, site } = await server.url(path.join(root, 'site/index.html'));
    const stream = await listen(server.port, tokenOf(url), site);
    await get(server.port, pathOf(url).replace('index.html', 'style.css'));
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path.join(root, 'site/style.css'), 'p { color: blue }');
    await stream.next(1, 5000);
    stream.close();
  } finally {
    server.stop();
  }
});

test('a note or a file on a server shown with its scripts: one page held in memory, nothing next to it', async () => {
  const server = ps.createPreviewServer({ allowed: () => false });
  try {
    const { url, site } = await server.notePage('f:abc', 'Chart', '<script>document.write(1+1)</script>', 'page-1');
    assert.match(url, /\/p\/[\w-]{24}\/note-[\w-]{12}\/Chart\.html$/);
    const page = await get(server.port, pathOf(url), { headers: { 'Sec-Fetch-Dest': 'iframe' } });
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.body, '<script>document.write(1+1)</script>');
    assert.equal((await get(server.port, pathOf(url).replace('Chart.html', 'other.css'))).status, 404);
    // The same tab again: the same address, the new text.
    const again = await server.notePage('f:abc', 'Chart', '<p>2</p>', 'page-1');
    assert.equal(again.site, site);
    assert.equal((await get(server.port, pathOf(again.url), { headers: { 'Sec-Fetch-Dest': 'iframe' } })).body, '<p>2</p>');
    assert.equal(await server.notePage('f:abc', 'Chart', null), null);
    assert.equal((await get(server.port, pathOf(url))).status, 404);
    // A page that went takes its notes with it.
    const other = await server.notePage('f:def', 'x.html', '<p>x</p>', 'page-2');
    server.forget('page-2');
    assert.equal((await get(server.port, pathOf(other.url))).status, 404);
  } finally {
    server.stop();
  }
});

test('it listens on 127.0.0.1 only and stops', async () => {
  const root = tree({ 'index.html': '<p>' });
  const server = ps.createPreviewServer({ allowed: rule([root]), tops: () => [root] });
  const { url } = await server.url(path.join(root, 'index.html'));
  assert.equal(new URL(url).hostname, '127.0.0.1');
  assert.ok(server.owns(url));
  assert.ok(!server.owns('https://example.com/'));
  // The site of an address served here (main.cjs sends the preview frame back to it after a link out).
  assert.equal(server.siteOf(url), siteOf(url));
  assert.equal(server.siteOf(url.replace(tokenOf(url), 'z'.repeat(24))), '');
  assert.equal(server.siteOf('https://example.com/p/x/y/'), '');
  const port = server.port;
  server.stop();
  await assert.rejects(get(port, pathOf(url)));
  assert.ok(!server.owns(url));
});
