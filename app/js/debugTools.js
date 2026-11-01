// Debugging (pure: the page, the main process and the tests use it). Which adapter debugs a
// file (debugpy for Python, js-debug for JavaScript and TypeScript), the launch configuration
// for a file or for one test of a test file (built in the main process from the programs it
// found: the page names a file, never a program), breakpoints kept per file path across
// restarts (line, on or off, condition, log message, hit count), a stack frame's place in
// the editor, values as the panel shows them and the variables tree drawn as rows.

const extOf = (p) => (/\.([^.\\/]+)$/.exec(String(p))?.[1] ?? '').toLowerCase();
const baseName = (p) => String(p).split(/[\\/]/).pop();

/** The adapters: what each is called and which languages it debugs. */
export const ADAPTERS = {
  python: { id: 'python', label: 'debugpy', language: 'Python' },
  node: { id: 'node', label: 'js-debug', language: 'JavaScript and TypeScript' },
};
const EXT_ADAPTER = { py: 'python', pyw: 'python', js: 'node', mjs: 'node', cjs: 'node', ts: 'node', mts: 'node', cts: 'node' };
/** The adapter for a file by its name ('python' | 'node'), or null. */
export const debugAdapterFor = (name) => EXT_ADAPTER[extOf(name)] ?? null;
/** Test frameworks a test can be debugged with, and their adapter. */
export const DEBUG_FRAMEWORKS = { pytest: 'python', unittest: 'python', node: 'node', vitest: 'node', jest: 'node' };

// ---- Launch configurations ----

const reEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const relPath = (root, file) => {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const f = norm(file);
  const low = /^[A-Za-z]:/.test(f) ? (x) => x.toLowerCase() : (x) => x;
  return r && low(f).startsWith(`${low(r)}/`) ? f.slice(r.length + 1) : f;
};
const pyName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const checkPy = (name, what) => {
  if (!pyName.test(String(name ?? ''))) throw new Error(`Not a Python ${what}: ${String(name).slice(0, 80)}`);
  return name;
};
/** A test's name pattern, as testRun.js runs it: suites and test joined by `join`, a suite's start only. */
const namePattern = (target, join) => `^${[...(target.chain ?? []), target.title].map((t) => reEscape(String(t))).join(join)}${target.kind === 'suite' ? '' : '$'}`;

/** pytest's id of a test (or of a class, or of the file's tests): path::Class::test_name. */
export function pytestId(file, root, target = null) {
  const rel = relPath(root, file);
  if (!target) return rel;
  return [rel, ...(target.kind === 'test' && target.cls ? [checkPy(target.cls, 'class')] : []), checkPy(target.title, target.kind === 'suite' ? 'class' : 'test name')].join('::');
}
/** unittest's dotted id: package.module.Class.test_name. */
export function unittestId(file, root, target = null) {
  const mod = relPath(root, file).replace(/\.py$/, '').split('/').map((p) => checkPy(p, 'module')).join('.');
  if (!target) return mod;
  return [mod, ...(target.kind === 'test' && target.cls ? [checkPy(target.cls, 'class')] : []), checkPy(target.title, target.kind === 'suite' ? 'class' : 'test name')].join('.');
}

/**
 * The launch configuration that debugs `file` with `adapter` ('python' | 'node'). What the
 * main process found: `python` (an interpreter with debugpy), `node` (the person's own Node.js),
 * `tsx` (the project has tsx: TypeScript runs through it), `programs` ({ vitest, jest }: the
 * project's scripts); `cwd` is where it runs. `test`: { framework, target } (testRun.js's
 * framework and test, or target null for the file's tests) debugs tests instead: pytest and
 * unittest as modules with the test's id, node:test with the name pattern in the file's own
 * process, Vitest and Jest through their scripts. Throws when something needed is missing.
 */
export function launchConfig(adapter, { file, cwd, python = '', node = '', tsx = false, programs = {}, test = null }) {
  const name = `Debug ${test?.target?.title ?? baseName(file)}`;
  if (adapter === 'python') {
    const base = { type: 'python', request: 'launch', name, cwd, console: 'internalConsole', justMyCode: true, subProcess: false, showReturnValue: true, ...(python ? { python } : {}) };
    if (!test) return { ...base, program: file };
    if (test.framework === 'pytest') return { ...base, module: 'pytest', args: [pytestId(file, cwd, test.target)] };
    if (test.framework === 'unittest') return { ...base, module: 'unittest', args: ['-v', unittestId(file, cwd, test.target)] };
    throw new Error(`Tests run with ${test.framework} cannot be debugged here.`);
  }
  if (adapter === 'node') {
    const ts = /^[cm]?ts$/.test(extOf(file));
    const base = {
      type: 'pwa-node',
      request: 'launch',
      name,
      cwd,
      runtimeExecutable: node || 'node',
      console: 'internalConsole',
      // stdout and stderr (test reporters write there), not only console.log.
      outputCapture: 'std',
      skipFiles: ['<node_internals>/**'],
      // The adapter runs on the editor's own Node.js (Electron's): not the program.
      env: { ELECTRON_RUN_AS_NODE: null },
    };
    const tsArgs = ts && tsx ? ['--import', 'tsx'] : [];
    const rel = relPath(cwd, file);
    const arg = rel.startsWith('-') ? `./${rel}` : rel;
    if (!test) return { ...base, program: file, ...(tsArgs.length ? { runtimeArgs: tsArgs } : {}) };
    const target = test.target;
    if (test.framework === 'node') return { ...base, program: file, runtimeArgs: [...tsArgs, ...(target ? [`--test-name-pattern=${reEscape(target.title)}`] : [])] };
    if (test.framework === 'vitest') {
      if (!programs.vitest) throw new Error('Vitest is not installed in this project (node_modules/vitest): run npm install first.');
      return { ...base, program: programs.vitest, args: ['run', arg, ...(target ? [`--testNamePattern=${namePattern(target, '( > | )')}`] : [])], skipFiles: ['<node_internals>/**', '**/node_modules/**'], autoAttachChildProcesses: true };
    }
    if (test.framework === 'jest') {
      if (!programs.jest) throw new Error('Jest is not installed in this project (node_modules/jest): run npm install first.');
      return { ...base, program: programs.jest, args: ['--runInBand', '--watchAll=false', arg, ...(target ? [`--testNamePattern=${namePattern(target, ' ')}`] : [])], skipFiles: ['<node_internals>/**', '**/node_modules/**'] };
    }
    throw new Error(`Tests run with ${test.framework} cannot be debugged here (node:test, Vitest and Jest can).`);
  }
  throw new Error('Debugging works for Python, JavaScript and TypeScript files.');
}

/** A test as the page sends it ({ framework, target }), checked: only names and kinds, nothing else. */
export function cleanTest(test) {
  if (!test || typeof test !== 'object' || !(test.framework in DEBUG_FRAMEWORKS)) return null;
  const t = test.target;
  const target =
    t && typeof t === 'object' && typeof t.title === 'string' && t.title
      ? { title: t.title.slice(0, 500), kind: t.kind === 'suite' ? 'suite' : 'test', cls: typeof t.cls === 'string' ? t.cls.slice(0, 200) : '', chain: Array.isArray(t.chain) ? t.chain.filter((c) => typeof c === 'string').slice(0, 20).map((c) => c.slice(0, 500)) : [] }
      : null;
  return { framework: test.framework, target };
}

// ---- Breakpoints: { line, enabled?, condition?, logMessage?, hitCondition? } per file path ----

export const MAX_BREAKPOINT_FILES = 300;
export const MAX_BREAKPOINTS = 200; // in one file
const text = (v, max = 1000) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : '');

/** A breakpoint as kept: its line and only what is set (enabled is left out when on). */
export function cleanBreakpoint(bp) {
  const line = Math.floor(Number(bp?.line));
  if (!Number.isFinite(line) || line < 1) return null;
  const out = { line };
  if (bp.enabled === false) out.enabled = false;
  for (const k of ['condition', 'logMessage', 'hitCondition']) if (text(bp[k])) out[k] = text(bp[k]);
  return out;
}
/** A file's breakpoints: clean, one a line, in line order. */
export function cleanList(list) {
  const byLine = new Map();
  for (const bp of Array.isArray(list) ? list : []) {
    const c = cleanBreakpoint(bp);
    if (c && !byLine.has(c.line)) byLine.set(c.line, c);
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line).slice(0, MAX_BREAKPOINTS);
}
/** The settings' breakpoints ({ path: list }), clean; files without any left out. */
export function cleanBreakpoints(all) {
  const out = {};
  if (!all || typeof all !== 'object') return out;
  for (const [path, list] of Object.entries(all).slice(-MAX_BREAKPOINT_FILES)) {
    const clean = cleanList(list);
    if (typeof path === 'string' && path && clean.length) out[path] = clean;
  }
  return out;
}
/** `all` with `path`'s list replaced (left out when empty); the file changed last goes last (the oldest go first past the limit). */
export function withBreakpoints(all, path, list) {
  const out = { ...cleanBreakpoints(all) };
  delete out[path];
  const clean = cleanList(list);
  if (clean.length) out[path] = clean;
  const paths = Object.keys(out);
  for (const p of paths.slice(0, Math.max(0, paths.length - MAX_BREAKPOINT_FILES))) delete out[p];
  return out;
}
/** A breakpoint at `line` added, or the one there removed. */
export function toggleBreakpoint(list, line) {
  const clean = cleanList(list);
  return clean.some((b) => b.line === line) ? clean.filter((b) => b.line !== line) : cleanList([...clean, { line }]);
}
/** The breakpoint at `line` changed (made when there is none): `patch` with '' clears a field. */
export function updateBreakpoint(list, line, patch) {
  const clean = cleanList(list);
  const at = clean.find((b) => b.line === line) ?? { line };
  const next = { ...at, ...patch, line };
  for (const k of ['condition', 'logMessage', 'hitCondition']) if (!text(next[k])) delete next[k];
  if (next.enabled !== false) delete next.enabled;
  return cleanList([...clean.filter((b) => b.line !== line), next]);
}
/** Paths moved or renamed (folders too: what is inside follows): [{ from, to }]. */
export function movedBreakpoints(all, moves) {
  const out = {};
  for (const [path, list] of Object.entries(cleanBreakpoints(all))) {
    let p = path;
    for (const { from, to } of moves ?? []) {
      if (p === from) p = to;
      else if (p.startsWith(`${from}/`) || p.startsWith(`${from}\\`)) p = to + p.slice(from.length);
    }
    out[p] = list;
  }
  return out;
}
/** What the adapter is sent for a file (setBreakpoints): the breakpoints that are on. */
export function sourceBreakpoints(list, caps = {}) {
  return cleanList(list)
    .filter((b) => b.enabled !== false)
    .map((b) => ({
      line: b.line,
      ...(b.condition && caps.supportsConditionalBreakpoints !== false ? { condition: b.condition } : {}),
      ...(b.hitCondition && caps.supportsHitConditionalBreakpoints !== false ? { hitCondition: b.hitCondition } : {}),
      ...(b.logMessage && caps.supportsLogPoints !== false ? { logMessage: b.logMessage } : {}),
    }));
}
/** The panel's list: every breakpoint with its file, by file name then line. */
export function breakpointRows(all) {
  const rows = [];
  for (const [path, list] of Object.entries(cleanBreakpoints(all))) for (const b of list) rows.push({ ...b, path, name: baseName(path) });
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path) || a.line - b.line);
}
/** What a breakpoint does, in a few words ('' for a plain one). */
export function breakpointNote(bp) {
  const parts = [];
  if (bp.condition) parts.push(`when ${bp.condition}`);
  if (bp.hitCondition) parts.push(`hit ${bp.hitCondition}`);
  if (bp.logMessage) parts.push(`logs ${bp.logMessage}`);
  return parts.join(' · ');
}
/** Are all breakpoints off (none on)? */
export const allOff = (all) => breakpointRows(all).every((b) => b.enabled === false);
/** Every breakpoint turned on or off. */
export function setAllEnabled(all, on) {
  const out = {};
  for (const [path, list] of Object.entries(cleanBreakpoints(all))) out[path] = cleanList(list.map((b) => ({ ...b, enabled: on })));
  return out;
}

// ---- What the adapter says ----

/** The exception filters to turn on, among those the adapter offers, for the choices kept ({ uncaught, all }). */
export function exceptionFilters(caps, prefs = {}, { test = false } = {}) {
  const offered = new Set((caps?.exceptionBreakpointFilters ?? []).map((f) => f.filter));
  const want = [];
  // debugpy: 'uncaught' and, in tests (pytest catches what a test raises), 'userUnhandled';
  // js-debug: 'uncaught'. All: debugpy's 'raised', js-debug's 'all'.
  if (prefs.uncaught !== false) want.push('uncaught', ...(test ? ['userUnhandled'] : []));
  if (prefs.all) want.push('raised', 'all');
  return [...new Set(want)].filter((f) => offered.has(f));
}

const absolute = (p) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(String(p));
/** Where a stack frame is in a file on this computer: { path, line, column }, or null (no file: an internal module, generated code). */
export function framePlace(frame) {
  const p = frame?.source?.path;
  if (!p || !absolute(p)) return null;
  return { path: p, line: Math.max(1, Math.floor(frame.line) || 1), column: Math.max(1, Math.floor(frame.column) || 1) };
}
/** The frame to show when a thread stops: the first in a file of the person's, else the top one. */
export function focusFrame(frames) {
  const list = frames ?? [];
  return list.find((f) => framePlace(f) && f.presentationHint !== 'subtle' && f.presentationHint !== 'deemphasize') ?? list.find((f) => framePlace(f)) ?? list[0] ?? null;
}
/** Why it stopped, for the panel and the status bar. */
export function stopReason(body = {}) {
  const what = { breakpoint: 'on a breakpoint', step: 'after a step', exception: 'on an exception', pause: '', entry: 'at the start', 'function breakpoint': 'on a breakpoint', 'data breakpoint': 'on a breakpoint', goto: '' }[body.reason] ?? '';
  const detail = body.reason === 'exception' ? String(body.text || body.description || '').trim() : '';
  return `Paused${what ? ` ${what}` : ''}${detail ? `: ${detail.split('\n')[0].slice(0, 200)}` : ''}`;
}
/** A value on one line: line breaks shown as ⏎, at most `max` characters. */
export function shortValue(value, max = 300) {
  const s = String(value ?? '').replace(/\r?\n/g, ' ⏎ ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
/** What an output event adds to the debug console ({ kind, text }), or null (telemetry). */
export function consoleOutput(body) {
  const category = body?.category ?? 'console';
  if (category === 'telemetry' || typeof body?.output !== 'string' || !body.output) return null;
  return { kind: { stdout: 'stdout', stderr: 'stderr', important: 'important' }[category] ?? 'console', text: body.output };
}
export const MAX_CONSOLE = 3000;
/** The console's entries with `entry` added: a piece of a line joins the one before it of the same kind. */
export function addToConsole(entries, entry, max = MAX_CONSOLE) {
  const out = entries.slice(Math.max(0, entries.length - max + 1));
  const last = out.at(-1);
  if (last && last.kind === entry.kind && !last.text.endsWith('\n') && (entry.kind === 'stdout' || entry.kind === 'stderr' || entry.kind === 'console')) out[out.length - 1] = { ...last, text: last.text + entry.text };
  else out.push(entry);
  return out;
}

// ---- The variables tree: scopes, then each open variable's children (loaded when opened) ----

/**
 * The rows to draw: `scopes` ([{ name, variablesReference, expensive }]), `children` (Map:
 * reference → the adapter's variables, null while they load), `open` (Set of row paths).
 * Rows are keyed by their path (scope / name / name…), so what was open stays open at the
 * next stop. → [{ path, depth, name, value, type, ref, open, loading, scope }]
 */
export function variableRows(scopes, children, open, { max = 2000 } = {}) {
  const rows = [];
  const walk = (vars, depth, parent) => {
    for (const v of vars ?? []) {
      if (rows.length >= max) return;
      const path = `${parent}/${v.name}`;
      const ref = v.variablesReference || 0;
      const isOpen = ref > 0 && open.has(path);
      const kids = isOpen ? children.get(ref) : undefined;
      rows.push({ path, depth, name: v.name, value: v.value ?? '', type: v.type ?? '', ref, open: isOpen, loading: isOpen && !kids });
      if (kids) walk(kids, depth + 1, path);
    }
  };
  for (const s of scopes ?? []) {
    if (rows.length >= max) break;
    const path = s.name;
    const ref = s.variablesReference || 0;
    const isOpen = ref > 0 && open.has(path);
    const kids = isOpen ? children.get(ref) : undefined;
    rows.push({ path, depth: 0, name: s.name, value: '', type: '', ref, open: isOpen, loading: isOpen && !kids, scope: true });
    if (kids) walk(kids, 1, path);
  }
  return rows;
}
/** The references the open rows need and that are not loaded (nor loading) yet. */
export const refsToLoad = (rows, children) => rows.filter((r) => r.open && r.ref > 0 && !children.has(r.ref)).map((r) => r.ref);
/** The scopes open at first: the first that is not expensive (the locals). */
export const firstOpen = (scopes) => {
  const s = (scopes ?? []).find((x) => !x.expensive && x.variablesReference > 0);
  return s ? [s.name] : [];
};

/** Watch expressions as kept: trimmed, one each, at most 50. */
export function cleanWatches(list) {
  const out = [];
  for (const w of Array.isArray(list) ? list : []) {
    const e = typeof w === 'string' ? w.trim().slice(0, 500) : '';
    if (e && !out.includes(e)) out.push(e);
  }
  return out.slice(0, 50);
}
