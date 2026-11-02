// Settings per project (0.46), the page's side. The main process finds the nearest
// .tracker-editor.json above a file and cleans it (electron/projectSettings.cjs, IPC
// project:settings); what changes what runs (run commands, tasks, variables) comes only once the
// person trusted the file as it is, in a native dialog the main process shows (project:trust:
// the page cannot answer it). Here: those answers kept a moment per folder, asking once before
// a run that would use what waits for trust, and the template a new file starts from.
// Pure (the bridge is given): the tests use it.

export const PROJECT_FILE = '.tracker-editor.json';

/** A new project file: every setting there is, commented out, with what it does. */
export const PROJECT_TEMPLATE = `// Tracker Editor's settings for this project's files: JSON with comments.
// The nearest .tracker-editor.json above a file counts (one in a folder inside the project
// counts for that folder). Run commands, tasks and variables count once you trust this file:
// you are asked the first time you run something, and again whenever the file changes.
{
  // What F5 runs, by file type: {file} is the file, {name} its name, {dir} its folder.
  "run": {
    // ".py": "python -m app",
  },
  // Tasks for Ctrl+Shift+B: a name, a command, and a folder inside the project to run it in.
  "tasks": [
    // { "name": "serve", "command": "npm run dev", "cwd": "web" },
  ],
  // Variables set in the terminal for what runs here: F5, tests and tasks.
  "env": {
    // "DEBUG": "1",
  },
  // Language servers: "off": true, or which one ("pyright" or "basedpyright"; "tsc" or "tls").
  "languages": {
    // "python": { "server": "basedpyright" },
  },
  // Format document: "server" (the language server first) or "builtin" (Prettier and the editor's own).
  // "formatter": "server",
  // The test framework when the one found is not right: "vitest", "jest", "mocha", "node",
  // "pytest", "unittest", "phpunit" or "pest".
  // "tests": "vitest",
}
`;

/** The folder a path is in (here, or remote://id/…). */
export const folderOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '') || String(p);

/** A file's type as run commands name it: "py" for app.py. */
export const typeOf = (name) => (/\.([^.\\/]+)$/.exec(String(name))?.[1] ?? '').toLowerCase();

/** Settings' run commands (type → command) with the project's over them. */
export const withProjectRun = (custom, info) => ({ ...custom, ...(info?.settings?.run ?? {}) });

/**
 * What a run would use of a project file that is not trusted: 'run' (the command for its type
 * `ext`), 'task' (the project's task `task`), 'env' (its variables). [] when nothing.
 */
export function heldFor(info, { ext = '', task = '' } = {}) {
  const h = info?.held;
  if (!h) return [];
  return [...(ext && h.run?.includes(ext) ? ['run'] : []), ...(task && h.tasks?.includes(task) ? ['task'] : []), ...(h.env?.length ? ['env'] : [])];
}

/** How a project file stands, for the status bar and Settings: { tone, text }, or null without one. */
export function projectStatus(info) {
  if (!info?.path) return null;
  const n = info.problems?.length ?? 0;
  const problems = n ? ` · ${n} problem${n === 1 ? '' : 's'}` : '';
  if (info.broken) return { tone: 'error', text: `Cannot be used: ${info.problems?.[0]?.message ?? 'it could not be read'}` };
  if (info.held && info.declined) return { tone: 'warn', text: `Not trusted: its run commands, tasks and variables are left out${problems}` };
  if (info.held) return { tone: 'warn', text: `Not trusted yet: you are asked when you run something${problems}` };
  return { tone: n ? 'warn' : 'ok', text: `${info.needsTrust ? 'Trusted' : 'In use (nothing in it needs trust)'}${problems}` };
}

/**
 * The project files' answers, kept `ttl` ms per folder. `bridge`: window.desktop.project
 * ({ settings(target, { folder, fresh }), trust(path), untrust(path) }). `onChange(info, before)`
 * runs when a folder's answer is first known or changes (`before` undefined the first time).
 */
export function createProjects({ bridge, onChange = () => {}, ttl = 3000, clock = () => Date.now() } = {}) {
  const cache = new Map(); // folder → { at, promise, info, loaded }
  const asking = new Map(); // project file → the trust question on screen (asked once at a time)
  const ask = (path) => {
    if (!asking.has(path))
      asking.set(
        path,
        Promise.resolve()
          .then(() => bridge.trust(path))
          .finally(() => asking.delete(path)),
      );
    return asking.get(path);
  };
  const keyOf = (target, folder) => (folder ? String(target) : folderOf(target));
  async function get(target, { fresh = false, folder = false } = {}) {
    if (!bridge?.settings || !target) return null;
    const key = keyOf(target, folder);
    const known = cache.get(key);
    if (!fresh && known && clock() - known.at < ttl) return known.promise;
    const entry = { at: clock(), promise: null, info: known?.info ?? null, loaded: Boolean(known?.loaded) };
    entry.promise = Promise.resolve()
      .then(() => bridge.settings(target, { folder, fresh }))
      .catch(() => null);
    cache.set(key, entry);
    const info = await entry.promise;
    if (cache.get(key) !== entry) return info;
    const { info: before, loaded } = entry;
    entry.info = info;
    entry.loaded = true;
    if (!loaded || JSON.stringify(before) !== JSON.stringify(info)) onChange(info, loaded ? before : undefined);
    return info;
  }
  const stale = () => {
    for (const e of cache.values()) e.at = -Infinity;
  };
  return {
    get,
    /** What is known already (no asking): the last answer for the target's folder, or null. */
    now: (target, { folder = false } = {}) => cache.get(keyOf(target, folder))?.info ?? null,
    /** Every folder asked again next time (a project file saved, trusted…). */
    stale,
    /**
     * For a run (a file of type `ext`, the project task `task`): the answer read again; when the
     * run would use what waits for trust and the person was never asked about the file as it
     * is, asked now (once: the main process keeps a no too). { info, left }: `left` names what
     * stays out (heldFor) because the file is not trusted.
     */
    async forRun(target, { folder = false, ext = '', task = '' } = {}) {
      let info = await get(target, { fresh: true, folder });
      if (info?.path && !info.trusted && !info.declined && bridge.trust && heldFor(info, { ext, task }).length) {
        await ask(info.path).catch(() => null);
        stale();
        info = await get(target, { fresh: true, folder });
      }
      return { info, left: info && !info.trusted ? heldFor(info, { ext, task }) : [] };
    },
    /** Asks the person (the main process's dialog) to trust the file at `path`: { trusted }. */
    async trust(path) {
      const answer = await ask(path);
      stale();
      return answer;
    },
    /** Stops trusting it (no question: trusting less needs none). */
    async untrust(path) {
      const answer = await bridge.untrust(path);
      stale();
      return answer;
    },
  };
}
