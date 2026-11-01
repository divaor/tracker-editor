// Running tests (desktop; pure: the page and the tests use it). Which framework a test file
// uses (from the file and the project files above it: tests:project), the tests it declares
// (with the lines they span, for the test at the cursor and the marks next to the line
// numbers), the command that runs one test or the file's (typed into a terminal, its names
// quoted for the shell), and what came of it: from a report the framework writes to a file
// (JUnit XML, Jest's JSON, TAP, .NET's TRX) or, without one, from what it printed. Failures
// are placed on their lines: the report's, else the first place in the test file the stack
// names.
import { findFileRefs, resolveRef } from './fileRefs.js';
import { attr, findAll, kid, parseXml, textOf } from './xmlLite.js';

export const FRAMEWORKS = {
  vitest: { label: 'Vitest', language: 'js' },
  jest: { label: 'Jest', language: 'js' },
  mocha: { label: 'Mocha', language: 'js' },
  node: { label: 'node:test', language: 'js' },
  pytest: { label: 'pytest', language: 'py' },
  unittest: { label: 'unittest', language: 'py' },
  go: { label: 'go test', language: 'go' },
  cargo: { label: 'cargo test', language: 'rust' },
  phpunit: { label: 'PHPUnit', language: 'php' },
  pest: { label: 'Pest', language: 'php' },
  dotnet: { label: 'dotnet test', language: 'cs' },
};

const EXT_LANGUAGE = { js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', py: 'py', go: 'go', rs: 'rust', php: 'php', cs: 'cs' };
const baseName = (p) => String(p).split(/[\\/]/).pop();
/** A file's language for tests ('js', 'py', 'go', 'rust', 'php', 'cs'), or null. */
export const testLanguage = (name) => EXT_LANGUAGE[(/\.([^.\\/]+)$/.exec(String(name))?.[1] ?? '').toLowerCase()] ?? null;

/** Does this file hold tests? By its name (x.test.js, test_x.py, x_test.go, XTest.php…), else by what it imports or marks. */
export function looksLikeTestFile(name, text = '') {
  const base = baseName(name);
  const lang = testLanguage(base);
  if (!lang) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base) || /^test_.*\.py$|_test\.py$/.test(base) || /_test\.go$/.test(base) || /Tests?\.(php|cs)$/.test(base)) return true;
  const t = String(text).slice(0, 200_000);
  if (lang === 'js') return /from\s+['"](node:test|vitest|@jest\/globals)['"]|require\(\s*['"](node:test|vitest)['"]\s*\)/.test(t) || /^\s*(describe|it|test)\s*\(\s*['"`]/m.test(t);
  if (lang === 'py') return /^\s*import\s+(pytest|unittest)|^\s*from\s+(pytest|unittest)\s+import|^\s*(async\s+)?def\s+test_\w*\s*\(/m.test(t);
  if (lang === 'rust') return /#\[(tokio::)?test\]/.test(t);
  if (lang === 'php') return /extends\s+\\?(PHPUnit\\Framework\\)?TestCase\b|^\s*(it|test)\s*\(\s*['"]/m.test(t);
  if (lang === 'cs') return /\[(Fact|Theory|Test|TestCase|TestMethod|DataTestMethod)\b/.test(t);
  return false;
}

const has = (names, re) => names.some((n) => (typeof re === 'string' ? n === re : re.test(n)));
const depsOf = (pkgText) => {
  try {
    const pkg = JSON.parse(pkgText);
    return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), test: pkg.scripts?.test ?? '' };
  } catch {
    return {};
  }
};

/**
 * The framework a test file runs with, and where: `dirs` (tests:project) are the file's
 * folder and those above it, nearest first, each { dir, names (what is there), texts
 * (package.json, composer.json, pyproject.toml…) }. → { framework, root, runner } or null.
 * `runner` is what goes before the framework's own program ([] or ['npx'], ['uv', 'run']…).
 */
export function detectFramework({ name, text = '', dirs = [] }) {
  const lang = testLanguage(name);
  if (!lang) return null;
  const nearest = (pred) => dirs.find(pred) ?? null;
  const t = String(text).slice(0, 200_000);
  if (lang === 'js') {
    const pkgDir = nearest((d) => d.names.includes('package.json'));
    const root = pkgDir?.dir ?? dirs[0]?.dir ?? '';
    // The lock file: next to package.json, or in a workspace's top folder above it.
    const from = Math.max(0, dirs.indexOf(pkgDir));
    const locks = dirs.slice(from).find((d) => has(d.names, /^(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json)$/))?.names ?? [];
    const names = pkgDir?.names ?? [];
    const runner = has(locks, 'pnpm-lock.yaml') ? ['pnpm', 'exec'] : has(locks, 'yarn.lock') ? ['yarn'] : has(locks, /^bun\.lockb?$/) ? ['bunx'] : ['npx'];
    let framework = null;
    if (/from\s+['"]node:test['"]|require\(\s*['"]node:test['"]\s*\)/.test(t)) framework = 'node';
    else if (/from\s+['"]vitest['"]/.test(t)) framework = 'vitest';
    else if (/from\s+['"]@jest\/globals['"]/.test(t)) framework = 'jest';
    else {
      const deps = depsOf(pkgDir?.texts?.['package.json'] ?? '');
      if (deps.vitest || has(names, /^vitest\.(config|workspace)\.[cm]?[jt]s$/) || /\bvitest\b/.test(deps.test)) framework = 'vitest';
      else if (deps.jest || deps['ts-jest'] || has(names, /^jest\.config\.[cm]?[jt]s(on)?$/) || /\bjest\b/.test(deps.test)) framework = 'jest';
      else if (deps.mocha || has(names, /^\.mocharc(\.(c?js|json|jsonc|ya?ml))?$/) || /\bmocha\b/.test(deps.test)) framework = 'mocha';
      else if (/node\s+--test\b/.test(deps.test)) framework = 'node';
    }
    if (!framework) framework = 'node';
    return { framework, root, runner: framework === 'node' ? [] : runner };
  }
  if (lang === 'py') {
    const proj = nearest((d) => has(d.names, /^(pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini|setup\.py)$/));
    const root = proj?.dir ?? dirs[0]?.dir ?? '';
    const lockDir = nearest((d) => has(d.names, /^(uv|poetry|pdm)\.lock$/));
    const names = lockDir?.names ?? [];
    const runner = has(names, 'uv.lock') ? ['uv', 'run'] : has(names, 'poetry.lock') ? ['poetry', 'run'] : has(names, 'pdm.lock') ? ['pdm', 'run'] : [];
    const pyproject = proj?.texts?.['pyproject.toml'] ?? '';
    const pytestHere = /^\s*import\s+pytest|^\s*from\s+pytest\s+import/m.test(t) || has(proj?.names ?? [], /^(pytest\.ini|conftest\.py)$/) || dirs.some((d) => d.names.includes('conftest.py')) || /\[tool\.pytest|\bpytest\b/.test(pyproject);
    const unittestOnly = /^\s*import\s+unittest|^\s*from\s+unittest\s+import/m.test(t) && /\(\s*(unittest\.)?TestCase\s*\)/.test(t) && !pytestHere;
    return { framework: unittestOnly ? 'unittest' : 'pytest', root, runner };
  }
  if (lang === 'go') return { framework: 'go', root: dirs[0]?.dir ?? '', runner: [] };
  if (lang === 'rust') return { framework: 'cargo', root: nearest((d) => d.names.includes('Cargo.toml'))?.dir ?? dirs[0]?.dir ?? '', runner: [] };
  if (lang === 'php') {
    const comp = nearest((d) => d.names.includes('composer.json'));
    const root = comp?.dir ?? dirs[0]?.dir ?? '';
    const composer = comp?.texts?.['composer.json'] ?? '';
    const pest = /pestphp\/pest/.test(composer) || (/^\s*(it|test|describe)\s*\(\s*['"]/m.test(t) && !/extends\s+\\?(PHPUnit\\Framework\\)?TestCase\b/.test(t));
    return { framework: pest ? 'pest' : 'phpunit', root, runner: [] };
  }
  if (lang === 'cs') {
    const proj = nearest((d) => has(d.names, /\.csproj$/));
    return { framework: 'dotnet', root: proj?.dir ?? dirs[0]?.dir ?? '', project: proj?.names.find((n) => /\.csproj$/.test(n)) ?? '', runner: [] };
  }
  return null;
}

// ---- The tests a file declares ----

// The end of a bracket that opens at text[at] ('(' or '{'), past strings and comments: its index, or -1.
function closing(text, at, { hash = false } = {}) {
  const open = text[at];
  const close = open === '(' ? ')' : open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i === -1) return -1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) return -1;
      i++;
      continue;
    }
    if (hash && c === '#') {
      i = text.indexOf('\n', i);
      if (i === -1) return -1;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
const lineAt = (starts, pos) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};
const unescape = (s) => s.replace(/\\(.)/g, '$1');

/** The text with what is inside strings and comments blanked (quotes kept, lengths the same): calls in them are not tests. */
function codeOnly(text) {
  const out = text.split('');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c && !(c !== '`' && text[i] === '\n'); i++) {
        if (text[i] === '\\') out[i++] = ' ';
        if (text[i] !== '\n') out[i] = ' ';
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      for (; i < text.length && text[i] !== '\n'; i++) out[i] = ' ';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== '\n') out[i] = ' ';
      i--;
    }
  }
  return out.join('');
}

/**
 * The tests and suites `text` declares for `framework`: [{ name, title, chain, line, end,
 * kind ('test' | 'suite'), cls }] (lines 1-based; `chain`: the suites around it, outermost first).
 */
export function testsInFile(text, framework) {
  const src = String(text ?? '');
  if (src.length > 2_000_000) return [];
  const lang = FRAMEWORKS[framework]?.language;
  const starts = lineStarts(src);
  const out = [];
  const withChains = () => {
    for (const t of out) t.chain = out.filter((s) => s.kind === 'suite' && s !== t && s.line <= t.line && s.end >= t.end && (s.line < t.line || s.end > t.end)).sort((a, b) => a.line - b.line).map((s) => s.title);
    for (const t of out) t.name = [...t.chain, t.title].join(' ');
    return out;
  };
  if (lang === 'js' || framework === 'pest') {
    // Found in the code only (strings and comments blanked), the titles read from the text.
    const code = codeOnly(src);
    const re = /(^|[^\w.$])(describe|context|suite|it|test|specify)((?:\.(?:only|skip|todo|concurrent|sequential|fails|skipIf\([^)]*\)|runIf\([^)]*\)|each\s*(?:`[^`]*`|\([^)]*\))))*)\s*\(\s*(['"`])/gm;
    for (const m of code.matchAll(re)) {
      const at = m.index + m[1].length;
      const open = m.index + m[0].length - 1;
      const close = code.indexOf(m[4], open + 1);
      if (close === -1 || src.slice(open + 1, close).includes('\n') && m[4] !== '`') continue;
      const paren = code.indexOf('(', at + m[2].length + m[3].length);
      const end = paren === -1 ? -1 : closing(src, paren);
      const kind = /^(describe|context|suite)$/.test(m[2]) ? 'suite' : 'test';
      const raw = unescape(src.slice(open + 1, close));
      // Pest names `it('adds')` as "it adds".
      const title = framework === 'pest' && m[2] === 'it' ? `it ${raw}` : raw;
      out.push({ title, kind, line: lineAt(starts, at), end: end === -1 ? lineAt(starts, at) : lineAt(starts, end), skip: /\.(skip|todo)/.test(m[3]) });
    }
    return withChains();
  }
  if (lang === 'py') {
    const lines = src.split('\n');
    const indentOf = (l) => /^[ \t]*/.exec(l)[0].replace(/\t/g, '    ').length;
    const endOf = (i, indent) => {
      let last = i;
      for (let k = i + 1; k < lines.length; k++) {
        if (!lines[k].trim() || /^\s*#/.test(lines[k])) continue;
        if (indentOf(lines[k]) <= indent) break;
        last = k;
      }
      return last + 1;
    };
    lines.forEach((l, i) => {
      let m = /^(\s*)class\s+(\w+)\s*(\(([^)]*)\))?\s*:/.exec(l);
      if (m && (/^Test/.test(m[2]) || /TestCase/.test(m[4] ?? ''))) out.push({ title: m[2], kind: 'suite', line: i + 1, end: endOf(i, indentOf(l)), cls: m[2] });
      m = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(l);
      if (m) out.push({ title: m[2], kind: 'test', line: i + 1, end: endOf(i, indentOf(l)) });
    });
    for (const t of out) if (t.kind === 'test') t.cls = out.find((s) => s.kind === 'suite' && s.line < t.line && s.end >= t.end)?.title ?? '';
    return withChains();
  }
  if (lang === 'go') {
    for (const m of src.matchAll(/^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)\s*\{/gm)) {
      const brace = m.index + m[0].length - 1;
      const end = closing(src, brace);
      out.push({ title: m[1], kind: 'test', line: lineAt(starts, m.index), end: lineAt(starts, end === -1 ? brace : end) });
    }
    return withChains();
  }
  if (lang === 'rust') {
    for (const m of src.matchAll(/#\[(?:tokio::)?test(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g)) {
      const fnAt = m.index + m[0].lastIndexOf('fn');
      const brace = src.indexOf('{', fnAt);
      const end = brace === -1 ? -1 : closing(src, brace);
      out.push({ title: m[1], kind: 'test', line: lineAt(starts, fnAt), end: lineAt(starts, end === -1 ? fnAt : end) });
    }
    return withChains();
  }
  if (lang === 'php') {
    for (const m of src.matchAll(/^\s*(?:final\s+|abstract\s+)*class\s+(\w+)[^{]*\{/gm)) {
      const brace = m.index + m[0].length - 1;
      const end = closing(src, brace, { hash: true });
      out.push({ title: m[1], kind: 'suite', line: lineAt(starts, m.index + m[0].indexOf('class')), end: lineAt(starts, end === -1 ? brace : end), cls: m[1] });
    }
    for (const m of src.matchAll(/^(\s*)(?:(?:public|protected|private|static|final)\s+)*function\s+(\w+)\s*\(/gm)) {
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      const marked = /(@test\b|#\[\s*(\\?PHPUnit\\Framework\\Attributes\\)?Test\s*\])[^{};]*$/.test(before);
      if (!/^test/.test(m[2]) && !marked) continue;
      const brace = src.indexOf('{', m.index + m[0].length);
      const end = brace === -1 ? -1 : closing(src, brace, { hash: true });
      const line = lineAt(starts, m.index + m[1].length);
      out.push({ title: m[2], kind: 'test', line, end: lineAt(starts, end === -1 ? m.index : end) });
    }
    for (const t of out) if (t.kind === 'test') t.cls = out.find((s) => s.kind === 'suite' && s.line < t.line && s.end >= t.end)?.title ?? '';
    return withChains();
  }
  if (lang === 'cs') {
    const ns = /^\s*namespace\s+([\w.]+)/m.exec(src)?.[1] ?? '';
    for (const m of src.matchAll(/^\s*(?:(?:public|internal|sealed|static|abstract|partial)\s+)*class\s+(\w+)[^{;]*\{/gm)) {
      const brace = m.index + m[0].length - 1;
      const end = closing(src, brace);
      out.push({ title: m[1], kind: 'suite', line: lineAt(starts, m.index + m[0].indexOf('class')), end: lineAt(starts, end === -1 ? brace : end), cls: m[1], ns });
    }
    for (const m of src.matchAll(/\[\s*(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod)\b[^\]]*\]\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|internal|protected|static|async|virtual|override)\s+)*[\w<>[\],.?\s]+?\s+(\w+)\s*\(/g)) {
      const nameAt = m.index + m[0].lastIndexOf(m[1]);
      const brace = src.indexOf('{', nameAt);
      const arrow = src.indexOf('=>', nameAt);
      const end = brace !== -1 && (arrow === -1 || brace < arrow) ? closing(src, brace) : src.indexOf(';', nameAt);
      out.push({ title: m[1], kind: 'test', line: lineAt(starts, nameAt), end: lineAt(starts, end === -1 ? nameAt : end), ns });
    }
    for (const t of out) if (t.kind === 'test') t.cls = out.filter((s) => s.kind === 'suite' && s.line < t.line && s.end >= t.end).at(-1)?.title ?? '';
    return withChains();
  }
  return [];
}

/** The test or suite at `line` (the innermost one that spans it), or null. */
export function testAt(tests, line) {
  let best = null;
  for (const t of tests) if (t.line <= line && t.end >= line && (!best || t.end - t.line < best.end - best.line)) best = t;
  return best;
}

// ---- The command ----

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const posixRel = (root, file) => {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const r = norm(root);
  const f = norm(file);
  const low = /^[A-Za-z]:/.test(f) ? (x) => x.toLowerCase() : (x) => x;
  return r && low(f).startsWith(`${low(r)}/`) ? f.slice(r.length + 1) : f;
};
const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '') || p;
/** The file's report format by framework (written to `report`): what parseReport reads. */
export const REPORTS = { vitest: 'junit', jest: 'jest', node: 'tap', pytest: 'junit', phpunit: 'junit', pest: 'junit', dotnet: 'trx' };
/** The report's file extension. */
export const reportExt = (framework) => ({ junit: '.xml', jest: '.json', tap: '.tap', trx: '.trx' })[REPORTS[framework]] ?? '';

/**
 * The command that runs `target` (a test or suite from testsInFile; null: the whole file)
 * of `file`: { program, args, cwd, report (its format, or null) }. `setup` is detectFramework's;
 * `report` the path the framework writes its report to (tests:prepare), or ''; `windows`: the
 * terminal runs Windows' programs (python, not python3).
 */
export function testCommand(setup, { file, target = null, report = '', windows = false, tests = [] }) {
  const { framework, root, runner = [] } = setup;
  const rel = posixRel(root, file);
  const withRunner = (program, args) => (runner.length ? { program: runner[0], args: [...runner.slice(1), program, ...args] } : { program, args });
  const title = target?.title ?? '';
  // A name pattern for the test (whole name) or suite (its start): suites and test joined by a
  // space (Jest, Mocha, Vitest before 5) or " > " (Vitest 5).
  const parts = target ? [...(target.chain ?? []), title].map(reEscape) : [];
  const pattern = (join) => (target ? `^${parts.join(join)}${target.kind === 'suite' ? '' : '$'}` : '');
  const rep = report && REPORTS[framework] ? REPORTS[framework] : null;
  let cmd;
  let cwd = root || dirOf(file);
  switch (framework) {
    case 'vitest':
      cmd = withRunner('vitest', ['run', rel, ...(target ? ['-t', pattern('( > | )')] : []), ...(rep ? ['--reporter=default', '--reporter=junit', `--outputFile.junit=${report}`] : [])]);
      break;
    case 'jest':
      cmd = withRunner('jest', [rel, ...(target ? ['-t', pattern(' ')] : []), ...(rep ? ['--json', `--outputFile=${report}`, '--testLocationInResults'] : [])]);
      break;
    case 'mocha':
      cmd = withRunner('mocha', [rel, ...(target ? ['--grep', pattern(' ')] : [])]);
      break;
    case 'node':
      cmd = { program: 'node', args: ['--test', ...(target ? [`--test-name-pattern=${reEscape(title)}`] : []), ...(rep ? ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${report}`] : []), rel] };
      break;
    case 'pytest': {
      const id = target ? [rel, ...(target.kind === 'test' && target.cls ? [target.cls] : []), title].join('::') : rel;
      cmd = withRunner('pytest', [id, ...(rep ? [`--junitxml=${report}`, '-o', 'junit_family=xunit1'] : [])]);
      break;
    }
    case 'unittest': {
      const mod = rel.replace(/\.py$/, '').replace(/\//g, '.');
      const id = target ? [mod, ...(target.kind === 'test' && target.cls ? [target.cls] : []), title].join('.') : mod;
      cmd = withRunner(windows ? 'python' : 'python3', ['-m', 'unittest', '-v', id]);
      break;
    }
    case 'go': {
      cwd = dirOf(file);
      const names = target ? (target.kind === 'test' ? [title] : []) : tests.filter((t) => t.kind === 'test').map((t) => t.title);
      cmd = { program: 'go', args: ['test', '-v', ...(names.length ? ['-run', `^(${names.join('|')})$`] : []), '.'] };
      break;
    }
    case 'cargo': {
      const integration = /^tests\/[^/]+\.rs$/.exec(rel) ? rel.slice(6, -3) : '';
      cmd = { program: 'cargo', args: ['test', ...(integration ? ['--test', integration] : []), ...(target ? [title] : [])] };
      break;
    }
    case 'phpunit':
    case 'pest': {
      const filter = !target ? [] : framework === 'pest' ? ['--filter', reEscape(title)] : target.kind === 'suite' ? ['--filter', title] : ['--filter', `::${title}\\b`];
      cmd = { program: 'php', args: [`vendor/bin/${framework}`, rel, ...filter, ...(rep ? ['--log-junit', report] : [])] };
      break;
    }
    case 'dotnet': {
      const classes = target ? [] : tests.filter((t) => t.kind === 'suite');
      const qualified = (cls, method = '') => [target?.ns ?? classes[0]?.ns ?? '', cls, method].filter(Boolean).join('.');
      const filter = target ? `FullyQualifiedName~${qualified(target.kind === 'test' ? target.cls : title, target.kind === 'test' ? title : '')}` : classes.map((c) => `FullyQualifiedName~${qualified(c.title)}`).join('|');
      cmd = { program: 'dotnet', args: ['test', ...(setup.project ? [setup.project] : []), ...(filter ? ['--filter', filter] : []), ...(rep ? ['--logger', `trx;LogFileName=${report}`] : [])] };
      break;
    }
    default:
      return null;
  }
  return { ...cmd, cwd, report: rep };
}

// ---- What came of it ----

const status = (s) => (/^(passed|pass|ok|success)$/i.test(s) ? 'passed' : /^(failed|fail|error|errored|broken)$/i.test(s) ? 'failed' : 'skipped');
const result = (tests) => {
  const count = (s) => tests.filter((t) => t.status === s).length;
  return { tests, passed: count('passed'), failed: count('failed'), skipped: count('skipped') };
};

/** JUnit XML (pytest, Vitest, PHPUnit, Pest): the test cases, with their failures. */
export function parseJunit(xml) {
  const root = parseXml(String(xml));
  const tests = findAll(root, 'testcase', [], true).map((tc) => {
    const failure = kid(tc, 'failure') ?? kid(tc, 'error');
    const skipped = kid(tc, 'skipped');
    const line = Number(attr(tc, 'line'));
    return {
      name: attr(tc, 'name') ?? '',
      cls: attr(tc, 'class') ?? attr(tc, 'classname') ?? '',
      file: attr(tc, 'file') ?? '',
      line: Number.isFinite(line) && attr(tc, 'line') !== null ? line : null,
      status: failure ? 'failed' : skipped ? 'skipped' : 'passed',
      message: failure ? [attr(failure, 'message'), textOf(failure).trim()].filter(Boolean).join('\n') : '',
    };
  });
  return result(tests);
}

/** Jest's --json report. */
export function parseJestJson(text) {
  const report = JSON.parse(String(text));
  const tests = [];
  for (const file of report.testResults ?? []) {
    for (const a of file.assertionResults ?? []) tests.push({ name: a.title, chain: a.ancestorTitles ?? [], file: file.name, testLine: a.location?.line ?? null, status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped', message: (a.failureMessages ?? []).join('\n') });
    // A file that could not run (a syntax error): one failure with its message.
    if (!(file.assertionResults ?? []).length && file.status === 'failed') tests.push({ name: baseName(file.name), file: file.name, status: 'failed', message: file.message ?? '' });
  }
  return result(tests);
}

/** TAP from node --test (nested subtests indented by 4; YAML blocks with location and error). */
export function parseTap(text) {
  const lines = String(text).split(/\r?\n/);
  const tests = [];
  const open = []; // suite names by depth
  for (let i = 0; i < lines.length; i++) {
    const sub = /^(\s*)# Subtest: (.*)$/.exec(lines[i]);
    if (sub) {
      open[sub[1].length / 4] = sub[2];
      open.length = sub[1].length / 4 + 1;
      continue;
    }
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/i.exec(lines[i]);
    if (!m) continue;
    const depth = m[1].length / 4;
    const yaml = [];
    if (/^\s*---$/.test(lines[i + 1] ?? '')) {
      for (i += 2; i < lines.length && !/^\s*\.\.\.$/.test(lines[i]); i++) yaml.push(lines[i]);
    }
    const field = (name) => {
      const at = yaml.findIndex((l) => new RegExp(`^\\s*${name}:`).test(l));
      if (at === -1) return '';
      const value = yaml[at].replace(new RegExp(`^\\s*${name}:\\s*`), '');
      if (/^\|-?$/.test(value)) {
        const indent = /^\s*/.exec(yaml[at])[0].length;
        const block = [];
        for (let k = at + 1; k < yaml.length && (!yaml[k].trim() || /^\s*/.exec(yaml[k])[0].length > indent); k++) block.push(yaml[k].trim());
        return block.join('\n').trim();
      }
      return value.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
    };
    if (field('type') === 'suite') continue;
    const loc = /^(.*):(\d+):(\d+)$/.exec(field('location'));
    tests.push({ name: m[3].replace(/\\#/g, '#'), chain: open.slice(0, depth), file: loc?.[1] ?? '', testLine: loc ? Number(loc[2]) : null, status: m[4] ? 'skipped' : m[2] === 'ok' ? 'passed' : 'failed', message: m[2] === 'ok' ? '' : [field('error'), field('stack')].filter(Boolean).join('\n') });
  }
  return result(tests);
}

/** .NET's TRX (dotnet test --logger trx). */
export function parseTrx(xml) {
  const root = parseXml(String(xml));
  const tests = findAll(root, 'UnitTestResult', [], true).map((r) => {
    const info = kid(kid(r, 'Output'), 'ErrorInfo');
    const full = attr(r, 'testName') ?? '';
    const bare = full.replace(/\(.*$/, '');
    return { name: bare.split('.').pop(), cls: bare.split('.').slice(-2, -1)[0] ?? '', file: '', line: null, status: status(attr(r, 'outcome') ?? ''), message: info ? [textOf(kid(info, 'Message')), textOf(kid(info, 'StackTrace'))].map((t) => t.trim()).filter(Boolean).join('\n') : '' };
  });
  return result(tests);
}

/** A report's text in its format ('junit', 'jest', 'tap', 'trx') → { tests, passed, failed, skipped }. */
export function parseReport(format, text) {
  if (format === 'junit') return parseJunit(text);
  if (format === 'jest') return parseJestJson(text);
  if (format === 'tap') return parseTap(text);
  if (format === 'trx') return parseTrx(text);
  throw new Error(`Unknown report: ${format}`);
}

/** What a framework printed (no report: mocha, unittest, go test, cargo test) → the same as parseReport. */
export function parseOutput(framework, text) {
  const lines = String(text).split(/\r?\n/);
  const tests = [];
  if (framework === 'go') {
    const notes = new Map();
    let current = '';
    for (const l of lines) {
      const run = /^=== (RUN|CONT|PAUSE)\s+(\S+)/.exec(l);
      if (run) {
        current = run[2];
        continue;
      }
      const end = /^\s*--- (PASS|FAIL|SKIP): (\S+) \(/.exec(l);
      if (end) {
        if (!end[2].includes('/')) tests.push({ name: end[2], status: status(end[1] === 'PASS' ? 'passed' : end[1] === 'FAIL' ? 'failed' : 'skip'), message: (notes.get(end[2]) ?? []).join('\n') });
        else if (end[1] === 'FAIL') notes.set(end[2].split('/')[0], [...(notes.get(end[2].split('/')[0]) ?? []), ...(notes.get(end[2]) ?? [])]);
        continue;
      }
      if (current && /^\s{4}\S/.test(l)) notes.set(current, [...(notes.get(current) ?? []), l.trim()]);
    }
  } else if (framework === 'cargo') {
    for (const l of lines) {
      const m = /^test (\S+) \.\.\. (ok|FAILED|ignored)/.exec(l);
      if (m) tests.push({ name: m[1].split('::').pop(), cls: m[1], status: m[2] === 'ok' ? 'passed' : m[2] === 'FAILED' ? 'failed' : 'skipped', message: '' });
    }
    for (let i = 0; i < lines.length; i++) {
      const head = /^---- (\S+) stdout ----$/.exec(lines[i]);
      if (!head) continue;
      const body = [];
      for (i++; i < lines.length && !/^---- \S+ stdout ----$|^failures:$|^stack backtrace:$/.test(lines[i]); i++) body.push(lines[i]);
      i--;
      const t = tests.find((x) => x.cls === head[1]);
      if (t) t.message = body.join('\n').trim();
    }
  } else if (framework === 'unittest') {
    for (const l of lines) {
      const m = /^(\w+) \(([\w.]+)\)(?:\s*\n?.*?)? \.\.\. (ok|FAIL|ERROR|skipped.*)$/.exec(l);
      if (m) tests.push({ name: m[1], cls: m[2].split('.').slice(-2, -1)[0] ?? '', status: m[3] === 'ok' ? 'passed' : /^(FAIL|ERROR)$/.test(m[3]) ? 'failed' : 'skipped', message: '' });
    }
    for (let i = 0; i < lines.length; i++) {
      const head = /^(FAIL|ERROR): (\w+) \(([\w.]+)\)/.exec(lines[i]);
      if (!head) continue;
      const body = [];
      for (i++; i < lines.length && !/^(=+|-{20,})$/.test(lines[i]); i++) body.push(lines[i]);
      // The dashes under the title come first: skip them.
      if (/^-{20,}$/.test(lines[i]) && !body.length) {
        for (i++; i < lines.length && !/^(=+|-{20,})$/.test(lines[i]); i++) body.push(lines[i]);
      }
      i--;
      const name = head[2];
      const t = tests.find((x) => x.name === name) ?? (tests.push({ name, cls: head[3].split('.').slice(-2, -1)[0] ?? '', status: 'failed', message: '' }), tests.at(-1));
      t.status = 'failed';
      t.message = body.join('\n').trim();
    }
  } else if (framework === 'mocha') {
    // Passed ones (✔ title) and pending ones (- title), the suite above them by indentation.
    const stack = [];
    for (const l of lines) {
      if (/^\s+\d+ (passing|failing|pending)/.test(l)) break;
      const m = /^(\s+)(?:(✔|✓|√)\s+(.*?)(?: \(\d+ms\))?|(\d+)\) (.*)|- (.*))$/.exec(l);
      const plain = !m && /^(\s+)(\S.*)$/.exec(l);
      if (plain) {
        const depth = plain[1].length;
        while (stack.length && stack.at(-1).depth >= depth) stack.pop();
        stack.push({ depth, title: plain[2] });
        continue;
      }
      if (!m) continue;
      const depth = m[1].length;
      while (stack.length && stack.at(-1).depth >= depth) stack.pop();
      const chain = stack.map((s) => s.title);
      if (m[3] !== undefined) tests.push({ name: m[3], chain, status: 'passed', message: '' });
      else if (m[5] !== undefined) tests.push({ name: m[5], chain, status: 'failed', message: '' });
      else tests.push({ name: m[6], chain, status: 'skipped', message: '' });
    }
    // The failures below: "  1) suite\n       test:\n     Error…", in the order they were numbered.
    const failing = tests.filter((t) => t.status === 'failed');
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s+\d+\) \S/.test(lines[i]) || !lines.slice(0, i).some((l) => /^\s+\d+ failing/.test(l))) continue;
      const body = [];
      for (i++; i < lines.length && !/^\s+\d+\) \S/.test(lines[i]); i++) body.push(lines[i]);
      i--;
      const titleEnd = body.findIndex((l) => /:\s*$/.test(l));
      const message = body.slice(titleEnd + 1).join('\n').trim();
      if (failing[n]) failing[n].message = message;
      n++;
    }
  }
  return result(tests);
}

// ---- Where failures are, and which declared test each result is ----

const samePath = (a, b) => {
  const norm = (p) => String(p).replace(/^file:\/\//, '').replace(/\\/g, '/').replace(/^\/([A-Za-z]:)/, '$1');
  const x = norm(a);
  const y = norm(b);
  return /^[A-Za-z]:/.test(x) ? x.toLowerCase() === y.toLowerCase() : x === y;
};

/**
 * Each failed result's place in the test file (`file`, absolute): { line, column } from the
 * report when it names this file, else the first place in its message the file is named
 * (stack traces, "x_test.go:12", "File \"x.py\", line 9"), else the test's own line.
 */
export function placeFailures(results, { file, root, tests = [] }) {
  const base = dirOf(file);
  for (const r of results.tests) {
    if (r.status !== 'failed') continue;
    const refs = findFileRefs(r.message ?? '');
    const inFile = refs.map((ref) => ({ ref, path: resolveRef(ref.path.replace(/^file:\/\//, ''), root || base) })).find(({ ref, path }) => samePath(path, file) || (!/[\\/]/.test(ref.path) && baseName(ref.path) === baseName(file) && samePath(resolveRef(ref.path, base), file)));
    if (inFile) {
      r.at = { line: inFile.ref.line, column: inFile.ref.column ?? 1 };
      continue;
    }
    const own = matchTest(tests, r);
    if (own) r.at = { line: own.line, column: 1 };
    else if (r.line && samePath(resolveRef(r.file, root || base), file)) r.at = { line: r.line, column: 1 };
  }
  return results;
}

const bareName = (name) => String(name).replace(/\[.*\]$/, '').replace(/ with data set .*$/, '').replace(/\(.*\)$/, '').trim();

/** The declared test (testsInFile) a result is: by its line when the report gives one, else by name and suites. */
export function matchTest(tests, r) {
  if (r.testLine) {
    const t = tests.find((x) => x.line === r.testLine && x.kind === 'test');
    if (t) return t;
  }
  const leaf = bareName(r.name).split(' > ').pop();
  const chain = r.chain?.length ? r.chain : String(r.name).includes(' > ') ? String(r.name).split(' > ').slice(0, -1) : null;
  const named = tests.filter((t) => t.kind === 'test' && t.title === leaf);
  if (named.length <= 1) return named[0] ?? null;
  return named.find((t) => (chain ? t.chain.join(' ') === chain.join(' ') : r.cls ? String(r.cls).split(/[.\\:]/).includes(t.cls) : false)) ?? named[0];
}

/**
 * Each declared test's state after a run: Map(line → 'passed' | 'failed' | 'skipped'); a suite
 * failed when one of its tests did, passed when all that ran did.
 */
export function testStates(tests, results) {
  const states = new Map();
  for (const r of results.tests) {
    const t = matchTest(tests, r);
    if (!t) continue;
    const before = states.get(t.line);
    // Parameterized tests: one failure fails it.
    if (before !== 'failed') states.set(t.line, r.status === 'skipped' && before === 'passed' ? 'passed' : r.status);
  }
  for (const s of tests.filter((t) => t.kind === 'suite')) {
    const inside = tests.filter((t) => t.kind === 'test' && t.line > s.line && t.end <= s.end).map((t) => states.get(t.line)).filter(Boolean);
    if (inside.length) states.set(s.line, inside.includes('failed') ? 'failed' : inside.includes('passed') ? 'passed' : 'skipped');
  }
  return states;
}

/** "2 failed, 10 passed, 1 skipped" (what ran). */
export function summaryText(results) {
  if (!results?.tests.length) return 'No tests ran';
  return [results.failed && `${results.failed} failed`, results.passed && `${results.passed} passed`, results.skipped && `${results.skipped} skipped`].filter(Boolean).join(', ');
}

/** The line of a failure's message worth showing: the assertion or exception, not the code, title or stack around it. */
export function firstMessageLine(message) {
  const lines = String(message ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  // Python and others: the exception's own line ("AssertionError: 2 != 1"), last in a traceback.
  const exception = [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Failure)\b(: |$)/.test(l) && !/^Error: expect\(/.test(l));
  const useful = lines.find((l) => !/^(at |File "|Traceback|self = |def |>|E\s|stack backtrace|thread '.*panicked at|[\w\\]+::\w+$|- Expected$|\+ Received$|[\w.]+\.(go|rs|php|py|cs|[cm]?[jt]sx?):\d+$)/.test(l));
  const pick = exception && !/^AssertionError$/.test(exception) ? exception : (useful ?? lines[0] ?? '');
  // go test's "x_test.go:13: message", Jest's "Error: expect(…)".
  return pick.replace(/^[\w.-]+\.(go|rs):\d+(:\d+)?: /, '').replace(/^Error: (?=expect\()/, '');
}
