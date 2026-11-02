// Settings per project, the main process's side (electron/projectSettings.cjs): finding the
// nearest .tracker-editor.json, reading it (JSON with comments, cleaned, every problem said),
// trust by the text's hash, the dialog's words and the language choices it may make.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ps = require('../electron/projectSettings.cjs');

const CATALOG = [
  { id: 'typescript', choices: ['tsc', 'tls'] },
  { id: 'python', choices: ['pyright', 'basedpyright'] },
  { id: 'go', choices: [] },
];
const parse = (text) => ps.parseProjectSettings(text, { catalog: CATALOG });

test('JSON with comments and trailing commas, places kept', () => {
  const text = '{\n  // a comment, "with quotes"\n  "a": "x // not a comment", /* b */\n  "b": [1, 2,],\n}\n';
  const blank = ps.blankJsonc(text);
  assert.equal(blank.length, text.length);
  assert.deepEqual(JSON.parse(blank), { a: 'x // not a comment', b: [1, 2] });
  assert.equal(blank.split('\n').length, text.split('\n').length);
});

test('a whole file: every setting cleaned', () => {
  const { settings, problems } = parse(`// The project's settings
{
  "$schema": "https://example.com/schema.json",
  "run": { ".py": "python -m app", "JS": "node --inspect {file}", "sh": "" },
  "tasks": [
    { "name": "serve", "command": "npm run dev", "cwd": "web/" },
    { "name": "test", "command": "pytest -q", "detail": "All of them" },
  ],
  "env": { "DEBUG": "1", "PORT": 8080, "VERBOSE": true },
  "languages": { "python": { "server": "basedpyright", "formatter": "builtin" }, "go": { "off": true } },
  "formatter": "server",
  "tests": "vitest",
}`);
  assert.deepEqual(problems, []);
  assert.deepEqual(settings.run, { py: 'python -m app', js: 'node --inspect {file}', sh: '' });
  assert.deepEqual(settings.tasks, [
    { name: 'serve', command: 'npm run dev', cwd: 'web', detail: '' },
    { name: 'test', command: 'pytest -q', cwd: '', detail: 'All of them' },
  ]);
  assert.deepEqual(settings.env, { DEBUG: '1', PORT: '8080', VERBOSE: 'true' });
  assert.deepEqual(settings.languages, { python: { server: 'basedpyright', formatter: 'builtin' }, go: { off: true } });
  assert.equal(settings.formatter, 'server');
  assert.deepEqual(settings.tests, ['vitest']);
  assert.ok(ps.needsTrust(settings));
  assert.ok(!ps.needsTrust({ ...settings, run: {}, tasks: [], env: {} }), 'languages, formatter and tests need no trust');
});

test('unknown keys and values that do not check out: left out, each said', () => {
  const { settings, problems } = parse(
    JSON.stringify({
      environment: { A: '1' },
      Run: {},
      colour: 'red',
      run: { '../x': 'a', py: 'two\nlines', rb: 5 },
      tasks: [{ name: 'a' }, { name: 'b', command: 'make', cwd: '../outside' }, { name: 'c', command: 'ok', extra: 1 }, { name: 'c', command: 'again' }, 'nope'],
      env: { '1BAD': 'x', PS1: '$ ', PROMPT_COMMAND: 'x', GOOD: 'yes', OBJ: { a: 1 } },
      languages: { cobol: {}, python: { server: 'jedi', off: 'yes', color: 'x' }, typescript: 'tsc' },
      formatter: 'prettier',
      tests: ['pytest', 'nose'],
    }),
  );
  const said = problems.map((p) => p.message).join('\n');
  assert.match(said, /Unknown setting “environment” \(did you mean "env"\?\)/);
  assert.match(said, /Unknown setting “Run” \(did you mean "run"\?\)/);
  assert.match(said, /Unknown setting “colour”: left out/);
  assert.match(said, /“\.\.\/x” is not a file type/);
  assert.match(said, /line break or a control character/);
  assert.match(said, /"run" for \.rb should be text/);
  assert.match(said, /Task 1 needs a "name" and a "command"/);
  assert.match(said, /folder inside the project/);
  assert.match(said, /unknown field “extra”/);
  assert.match(said, /Two tasks are named “c”/);
  assert.match(said, /item 5 should be/);
  assert.match(said, /“1BAD” is not a variable name/);
  assert.match(said, /PS1 belongs to the terminal itself/);
  assert.match(said, /PROMPT_COMMAND belongs to the terminal itself/);
  assert.match(said, /"env" OBJ should be text/);
  assert.match(said, /“cobol” is not one of typescript, python, go/);
  assert.match(said, /"server" is one of "pyright", "basedpyright", not “jedi”/);
  assert.match(said, /"off" should be true or false/);
  assert.match(said, /unknown field “color”/);
  assert.match(said, /"languages" typescript should be/);
  assert.match(said, /"formatter" is "server"/);
  assert.match(said, /“nose” is not one of/);
  assert.deepEqual(settings.run, {});
  assert.deepEqual(settings.tasks.map((t) => t.name), ['c']);
  assert.deepEqual(settings.env, { GOOD: 'yes' });
  assert.deepEqual(settings.languages, {});
  assert.equal(settings.formatter, '');
  assert.deepEqual(settings.tests, ['pytest']);
});

test('a file that cannot be read: nothing used, the mistake said with its line', () => {
  const broken = parse('{\n  "run": {\n    ".py": "python"\n  \n  "tasks": []\n}');
  assert.ok(broken.broken);
  assert.equal(broken.problems.length, 1);
  assert.deepEqual(broken.settings, ps.emptySettings());
  assert.ok(parse('[1, 2]').broken, 'not an object');
  assert.deepEqual(parse('').problems, [], 'an empty file is fine');
  assert.deepEqual(parse('// only comments\n').problems, []);
  assert.deepEqual(parse(`${String.fromCharCode(0xfeff)}{ "formatter": "builtin" }`).settings.formatter, 'builtin', 'a BOM is fine');
  assert.ok(parse(`{ "a": "${'x'.repeat(ps.MAX_BYTES)}" }`).broken, 'too large');
});

test('trust by the text’s hash: asked again when it changes; answers kept tidy', () => {
  const text = '{ "run": { "py": "python -m app" } }';
  const hash = ps.trustHash(text);
  assert.match(hash, /^[0-9a-f]{64}$/);
  let store = ps.cleanTrust(null);
  assert.equal(ps.trustState(store, '/p/.tracker-editor.json', hash), 'ask');
  store = ps.rememberTrust(store, '/p/.tracker-editor.json', hash, true, 1);
  assert.equal(ps.trustState(store, '/p/.tracker-editor.json', hash), 'yes');
  assert.equal(ps.trustState(store, '/p/.tracker-editor.json', ps.trustHash(`${text} `)), 'ask', 'changed: asked again');
  assert.equal(ps.trustState(store, '/q/.tracker-editor.json', hash), 'ask', 'another folder: its own answer');
  store = ps.rememberTrust(store, '/q/.tracker-editor.json', hash, false, 2);
  assert.equal(ps.trustState(store, '/q/.tracker-editor.json', hash), 'no');
  // What prefs.json holds is checked: odd rows dropped, the newest kept.
  const odd = ps.cleanTrust({ '/a': { hash: 'nothex', allow: true }, '/b': { hash, allow: 'yes' }, '/c': { hash, allow: true, at: 5 }, '/d': 'x' });
  assert.deepEqual(Object.keys(odd), ['/c']);
  let many = {};
  for (let i = 0; i < 320; i++) many = { ...many, [`/p${i}`]: { hash, allow: true, at: i } };
  const kept = ps.cleanTrust(many);
  assert.equal(Object.keys(kept).length, 300);
  assert.ok(!('/p0' in kept) && '/p319' in kept, 'the oldest answers go first');
});

test('what the page gets: run, tasks and env only once trusted; tasks’ folders whole', () => {
  const text = '{ "run": { "py": "python -m app" }, "tasks": [{ "name": "serve", "command": "npm run dev", "cwd": "web" }], "env": { "A": "1" }, "formatter": "builtin" }';
  const where = { path: '/p/.tracker-editor.json', dir: '/p', root: '/p', catalog: CATALOG, join: (a, b) => `${a}/${b}` };
  const fresh = ps.projectInfo(text, { ...where, trust: {} });
  assert.equal(fresh.trusted, false);
  assert.equal(fresh.declined, false);
  assert.deepEqual(fresh.held, { run: ['py'], tasks: ['serve'], env: ['A'] });
  assert.deepEqual(fresh.settings.run, {});
  assert.deepEqual(fresh.settings.tasks, []);
  assert.deepEqual(fresh.settings.env, {});
  assert.equal(fresh.settings.formatter, 'builtin', 'the rest counts at once');
  assert.equal(fresh.full.tasks[0].cwd, '/p/web');
  const trust = ps.rememberTrust({}, where.path, ps.trustHash(text), true);
  const trusted = ps.projectInfo(text, { ...where, trust });
  assert.equal(trusted.trusted, true);
  assert.equal(trusted.held, null);
  assert.deepEqual(trusted.settings.run, { py: 'python -m app' });
  assert.deepEqual(trusted.settings.tasks, [{ name: 'serve', command: 'npm run dev', cwd: '/p/web', detail: '' }]);
  assert.deepEqual(trusted.settings.env, { A: '1' });
  const refused = ps.projectInfo(text, { ...where, trust: ps.rememberTrust({}, where.path, ps.trustHash(text), false) });
  assert.equal(refused.declined, true);
  assert.deepEqual(refused.settings.env, {});
  const plain = ps.projectInfo('{ "tests": "pytest" }', { ...where, trust: {} });
  assert.equal(plain.trusted, true, 'nothing that needs trust: in use as it is');
  assert.equal(plain.needsTrust, false);
  assert.equal(ps.projectInfo(null, where).broken, true, 'unreadable');
});

test('the nearest file, up to the folder picked, a repository’s top or 6 up', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-settings-'));
  const mk = (rel, text = '') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  mk('repo/.git/HEAD', 'ref: refs/heads/main');
  mk('repo/package.json', '{}');
  mk('repo/.tracker-editor.json', '{}');
  mk('repo/sub/.tracker-editor.json', '{}');
  mk('repo/sub/deep/a.py');
  mk('repo/other/b.py');
  mk('.tracker-editor.json', '{}'); // above the repository: never reached
  mk('plain/pkg/pyproject.toml', '');
  mk('plain/pkg/src/x.py');
  mk('plain/notes/n.txt');
  const opts = (stop) => ({ list: (d) => fs.readdirSync(d), path, stop });
  const at = (rel) => path.join(root, rel);
  // A sub-folder's own file wins.
  assert.deepEqual(await ps.findProjectFile(at('repo/sub/deep'), opts(root)), { file: at('repo/sub/.tracker-editor.json'), dir: at('repo/sub'), root: at('repo/sub') });
  assert.equal((await ps.findProjectFile(at('repo/other'), opts(root))).file, at('repo/.tracker-editor.json'));
  // Without one: where a new one would go.
  fs.rmSync(at('repo/.tracker-editor.json'));
  assert.deepEqual(await ps.findProjectFile(at('repo/other'), opts(root)), { file: null, dir: null, root: at('repo') }, 'the repository’s top; not the file above it');
  assert.equal((await ps.findProjectFile(at('plain/pkg/src'), opts(at('plain')))).root, at('plain/pkg'), 'the nearest project file’s folder');
  assert.equal((await ps.findProjectFile(at('plain/notes'), opts(at('plain')))).root, at('plain'), 'else the folder picked');
  assert.equal((await ps.findProjectFile(at('plain/notes'), opts(at('plain')))).file, null, 'never above the folder picked');
  assert.equal((await ps.findProjectFile(at('plain/notes'), opts(''))).root, at('plain/notes'), 'a file opened alone: its own folder only');
  assert.equal((await ps.findProjectFile(at('plain/notes'), opts(null))).file, at('.tracker-editor.json'), 'no bound (a server): up to 6 folders');
  assert.equal((await ps.findProjectFile(at('missing/folder'), opts(root))).file, null, 'a folder that cannot be listed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the trust dialog shows each command and variable', () => {
  const { settings } = parse('{ "run": { "py": "python -m app", "sh": "" }, "tasks": [{ "name": "serve", "command": "npm run dev", "cwd": "web" }], "env": { "TOKEN": "abc" } }');
  const detail = ps.trustDetail({ ...settings, tasks: settings.tasks.map((t) => ({ ...t, cwd: '/p/web' })) }, { folder: '/p' });
  assert.match(detail, /^\/p\n/);
  assert.match(detail, /\.py: python -m app/);
  assert.match(detail, /\.sh: \(nothing: F5 does not run these\)/);
  assert.match(detail, /serve: npm run dev {2}\(in \/p\/web\)/);
  assert.match(detail, /TOKEN=abc/);
  assert.match(detail, /asked again/);
});

test('languages: the project turns servers off or picks one, never turns one on', () => {
  const page = { off: ['yaml'], prefer: { typescript: 'tls' } };
  assert.deepEqual(ps.withProjectLanguages(page, { python: { server: 'basedpyright' }, go: { off: true }, yaml: { off: false } }), { off: ['yaml', 'go'], prefer: { typescript: 'tls', python: 'basedpyright' } });
  assert.deepEqual(ps.withProjectLanguages(page, undefined), { off: ['yaml'], prefer: { typescript: 'tls' } });
  assert.deepEqual(ps.withProjectLanguages(undefined, { typescript: { server: 'tsc' } }), { off: [], prefer: { typescript: 'tsc' } });
});
