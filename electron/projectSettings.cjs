// Settings per project (0.46): a `.tracker-editor.json` file (JSON with comments and trailing
// commas) in a project's folder, which changes for that project's files what F5 runs (`run`),
// adds tasks to Ctrl+Shift+B (`tasks`), sets variables for runs, tests and tasks (`env`), picks
// between the catalog's language servers (`languages`), which formatter goes first
// (`formatter`) and the test framework (`tests`). It is looked for from a file's folder up to
// the folder picked, a Git repository's top or 6 folders up; the nearest one counts, alone.
//
// What changes what runs (run, tasks, env) counts only once the person trusted the file as it
// is now, in a native dialog the main process shows (project:trust): the answer is kept by the
// file's path with the SHA-256 of its text, so a changed file is asked about again. Nothing in
// it names a program for a language server or runs by itself: languages are choices among the
// catalog's ways, and run, tasks and env apply only when the person runs something.
// Pure but for the hash (node:crypto): main.cjs reads the files; the tests use it.
'use strict';
const crypto = require('node:crypto');

const PROJECT_FILE = '.tracker-editor.json';
const MAX_BYTES = 256 * 1024;
const LEVELS = 6;
const SETTINGS = ['run', 'tasks', 'env', 'languages', 'formatter', 'tests'];
/** The test frameworks a project may name (testRun.js's, where a language has more than one). */
const TEST_FRAMEWORKS = ['vitest', 'jest', 'mocha', 'node', 'pytest', 'unittest', 'phpunit', 'pest'];
// Variables the terminal's own workings need (its prompt, the folder it says it is in, how it
// starts): never set from a project file.
const SHELL_OWN = new Set(['PROMPT_COMMAND', 'PS0', 'PS1', 'PS2', 'PS3', 'PS4', 'PROMPT', 'IFS', 'ZDOTDIR', 'TE_ZDOTDIR', 'TRACKER_LOGIN', 'BASH_ENV', 'ENV']);
// What makes a folder a project's top, for where a new file goes when none is found.
const MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json', 'deno.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'mix.exs', 'pubspec.yaml', 'CMakeLists.txt', 'setup.py'];
const MARKER_PATTERN = /\.(csproj|sln|slnx)$/i;
// Names people may write for the settings, to say which one they meant.
const ALIASES = { environment: 'env', variables: 'env', vars: 'env', commands: 'run', runcommands: 'run', formatters: 'formatter', test: 'tests', framework: 'tests', language: 'languages', languageservers: 'languages', servers: 'languages' };
const LIMITS = { run: 40, tasks: 50, env: 50, line: 2000, value: 4000, name: 120 };
const MAX_TRUSTED = 300;

const hasControl = (s) => /[\x00-\x1f\x7f]/.test(s);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const quoted = (s) => `“${String(s).slice(0, 60)}”`;

/** Empty settings: what a project without a file (or a file that cannot be read) gives. */
const emptySettings = () => ({ run: {}, tasks: [], env: {}, languages: {}, formatter: '', tests: [] });

/** The text with comments and trailing commas made spaces (same length, so places stay). */
function blankJsonc(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let lastComma = -1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      lastComma = -1;
      for (i++; i < text.length && text[i] !== '"' && text[i] !== '\n'; i += text[i] === '\\' ? 2 : 1);
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      blank(i, end === -1 ? text.length : end + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      if (c === ',') lastComma = i;
      else if ((c === '}' || c === ']') && lastComma !== -1) out[lastComma] = ' ';
      if (!' \t\r\n,'.includes(c)) lastComma = -1;
      i++;
    }
  }
  return out.join('');
}

// JSON.parse's words for a mistake, with its line when the engine gives the place.
function parseMessage(err, text) {
  const msg = String(err?.message ?? err);
  const lineCol = /\(line (\d+) column (\d+)\)/.exec(msg);
  const at = /at position (\d+)/.exec(msg);
  const line = lineCol ? Number(lineCol[1]) : at ? text.slice(0, Number(at[1])).split('\n').length : 0;
  const what = msg
    .replace(/^JSON\.parse: /, '')
    .replace(/\s*\(line \d+ column \d+\)/, '')
    .replace(/ in JSON at position \d+/, '')
    .slice(0, 160);
  return `${line ? `Line ${line}: ` : ''}${what}`;
}

/** A text kept as one line ({ value } or { problem }). */
function oneLine(value, { max = LIMITS.line, what }) {
  if (typeof value !== 'string') return { problem: `${what} should be text in quotes.` };
  if (hasControl(value)) return { problem: `${what} has a line break or a control character: left out.` };
  if (value.length > max) return { problem: `${what} is longer than ${max} characters: left out.` };
  return { value: value.trim() };
}

// A folder inside the project, as written in a task's "cwd": relative, never above it.
function cleanCwd(value, what) {
  if (value === undefined || value === null || value === '' || value === '.') return { value: '' };
  const line = oneLine(value, { max: 300, what });
  if (line.problem) return line;
  const rel = line.value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (/^(\/|[A-Za-z]:|~)/.test(rel) || rel.split('/').includes('..')) return { problem: `${what} should be a folder inside the project (like "web"), not ${quoted(value)}.` };
  return { value: rel === '.' ? '' : rel };
}

function cleanRun(value, problems) {
  const out = {};
  if (!isObject(value)) return problems.push({ key: 'run', message: '"run" should be { ".py": "python -m app" }: left out.' }), out;
  for (const [key, command] of Object.entries(value)) {
    const ext = /^\.?([A-Za-z0-9_+-]{1,20})$/.exec(key)?.[1]?.toLowerCase();
    if (!ext) {
      problems.push({ key: `run.${key}`, message: `"run": ${quoted(key)} is not a file type (".py", "js"): left out.` });
      continue;
    }
    if (Object.keys(out).length >= LIMITS.run) {
      problems.push({ key: 'run', message: `"run": more than ${LIMITS.run} types; the rest left out.` });
      break;
    }
    const line = oneLine(command, { what: `"run" for .${ext}` });
    if (line.problem) problems.push({ key: `run.${key}`, message: line.problem });
    else out[ext] = line.value;
  }
  return out;
}

function cleanTasks(value, problems) {
  const out = [];
  if (!Array.isArray(value)) return problems.push({ key: 'tasks', message: '"tasks" should be a list: [{ "name": "serve", "command": "npm run dev" }]. Left out.' }), out;
  value.forEach((task, i) => {
    const at = `tasks[${i}]`;
    if (!isObject(task)) return problems.push({ key: at, message: `"tasks" item ${i + 1} should be { "name", "command" }: left out.` });
    if (out.length >= LIMITS.tasks) return i === LIMITS.tasks && problems.push({ key: 'tasks', message: `More than ${LIMITS.tasks} tasks; the rest left out.` });
    for (const k of Object.keys(task)) if (!['name', 'command', 'cwd', 'detail'].includes(k)) problems.push({ key: `${at}.${k}`, message: `Task ${i + 1}: unknown field ${quoted(k)} (name, command, cwd, detail): left out.` });
    if (task.name === undefined || task.command === undefined) return problems.push({ key: at, message: `Task ${i + 1} needs a "name" and a "command": left out.` });
    const name = oneLine(task.name, { max: LIMITS.name, what: `Task ${i + 1}'s "name"` });
    const command = oneLine(task.command, { what: `Task ${i + 1}'s "command"` });
    const cwd = cleanCwd(task.cwd, `Task ${i + 1}'s "cwd"`);
    const detail = task.detail === undefined ? { value: '' } : oneLine(task.detail, { max: 200, what: `Task ${i + 1}'s "detail"` });
    const bad = [name, command, cwd, detail].find((x) => x.problem);
    if (bad) return problems.push({ key: at, message: bad.problem });
    if (!name.value || !command.value) return problems.push({ key: at, message: `Task ${i + 1} needs a "name" and a "command": left out.` });
    if (out.some((t) => t.name === name.value)) return problems.push({ key: at, message: `Two tasks are named ${quoted(name.value)}: the first counts.` });
    out.push({ name: name.value, command: command.value, cwd: cwd.value, detail: detail.value });
  });
  return out;
}

function cleanEnv(value, problems) {
  const out = {};
  if (!isObject(value)) return problems.push({ key: 'env', message: '"env" should be { "NAME": "value" }: left out.' }), out;
  for (const [name, v] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name)) {
      problems.push({ key: `env.${name}`, message: `"env": ${quoted(name)} is not a variable name (letters, digits and _): left out.` });
      continue;
    }
    if (SHELL_OWN.has(name.toUpperCase())) {
      problems.push({ key: `env.${name}`, message: `"env": ${name} belongs to the terminal itself: left out.` });
      continue;
    }
    if (Object.keys(out).length >= LIMITS.env) {
      problems.push({ key: 'env', message: `"env": more than ${LIMITS.env} variables; the rest left out.` });
      break;
    }
    const text = typeof v === 'number' || typeof v === 'boolean' ? String(v) : v;
    const line = oneLine(text, { max: LIMITS.value, what: `"env" ${name}` });
    if (line.problem) problems.push({ key: `env.${name}`, message: line.problem });
    else out[name] = typeof text === 'string' ? text : line.value;
  }
  return out;
}

function cleanLanguages(value, problems, catalog) {
  const out = {};
  if (!isObject(value)) return problems.push({ key: 'languages', message: '"languages" should be { "python": { "server": "basedpyright" } }: left out.' }), out;
  const ids = catalog.map((e) => e.id);
  for (const [id, v] of Object.entries(value)) {
    const entry = catalog.find((e) => e.id === id);
    if (!entry) {
      problems.push({ key: `languages.${id}`, message: `"languages": ${quoted(id)} is not one of ${ids.join(', ')}: left out.` });
      continue;
    }
    if (!isObject(v)) {
      problems.push({ key: `languages.${id}`, message: `"languages" ${id} should be { "off": true } or { "server": "…" }: left out.` });
      continue;
    }
    const clean = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'off') {
        if (typeof x === 'boolean') clean.off = x;
        else problems.push({ key: `languages.${id}.off`, message: `"languages" ${id}: "off" should be true or false.` });
      } else if (k === 'server') {
        if (entry.choices.includes(x)) clean.server = x;
        else problems.push({ key: `languages.${id}.server`, message: entry.choices.length ? `"languages" ${id}: "server" is one of ${entry.choices.map((c) => `"${c}"`).join(', ')}, not ${quoted(x)}.` : `"languages" ${id} has one server only: "server" left out.` });
      } else if (k === 'formatter') {
        if (x === 'server' || x === 'builtin') clean.formatter = x;
        else problems.push({ key: `languages.${id}.formatter`, message: `"languages" ${id}: "formatter" is "server" or "builtin".` });
      } else problems.push({ key: `languages.${id}.${k}`, message: `"languages" ${id}: unknown field ${quoted(k)} (off, server, formatter): left out.` });
    }
    if (Object.keys(clean).length) out[id] = clean;
  }
  return out;
}

function cleanTests(value, problems) {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!list) return problems.push({ key: 'tests', message: `"tests" should be a framework's name, like "vitest" or "pytest": left out.` }), [];
  const out = [];
  for (const name of list) {
    if (TEST_FRAMEWORKS.includes(name)) {
      if (!out.includes(name)) out.push(name);
    } else problems.push({ key: 'tests', message: `"tests": ${quoted(name)} is not one of ${TEST_FRAMEWORKS.join(', ')}: left out.` });
  }
  return out;
}

/**
 * A project file's text → { settings, problems, broken? }: the settings cleaned (anything that
 * does not check out left out, with a problem saying why; unknown keys too). `catalog`: the
 * language servers' entries, [{ id, choices: [ids] }], which "languages" may name.
 */
function parseProjectSettings(text, { catalog = [] } = {}) {
  const settings = emptySettings();
  const problems = [];
  const raw = String(text ?? '');
  if (raw.length > MAX_BYTES) return { settings, problems: [{ message: `The file is larger than ${MAX_BYTES / 1024} KB: left out.` }], broken: true };
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!blankJsonc(body).trim()) return { settings, problems };
  let data;
  try {
    data = JSON.parse(blankJsonc(body));
  } catch (err) {
    return { settings, problems: [{ message: parseMessage(err, body) }], broken: true };
  }
  if (!isObject(data)) return { settings, problems: [{ message: 'The file should hold one object: { "run": …, "tasks": … }.' }], broken: true };
  for (const [key, value] of Object.entries(data)) {
    if (key === '$schema') continue;
    if (key === 'run') settings.run = cleanRun(value, problems);
    else if (key === 'tasks') settings.tasks = cleanTasks(value, problems);
    else if (key === 'env') settings.env = cleanEnv(value, problems);
    else if (key === 'languages') settings.languages = cleanLanguages(value, problems, catalog);
    else if (key === 'formatter') {
      if (value === 'server' || value === 'builtin') settings.formatter = value;
      else problems.push({ key, message: '"formatter" is "server" (the language server first) or "builtin" (Prettier and the editor’s own).' });
    } else if (key === 'tests') settings.tests = cleanTests(value, problems);
    else {
      const meant = SETTINGS.find((k) => k === key.toLowerCase()) ?? ALIASES[key.toLowerCase().replace(/[^a-z]/g, '')];
      problems.push({ key, message: `Unknown setting ${quoted(key)}${meant ? ` (did you mean "${meant}"?)` : ''}: left out.` });
    }
  }
  return { settings, problems };
}

/** Whether the settings change what runs (run commands, tasks, variables): those need trust. */
const needsTrust = (s) => Boolean(s) && (Object.keys(s.run ?? {}).length > 0 || (s.tasks ?? []).length > 0 || Object.keys(s.env ?? {}).length > 0);
/** What waits for trust: the run commands' types, the tasks' names, the variables' names. */
const heldOf = (s) => ({ run: Object.keys(s.run ?? {}), tasks: (s.tasks ?? []).map((t) => t.name), env: Object.keys(s.env ?? {}) });
/** The settings without what needs trust. */
const withoutUntrusted = (s) => ({ ...s, run: {}, tasks: [], env: {} });

/** The text's SHA-256 (hex): what a trust answer is kept for. */
const trustHash = (text) => crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

/** The trust answers kept in prefs.json, checked: { [path]: { hash, allow, at } }, the newest MAX_TRUSTED. */
function cleanTrust(saved) {
  const rows = Object.entries(isObject(saved) ? saved : {}).filter(([p, v]) => typeof p === 'string' && p.length <= 4096 && isObject(v) && /^[0-9a-f]{64}$/.test(v.hash) && typeof v.allow === 'boolean');
  rows.sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0));
  return Object.fromEntries(rows.slice(0, MAX_TRUSTED).map(([p, v]) => [p, { hash: v.hash, allow: v.allow, at: Number(v.at) || 0 }]));
}
/** The answers with this one: allowed or not, for the file at `path` as its text is now. */
const rememberTrust = (store, path, hash, allow, at = Date.now()) => cleanTrust({ ...cleanTrust(store), [path]: { hash, allow: Boolean(allow), at } });
/** 'yes' (trusted as it is now), 'no' (refused as it is now) or 'ask' (never asked, or changed since). */
function trustState(store, path, hash) {
  const v = isObject(store) ? store[path] : null;
  if (!v || v.hash !== hash) return 'ask';
  return v.allow ? 'yes' : 'no';
}

/**
 * The nearest project file from folder `start` up: { file, dir, root }. `list(dir)` gives a
 * folder's names (throws when it cannot); `path` is node's path (path.posix on servers). It
 * stops at a Git repository's top, the filesystem's root, `levels` folders up, and `stop`: the
 * folder picked ('' = only `start`; null = no such bound, as on servers). Without a file,
 * `root` is where a new one would go: the repository's top, else the nearest folder with a
 * project's file (package.json, pyproject.toml…), else the folder picked when reached, else `start`.
 */
async function findProjectFile(start, { list, path, stop = null, levels = LEVELS }) {
  let dir = start;
  let marker = '';
  let repository = '';
  let picked = '';
  for (let up = 0; up < levels; up++) {
    let names;
    try {
      names = await list(dir);
    } catch {
      break;
    }
    if (names.includes(PROJECT_FILE)) return { file: path.join(dir, PROJECT_FILE), dir, root: dir };
    if (!marker && names.some((n) => MARKERS.includes(n) || MARKER_PATTERN.test(n))) marker = dir;
    if (names.includes('.git')) {
      repository = dir;
      break;
    }
    if (stop === '') break;
    if (stop && path.resolve(dir) === path.resolve(stop)) {
      picked = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { file: null, dir: null, root: repository || marker || picked || start };
}

/**
 * What the page is told about a project file: { path, dir, root, settings, held, trusted,
 * declined, problems }. `settings` lacks run, tasks and env until the person trusted the file
 * as it is (`held` names them meanwhile); tasks' folders are made whole with `join(dir, rel)`.
 */
function projectInfo(text, { path, dir, root = dir, trust = {}, catalog = [], join = (a, b) => (b ? `${a}/${b}` : a) }) {
  if (text === null || text === undefined) return { path, dir, root, settings: emptySettings(), held: null, trusted: false, declined: false, problems: [{ message: `The file could not be read, or is larger than ${MAX_BYTES / 1024} KB.` }], broken: true };
  const parsed = parseProjectSettings(text, { catalog });
  const full = { ...parsed.settings, tasks: parsed.settings.tasks.map((t) => ({ ...t, cwd: t.cwd ? join(dir, t.cwd) : '' })) };
  const asks = needsTrust(full);
  const state = asks ? trustState(trust, path, trustHash(text)) : 'yes';
  return {
    path,
    dir,
    root,
    settings: state === 'yes' ? full : withoutUntrusted(full),
    full,
    held: state === 'yes' ? null : heldOf(full),
    trusted: state === 'yes',
    declined: state === 'no',
    needsTrust: asks,
    problems: parsed.problems,
    ...(parsed.broken ? { broken: true } : {}),
  };
}

/** The native dialog's text: the folder, then each run command, task and variable it would use. */
function trustDetail(s, { folder }) {
  const cut = (t, n = 140) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const lines = [folder, ''];
  const run = Object.entries(s.run ?? {});
  if (run.length) lines.push('Run (F5):', ...run.map(([ext, cmd]) => `  .${ext}: ${cmd ? cut(cmd) : '(nothing: F5 does not run these)'}`), '');
  if (s.tasks?.length) lines.push('Tasks (Ctrl+Shift+B):', ...s.tasks.slice(0, 20).map((t) => `  ${t.name}: ${cut(t.command)}${t.cwd ? `  (in ${t.cwd})` : ''}`), ...(s.tasks.length > 20 ? [`  …and ${s.tasks.length - 20} more`] : []), '');
  const env = Object.entries(s.env ?? {});
  if (env.length) lines.push('Variables for runs, tests and tasks:', ...env.slice(0, 20).map(([k, v]) => `  ${k}=${cut(v, 80)}`), ...(env.length > 20 ? [`  …and ${env.length - 20} more`] : []), '');
  lines.push('They are used only when you run something (F5, a task, tests), typed into the terminal where you see them. If the file changes, you are asked again.');
  return lines.join('\n');
}

/**
 * Settings' language choices (the page's { off, prefer }) with the project's over them: a
 * project turns a language's server off or picks one of its ways; it never turns on one the
 * person turned off.
 */
function withProjectLanguages(opts, languages) {
  const off = new Set(Array.isArray(opts?.off) ? opts.off : []);
  const prefer = { ...(isObject(opts?.prefer) ? opts.prefer : {}) };
  for (const [id, v] of Object.entries(isObject(languages) ? languages : {})) {
    if (v?.off === true) off.add(id);
    if (typeof v?.server === 'string' && v.server) prefer[id] = v.server;
  }
  return { off: [...off], prefer };
}

module.exports = {
  PROJECT_FILE,
  MAX_BYTES,
  LEVELS,
  SETTINGS,
  TEST_FRAMEWORKS,
  SHELL_OWN,
  emptySettings,
  blankJsonc,
  parseProjectSettings,
  needsTrust,
  heldOf,
  withoutUntrusted,
  trustHash,
  cleanTrust,
  rememberTrust,
  trustState,
  findProjectFile,
  projectInfo,
  trustDetail,
  withProjectLanguages,
};
