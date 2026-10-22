// Consistency checks across the app files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION } from '../app/js/version.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.join(root, 'app');

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)])),
  );
  return files.flat();
}

test('APP_VERSION matches package.json', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(APP_VERSION, pkg.version);
});

test('service worker precaches every app file and its cache name tracks the version', async () => {
  const sw = await readFile(path.join(appDir, 'sw.js'), 'utf8');
  const assets = JSON.parse(`[${/const ASSETS = \[([\s\S]*?)\];/.exec(sw)[1].replace(/'/g, '"').replace(/,\s*$/, '')}]`);
  // CodeMirror's language chunks are listed by `npm run vendor` in files.json.
  const chunks = JSON.parse(await readFile(path.join(appDir, 'vendor/cm/files.json'), 'utf8')).map((f) => `vendor/cm/${f}`);
  // Text recognition (about 9 MB) is cached when first used instead; vendor/ocr/files.json lists it.
  const ocr = JSON.parse(await readFile(path.join(appDir, 'vendor/ocr/files.json'), 'utf8')).map((f) => `vendor/ocr/${f}`);
  // The terminal (desktop only) too; vendor/xterm/files.json.
  const xterm = JSON.parse(await readFile(path.join(appDir, 'vendor/xterm/files.json'), 'utf8')).map((f) => `vendor/xterm/${f}`);
  const files = (await listFiles(appDir)).map((f) => path.relative(appDir, f).split(path.sep).join('/')).filter((f) => !['sw.js', 'vendor/cm/files.json', 'vendor/ocr/files.json', 'vendor/xterm/files.json'].includes(f));
  assert.deepEqual([...assets.filter((a) => a !== './'), ...chunks, ...ocr, ...xterm].sort(), files.sort());
  assert.ok(!assets.some((a) => a.startsWith('vendor/ocr/')), 'text recognition is not precached');
  assert.ok(!assets.some((a) => a.startsWith('vendor/xterm/')), 'the terminal is not precached');
  assert.match(sw, new RegExp(`const CACHE = 'editor-v${APP_VERSION.replace(/\./g, '\\.')}'`));
});

test('every relative import in the app resolves to a file', async () => {
  const jsFiles = (await listFiles(appDir)).filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}vendor${path.sep}`));
  const all = new Set(await listFiles(appDir));
  for (const file of jsFiles) {
    const source = await readFile(file, 'utf8');
    for (const [, spec] of source.matchAll(/from '(\.[^']+)'/g)) {
      assert.ok(all.has(path.resolve(path.dirname(file), spec)), `${path.relative(root, file)} imports missing ${spec}`);
    }
  }
});

test('the page allows only same-origin scripts', async () => {
  const html = await readFile(path.join(appDir, 'index.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline scripts');
});

test('the app id is the editor’s own on the shared origin', async () => {
  // Browsers resolve a manifest id against the origin, not the app's folder, and
  // the tracker on the same origin (divaor.github.io) already has "./", which is
  // the origin root. Sharing it made Android take the editor for the tracker.
  const manifest = JSON.parse(await readFile(path.join(appDir, 'manifest.webmanifest'), 'utf8'));
  assert.equal(new URL(manifest.id, 'https://divaor.github.io').href, 'https://divaor.github.io/tracker-editor/');
});
