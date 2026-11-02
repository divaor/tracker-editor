// Settings per project, the page's side (app/js/project.js): the answers kept per folder, asking
// to trust once before a run that would use what waits for it, the words for how a file stands,
// and the template a new file starts from (which the main process must read without a problem).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createProjects, folderOf, heldFor, PROJECT_FILE, PROJECT_TEMPLATE, projectStatus, typeOf, withProjectRun } from '../app/js/project.js';

const require = createRequire(import.meta.url);
const ps = require('../electron/projectSettings.cjs');

test('the template: every setting written out, all commented, read without a problem', () => {
  assert.equal(PROJECT_FILE, ps.PROJECT_FILE);
  const { settings, problems } = ps.parseProjectSettings(PROJECT_TEMPLATE, { catalog: [{ id: 'python', choices: ['pyright', 'basedpyright'] }] });
  assert.deepEqual(problems, []);
  assert.deepEqual(settings, ps.emptySettings(), 'nothing counts until something is uncommented');
  for (const key of ps.SETTINGS) assert.match(PROJECT_TEMPLATE, new RegExp(`"${key}"`), key);
  // Uncommenting the examples gives settings that check out.
  const used = PROJECT_TEMPLATE.replace(/^(\s*)\/\/ (\{ "name"|"\.py"|"DEBUG"|"python"|"formatter"|"tests")/gm, '$1$2');
  const read = ps.parseProjectSettings(used, { catalog: [{ id: 'python', choices: ['pyright', 'basedpyright'] }] });
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.settings.run, { py: 'python -m app' });
  assert.equal(read.settings.tasks[0].name, 'serve');
  assert.deepEqual(read.settings.env, { DEBUG: '1' });
  assert.deepEqual(read.settings.languages, { python: { server: 'basedpyright' } });
  assert.equal(read.settings.formatter, 'server');
  assert.deepEqual(read.settings.tests, ['vitest']);
});

test('small helpers', () => {
  assert.equal(folderOf('/w/app/main.py'), '/w/app');
  assert.equal(folderOf('C:\\w\\a.js'), 'C:\\w');
  assert.equal(folderOf('remote://s1/home/me/a.py'), 'remote://s1/home/me');
  assert.equal(typeOf('App.PY'), 'py');
  assert.equal(typeOf('Makefile'), '');
  assert.deepEqual(withProjectRun({ py: 'uv run {file}', js: 'node {file}' }, { settings: { run: { py: 'python -m app' } } }), { py: 'python -m app', js: 'node {file}' });
  assert.deepEqual(withProjectRun({ py: 'x' }, null), { py: 'x' });
});

test('what a run would use of a file not trusted', () => {
  const info = { path: '/p/.tracker-editor.json', held: { run: ['py'], tasks: ['serve'], env: [] } };
  assert.deepEqual(heldFor(info, { ext: 'py' }), ['run']);
  assert.deepEqual(heldFor(info, { ext: 'js' }), []);
  assert.deepEqual(heldFor(info, { task: 'serve' }), ['task']);
  assert.deepEqual(heldFor({ ...info, held: { run: [], tasks: [], env: ['A'] } }, { ext: 'js' }), ['env']);
  assert.deepEqual(heldFor({ path: 'x', held: null }, { ext: 'py' }), []);
});

test('how a file stands, in words', () => {
  assert.equal(projectStatus(null), null);
  assert.equal(projectStatus({ path: null }), null);
  assert.equal(projectStatus({ path: 'p', trusted: true, needsTrust: true, problems: [] }).tone, 'ok');
  assert.match(projectStatus({ path: 'p', trusted: true, needsTrust: false, problems: [] }).text, /nothing in it needs trust/);
  assert.match(projectStatus({ path: 'p', held: { run: ['py'] }, declined: false, problems: [] }).text, /Not trusted yet/);
  assert.match(projectStatus({ path: 'p', held: { run: ['py'] }, declined: true, problems: [{ message: 'x' }] }).text, /Not trusted: .*1 problem$/);
  assert.equal(projectStatus({ path: 'p', broken: true, problems: [{ message: 'Line 2: oops' }] }).tone, 'error');
});

// A main process standing in: trust asked for is answered by `answer`.
function fakeBridge({ answer = true } = {}) {
  const state = { trusted: false, declined: false, asks: 0, reads: 0 };
  const held = { run: ['py'], tasks: [], env: ['DEBUG'] };
  return {
    state,
    async settings(target, { folder }) {
      state.reads += 1;
      if (String(target).startsWith('/none')) return { path: null, root: folder ? target : folderOf(target), settings: ps.emptySettings(), held: null, problems: [] };
      const settings = state.trusted ? { ...ps.emptySettings(), run: { py: 'python -m app' }, env: { DEBUG: '1' } } : ps.emptySettings();
      return { path: '/p/.tracker-editor.json', dir: '/p', settings, held: state.trusted ? null : held, trusted: state.trusted, declined: state.declined, needsTrust: true, problems: [] };
    },
    async trust() {
      state.asks += 1;
      state.trusted = answer;
      state.declined = !answer;
      return { trusted: answer };
    },
    async untrust() {
      state.trusted = false;
      state.declined = true;
      return { trusted: false };
    },
  };
}

test('answers kept a moment per folder; told when they change', async () => {
  let now = 0;
  const bridge = fakeBridge();
  const changes = [];
  const projects = createProjects({ bridge, ttl: 1000, clock: () => now, onChange: (info, before) => changes.push([info?.trusted, before === undefined]) });
  assert.equal(projects.now('/p/a.py'), null);
  await projects.get('/p/a.py');
  await projects.get('/p/b.py'); // the same folder: kept
  assert.equal(bridge.state.reads, 1);
  assert.equal(projects.now('/p/a.py').path, '/p/.tracker-editor.json');
  now = 2000;
  await projects.get('/p/a.py');
  assert.equal(bridge.state.reads, 2, 'asked again after a while');
  assert.deepEqual(changes, [[false, true]], 'told the first time, not when the same comes back');
  await projects.get('/p/a.py', { fresh: true });
  assert.equal(bridge.state.reads, 3);
  assert.equal((await projects.get('/none/x.py')).path, null);
  assert.equal(await createProjects({ bridge: null }).get('/p/a.py'), null, 'no bridge (the web app): nothing');
});

test('a run asks to trust once, uses the settings when allowed', async () => {
  const bridge = fakeBridge({ answer: true });
  const projects = createProjects({ bridge });
  const js = await projects.forRun('/p/a.js', { ext: 'js' });
  assert.equal(bridge.state.asks, 1, 'its variables would change the run: asked');
  assert.deepEqual(js.left, []);
  assert.deepEqual(js.info.settings.env, { DEBUG: '1' });
  const again = await projects.forRun('/p/a.py', { ext: 'py' });
  assert.equal(bridge.state.asks, 1, 'trusted: not asked again');
  assert.deepEqual(again.info.settings.run, { py: 'python -m app' });
});

test('a no is kept: the run goes on without, saying what was left out', async () => {
  const bridge = fakeBridge({ answer: false });
  const projects = createProjects({ bridge });
  const first = await projects.forRun('/p/a.py', { ext: 'py' });
  assert.equal(bridge.state.asks, 1);
  assert.deepEqual(first.left, ['run', 'env']);
  assert.deepEqual(first.info.settings.run, {});
  await projects.forRun('/p/a.py', { ext: 'py' });
  assert.equal(bridge.state.asks, 1, 'refused: not asked at every run');
  // Trust… asks again (the person's own act), Stop trusting takes it back.
  bridge.trust = async () => ((bridge.state.trusted = true), (bridge.state.declined = false), { trusted: true });
  assert.deepEqual(await projects.trust('/p/.tracker-editor.json'), { trusted: true });
  assert.equal((await projects.get('/p/a.py')).trusted, true, 'read again after trusting');
  await projects.untrust('/p/.tracker-editor.json');
  assert.equal((await projects.get('/p/a.py')).trusted, false);
});

test('nothing held that the run would use: not asked', async () => {
  const bridge = fakeBridge();
  bridge.settings = async () => ({ path: '/p/.tracker-editor.json', dir: '/p', settings: ps.emptySettings(), held: { run: ['py'], tasks: [], env: [] }, trusted: false, declined: false, needsTrust: true, problems: [] });
  const projects = createProjects({ bridge });
  const { left } = await projects.forRun('/p/a.js', { ext: 'js' });
  assert.equal(bridge.state.asks, 0, 'a .js run does not use the .py command');
  assert.deepEqual(left, []);
});

test('two runs at once: one question', async () => {
  const bridge = fakeBridge({ answer: true });
  let release;
  const gate = new Promise((r) => (release = r));
  const trust = bridge.trust;
  bridge.trust = async (path) => (await gate, trust(path));
  const projects = createProjects({ bridge });
  const both = Promise.all([projects.forRun('/p/a.py', { ext: 'py' }), projects.forRun('/p/b.py', { ext: 'py' })]);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [a, b] = await both;
  assert.equal(bridge.state.asks, 1);
  assert.deepEqual(a.info.settings.run, { py: 'python -m app' });
  assert.deepEqual(b.left, []);
});
