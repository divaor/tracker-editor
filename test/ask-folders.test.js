// 0.40: Find by asking in the folders shown (the walk and the measuring, without a disk or a server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { measure, patternProblem, plainPlan } from '../app/js/askFind.js';
import { opensInEditor } from '../app/js/folders.js';

const require = createRequire(import.meta.url);
const { askFolders, cleanPlan } = require('../electron/askFolders.cjs');
const { decode } = require('../electron/diskFiles.cjs');

// A folder tree: path → [text, mtime] (folders end with /, links have link: true).
const TREE = {
  '/r/': null,
  '/r/deploy.md': ['Deploy\n\ndocker compose up -d\n', '2026-10-30T10:00:00Z'],
  '/r/notes.txt': ['Shopping list\nmilk\n', '2026-10-31T10:00:00Z'],
  '/r/logo.png': ['binary', '2026-10-01T10:00:00Z'],
  '/r/data.txt': ['x\u0000y docker', '2026-10-01T10:00:00Z'],
  '/r/huge.log': ['docker '.repeat(400), '2026-10-01T10:00:00Z'],
  '/r/.env': ['DOCKER=1', '2026-10-01T10:00:00Z'],
  '/r/src/': null,
  '/r/src/Dockerfile': ['FROM node:22\n', '2026-09-01T10:00:00Z'],
  '/r/node_modules/': null,
  '/r/node_modules/lib.md': ['docker in a dependency', '2026-10-01T10:00:00Z'],
  '/r/linked/': { link: true },
  '/r/linked/far.md': ['docker far away', '2026-10-01T10:00:00Z'],
  '/s/': null,
  '/s/other.md': ['docker run hello-world\n', '2026-10-29T10:00:00Z'],
};
const list = async (dir) =>
  Object.keys(TREE)
    .filter((p) => p !== dir && p.startsWith(dir) && !p.slice(dir.length).replace(/\/$/, '').includes('/'))
    .map((p) => {
      const v = TREE[p];
      return { name: p.slice(dir.length).replace(/\/$/, ''), path: p, dir: p.endsWith('/'), size: Array.isArray(v) ? v[0].length : 0, mtimeMs: Array.isArray(v) ? Date.parse(v[1]) : 0, link: Boolean(v?.link) };
    });
const read = async (p) => Buffer.from(TREE[p][0]);
const run = (plan, opts = {}) =>
  askFolders({
    roots: ['/r/', '/s/'],
    plan,
    list,
    read,
    decode: (b) => decode(b).text,
    isText: opensInEditor,
    measure,
    projectOf: (root) => (root === '/s/' ? 'Deep Time' : ''),
    relative: (root, p) => p.slice(root.length),
    maxSize: 1000,
    ...opts,
  });

test('folders: text files measured, only those that match come back, with how many passed', async () => {
  const plan = { ...plainPlan(''), terms: ['docker', 'docker compose'], names: ['dockerfile'] };
  const out = await run(plan);
  assert.deepEqual(out.entries.map((e) => e.id).sort(), ['d:/r/deploy.md', 'd:/r/src/Dockerfile', 'd:/s/other.md']);
  // deploy, notes, Dockerfile, other: read and passed; the binary one could not be decoded; huge, hidden, node_modules and the link were never read.
  assert.equal(out.total, 4);
  assert.equal(out.scanned, 5);
  assert.equal(out.truncated, false);
  const deploy = out.entries.find((e) => e.id === 'd:/r/deploy.md');
  assert.deepEqual([deploy.kind, deploy.name, deploy.root, deploy.rel, deploy.date], ['disk', 'deploy.md', '/r/', 'deploy.md', '2026-10-30T10:00:00.000Z']);
  assert.deepEqual(deploy.lines, [{ line: 3, text: 'docker compose up -d' }]);
  assert.equal(deploy.text, undefined, 'the text never goes back');
  assert.equal(out.entries.find((e) => e.id === 'd:/s/other.md').project, 'Deep Time', 'the project the folder is linked to');
});

test('folders: filters, listings (newest first), limits and Stop', async () => {
  const project = await run({ ...plainPlan(''), terms: ['docker'], projects: ['Deep Time'] });
  assert.deepEqual(project.entries.map((e) => e.id), ['d:/s/other.md']);
  assert.equal(project.total, 1);
  const listing = await run({ ...plainPlan(''), intent: 'list', terms: [], since: '2026-10-29' });
  assert.deepEqual(listing.entries.map((e) => e.id), ['d:/r/notes.txt', 'd:/r/deploy.md', 'd:/s/other.md']);
  const few = await run({ ...plainPlan(''), terms: ['docker'] }, { maxFiles: 2 });
  assert.equal(few.scanned, 2);
  assert.equal(few.truncated, true);
  const controller = new AbortController();
  controller.abort();
  const stopped = await run({ ...plainPlan(''), terms: ['docker'] }, { signal: controller.signal });
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.entries, []);
  // A file that takes too long (the worker's time limit) stops the search with what it found.
  let n = 0;
  const slow = await run({ ...plainPlan(''), terms: ['docker'] }, {
    concurrency: 1,
    measure: (source, plan) => {
      if (++n === 2) throw Object.assign(new Error('too long'), { fatal: true });
      return measure(source, plan);
    },
  });
  assert.equal(slow.stopped, true);
  assert.ok(slow.scanned < 5);
});

test('the plan from the page is checked again', () => {
  const plan = cleanPlan({ intent: 'list', terms: ['docker', 7, 'x'.repeat(61), ...Array(20).fill('t')], patterns: ['(a+)+', '\\bdocker\\b', 'ok'], projects: ['Deep Time'], since: '2026-10-01', until: 'tomorrow', sort: 'sideways', encrypted: 'yes', limit: 999 }, patternProblem);
  assert.equal(plan.intent, 'list');
  assert.deepEqual(plan.terms.slice(0, 2), ['docker', 't']);
  assert.equal(plan.terms.length, 12);
  assert.deepEqual(plan.patterns, ['\\bdocker\\b', 'ok']);
  assert.deepEqual([plan.since, plan.until, plan.sort, plan.encrypted, plan.limit], ['2026-10-01', '', 'relevance', false, 50]);
  assert.deepEqual(cleanPlan(null, patternProblem).terms, []);
});
