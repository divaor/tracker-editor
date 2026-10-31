// The tasks list (Terminal, part two): the commands a project names for itself, found in its
// files and run with one click in a terminal. npm scripts (package.json; pnpm, yarn or bun
// when their lock file is there), Makefile targets, pyproject.toml scripts ([project.scripts],
// Poetry's, PDM's, taskipy's; through uv, Poetry or PDM when their lock file is there) and
// Composer scripts. Pure: the main process reads the files (tasks:files), the tests use it.
// A task's command is { program, args }: the program is a plain name of ours, the arguments are
// quoted for the terminal's shell (quoteFor) when the line is typed, never pasted in as they are.

/** The project files looked for, by name. */
export const TASK_FILES = ['package.json', 'Makefile', 'makefile', 'GNUmakefile', 'pyproject.toml', 'composer.json'];
/** Lock files that say which tool runs a project's scripts. */
export const LOCK_FILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'uv.lock', 'poetry.lock', 'pdm.lock'];

// A task's name: one line, not too long, nothing a terminal would read as a control key.
const fineName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 120 && !/[\u0000-\u001f\u007f]/.test(n);
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

/** package.json → [{ name, command, detail }]: `npm run x` (or pnpm, yarn, bun by their lock file). */
export function npmTasks(text, lockfiles = []) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const runner = lockfiles.includes('pnpm-lock.yaml') ? 'pnpm' : lockfiles.includes('yarn.lock') ? 'yarn' : lockfiles.includes('bun.lockb') || lockfiles.includes('bun.lock') ? 'bun' : 'npm';
  const scripts = pkg && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
  return Object.entries(scripts)
    .filter(([name, body]) => fineName(name) && typeof body === 'string')
    .map(([name, body]) => ({ name, command: { program: runner, args: ['run', name] }, detail: oneLine(body) }));
}

/**
 * A Makefile → its targets (not .SPECIAL ones, patterns or variables), each with the comment
 * on its line ("## Build it") or the line before.
 */
export function makeTargets(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /^([A-Za-z0-9_][A-Za-z0-9_./+-]*(?:[ \t]+[A-Za-z0-9_][A-Za-z0-9_./+-]*)*)[ \t]*:(?![:=])(.*)$/.exec(line);
    if (!m) return;
    const comment = /##?\s*(.+)$/.exec(m[2])?.[1] ?? /^\s*##?\s*(.+)$/.exec(lines[i - 1] ?? '')?.[1] ?? '';
    for (const target of m[1].split(/[ \t]+/)) {
      if (seen.has(target) || target.includes('%')) continue;
      seen.add(target);
      out.push({ name: target, command: { program: 'make', args: [target] }, detail: oneLine(comment) });
    }
  });
  return out;
}

/** The [section] tables of a TOML text that matter here: { 'tool.poetry.scripts': { name: value } }. Strings and inline tables' cmd only. */
function tomlTables(text, wanted) {
  const tables = {};
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^[\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) {
      const name = header[1].replace(/\s+/g, '').replace(/"/g, '');
      current = wanted.includes(name) ? (tables[name] ??= {}) : null;
      continue;
    }
    if (line.startsWith('[')) {
      current = null;
      continue;
    }
    if (!current) continue;
    const kv = /^("([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[2] ?? kv[3] ?? kv[4];
    const value = kv[5];
    const str = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value);
    const cmd = /cmd\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(value) ?? /(?:call|shell|composite)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(value);
    current[key] = str ? (str[1] ?? str[2]) : cmd ? (cmd[1] ?? cmd[2]) : value.startsWith('[') ? value : '';
  }
  return tables;
}

/**
 * pyproject.toml → tasks: taskipy's (`task x`), PDM's (`pdm run x`), Poetry's scripts (`poetry
 * run x`), and [project.scripts] run by the tool its lock file names (uv, Poetry, PDM), else as
 * installed in the environment (`x`).
 */
export function pyprojectTasks(text, lockfiles = []) {
  const wanted = ['tool.taskipy.tasks', 'tool.pdm.scripts', 'tool.poetry.scripts', 'project.scripts'];
  const t = tomlTables(text, wanted);
  const out = [];
  const add = (name, program, args, detail) => fineName(name) && out.push({ name, command: { program, args }, detail: oneLine(detail) });
  for (const [name, v] of Object.entries(t['tool.taskipy.tasks'] ?? {})) add(name, 'task', [name], v);
  for (const [name, v] of Object.entries(t['tool.pdm.scripts'] ?? {})) if (name !== '_') add(name, 'pdm', ['run', name], v);
  const via = lockfiles.includes('uv.lock') ? ['uv', 'run'] : lockfiles.includes('poetry.lock') ? ['poetry', 'run'] : lockfiles.includes('pdm.lock') ? ['pdm', 'run'] : null;
  const scripts = { ...(t['project.scripts'] ?? {}), ...(t['tool.poetry.scripts'] ?? {}) };
  for (const [name, v] of Object.entries(scripts)) {
    if (out.some((x) => x.name === name)) continue;
    const poetry = name in (t['tool.poetry.scripts'] ?? {});
    // Run as a program of its own (no tool to run it through): a plain name only, as it is typed unquoted.
    if (!poetry && !via && !/^[A-Za-z0-9_.-]+$/.test(name)) continue;
    const [program, ...pre] = poetry ? ['poetry', 'run'] : (via ?? [name]);
    add(name, program, poetry || via ? [...pre, name] : [], v);
  }
  return out;
}

/** composer.json → its scripts (`composer run-script x`), not the event hooks (pre-/post-…). */
export function composerTasks(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const scripts = json && typeof json.scripts === 'object' && !Array.isArray(json.scripts) ? json.scripts : {};
  const descriptions = json?.['scripts-descriptions'] ?? {};
  return Object.entries(scripts)
    .filter(([name]) => fineName(name) && !/^(pre|post)-/.test(name))
    .map(([name, body]) => ({ name, command: { program: 'composer', args: ['run-script', name] }, detail: oneLine(descriptions[name] ?? (Array.isArray(body) ? body.join(' && ') : body)) }));
}

const KIND_OF = { 'package.json': 'npm', Makefile: 'make', makefile: 'make', GNUmakefile: 'make', 'pyproject.toml': 'python', 'composer.json': 'composer' };
const LABELS = { npm: 'npm scripts', make: 'Makefile', python: 'pyproject.toml', composer: 'Composer scripts' };

/**
 * The files tasks:files found ([{ dir, name, text, siblings }]) → groups of tasks, the nearest
 * folder first: [{ dir, file, kind, label, tasks }]. Groups without tasks are left out.
 */
export function taskGroups(files) {
  const groups = [];
  for (const f of files) {
    const kind = KIND_OF[f.name];
    if (!kind) continue;
    const locks = f.siblings ?? [];
    const tasks = kind === 'npm' ? npmTasks(f.text, locks) : kind === 'make' ? makeTargets(f.text) : kind === 'python' ? pyprojectTasks(f.text, locks) : composerTasks(f.text);
    // Two Makefiles in one folder (Makefile and makefile): make reads the first it finds.
    if (kind === 'make' && groups.some((g) => g.kind === 'make' && g.dir === f.dir)) continue;
    if (tasks.length) groups.push({ dir: f.dir, file: f.name, kind, label: LABELS[kind], tasks });
  }
  return groups;
}

/**
 * The line typed into a terminal for a task: into its folder first, then the command, with
 * the task's own names quoted for the shell (`quote(kind, text)`, runFile.js's quoteFor).
 */
export function taskLine(task, dir, { kind = 'posix', quote, line }) {
  // Plain words as they are (npm run test:unit); anything else quoted. Names are not paths:
  // under WSL they are quoted as a posix shell's words.
  const word = (a) => (/^[\w.:@/+=-]+$/.test(a) ? a : quote(kind === 'wsl' ? 'posix' : kind, a));
  const command = [task.command.program, ...task.command.args.map(word)].join(' ');
  return line({ command, dir, kind });
}
