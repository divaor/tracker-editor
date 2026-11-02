// The tasks list: npm scripts, Makefile targets, pyproject and Composer scripts, and the line
// typed for one, quoted for the terminal's shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composerTasks, makeTargets, npmTasks, pyprojectTasks, taskGroups, taskLine } from '../app/js/tasks.js';
import { quoteFor, runLine } from '../app/js/runFile.js';

test('npm scripts, run by the tool whose lock file is there', () => {
  const pkg = JSON.stringify({ scripts: { build: 'vite build', 'test:unit': 'node --test', dev: 'vite' } });
  assert.deepEqual(npmTasks(pkg).map((t) => [t.name, t.command.program, t.command.args, t.detail]), [
    ['build', 'npm', ['run', 'build'], 'vite build'],
    ['test:unit', 'npm', ['run', 'test:unit'], 'node --test'],
    ['dev', 'npm', ['run', 'dev'], 'vite'],
  ]);
  assert.equal(npmTasks(pkg, ['pnpm-lock.yaml'])[0].command.program, 'pnpm');
  assert.equal(npmTasks(pkg, ['yarn.lock'])[0].command.program, 'yarn');
  assert.equal(npmTasks(pkg, ['bun.lock'])[0].command.program, 'bun');
  assert.deepEqual(npmTasks('{ not json'), []);
  assert.deepEqual(npmTasks('{"scripts": ["x"]}'), []);
});

test('Makefile targets, with their comments; not special ones, patterns or variables', () => {
  const mk = ['CC := gcc', '.PHONY: all clean', '# Build everything', 'all: app ## the default', 'app: main.o', '\t$(CC) -o app main.o', '%.o: %.c', '\t$(CC) -c $<', 'clean test:', '\trm -f app', 'VERSION ?= 1', 'x::', 'install: ; cp app /usr/local/bin'].join('\n');
  assert.deepEqual(makeTargets(mk).map((t) => [t.name, t.detail]), [['all', 'the default'], ['app', ''], ['clean', ''], ['test', ''], ['install', '']]);
  assert.deepEqual(makeTargets(mk)[0].command, { program: 'make', args: ['all'] });
});

test('pyproject scripts: taskipy, PDM, Poetry, and [project.scripts] through uv when it is used', () => {
  const toml = `[project]
name = "app"
[project.scripts]
serve = "app.web:main"
"two words" = "app:x"
[tool.taskipy.tasks]
lint = "ruff check ."
test = { cmd = "pytest -q", help = "the tests" }
[tool.pdm.scripts]
_ = { env_file = ".env" }
start = "flask run"
dev = { cmd = "flask run --debug" }
[tool.ruff]
line-length = 100
`;
  const plain = pyprojectTasks(toml);
  assert.deepEqual(plain.map((t) => [t.name, t.command.program, t.command.args]), [
    ['lint', 'task', ['lint']],
    ['test', 'task', ['test']],
    ['start', 'pdm', ['run', 'start']],
    ['dev', 'pdm', ['run', 'dev']],
    ['serve', 'serve', []],
  ]);
  assert.equal(plain.find((t) => t.name === 'test').detail, 'pytest -q');
  // A name that is not a plain word is not run as a program of its own; through uv it is fine.
  assert.equal(plain.some((t) => t.name === 'two words'), false);
  const uv = pyprojectTasks(toml, ['uv.lock']);
  assert.deepEqual(uv.find((t) => t.name === 'two words').command, { program: 'uv', args: ['run', 'two words'] });
  assert.deepEqual(pyprojectTasks('[tool.poetry.scripts]\ncli = "app.cli:run"\n')[0].command, { program: 'poetry', args: ['run', 'cli'] });
});

test('Composer scripts, without the event hooks', () => {
  const json = JSON.stringify({ scripts: { test: 'phpunit', 'post-install-cmd': 'x', lint: ['phpcs', 'phpstan'] }, 'scripts-descriptions': { test: 'Run the tests' } });
  assert.deepEqual(composerTasks(json).map((t) => [t.name, t.command.args, t.detail]), [
    ['test', ['run-script', 'test'], 'Run the tests'],
    ['lint', ['run-script', 'lint'], 'phpcs && phpstan'],
  ]);
});

test('groups from the files found, and the line typed: names quoted for the shell', () => {
  const groups = taskGroups([
    { dir: '/w/app', name: 'package.json', text: JSON.stringify({ scripts: { 'x; rm -rf ~': 'echo hi', build: 'tsc' } }), siblings: [] },
    { dir: '/w/app', name: 'Makefile', text: 'all:\n', siblings: [] },
    { dir: '/w/app', name: 'makefile', text: 'other:\n', siblings: [] },
    { dir: '/w', name: 'composer.json', text: '{}', siblings: [] },
  ]);
  assert.deepEqual(groups.map((g) => [g.dir, g.kind, g.tasks.length]), [['/w/app', 'npm', 2], ['/w/app', 'make', 1]]);
  const [odd] = groups[0].tasks;
  assert.equal(taskLine(odd, '/w/app', { kind: 'posix', quote: quoteFor, line: runLine }), "cd -- /w/app && npm run 'x; rm -rf ~'");
  assert.equal(taskLine(odd, 'C:\\w', { kind: 'powershell', quote: quoteFor, line: runLine }), "Set-Location -LiteralPath 'C:\\w'; npm run 'x; rm -rf ~'");
  assert.equal(taskLine(groups[0].tasks[1], '/w/my app', { kind: 'posix', quote: quoteFor, line: runLine }), "cd -- '/w/my app' && npm run build");
});

test('a project’s settings: its tasks (once trusted) and the names of those waiting', () => {
  const groups = taskGroups([
    { dir: '/w/app', name: '.tracker-editor.json', project: { path: '/w/app/.tracker-editor.json', tasks: [{ name: 'serve', command: 'npm run dev -- --port 3000', cwd: '/w/app/web', detail: '' }], held: [], trusted: true } },
    { dir: '/w/other', name: '.tracker-editor.json', project: { path: '/w/other/.tracker-editor.json', tasks: [], held: ['build', 'deploy'], trusted: false } },
    { dir: '/w/none', name: '.tracker-editor.json', project: { path: '/w/none/.tracker-editor.json', tasks: [], held: [], trusted: true } },
    { dir: '/w/app', name: 'package.json', text: JSON.stringify({ scripts: { build: 'tsc' } }), siblings: [] },
  ]);
  assert.deepEqual(groups.map((g) => [g.dir, g.kind, g.tasks.length, g.held?.length ?? 0]), [['/w/app', 'project', 1, 0], ['/w/other', 'project', 0, 2], ['/w/app', 'npm', 1, 0]]);
  const [serve] = groups[0].tasks;
  assert.deepEqual(serve, { name: 'serve', command: { line: 'npm run dev -- --port 3000' }, detail: 'npm run dev -- --port 3000 · in web', cwd: '/w/app/web' });
  // Typed as written (the person's own line), with the variables first.
  assert.equal(taskLine(serve, '/w/app/web', { kind: 'posix', quote: quoteFor, line: runLine, env: { PORT: '3000' } }), 'export PORT=3000; cd -- /w/app/web && npm run dev -- --port 3000');
  assert.equal(taskLine(groups[2].tasks[0], 'C:\\w', { kind: 'cmd', quote: quoteFor, line: runLine, env: { CI: '1' } }), 'set "CI=1" && cd /d "C:\\w" && npm run build');
});
