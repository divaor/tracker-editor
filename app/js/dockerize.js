// Dockerize a project (desktop, folders on this computer). What kind of project a folder holds,
// worked out from its files (`scanProject` reads them through an `io` the dialog gives:
// ui/dockerize.js uses the folders bridge), and the files that build and run it with Docker:
// a Dockerfile (stages, slim images pinned to a version, an unprivileged user), a compose file
// (one service: its port, restarts, volumes and .env only when needed), .dockerignore and
// DOCKER.md (installing Docker on Windows, Mac and Linux; start, stop, logs, update), and on
// request a package for a server without internet (docker/offline: compose.yml with the image
// only, install.sh, install.ps1, README.txt). The commands that build and run are typed into a
// terminal by the dialog, never run here. Pure: the Node tests import it.

// ---- Kinds, versions, images ----

export const KINDS = {
  node: 'Node.js',
  python: 'Python',
  php: 'PHP',
  dotnet: '.NET',
  go: 'Go',
  java: 'Java',
  rust: 'Rust',
  static: 'Static website',
  unknown: 'Not known',
};

/** Versions offered per language: the preferred one when the project does not say (or allows it). */
export const VERSIONS = {
  node: { candidates: ['26', '24', '22', '20', '18'], preferred: '24', tilde: 'npm' },
  python: { candidates: ['3.14', '3.13', '3.12', '3.11', '3.10', '3.9'], preferred: '3.13', tilde: 'npm' },
  php: { candidates: ['8.5', '8.4', '8.3', '8.2', '8.1', '8.0', '7.4'], preferred: '8.4', tilde: 'compatible' },
  java: { candidates: ['25', '21', '17', '11', '8'], preferred: '21', tilde: 'npm' },
  go: { preferred: '1.24' },
  dotnet: { preferred: '8.0' },
  rust: { preferred: '1' },
};

const NGINX = 'nginxinc/nginx-unprivileged:stable-alpine';
const ALPINE = 'alpine:3.22';
const DEBIAN = 'debian:bookworm-slim';

// ---- Versions from constraints ("^20", ">=3.10,<3.13", "~8.1", "18 || 20") ----

const nums = (v) => String(v).split('.').map(Number);
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
const bump = (parts, at) => [...parts.slice(0, at), (parts[at] ?? 0) + 1];

/** The comparators of one alternative: [{ op, parts }] ("^3.10" becomes ">=3.10" and "<4"). */
function comparatorsOf(text, tilde) {
  const out = [];
  const hyphen = /^\s*v?(\d+(?:\.\d+)*)\s+-\s+v?(\d+(?:\.\d+)*)\s*$/.exec(text);
  if (hyphen) return [{ op: '>=', parts: nums(hyphen[1]) }, { op: '<=', parts: nums(hyphen[2]) }];
  const re = /(\^|~=|~|>=|<=|>|<|===|==|=|!=)?\s*v?(\d+(?:\.(?:\d+|[xX*]))*)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const op = m[1] ?? '=';
    const parts = [];
    for (const p of m[2].split('.')) {
      if (!/^\d+$/.test(p)) break;
      parts.push(Number(p));
    }
    if (!parts.length) continue;
    if (op === '^') {
      const at = parts[0] > 0 || parts.length === 1 ? 0 : 1;
      out.push({ op: '>=', parts }, { op: '<', parts: bump(parts, at) });
    } else if (op === '~=' || (op === '~' && tilde === 'compatible')) {
      out.push({ op: '>=', parts }, { op: '<', parts: bump(parts, Math.max(0, parts.length - 2)) });
    } else if (op === '~') {
      out.push({ op: '>=', parts }, { op: '<', parts: bump(parts, parts.length >= 2 ? 1 : 0) });
    } else out.push({ op: op.startsWith('=') ? '=' : op, parts });
  }
  return out;
}

// Whether some version of the candidate's line (24 → 24.x, 3.12 → 3.12.x) meets a comparator.
function lineMeets(candidate, { op, parts }) {
  const c = nums(candidate);
  const end = bump(c, c.length - 1);
  const coarse = parts.length <= c.length;
  switch (op) {
    case '>=':
      return cmp(parts, end) < 0;
    case '>':
      return coarse ? cmp(bump(parts, parts.length - 1), end) < 0 : cmp(parts, end) < 0;
    case '<':
      return cmp(c, parts) < 0;
    case '<=':
      return parts.length < c.length ? cmp(c, bump(parts, parts.length - 1)) < 0 : cmp(c, parts) <= 0;
    case '!=':
      return !(parts.length === c.length && cmp(c, parts) === 0);
    default:
      return parts.length >= c.length ? cmp(parts.slice(0, c.length), c) === 0 : cmp(c.slice(0, parts.length), parts) === 0;
  }
}

/** Whether a version line ("24", "3.12") meets a constraint. */
export function meets(candidate, constraint, { tilde = 'npm' } = {}) {
  const text = String(constraint ?? '').trim();
  if (!text || text === '*' || /^(latest|x)$/i.test(text)) return true;
  return text.split(/\|\|?/).some((alt) => {
    const list = comparatorsOf(alt, tilde);
    return list.length > 0 && list.every((c) => lineMeets(candidate, c));
  });
}

/**
 * The version for a constraint: the preferred one when it fits, else the newest candidate that
 * fits, else the constraint's first number (at the candidates' precision), else the preferred.
 */
export function pickVersion(constraint, { candidates = [], preferred, tilde = 'npm' }) {
  const text = String(constraint ?? '').trim();
  if (!text) return preferred;
  if (meets(preferred, text, { tilde })) return preferred;
  const fit = candidates.filter((c) => meets(c, text, { tilde })).sort((a, b) => cmp(nums(b), nums(a)))[0];
  if (fit) return fit;
  const first = /(\d+)(?:\.(\d+))?/.exec(text);
  if (!first) return preferred;
  return String(preferred).includes('.') ? `${first[1]}.${first[2] ?? '0'}` : first[1];
}

// ---- Small readers: TOML, requirements, solutions ----

// Text outside strings up to a # comment.
function uncomment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}
function balanced(text, open, close) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === open) depth++;
    else if (ch === close) depth--;
  }
  return depth <= 0;
}
const stringsIn = (text) => [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
const unquote = (v) => {
  const m = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(v.trim());
  return m ? (m[1] ?? m[2]) : v.trim();
};

/**
 * The tables of a TOML text that detection needs: { 'project': { name, dependencies: [...] },
 * 'tool.poetry.dependencies': { fastapi: '^0.110', flask: { version, inline } }, bin: [{ name }] }.
 * Strings, arrays of strings and inline tables (their text and `version`); never throws.
 */
export function readToml(text) {
  const tables = { '': {} };
  let current = tables[''];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = uncomment(lines[i]).trim();
    if (!line) continue;
    let m = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(line);
    if (m) {
      if (!Array.isArray(tables[m[1]])) tables[m[1]] = [];
      current = {};
      tables[m[1]].push(current);
      continue;
    }
    m = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (m) {
      current = tables[m[1]] && !Array.isArray(tables[m[1]]) ? tables[m[1]] : (tables[m[1]] = {});
      continue;
    }
    m = /^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].replace(/^["']|["']$/g, '');
    let value = m[2];
    if (value.startsWith('[')) {
      while (!balanced(value, '[', ']') && i + 1 < lines.length) value += ` ${uncomment(lines[++i])}`;
      current[key] = stringsIn(value);
    } else if (value.startsWith('{')) {
      while (!balanced(value, '{', '}') && i + 1 < lines.length) value += ` ${uncomment(lines[++i])}`;
      current[key] = { inline: value, version: /\bversion\s*=\s*["']([^"']*)["']/.exec(value)?.[1] ?? '' };
    } else if (/^("""|''')/.test(value)) {
      const fence = value.slice(0, 3);
      let body = value.slice(3);
      while (!body.includes(fence) && i + 1 < lines.length) body += `\n${lines[++i]}`;
      current[key] = body.slice(0, body.indexOf(fence));
    } else current[key] = unquote(value);
  }
  return tables;
}

/** Package names in a requirements file ("Flask[async]>=3" → { name: 'flask', extras: ['async'] }). */
export function requirementNames(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line || line.startsWith('-') || /^(git|hg|svn|bzr)\+|:\/\//.test(line)) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?/.exec(line);
    if (m) out.push({ name: m[1].toLowerCase().replace(/[_.]+/g, '-'), extras: (m[2] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) });
  }
  return out;
}

/** The projects a .sln or .slnx names: relative paths with "/". */
export function solutionProjects(text) {
  const t = String(text ?? '');
  const sln = [...t.matchAll(/^Project\("[^"]*"\)\s*=\s*"[^"]*",\s*"([^"]+\.(?:cs|fs|vb)proj)"/gm)].map((m) => m[1]);
  const slnx = [...t.matchAll(/<Project\s+Path="([^"]+\.(?:cs|fs|vb)proj)"/g)].map((m) => m[1]);
  return [...sln, ...slnx].map((p) => p.replace(/\\/g, '/')).filter(safeRel);
}

// A relative path of plain names (never .., never absolute): what may be read inside the folder.
const safeRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length < 512 && !/^[/\\]|^[A-Za-z]:/.test(rel) && rel.split('/').every((p) => p && p !== '.' && p !== '..');

const parseJson = (text) => {
  try {
    const v = JSON.parse(String(text ?? '').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};

// ---- Reading the project ----

/** The most a detection read takes of one file. */
export const MAX_READ = 512 * 1024;

/** Names at a folder's top that make it a project here (Folders' menus offer Dockerize then). */
const MARKERS = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'manage.py', 'composer.json', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml', 'index.html', 'index.php']);
const MARKER_PATTERN = /\.(csproj|fsproj|vbproj|sln|slnx)$/i;
/** Whether a folder's names say a project is there. */
export const looksLikeProject = (names = []) => names.some((n) => MARKERS.has(n) || MARKER_PATTERN.test(n));

// The files Dockerize writes (read when there, to show how they differ).
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const OWN_TOP = ['Dockerfile', ...COMPOSE_NAMES, '.dockerignore', 'DOCKER.md', 'nginx.conf'];
const OWN_DOCKER = ['Dockerfile', 'Dockerfile.dockerignore', ...COMPOSE_NAMES, 'DOCKER.md', 'nginx.conf'];
const OWN_OFFLINE = ['compose.yml', 'install.sh', 'install.ps1', 'README.txt', '.gitignore'];
const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'example.env'];
const TOP_FILES = new Set([
  'package.json', '.nvmrc', '.node-version', 'angular.json',
  'requirements.txt', 'pyproject.toml', 'Pipfile', '.python-version', 'runtime.txt', 'manage.py',
  'main.py', 'app.py', 'server.py', 'api.py', 'run.py', 'wsgi.py', 'asgi.py', 'application.py', 'streamlit_app.py',
  'server.js', 'app.js', 'index.js', 'main.js', 'server.mjs', 'index.mjs', 'app.mjs', 'server.ts', 'index.ts', 'main.ts', 'app.ts',
  'composer.json', 'go.mod', 'main.go', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml',
  ...ENV_EXAMPLES, ...OWN_TOP,
]);
const TOP_PATTERNS = [MARKER_PATTERN, /^(vite|next|astro|svelte|nuxt)\.config\.[cm]?[jt]s$/];
const SRC_FILES = ['index.js', 'index.ts', 'server.js', 'server.ts', 'main.js', 'main.ts', 'app.js', 'app.ts', 'index.mjs', 'server.mjs', 'main.rs', 'main.py', 'app.py'];
const APP_FILES = ['main.py', '__init__.py', 'app.py', 'server.py', 'api.py'];
const PY_PACKAGE_FILES = ['main.py', 'app.py', '__init__.py', 'wsgi.py', 'asgi.py'];
const RESOURCES = ['application.properties', 'application.yml', 'application.yaml'];

/** The entry at `rel` in what a scan listed ({ name, dir, size }), or null. */
export function scanEntry(scan, rel) {
  const at = rel.lastIndexOf('/');
  const parent = at < 0 ? '' : rel.slice(0, at);
  return (scan.entries[parent] ?? []).find((e) => e.name === rel.slice(at + 1)) ?? null;
}

// What to list and read next, from what is known so far (folders listed, texts read).
function nextLooks(scan) {
  const lists = [];
  const reads = [];
  const file = (rel) => {
    const e = scanEntry(scan, rel);
    if (e && !e.dir && e.size <= MAX_READ) reads.push(rel);
  };
  const dir = (rel) => scanEntry(scan, rel)?.dir && lists.push(rel);
  for (const e of scan.entries[''] ?? []) if (!e.dir && (TOP_FILES.has(e.name) || TOP_PATTERNS.some((re) => re.test(e.name)))) file(e.name);
  for (const d of ['src', 'app', 'cmd', 'public', 'docker', 'docker/offline', 'src/main', 'src/main/resources']) dir(d);
  for (const n of SRC_FILES) file(`src/${n}`);
  for (const n of APP_FILES) file(`app/${n}`);
  for (const n of RESOURCES) file(`src/main/resources/${n}`);
  for (const n of OWN_DOCKER) file(`docker/${n}`);
  for (const n of OWN_OFFLINE) file(`docker/offline/${n}`);
  for (const e of (scan.entries.cmd ?? []).filter((x) => x.dir).slice(0, 6)) {
    dir(`cmd/${e.name}`);
    file(`cmd/${e.name}/main.go`);
  }
  // Python packages under src/ (the src layout), and .NET projects one level inside it.
  for (const e of (scan.entries.src ?? []).filter((x) => x.dir && /^[A-Za-z_][\w.]*$/.test(x.name) && x.name !== 'main').slice(0, 6)) {
    dir(`src/${e.name}`);
    for (const n of PY_PACKAGE_FILES) file(`src/${e.name}/${n}`);
    for (const f of (scan.entries[`src/${e.name}`] ?? []).filter((x) => !x.dir && MARKER_PATTERN.test(x.name)).slice(0, 2)) file(`src/${e.name}/${f.name}`);
  }
  // Projects a solution names, and the file package.json starts (read when there).
  for (const [rel, text] of Object.entries(scan.texts)) if (/\.slnx?$/i.test(rel)) reads.push(...solutionProjects(text).slice(0, 4));
  const entry = nodeEntry(parseJson(scan.texts['package.json']));
  if (entry && safeRel(entry)) reads.push(entry);
  return { lists, reads };
}

/**
 * Reads what detection needs from a folder. `io`: { list(rel) → [{ name, dir, size }],
 * read(rel) → text } with paths relative to the folder ('' is the folder, "/" between names);
 * either may throw (not there, unreadable). → { entries: { rel: [...] }, texts: { rel: text } }.
 */
export async function scanProject(io, { maxReads = 48 } = {}) {
  const scan = { entries: {}, texts: {} };
  const listed = new Set();
  const asked = new Set();
  const list = async (rel) => {
    listed.add(rel);
    try {
      const got = await io.list(rel);
      scan.entries[rel] = (Array.isArray(got) ? got : []).slice(0, 3000).map((e) => ({ name: String(e.name), dir: Boolean(e.dir), size: Number(e.size) || 0 }));
    } catch {
      // not a folder there
    }
  };
  const read = async (rel) => {
    asked.add(rel);
    try {
      const text = await io.read(rel);
      if (typeof text === 'string') scan.texts[rel] = text;
    } catch {
      // not there, or not text
    }
  };
  await list('');
  for (let round = 0; round < 5; round++) {
    const { lists, reads } = nextLooks(scan);
    const toList = [...new Set(lists)].filter((r) => !listed.has(r));
    const toRead = [...new Set(reads)].filter((r) => !asked.has(r)).slice(0, Math.max(0, maxReads - asked.size));
    if (!toList.length && !toRead.length) break;
    await Promise.all([...toList.map(list), ...toRead.map(read)]);
  }
  return scan;
}

/** The folder above `p` (here: "/" or "C:\" at the top), or null at the top. */
export function parentFolder(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const at = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (at < 0) return null;
  const up = s.slice(0, at);
  if (!up) return s.length > 1 && s.startsWith('/') ? '/' : null;
  if (/^[A-Za-z]:$/.test(up)) return `${up}\\`;
  return up;
}

/**
 * The project a file's folder belongs to: from `start` up (at most `max` folders, while
 * `list(dir)` answers), the nearest folder with a project's own file (package.json, go.mod…),
 * else the nearest with an index.html or index.php, else `start`.
 */
export async function findProjectRoot(start, list, { max = 6 } = {}) {
  let dir = start;
  let weak = null;
  for (let i = 0; i < max && dir; i++) {
    let names;
    try {
      names = (await list(dir)).map((e) => e.name);
    } catch {
      break;
    }
    if (names.some((n) => MARKERS.has(n) && n !== 'index.html' && n !== 'index.php') || names.some((n) => MARKER_PATTERN.test(n))) return dir;
    if (!weak && (names.includes('index.html') || names.includes('index.php'))) weak = dir;
    if (names.includes('.git')) break;
    const up = parentFolder(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return weak ?? start;
}

// ---- Detection ----

// Ports of databases and caches: never taken for the app's.
const OTHER_PORTS = new Set([3306, 5432, 6379, 27017, 11211, 9200, 5672, 1433, 1521]);

/** A port a source text names for its server (listen(3000), PORT || 3000, ":8080"), or null. */
export function portIn(text) {
  const t = String(text ?? '');
  const patterns = [
    /\.listen\(\s*(\d{2,5})\b/g,
    /\bPORT\b['"]?\s*(?:\|\||\?\?|\bor\b|,|:-)\s*['"]?(\d{2,5})\b/g,
    // Number(process.env.PORT) || 3000, parseInt(process.env.PORT, 10) || 3000, int(os.getenv("PORT")) or 8000.
    /\bPORT\b['"]?(?:\s*,\s*\d+)?(?:\s*\))+\s*(?:\|\||\?\?|\bor\b)\s*['"]?(\d{2,5})\b/g,
    /\b(?:run|serve|listen)\([^)\n]*\bport\s*=\s*(\d{2,5})\b/g,
    /(?:ListenAndServe|Listen|Run|bind|Addr\s*:)\s*\(?\s*["'](?:0\.0\.0\.0|\[::\]|localhost|127\.0\.0\.1)?:(\d{2,5})["']/g,
    /\bbind\(\(\s*["'][^"']*["']\s*,\s*(\d{2,5})\s*\)/g,
    /\bport\s*[=:]\s*['"]?(\d{2,5})\b/gi,
  ];
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      const n = Number(m[1]);
      if (n >= 80 && n <= 65535 && !OTHER_PORTS.has(n)) return n;
    }
  }
  return null;
}

/** Whether a source text makes its server listen on this computer only (127.0.0.1, localhost). */
export function listensLocally(text) {
  const t = String(text ?? '');
  return (
    /\.listen\(\s*[^,)\n]+,\s*['"](?:localhost|127\.0\.0\.1)['"]/.test(t) ||
    /\bhost\s*=\s*['"](?:localhost|127\.0\.0\.1)['"]/.test(t) ||
    /(?:ListenAndServe|Run|bind|Addr\s*:)\s*\(?\s*["'](?:localhost|127\.0\.0\.1):\d{2,5}["']/.test(t) ||
    /\bbind\(\(\s*["'](?:localhost|127\.0\.0\.1)["']/.test(t)
  );
}

/**
 * A start command split into words ('quoted words' kept whole), or null when it needs a shell:
 * pipes, &&, $VARS, globs, a leading VAR=value.
 */
export function splitWords(command) {
  const s = String(command ?? '').trim();
  if (!s || /^\w+=/.test(s)) return null;
  const words = [];
  let word = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === "'" || ch === '"') {
      const end = s.indexOf(ch, i + 1);
      if (end < 0) return null;
      const part = s.slice(i + 1, end);
      if (ch === '"' && /[$`\\]/.test(part)) return null;
      word = (word ?? '') + part;
      i = end;
    } else if (/[|&;<>()$`\\*?[\]{}]/.test(ch) || (word === null && /[#~]/.test(ch))) return null;
    else word = (word ?? '') + ch;
  }
  if (word !== null) words.push(word);
  return words.length ? words : null;
}

/** The Dockerfile line that starts `command`: CMD ["node", "server.js"], or a shell line when it needs one. */
export function cmdLine(command, word = 'CMD') {
  const words = splitWords(command);
  return words ? `${word} [${words.map((w) => JSON.stringify(w)).join(', ')}]` : `${word} ${String(command).trim()}`;
}

// What the folders hold.
function context(scan) {
  const top = scan.entries[''] ?? [];
  const names = top.map((e) => e.name);
  const has = (name) => names.includes(name);
  const isDir = (name) => top.some((e) => e.name === name && e.dir);
  const text = (rel) => scan.texts[rel] ?? null;
  const envExample = ENV_EXAMPLES.find(has) ?? null;
  return { scan, top, names, has, isDir, text, envExample, json: (rel) => parseJson(text(rel)), listed: (rel) => (scan.entries[rel] ?? []).map((e) => e.name) };
}

// ---- Node.js ----

const NODE_SERVERS = ['express', 'fastify', 'koa', '@hapi/hapi', 'hapi', 'restify', 'hono', '@hono/node-server', 'socket.io', '@adonisjs/core', 'sails', '@feathersjs/feathers', 'polka', '@loopback/core', '@strapi/strapi', 'json-server', 'connect', 'micro', 'elysia'];
const FRONT_ENDS = [
  { dep: '@angular/core', what: 'Angular', out: 'dist', spa: true },
  { dep: 'react-scripts', what: 'Create React App', out: 'build', spa: true },
  { dep: '@vue/cli-service', what: 'Vue CLI', out: 'dist', spa: true },
  { dep: 'gatsby', what: 'Gatsby', out: 'public', spa: false },
  { dep: '@docusaurus/core', what: 'Docusaurus', out: 'build', spa: false },
  { dep: 'vitepress', what: 'VitePress', out: 'docs/.vitepress/dist', spa: false },
  { dep: '@11ty/eleventy', what: 'Eleventy', out: '_site', spa: false },
  { dep: 'astro', what: 'Astro', out: 'dist', spa: false },
  { dep: 'ember-cli', what: 'Ember', out: 'dist', spa: true },
  { dep: 'vite', what: 'Vite', out: 'dist', spa: true },
  { dep: 'parcel', what: 'Parcel', out: 'dist', spa: true },
  { dep: 'webpack', what: 'webpack', out: 'dist', spa: true },
];
const LTS_NAMES = { argon: '4', boron: '6', carbon: '8', dubnium: '10', erbium: '12', fermium: '14', gallium: '16', hydrogen: '18', iron: '20', jod: '22', krypton: '24' };

// The file a package.json starts: the first script file after node (nodemon, tsx…) in its start
// script, else `main`.
function nodeEntry(pkg) {
  if (!pkg) return null;
  const words = String(pkg.scripts?.['start:prod'] ?? pkg.scripts?.start ?? '').split(/\s+/);
  const at = words.findIndex((w) => /^(node|nodemon|tsx|ts-node|bun)$/.test(w));
  let file = null;
  for (let i = at + 1; at >= 0 && i < words.length && !/^(&&|\|\||;|\|)$/.test(words[i]); i++) {
    if (/^(-r|--require|--import|--loader|--env-file)$/.test(words[i - 1])) continue;
    if (/^[\w./@-]+\.[cm]?[jt]s$/.test(words[i])) {
      file = words[i];
      break;
    }
  }
  file ??= typeof pkg.main === 'string' ? pkg.main : null;
  return file ? file.replace(/^\.\//, '') : null;
}

function nodeVersion(ctx, pkg) {
  const v = VERSIONS.node;
  const pin = String(ctx.text('.nvmrc') ?? ctx.text('.node-version') ?? '').trim().replace(/^v/, '');
  if (pin) {
    const lts = /^lts\/(\w+|\*)$/i.exec(pin);
    if (lts) return { version: LTS_NAMES[lts[1].toLowerCase()] ?? v.preferred, from: ctx.has('.nvmrc') ? '.nvmrc' : '.node-version' };
    if (/^\d+/.test(pin)) return { version: pin.split('.')[0], from: ctx.has('.nvmrc') ? '.nvmrc' : '.node-version' };
  }
  if (pkg?.volta?.node) return { version: String(pkg.volta.node).split('.')[0], from: 'package.json volta' };
  if (pkg?.engines?.node) return { version: pickVersion(pkg.engines.node, v), from: `package.json engines ${pkg.engines.node}` };
  return { version: v.preferred, from: 'the current long-term version' };
}

function nodeTool(ctx, pkg) {
  const pm = String(pkg?.packageManager ?? '');
  if (ctx.has('bun.lockb') || ctx.has('bun.lock') || pm.startsWith('bun@')) return { pm: 'bun', lock: ctx.has('bun.lock') ? 'bun.lock' : ctx.has('bun.lockb') ? 'bun.lockb' : null };
  if (ctx.has('pnpm-lock.yaml') || pm.startsWith('pnpm@')) return { pm: 'pnpm', lock: ctx.has('pnpm-lock.yaml') ? 'pnpm-lock.yaml' : null };
  if (ctx.has('yarn.lock') || pm.startsWith('yarn@')) {
    const berry = ctx.has('.yarnrc.yml') || /^yarn@[2-9]/.test(pm);
    return { pm: 'yarn', lock: ctx.has('yarn.lock') ? 'yarn.lock' : null, berry, yarnrc: ctx.has('.yarnrc.yml'), yarnDir: berry && ctx.isDir('.yarn') };
  }
  return { pm: 'npm', lock: ctx.has('package-lock.json') ? 'package-lock.json' : ctx.has('npm-shrinkwrap.json') ? 'npm-shrinkwrap.json' : null };
}

// The command that runs a script with the project's tool.
const runScript = (pm, script) => (pm === 'npm' ? `npm run ${script}` : pm === 'bun' ? `bun run ${script}` : `corepack ${pm} run ${script}`);
// Bun's image has no npm or node: its own words for the same.
const forBun = (cmd) => cmd.replace(/^npm start$/, 'bun run start').replace(/^npm run /, 'bun run ').replace(/^npx /, 'bunx ').replace(/^node /, 'bun ');
// Start scripts that are a development server, or a server of plain files: not the app itself.
const DEV_SERVERS = /^\s*(vite|react-scripts\s+start|ng\s+serve|vue-cli-service\s+serve|parcel|webpack\s+serve|webpack-dev-server|astro\s+(dev|preview)|gatsby\s+(develop|serve)|docusaurus\s+(start|serve)|eleventy\s+--serve|ember\s+serve|live-server|http-server|lite-server|browser-sync|five-server|serve)\b/;

function detectNode(ctx, { serverOnly, namedOnly = false }) {
  const pkg = ctx.json('package.json');
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const runtime = pkg.dependencies ?? {};
  const has = (d) => d in deps;
  const scripts = pkg.scripts ?? {};
  const tool = nodeTool(ctx, pkg);
  const { version, from } = nodeVersion(ctx, pkg);
  const found = [`package.json${pkg.name ? ` (${pkg.name})` : ''}`, tool.lock ? `${tool.lock}: ${tool.pm}` : `${tool.pm}, no lock file`];
  const notes = [];
  if (!tool.lock) notes.push(`No lock file: the build installs the newest versions package.json allows. Commit ${tool.pm === 'npm' ? 'package-lock.json' : 'the lock file'} for the same versions every time.`);
  if (ctx.has('pnpm-workspace.yaml') || Array.isArray(pkg.workspaces) || pkg.workspaces?.packages) notes.push('A workspace with several packages: the image builds them all. To run one package only, change the build and start commands.');
  const base = { kind: 'node', version, versionFrom: from, tool: tool.pm, found, notes, node: { ...tool, build: null, dev: false, front: null, excludes: [], env: {} } };
  const build = scripts.build ? 'build' : null;
  const cfg = (prefix) => {
    const name = ctx.names.find((n) => new RegExp(`^${prefix}\\.config\\.[cm]?[jt]s$`).test(n));
    return name ? (ctx.text(name) ?? '') : '';
  };
  const server = (what, start, port, extra = {}) => ({
    ...base,
    what,
    start: tool.pm === 'bun' ? forBun(start) : start,
    port,
    portFrom: extra.portFrom ?? `the usual port for ${what}`,
    web: port !== null,
    node: { ...base.node, build, ...extra.node },
  });

  // Frameworks with their own server.
  if (has('next')) {
    if (/\boutput\s*:\s*['"]export['"]/.test(cfg('next'))) return front({ what: 'Next.js (static export)', out: 'out', spa: false });
    notes.push('Next.js: the image builds it (next build) and runs next start. For a smaller image, set output: "standalone" in next.config.');
    return server('Next.js', scripts.start ? 'npm start' : 'npx next start', 3000, { node: { excludes: ['.next'] } });
  }
  if (has('nuxt') || has('nuxt3')) return server('Nuxt', 'node .output/server/index.mjs', 3000, { node: { excludes: ['.nuxt', '.output'] } });
  if (has('@remix-run/serve') || has('@react-router/serve')) return server(has('@remix-run/serve') ? 'Remix' : 'React Router', 'npm start', 3000, { node: { excludes: ['build'] } });
  if (has('@sveltejs/kit')) {
    if (has('@sveltejs/adapter-static')) return front({ what: 'SvelteKit (static)', out: 'build', spa: true });
    if (!has('@sveltejs/adapter-node')) notes.push('SvelteKit runs in Docker with adapter-node: npm install -D @sveltejs/adapter-node, and use it in svelte.config.js.');
    notes.push('SvelteKit: set ORIGIN in .env to the address people open (http://localhost:3000): its forms need it.');
    return server('SvelteKit', 'node build', 3000, { node: { excludes: ['build', '.svelte-kit'] } });
  }
  if (has('@nestjs/core')) {
    const port = portIn(ctx.text('src/main.ts'));
    const prodStart = /^node\s+\S+$/.test(String(scripts['start:prod'] ?? '').trim()) ? scripts['start:prod'].trim() : 'node dist/main.js';
    return server('NestJS', prodStart, port ?? 3000, { portFrom: port ? 'src/main.ts' : undefined, node: { excludes: ['dist'] } });
  }
  if (has('astro') && has('@astrojs/node')) return server('Astro (Node.js)', 'node ./dist/server/entry.mjs', 4321, { node: { excludes: ['dist'], env: { HOST: '0.0.0.0' } } });

  // A server of its own (Express, Fastify…), or a start script that runs the app.
  const named = NODE_SERVERS.find((d) => d in runtime) ?? NODE_SERVERS.find(has);
  const entry = nodeEntry(pkg);
  const entryText = entry ? ctx.text(entry) : null;
  const front_ = FRONT_ENDS.find((f) => has(f.dep));
  const startScript = String(scripts['start:prod'] ?? scripts.start ?? '');
  const runsItself = Boolean(startScript) && !DEV_SERVERS.test(startScript) && !(front_ && build);
  if (named || (!namedOnly && (runsItself || (!front_ && entryText !== null)))) {
    const start = nodeStart(pkg, entry, notes, deps, runtime);
    const envPort = Number(/^\s*PORT\s*=\s*["']?(\d{2,5})/m.exec(ctx.envExample ? (ctx.text(ctx.envExample) ?? '') : '')?.[1]) || Number(start.env.PORT) || null;
    const codePort = portIn(entryText);
    const port = envPort ?? codePort ?? (named ? 3000 : null);
    const what = named ? `${NODE_SERVER_NAMES[named] ?? named} server` : port ? 'a Node.js server' : 'a Node.js app';
    const portFrom = envPort ? (start.env.PORT ? 'the start script' : ctx.envExample) : codePort ? entry : port ? 'the usual port for Node.js' : null;
    const env = Object.fromEntries(Object.entries(start.env).filter(([k]) => k !== 'NODE_ENV'));
    const p = { ...server(what, start.command, port, { portFrom, node: { dev: start.dev, excludes: build ? ['dist'] : [], env } }), entry };
    if (entryText && listensLocally(entryText)) notes.push(`${entry} listens on this computer only (localhost): in a container it must listen on all addresses (0.0.0.0), or the app cannot be reached.`);
    if (named && !envPort && !codePort) notes.push('No port found in the code: 3000 is the usual one. Change it if the app listens on another.');
    if (!port) notes.push('No port found: it runs as a program that serves nothing. If it does listen on a port, fill it in.');
    return p;
  }
  if (serverOnly) return null;

  // A front end built into files (Vite, React, Angular…) and served by nginx.
  if (front_ && build) {
    let out = front_.out;
    if (front_.dep === 'vite') out = /\boutDir\s*:\s*['"]([^'"]+)['"]/.exec(cfg('vite'))?.[1] ?? out;
    if (front_.dep === '@angular/core') out = angularOut(ctx.json('angular.json')) ?? 'dist';
    const press = /vitepress\s+build\s+([\w./-]+)/.exec(scripts.build ?? '')?.[1];
    if (front_.dep === 'vitepress' && press) out = `${press.replace(/\/$/, '')}/.vitepress/dist`;
    return front({ what: front_.what, out: out.replace(/^\.\//, '').replace(/\/+$/, ''), spa: front_.spa });
  }
  if (build && !ctx.has('index.html')) return front({ what: 'a front end (npm run build)', out: 'dist', spa: true, guessed: true });
  return null;

  function front({ what, out, spa, guessed = false }) {
    if (guessed) notes.push('The built files are taken from dist/: change the folder if the build writes them elsewhere.');
    if (!build) notes.push('package.json has no build script: add one that writes the site’s files.');
    const top = out.split('/')[0];
    return {
      ...base,
      what: `${what}, built and served by nginx`,
      serves: 'static',
      start: null,
      port: 8080,
      portFrom: 'nginx in the image',
      web: true,
      out,
      node: { ...base.node, build: build ?? 'build', front: { spa }, excludes: [['dist', 'build', 'out', '_site', '.output'].includes(top) ? top : out] },
    };
  }
}

const NODE_SERVER_NAMES = { express: 'Express', fastify: 'Fastify', koa: 'Koa', '@hapi/hapi': 'hapi', hapi: 'hapi', restify: 'Restify', hono: 'Hono', '@hono/node-server': 'Hono', 'socket.io': 'Socket.IO', '@adonisjs/core': 'AdonisJS', sails: 'Sails', '@feathersjs/feathers': 'Feathers', polka: 'Polka', '@loopback/core': 'LoopBack', '@strapi/strapi': 'Strapi', 'json-server': 'json-server', connect: 'Connect', micro: 'Micro', elysia: 'Elysia' };

// Angular's output folder (the application builder writes the pages to its browser/ folder).
function angularOut(ng) {
  const project = ng?.projects && Object.values(ng.projects)[0];
  const opts = project?.architect?.build?.options ?? project?.targets?.build?.options;
  const builder = String(project?.architect?.build?.builder ?? project?.targets?.build?.builder ?? '');
  const path = typeof opts?.outputPath === 'string' ? opts.outputPath : opts?.outputPath?.base;
  if (!path) return null;
  return /:application$/.test(builder) || /@angular\/build/.test(builder) ? `${path}/browser` : path;
}

// How the image starts a Node.js app: { command, dev (keeps the dev dependencies), env (set
// before the command in the script: PORT=4000 node server.js) }.
function nodeStart(pkg, entry, notes, deps, runtime) {
  const scripts = pkg.scripts ?? {};
  const name = scripts['start:prod'] ? 'start:prod' : scripts.start ? 'start' : null;
  const script = String(name ? scripts[name] : '').trim();
  const env = {};
  const words = script
    .replace(/^cross-env\s+/, '')
    .replace(/^(?:(\w+)=(\S*)\s+)+/, (assignments) => {
      for (const m of assignments.matchAll(/(\w+)=(\S*)/g)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      return '';
    })
    .trim();
  const first = words.split(/\s+/)[0];
  const plain = !/[|&;<>$`]/.test(words);
  if (first === 'node' && plain) return { command: words.replace(/\s--watch\b/g, ''), dev: false, env };
  if (first === 'nodemon' && plain) {
    notes.push('The start script uses nodemon, which is for development: the image runs node instead.');
    return { command: words.replace(/^nodemon\b/, 'node').replace(/\s--(?:watch|ext|ignore|delay|exec)\s+\S+/g, ''), dev: false, env };
  }
  if (name) {
    const dev = Boolean(first && first in deps && !(first in runtime)) || (/\b(tsx|ts-node)\b/.test(words) && !('tsx' in runtime || 'ts-node' in runtime));
    if (dev) notes.push(`The start script uses ${first}, a dev dependency, so the image keeps the dev dependencies.`);
    return { command: name === 'start' ? 'npm start' : `npm run ${name}`, dev, env: {} };
  }
  return { command: `node ${entry ?? 'index.js'}`, dev: false, env };
}

// ---- Python ----

const PY_FRAMEWORKS = [
  { dep: 'django', what: 'Django', port: 8000 },
  { dep: 'fastapi', what: 'FastAPI', port: 8000 },
  { dep: 'flask', what: 'Flask', port: 8000 },
  { dep: 'streamlit', what: 'Streamlit', port: 8501 },
  { dep: 'gradio', what: 'Gradio', port: 7860 },
  { dep: 'dash', what: 'Dash', port: 8050 },
  { dep: 'starlette', what: 'Starlette', port: 8000 },
  { dep: 'quart', what: 'Quart', port: 8000 },
  { dep: 'sanic', what: 'Sanic', port: 8000 },
  { dep: 'aiohttp', what: 'aiohttp', port: 8080 },
  { dep: 'tornado', what: 'Tornado', port: 8888 },
  { dep: 'bottle', what: 'Bottle', port: 8080 },
];
const PY_ENTRIES = ['main.py', 'app.py', 'server.py', 'api.py', 'run.py', 'wsgi.py', 'asgi.py', 'application.py', 'streamlit_app.py', 'app/main.py', 'app/__init__.py', 'app/app.py', 'app/server.py', 'app/api.py', 'src/main.py', 'src/app.py'];

function pythonVersion(ctx, toml) {
  const v = VERSIONS.python;
  const pin = String(ctx.text('.python-version') ?? '').trim().split(/\s+/)[0];
  if (/^\d+\.\d+/.test(pin)) return { version: pin.split('.').slice(0, 2).join('.'), from: '.python-version' };
  const runtime = /python-(\d+\.\d+)/.exec(ctx.text('runtime.txt') ?? '');
  if (runtime) return { version: runtime[1], from: 'runtime.txt' };
  const requires = toml.project?.['requires-python'] ?? (typeof toml['tool.poetry.dependencies']?.python === 'string' ? toml['tool.poetry.dependencies'].python : '');
  if (requires) return { version: pickVersion(requires, v), from: `pyproject.toml ${requires}` };
  const pipfile = readToml(ctx.text('Pipfile') ?? '').requires?.python_version;
  if (pipfile) return { version: String(pipfile).split('.').slice(0, 2).join('.'), from: 'Pipfile' };
  return { version: v.preferred, from: 'a current Python' };
}

const PY_MARKERS = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'manage.py'];

function detectPython(ctx) {
  const entries = PY_ENTRIES.filter((rel) => ctx.text(rel) !== null);
  if (!PY_MARKERS.some(ctx.has) && !entries.length) return null;
  const toml = readToml(ctx.text('pyproject.toml') ?? '');
  const pipfile = readToml(ctx.text('Pipfile') ?? '');
  const deps = [
    ...requirementNames(ctx.text('requirements.txt') ?? ''),
    ...(toml.project?.dependencies ?? []).map((d) => requirementNames(d)[0]).filter(Boolean),
    ...Object.keys(toml['tool.poetry.dependencies'] ?? {}).filter((k) => k !== 'python').map((k) => ({ name: k.toLowerCase().replace(/[_.]+/g, '-'), extras: [] })),
    ...Object.keys(pipfile.packages ?? {}).map((k) => ({ name: k.toLowerCase().replace(/[_.]+/g, '-'), extras: [] })),
  ];
  const dep = (name) => deps.find((d) => d.name === name);
  // The tool that installs: uv or Poetry by their lock files, pipenv, pip with requirements.txt,
  // else uv reading the dependencies from pyproject.toml.
  let tool = 'pip';
  if (ctx.has('uv.lock')) tool = 'uv';
  else if (ctx.has('poetry.lock') || toml['tool.poetry']) tool = 'poetry';
  else if (ctx.has('Pipfile')) tool = 'pipenv';
  else if (!ctx.has('requirements.txt') && toml.project) tool = 'uv-pyproject';
  const { version, from } = pythonVersion(ctx, toml);
  const found = [{ uv: 'uv.lock: uv', poetry: `${ctx.has('poetry.lock') ? 'poetry.lock' : 'pyproject.toml'}: Poetry`, pipenv: 'Pipfile: pipenv', 'uv-pyproject': 'pyproject.toml (installed with uv)' }[tool] ?? (ctx.has('requirements.txt') ? 'requirements.txt: pip' : 'Python files, no requirements.txt')];
  const notes = [];
  if (tool === 'pip' && !ctx.has('requirements.txt')) notes.push('No requirements.txt: the image installs nothing but Python. Add one (pip freeze > requirements.txt) if the app needs packages.');
  const fw = PY_FRAMEWORKS.find((f) => dep(f.dep)) ?? (ctx.has('manage.py') ? PY_FRAMEWORKS[0] : null);
  const files = [...entries, ...pyPackageFiles(ctx)];
  const textOf = (rel) => ctx.text(rel) ?? '';
  const findIn = (re) => files.find((rel) => re.test(textOf(rel)));
  // What a server imports: app/main.py → app.main:app; inside src/ (the src layout) from there.
  const target = (rel, name) => {
    const inSrc = rel.startsWith('src/');
    return { mod: `${(inSrc ? rel.slice(4) : rel).replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.')}:${name}`, inSrc };
  };
  const extra = [];
  let start;
  let port = fw?.port ?? null;
  let entry = null;
  const what = fw?.what ?? 'a Python app';
  switch (fw?.dep) {
    case 'django': {
      const pkg = /DJANGO_SETTINGS_MODULE['"]?\s*,\s*['"]([\w.]+?)\.settings/.exec(textOf('manage.py'))?.[1] ?? 'config';
      if (!dep('gunicorn')) extra.push('gunicorn');
      start = `gunicorn --bind 0.0.0.0:8000 ${pkg}.wsgi`;
      entry = 'manage.py';
      notes.push('Django: add the server’s address to ALLOWED_HOSTS and turn DEBUG off; its static files then need WhiteNoise (or collectstatic and a web server).');
      break;
    }
    case 'fastapi':
    case 'starlette': {
      entry = findIn(/^\w+\s*=\s*(?:FastAPI|Starlette)\(/m) ?? entries[0] ?? 'main.py';
      const t = target(entry, /^(\w+)\s*=\s*(?:FastAPI|Starlette)\(/m.exec(textOf(entry))?.[1] ?? 'app');
      if (!dep('uvicorn') && !dep('fastapi')?.extras.some((x) => x === 'standard' || x === 'all')) extra.push('uvicorn');
      start = `uvicorn ${t.mod} --host 0.0.0.0 --port 8000${t.inSrc ? ' --app-dir src' : ''}`;
      break;
    }
    case 'flask': {
      entry = findIn(/^\w+\s*=\s*Flask\(/m) ?? findIn(/^def\s+create_app\(/m) ?? entries[0] ?? 'app.py';
      const name = /^(\w+)\s*=\s*Flask\(/m.exec(textOf(entry))?.[1];
      const factory = !name && /^def\s+create_app\(/m.test(textOf(entry));
      const t = target(entry, factory ? 'create_app()' : (name ?? 'app'));
      if (!dep('gunicorn')) extra.push('gunicorn');
      start = `gunicorn --bind 0.0.0.0:8000${t.inSrc ? ' --chdir src' : ''} ${factory ? `'${t.mod}'` : t.mod}`;
      break;
    }
    case 'streamlit':
      entry = findIn(/^\s*(?:import|from)\s+streamlit\b/m) ?? entries[0] ?? 'app.py';
      start = `streamlit run ${entry} --server.address=0.0.0.0 --server.port=8501`;
      break;
    default: {
      entry = (fw && findIn(new RegExp(`^\\s*(?:import|from)\\s+${fw.dep}\\b`, 'm'))) ?? entries.find((e) => !/__init__|wsgi|asgi/.test(e)) ?? entries[0] ?? null;
      const script = tool === 'uv' ? Object.keys(toml.project?.scripts ?? {})[0] : null;
      start = entry ? `python ${entry}` : (script ?? 'python main.py');
      port = portIn(textOf(entry)) ?? fw?.port ?? null;
      if (!entry && !script) notes.push('No main file found: fill in the start command (python main.py, or the module the app runs).');
    }
  }
  if (entry && !['django', 'fastapi', 'starlette', 'flask', 'streamlit'].includes(fw?.dep) && listensLocally(textOf(entry))) notes.push(`${entry} listens on this computer only (127.0.0.1): in a container it must listen on all addresses (0.0.0.0), or the app cannot be reached.`);
  if (extra.length) notes.push(`${extra.join(' and ')} ${extra.length > 1 ? 'are' : 'is'} not in the project’s dependencies: the image adds ${extra.length > 1 ? 'them' : 'it'} (the server that runs ${what} for real).`);
  if (dep('psycopg2') || dep('mysqlclient')) notes.push(`${dep('psycopg2') ? 'psycopg2' : 'mysqlclient'} is built from source: add build tools to the build stage (RUN apt-get update && apt-get install -y build-essential${dep('mysqlclient') ? ' default-libmysqlclient-dev pkg-config' : ' libpq-dev'}), or use ${dep('psycopg2') ? 'psycopg2-binary' : 'PyMySQL'}.`);
  if (fw?.dep === 'gradio') notes.push('Gradio listens on all addresses through GRADIO_SERVER_NAME, set in the image.');
  if (fw?.dep === 'dash') notes.push('Dash: start it with app.run(host="0.0.0.0") so it can be reached in the container.');
  return {
    kind: 'python',
    what,
    version,
    versionFrom: from,
    tool: tool === 'uv-pyproject' ? 'uv' : tool,
    found: [...found, ...(fw ? [`${fw.what} in the dependencies`] : [])],
    notes,
    start,
    port,
    portFrom: port ? (fw && port === fw.port ? `the usual port for ${what}` : entry) : null,
    web: Boolean(port),
    entry,
    python: { tool, extra, lock: { uv: 'uv.lock', poetry: ctx.has('poetry.lock') ? 'poetry.lock' : null, pipenv: ctx.has('Pipfile.lock') ? 'Pipfile.lock' : null }[tool] ?? null, env: fw?.dep === 'gradio' ? { GRADIO_SERVER_NAME: '0.0.0.0' } : {} },
  };
}

// Python files inside packages under src/ (the src layout).
const pyPackageFiles = (ctx) => Object.keys(ctx.scan.texts).filter((rel) => /^src\/\w+\/\w+\.py$/.test(rel));

// ---- PHP ----

const PHP_BUILT_IN = new Set(['ctype', 'curl', 'date', 'dom', 'fileinfo', 'filter', 'hash', 'iconv', 'json', 'libxml', 'mbstring', 'mysqlnd', 'openssl', 'pcre', 'pdo', 'pdo_sqlite', 'phar', 'posix', 'random', 'readline', 'reflection', 'session', 'simplexml', 'sodium', 'spl', 'sqlite3', 'standard', 'tokenizer', 'xml', 'xmlreader', 'xmlwriter', 'zlib', 'core']);

function detectPhp(ctx) {
  const composer = ctx.json('composer.json');
  if (!composer && !ctx.has('index.php') && !ctx.listed('public').includes('index.php')) return null;
  const require = composer?.require ?? {};
  const v = VERSIONS.php;
  const platform = composer?.config?.platform?.php;
  const version = platform ? String(platform).split('.').slice(0, 2).join('.') : require.php ? pickVersion(require.php, v) : v.preferred;
  const laravel = ctx.has('artisan') && 'laravel/framework' in require;
  const symfony = 'symfony/framework-bundle' in require;
  const publicRoot = laravel || symfony || ctx.isDir('public') && (ctx.listed('public').includes('index.php') || !ctx.has('index.php'));
  const exts = Object.keys(require).filter((k) => k.startsWith('ext-')).map((k) => k.slice(4).toLowerCase()).filter((e) => !PHP_BUILT_IN.has(e));
  const notes = [];
  if (exts.length) notes.push(`PHP extensions from composer.json are added with install-php-extensions: ${exts.join(', ')}.`);
  if (laravel) notes.push('Laravel: .env needs APP_KEY (php artisan key:generate --show prints one). With MySQL or PostgreSQL, add pdo_mysql or pdo_pgsql to the install-php-extensions line.');
  if (ctx.has('wp-config-sample.php') || ctx.isDir('wp-includes')) notes.push('WordPress needs a database: the official wordpress image with a MySQL service is usually easier.');
  if (composer && !ctx.has('composer.lock')) notes.push('No composer.lock: the build installs the newest versions composer.json allows. Commit composer.lock for the same versions every time.');
  const pkg = ctx.json('package.json');
  const assets = Boolean(pkg?.scripts?.build);
  return {
    kind: 'php', what: laravel ? 'Laravel, with Apache' : symfony ? 'Symfony, with Apache' : composer ? 'PHP with Composer, served by Apache' : 'PHP, served by Apache',
    version, versionFrom: platform ? 'composer.json config.platform' : require.php ? `composer.json php ${require.php}` : 'a current PHP',
    tool: composer ? 'composer' : '', found: [composer ? 'composer.json' : 'index.php', ...(laravel ? ['artisan: Laravel'] : [])], notes,
    start: null, port: 8080, portFrom: 'Apache in the image', web: true,
    php: { composer: Boolean(composer), lock: ctx.has('composer.lock'), publicRoot, exts, laravel, assets, node: assets ? nodeTool(ctx, pkg) : null, nodeVersion: assets ? nodeVersion(ctx, pkg).version : null },
  };
}

// ---- .NET ----

function detectDotnet(ctx) {
  const projects = Object.keys(ctx.scan.texts).filter((rel) => /\.(cs|fs|vb)proj$/i.test(rel));
  if (!projects.length) return null;
  const info = projects.map((rel) => {
    const t = ctx.text(rel);
    const sdk = /<Project\s+Sdk="([^"]+)"/.exec(t)?.[1] ?? '';
    const tfms = (/<TargetFrameworks?>([^<]+)</.exec(t)?.[1] ?? '').split(';').map((s) => s.trim()).filter(Boolean);
    const test = /<IsTestProject>\s*true/i.test(t) || /Microsoft\.NET\.Test\.Sdk/.test(t);
    const name = /<AssemblyName>([^<]+)</.exec(t)?.[1]?.trim() ?? rel.split('/').pop().replace(/\.\w+proj$/i, '');
    return { rel, sdk, tfms, test, name, exe: /<OutputType>\s*(Win)?Exe/i.test(t) };
  });
  const pick = info.find((p) => /\.Web$/.test(p.sdk) && !p.test) ?? info.find((p) => /BlazorWebAssembly|Worker/.test(p.sdk) && !p.test) ?? info.find((p) => p.exe && !p.test) ?? info.find((p) => !p.test) ?? info[0];
  const versions = pick.tfms.map((t) => /^net(?:coreapp)?(\d+\.\d+)$/.exec(t)?.[1]).filter(Boolean).sort((a, b) => cmp(nums(b), nums(a)));
  const notes = [];
  if (!versions.length) {
    return { kind: 'unknown', what: '.NET Framework', reason: `${pick.rel} targets ${pick.tfms.join(', ') || 'the .NET Framework'}, which runs only on Windows: it needs Windows containers, which this does not write.`, found: [pick.rel], notes };
  }
  const version = versions[0];
  const wasm = /BlazorWebAssembly/.test(pick.sdk);
  const web = /\.Web$/.test(pick.sdk);
  if (info.filter((p) => !p.test).length > 1) notes.push(`Several projects: ${pick.rel} is the one published. Change it in the Dockerfile for another.`);
  if (Number(version.split('.')[0]) < 8) notes.push(`${pick.tfms[0]} is out of support, and its images have no unprivileged user: the app runs as root. .NET 8 or later is better.`);
  return {
    kind: 'dotnet', what: wasm ? 'Blazor WebAssembly, served by nginx' : web ? 'ASP.NET Core' : /Worker/.test(pick.sdk) ? 'a worker service' : 'a .NET app',
    version, versionFrom: `${pick.rel}: ${pick.tfms.join(', ')}`, tool: 'dotnet', found: [pick.rel], notes,
    start: null, port: web || wasm ? 8080 : null, portFrom: web ? 'ASP.NET Core in the image' : wasm ? 'nginx in the image' : null, web: web || wasm,
    serves: wasm ? 'static' : undefined,
    dotnet: { project: pick.rel, name: pick.name, web, wasm },
  };
}

// ---- Go ----

function detectGo(ctx) {
  const mod = ctx.text('go.mod');
  if (mod === null) return null;
  const goLine = /^go\s+(\d+\.\d+)/m.exec(mod)?.[1];
  const toolchain = /^toolchain\s+go(\d+\.\d+)/m.exec(mod)?.[1];
  const version = [goLine, toolchain].filter(Boolean).sort((a, b) => cmp(nums(b), nums(a)))[0] ?? VERSIONS.go.preferred;
  const module = /^module\s+(\S+)/m.exec(mod)?.[1] ?? '';
  const cmds = ctx.listed('cmd').filter((n) => ctx.text(`cmd/${n}/main.go`) !== null);
  const last = module.split('/').pop();
  const cmd = ctx.has('main.go') ? null : (cmds.find((n) => n === last) ?? cmds.find((n) => /^(server|api|web|app)$/.test(n)) ?? cmds[0] ?? null);
  const mainText = ctx.text(cmd ? `cmd/${cmd}/main.go` : 'main.go') ?? '';
  const cgo = /github\.com\/mattn\/go-sqlite3/.test(mod);
  const port = portIn(mainText);
  const web = Boolean(port) || /net\/http|gin-gonic|labstack\/echo|gofiber|go-chi|gorilla\/mux/.test(mod + mainText);
  const notes = [];
  if (cgo) notes.push('go-sqlite3 needs C: the program is built with CGO on Debian, and runs on Debian slim.');
  if (!ctx.has('main.go') && !cmd) notes.push('No main.go at the top or in cmd/: the build takes the module’s top package. Change the path in the Dockerfile if the program is elsewhere.');
  if (listensLocally(mainText)) notes.push('The program listens on this computer only (localhost): in a container it must listen on all addresses (":8080" or "0.0.0.0:8080").');
  if (web && !port) notes.push('No port found in main.go: 8080 is assumed. Change it if the program listens on another.');
  const assets = ['templates', 'static', 'public', 'web', 'views', 'assets'].filter((d) => ctx.isDir(d));
  return {
    kind: 'go', what: web ? 'a Go web server' : 'a Go program', version, versionFrom: toolchain && toolchain === version ? 'go.mod toolchain' : 'go.mod', tool: 'go', found: ['go.mod', cmd ? `cmd/${cmd}/main.go` : ctx.has('main.go') ? 'main.go' : ''].filter(Boolean), notes,
    start: null, port: web ? (port ?? 8080) : null, portFrom: port ? (cmd ? `cmd/${cmd}/main.go` : 'main.go') : web ? 'the usual port' : null, web,
    go: { pkg: cmd ? `./cmd/${cmd}` : '.', cgo, sum: ctx.has('go.sum'), vendor: ctx.isDir('vendor'), assets },
  };
}

// ---- Java ----

function detectJava(ctx) {
  const pom = ctx.text('pom.xml');
  const gradleName = ctx.has('build.gradle.kts') ? 'build.gradle.kts' : ctx.has('build.gradle') ? 'build.gradle' : null;
  const gradle = gradleName ? ctx.text(gradleName) : null;
  if (pom === null && gradle === null) return null;
  const t = pom ?? gradle;
  const raw =
    /<java\.version>\s*([\d.]+)/.exec(t)?.[1] ??
    /<maven\.compiler\.(?:release|source|target)>\s*([\d.]+)/.exec(t)?.[1] ??
    /<release>\s*([\d.]+)\s*<\/release>/.exec(t)?.[1] ??
    /JavaLanguageVersion\.of\(\s*(\d+)/.exec(t)?.[1] ??
    /jvmToolchain\(\s*(\d+)/.exec(t)?.[1] ??
    /JavaVersion\.VERSION_(?:1_)?(\d+)/.exec(t)?.[1] ??
    /sourceCompatibility\s*=\s*['"]?(?:1\.)?(\d+)/.exec(t)?.[1] ??
    null;
  const asked = raw ? String(raw).replace(/^1\./, '') : null;
  const v = VERSIONS.java;
  const version = asked ? (v.candidates.includes(asked) ? asked : ([...v.candidates].sort((a, b) => a - b).find((c) => Number(c) >= Number(asked)) ?? asked)) : v.preferred;
  const boot = /spring-boot/.test(t) || /org\.springframework\.boot/.test(t);
  const quarkus = /io\.quarkus/.test(t);
  const war = pom !== null && /<packaging>\s*war\s*</.test(pom);
  const props = ctx.text('src/main/resources/application.properties') ?? '';
  const yml = ctx.text('src/main/resources/application.yml') ?? ctx.text('src/main/resources/application.yaml') ?? '';
  const named = Number(/^\s*server\.port\s*[=:]\s*(\d+)/m.exec(props)?.[1] ?? /^server:\s*\n(?:\s+.*\n)*?\s+port:\s*(\d+)/m.exec(yml)?.[1] ?? /^\s*quarkus\.http\.port\s*=\s*(\d+)/m.exec(props)?.[1] ?? 0);
  const web = boot ? /spring-boot-starter-(web|webflux)/.test(t) : quarkus || /micronaut|javalin|sparkjava|vertx|helidon|dropwizard/i.test(t);
  const notes = [];
  if (asked && asked !== version) notes.push(`The project asks for Java ${asked}; the image uses ${version}, the nearest long-term version.`);
  if (war && !boot) notes.push('A WAR file needs an application server (Tomcat, Jetty): the image runs a jar. Use a tomcat image in the run stage for a WAR.');
  if (gradle !== null && !ctx.has('gradlew')) notes.push('No Gradle wrapper (gradlew): the image’s Gradle builds it. The wrapper keeps the version the project expects.');
  if (!boot && !quarkus) notes.push('The jar must be runnable (a Main-Class in its manifest, or a "fat jar" with its libraries).');
  return {
    kind: 'java', what: boot ? `Spring Boot (${pom !== null ? 'Maven' : 'Gradle'})` : quarkus ? 'Quarkus (Maven)' : `a Java app (${pom !== null ? 'Maven' : 'Gradle'})`,
    version, versionFrom: asked ? `${pom !== null ? 'pom.xml' : gradleName}: Java ${asked}` : 'the current long-term version', tool: pom !== null ? 'maven' : 'gradle', found: [pom !== null ? 'pom.xml' : gradleName], notes,
    start: null, port: web ? named || 8080 : null, portFrom: named ? 'application settings (server.port)' : web ? 'the usual port' : null, web,
    java: { maven: pom !== null, wrapper: ctx.has('gradlew'), boot, quarkus },
  };
}

// ---- Rust ----

function detectRust(ctx) {
  const text = ctx.text('Cargo.toml');
  if (text === null) return null;
  const toml = readToml(text);
  const name = (Array.isArray(toml.bin) && toml.bin[0]?.name) || toml.package?.name;
  if (!name) return { kind: 'unknown', what: 'a Rust workspace', reason: 'Cargo.toml is a workspace without a package of its own: say which program to build.', found: ['Cargo.toml'], notes: [] };
  const deps = Object.keys(toml.dependencies ?? {});
  const web = deps.some((d) => /^(actix-web|axum|rocket|warp|poem|tide|salvo|hyper)$/.test(d));
  const mainText = ctx.text('src/main.rs') ?? '';
  const port = portIn(mainText);
  const rv = /^(\d+\.\d+)/.exec(String(toml.package?.['rust-version'] ?? ''))?.[1];
  const notes = [];
  if (listensLocally(mainText)) notes.push('src/main.rs listens on this computer only (127.0.0.1): in a container it must listen on all addresses (0.0.0.0), or the app cannot be reached.');
  // A program that binds a port of its own (std's TcpListener, a framework not listed here) serves
  // too: before 0.48.1 it got no port, and its container could not be reached.
  const serves = web || port !== null;
  return {
    kind: 'rust', what: web ? `a Rust web server (${deps.find((d) => /^(actix-web|axum|rocket|warp|poem|tide|salvo|hyper)$/.test(d))})` : serves ? 'a Rust server' : 'a Rust program',
    version: rv ?? VERSIONS.rust.preferred, versionFrom: rv ? 'Cargo.toml rust-version' : 'the current Rust', tool: 'cargo', found: ['Cargo.toml'], notes,
    start: null, port: serves ? (port ?? 8080) : null, portFrom: port ? 'src/main.rs' : web ? 'the usual port' : null, web: serves,
    rust: { bin: name, lock: ctx.has('Cargo.lock') },
  };
}

// ---- Static sites ----

function detectStatic(ctx) {
  const where = ctx.has('index.html') ? '' : ctx.listed('public').includes('index.html') ? 'public' : null;
  if (where === null) return null;
  return {
    kind: 'static', what: 'its files, served by nginx', serves: 'static', version: '', versionFrom: '', tool: '', found: [where ? 'public/index.html' : 'index.html'], notes: [],
    start: null, port: 8080, portFrom: 'nginx in the image', web: true, site: { dir: where },
  };
}

// Folders whose contents the app writes: kept in volumes, so they survive updates.
const DATA_DIRS = { all: ['data', 'uploads', 'upload'], python: ['instance', 'media'] };
const WORKDIRS = { node: '/app', python: '/app', php: '/var/www/html', dotnet: '/app', go: '/app', java: '/app', rust: '/app', static: '/usr/share/nginx/html' };

/**
 * What kind of project a scan shows (`scan` from scanProject): { kind, label, what, version,
 * versionFrom, tool, found, notes, start, port, web, volumes, env, … and the kind's own details },
 * or { kind: 'unknown', reason }. `name`: the folder's name.
 */
export function detectProject(scan, { name = '' } = {}) {
  const ctx = context(scan);
  const pythonish = PY_MARKERS.some(ctx.has);
  const project =
    detectDotnet(ctx) ??
    detectGo(ctx) ??
    detectJava(ctx) ??
    detectRust(ctx) ??
    (ctx.has('composer.json') ? detectPhp(ctx) : null) ??
    detectNode(ctx, { serverOnly: true, namedOnly: pythonish }) ??
    detectPython(ctx) ??
    detectNode(ctx, { serverOnly: false }) ??
    detectPhp(ctx) ??
    detectStatic(ctx);
  if (!project) return { kind: 'unknown', label: KINDS.unknown, name: imageName(name), reason: 'None of the files a project here is known by was found: package.json, requirements.txt or pyproject.toml, composer.json, a .csproj, go.mod, pom.xml or build.gradle, Cargo.toml, index.html.', found: [], notes: [] };
  if (project.kind === 'unknown') return { ...project, label: KINDS.unknown, name: imageName(name) };
  const static_ = project.serves === 'static';
  const dataDirs = static_ ? [] : [...DATA_DIRS.all, ...(project.kind === 'python' ? DATA_DIRS.python : []), ...(project.php?.laravel ? ['storage'] : [])].filter((d) => ctx.isDir(d));
  const env = ENV_EXAMPLES.find(ctx.has) ?? (ctx.has('.env') ? '.env' : null);
  const notes = [...project.notes];
  const sqlite = ctx.names.filter((n) => /\.(db|sqlite3?)$/i.test(n));
  if (sqlite.length && !static_) notes.push(`${sqlite.join(', ')} ${sqlite.length > 1 ? 'are' : 'is'} in the project’s top folder: it goes into the image, and what the app writes to it is lost when the image is built again. Keep it in a folder kept in a volume (data/).`);
  return {
    ...project,
    label: project.node?.pm === 'bun' ? 'Bun' : KINDS[project.kind],
    name: imageName(name),
    workdir: WORKDIRS[project.serves === 'static' ? 'static' : project.kind],
    volumes: dataDirs,
    env,
    init: !static_ && project.kind !== 'php',
    notes,
  };
}

/** A name Docker takes for the image, the service and the Compose project: "My App (2)" → "my-app-2". */
export function imageName(raw) {
  const s = String(raw ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return s || 'app';
}

// ---- The files ----

/** The choices the dialog starts with for a project. */
export function defaultOptions(project, { arch = '' } = {}) {
  return {
    name: project.name ?? 'app',
    version: project.version ?? '',
    port: project.port ?? '',
    hostPort: project.port ?? '',
    start: project.start ?? '',
    out: project.out ?? '',
    volumes: [...(project.volumes ?? [])],
    env: Boolean(project.env),
    location: 'root',
    offline: false,
    platform: 'linux/amd64',
    arch,
  };
}

/** Whether the container's port is the image's own (nginx, Apache: 8080), not the app's to choose. */
export const fixedPort = (project) => project.serves === 'static' || project.kind === 'php';
/** Whether the app listens on a port (static sites and PHP always do; an app when it has one). */
export const servesPort = (project, o) => fixedPort(project) || String(o.port ?? '').trim() !== '';

/** A problem with a choice (a word for the field), or ''. */
export function optionProblem(project, o) {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(o.name ?? '')) return 'The image name: lowercase letters, digits and dashes, starting with a letter or digit.';
  const port = (n) => /^\d{1,5}$/.test(String(n ?? '').trim()) && Number(n) >= 1 && Number(n) <= 65535;
  if (servesPort(project, o) && (!port(o.hostPort) || !port(fixedPort(project) ? 8080 : o.port))) return 'The ports are numbers from 1 to 65535.';
  if (project.serves !== 'static' && project.start !== null && project.start !== undefined && !String(o.start ?? '').trim()) return 'The start command is empty.';
  if (project.out !== undefined && project.out !== null && (!String(o.out ?? '').trim() || !safeRel(String(o.out).trim().replace(/\/+$/, '')))) return 'The built files folder is a folder inside the project (dist, build…).';
  if (!/^[\w.-]*$/.test(o.version ?? '')) return 'The version: digits and dots (24, 3.13).';
  return '';
}

const PLATFORMS = ['linux/amd64', 'linux/arm64'];

/**
 * Everything Dockerize writes for `project` with the choices `o` (defaultOptions): { files:
 * [{ path, text, about }], dockerfile, compose, up, down, logs, url, offlineDir, archive }.
 * Paths are relative to the project's folder, with "/". `composeName`: an existing compose
 * file's name at the top (compose.yaml…), which docker compose would read first.
 */
export function dockerPlan(project, o, { composeName = '' } = {}) {
  const inDocker = o.location === 'docker';
  const dir = inDocker ? 'docker/' : '';
  const dockerfile = `${dir}Dockerfile`;
  const composeFile = inDocker ? 'docker/docker-compose.yml' : composeName || 'docker-compose.yml';
  const fileFlag = inDocker ? ` -f ${composeFile}` : '';
  const url = servesPort(project, o) ? `http://localhost:${o.hostPort}` : null;
  const plan = {
    name: o.name,
    location: o.location,
    dockerfile,
    compose: composeFile,
    up: `docker compose${fileFlag} up -d --build`,
    down: `docker compose${fileFlag} down`,
    logs: `docker compose${fileFlag} logs -f`,
    url,
    offline: Boolean(o.offline),
    platform: PLATFORMS.includes(o.platform) ? o.platform : 'native',
    offlineDir: 'docker/offline',
    archive: `docker/offline/${o.name}`,
    env: o.env ? project.env : null,
    web: servesPort(project, o),
  };
  const spa = project.node?.front?.spa || project.dotnet?.wasm;
  const files = [
    { path: dockerfile, text: dockerfileText(project, o, dir), about: 'How the image is built' },
    spa ? { path: `${dir}nginx.conf`, text: nginxConf(o), about: 'nginx: the built pages, and the app’s own paths sent to index.html' } : null,
    { path: composeFile, text: composeText(project, o, { inDocker }), about: 'How it runs: its port, restarts, data' },
    { path: inDocker ? 'docker/Dockerfile.dockerignore' : '.dockerignore', text: dockerignoreText(project, o), about: 'What stays out of the image' },
    { path: `${dir}DOCKER.md`, text: guideText(project, o, plan), about: 'How to install Docker and run it (Windows, Mac, Linux)' },
  ];
  if (o.offline) {
    files.push(
      { path: 'docker/offline/compose.yml', text: composeText(project, o, { offline: true }), about: 'Runs the image on a server without internet' },
      { path: 'docker/offline/install.sh', text: installSh(project, o), about: 'Installs it on Linux and Mac' },
      { path: 'docker/offline/install.ps1', text: installPs1(project, o), about: 'Installs it on Windows' },
      { path: 'docker/offline/README.txt', text: offlineReadme(project, o), about: 'What to do on the server' },
      { path: 'docker/offline/.gitignore', text: '# The image is large and made again by each build: not kept in Git.\n*.tar\n*.tar.gz\n.env\n', about: 'Keeps the image out of Git' },
    );
  }
  plan.files = files.filter(Boolean);
  return plan;
}

// The Dockerfile's head comment.
const head = (project, o, plan) => [`# Tracker Editor wrote this for ${o.name} (${project.label}: ${project.what}).`, `# Build and start it: ${plan}   (DOCKER.md says more)`];
const lines = (...parts) => `${parts.flat(Infinity).filter((l) => l !== null && l !== false && l !== undefined).join('\n')}\n`;
const envLine = (env) => (Object.keys(env).length ? `ENV ${Object.entries(env).map(([k, v]) => `${k}=${/\s/.test(v) ? JSON.stringify(v) : v}`).join(' ')}` : null);
// The folders kept in volumes exist in the image and belong to the user the app runs as.
const volumeDirs = (o, workdir, user) => {
  const dirs = (o.volumes ?? []).map((v) => `${workdir}/${v}`).join(' ');
  return dirs ? `RUN mkdir -p ${dirs} && chown -R ${user} ${dirs}` : null;
};
const exposeLine = (project, o) => (servesPort(project, o) ? `EXPOSE ${fixedPort(project) ? 8080 : o.port}` : null);

function dockerfileText(project, o, dir) {
  const up = o.location === 'docker' ? 'docker compose -f docker/docker-compose.yml up -d --build' : 'docker compose up -d --build';
  const top = head(project, o, up);
  switch (project.kind) {
    case 'node':
      return project.serves === 'static' ? nodeFront(project, o, dir, top) : nodeServer(project, o, top);
    case 'python':
      return pythonFile(project, o, top);
    case 'php':
      return phpFile(project, o, top);
    case 'dotnet':
      return dotnetFile(project, o, dir, top);
    case 'go':
      return goFile(project, o, top);
    case 'java':
      return javaFile(project, o, top);
    case 'rust':
      return rustFile(project, o, top);
    default:
      return staticFile(project, o, top);
  }
}

// Node.js: installing with the project's tool.
function nodeSetup(n) {
  return n.pm === 'pnpm' || n.pm === 'yarn' ? ['# pnpm and Yarn come through Corepack, at the version package.json names.', 'ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0', 'RUN npm install -g --force corepack@latest'] : [];
}
function nodeInstall(n, { prod }) {
  const lock = Boolean(n.lock);
  if (n.pm === 'pnpm') return `corepack pnpm install${lock ? ' --frozen-lockfile' : ''}${prod ? ' --prod' : ''}`;
  if (n.pm === 'yarn') return n.berry ? `corepack yarn install${lock ? ' --immutable' : ''}` : `corepack yarn install${lock ? ' --frozen-lockfile' : ''}${prod ? ' --production' : ''}`;
  if (n.pm === 'bun') return `bun install${lock ? ' --frozen-lockfile' : ''}${prod ? ' --production' : ''}`;
  return `${lock ? 'npm ci' : 'npm install'}${prod ? ' --omit=dev' : ''}`;
}
function nodePrune(n) {
  if (n.pm === 'pnpm') return 'corepack pnpm prune --prod';
  if (n.pm === 'yarn') return n.berry ? null : `corepack yarn install${n.lock ? ' --frozen-lockfile' : ''} --production --ignore-scripts --prefer-offline`;
  if (n.pm === 'bun') return `rm -rf node_modules && bun install${n.lock ? ' --frozen-lockfile' : ''} --production`;
  return 'npm prune --omit=dev';
}
const nodeCopy = (n) => ['package.json', n.lock, n.yarnrc ? '.yarnrc.yml' : null].filter(Boolean).join(' ');

function nodeServer(p, o, top) {
  const n = p.node;
  const bun = n.pm === 'bun';
  const user = bun ? 'bun' : 'node';
  const image = bun ? 'oven/bun:1' : `node:${o.version}-slim`;
  const prod = !n.build && !n.dev;
  return lines(
    top,
    '',
    `# 1. Build: the dependencies${n.build ? `, then the app's own build (${runScript(n.pm, n.build)})` : ''}.`,
    `FROM ${image} AS build`,
    'WORKDIR /app',
    nodeSetup(n),
    `COPY ${nodeCopy(n)} ./`,
    n.yarnDir ? 'COPY .yarn ./.yarn' : null,
    `RUN ${nodeInstall(n, { prod })}`,
    'COPY . .',
    n.build ? `RUN ${runScript(n.pm, n.build)}` : null,
    n.build && !n.dev && nodePrune(n) ? `RUN ${nodePrune(n)}` : null,
    '',
    `# 2. Run: the app with what it needs, as the unprivileged "${user}" user.`,
    `FROM ${bun ? 'oven/bun:1-slim' : image}`,
    envLine({ NODE_ENV: 'production', ...n.env }),
    'WORKDIR /app',
    `COPY --from=build --chown=${user}:${user} /app ./`,
    volumeDirs(o, '/app', user),
    `USER ${user}`,
    exposeLine(p, o),
    cmdLine(o.start || 'npm start'),
  );
}

function nodeFront(p, o, dir, top) {
  const n = p.node;
  const out = String(o.out || p.out || 'dist').replace(/^\.\//, '').replace(/\/+$/, '');
  const spa = n.front?.spa;
  return lines(
    top,
    '',
    `# 1. Build: the site's files (${runScript(n.pm, n.build)} writes them to ${out}/).`,
    `FROM ${n.pm === 'bun' ? 'oven/bun:1' : `node:${o.version}-slim`} AS build`,
    'WORKDIR /app',
    nodeSetup(n),
    `COPY ${nodeCopy(n)} ./`,
    n.yarnDir ? 'COPY .yarn ./.yarn' : null,
    `RUN ${nodeInstall(n, { prod: false })}`,
    'COPY . .',
    `RUN ${runScript(n.pm, n.build)}`,
    '',
    "# 2. Serve: nginx with the built files, as an unprivileged user (nginx's own image for that).",
    `FROM ${NGINX}`,
    spa ? `COPY ${dir}nginx.conf /etc/nginx/conf.d/default.conf` : null,
    `COPY --from=build /app/${out} /usr/share/nginx/html`,
    'EXPOSE 8080',
  );
}

function staticFile(p, o, top) {
  const from = p.site?.dir ? `${p.site.dir}/` : '.';
  return lines(top, '', "# nginx serves the site's files, as an unprivileged user (nginx's own image for that).", `FROM ${NGINX}`, `COPY ${from} /usr/share/nginx/html`, 'EXPOSE 8080');
}

function nginxConf(o) {
  return lines(
    '# nginx for the built site (Tracker Editor wrote it): the files, and the paths the app routes',
    '# itself (/settings, /items/12) answered with index.html, so reloading a page works.',
    'server {',
    '    listen 8080;',
    '    server_name _;',
    '    root /usr/share/nginx/html;',
    '    index index.html;',
    '',
    '    location / {',
    '        try_files $uri $uri/ /index.html;',
    '    }',
    '',
    '    gzip on;',
    '    gzip_types text/css application/javascript application/json image/svg+xml;',
    '}',
  );
}

// Python: the dependencies in a virtual environment (/venv), by the project's tool. uv keeps to
// the image's own Python (one it downloaded would stay behind in the build stage).
const UV_PYTHON = 'UV_PYTHON=/usr/local/bin/python3 UV_PYTHON_DOWNLOADS=never';
function pythonBuild(py) {
  const env = 'ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1';
  const add = (how) => (py.extra.length ? `RUN ${how} ${py.extra.join(' ')}` : null);
  switch (py.tool) {
    case 'uv':
      return [`${env} UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/venv ${UV_PYTHON}`, 'RUN pip install uv', 'WORKDIR /app', 'COPY pyproject.toml uv.lock ./', 'RUN uv sync --frozen --no-dev --no-install-project', 'COPY . .', 'RUN uv sync --frozen --no-dev', add('uv pip install --python /venv/bin/python')];
    case 'uv-pyproject':
      return [`${env} ${UV_PYTHON}`, 'RUN pip install uv && uv venv /venv', 'WORKDIR /app', 'COPY pyproject.toml ./', 'RUN uv pip install --python /venv/bin/python -r pyproject.toml', add('uv pip install --python /venv/bin/python')];
    case 'poetry':
      return [`${env} POETRY_NO_INTERACTION=1`, 'RUN pip install poetry && python -m venv /venv', 'ENV VIRTUAL_ENV=/venv PATH="/venv/bin:$PATH"', 'WORKDIR /app', `COPY pyproject.toml ${py.lock ? 'poetry.lock ' : ''}./`, 'RUN poetry install --only main --no-root', add('pip install')];
    case 'pipenv':
      return [env, 'RUN pip install pipenv && python -m venv /venv', 'WORKDIR /app', `COPY Pipfile ${py.lock ? 'Pipfile.lock ' : ''}./`, 'RUN pipenv requirements > /tmp/requirements.txt && /venv/bin/pip install -r /tmp/requirements.txt', add('/venv/bin/pip install')];
    default:
      return [env, 'RUN python -m venv /venv', 'ENV PATH="/venv/bin:$PATH"', 'WORKDIR /app', 'COPY requirements.txt ./', 'RUN pip install -r requirements.txt', add('pip install')];
  }
}

function pythonFile(p, o, top) {
  const py = p.python;
  const image = `python:${o.version}-slim`;
  return lines(
    top,
    '',
    `# 1. Build: the dependencies in a virtual environment (${py.tool === 'uv-pyproject' ? 'uv, from pyproject.toml' : py.tool}).`,
    `FROM ${image} AS build`,
    pythonBuild(py),
    '',
    '# 2. Run: the app with its environment, as the unprivileged "app" user.',
    `FROM ${image}`,
    `ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH="/venv/bin:$PATH"${Object.entries(py.env).map(([k, v]) => ` ${k}=${v}`).join('')}`,
    'WORKDIR /app',
    'RUN useradd --create-home --uid 10001 app',
    'COPY --from=build /venv /venv',
    'COPY --chown=app . .',
    volumeDirs(o, '/app', 'app'),
    'USER app',
    exposeLine(p, o),
    cmdLine(o.start || 'python main.py'),
  );
}

function phpFile(p, o, top) {
  const php = p.php;
  const root = php.publicRoot ? '/var/www/html/public' : '/var/www/html';
  const n = php.node;
  return lines(
    top,
    '',
    php.composer ? '# 1. Dependencies: Composer installs vendor/ (without the dev packages).' : null,
    php.composer ? 'FROM composer:2 AS vendor' : null,
    php.composer ? 'WORKDIR /app' : null,
    php.composer ? `COPY composer.json ${php.lock ? 'composer.lock ' : ''}./` : null,
    php.composer ? 'RUN composer install --no-dev --no-interaction --no-progress --prefer-dist --no-scripts --ignore-platform-reqs --optimize-autoloader' : null,
    php.composer ? '' : null,
    n ? `# ${php.composer ? '2' : '1'}. Front-end files: ${runScript(n.pm, 'build')} writes them into public/.` : null,
    n ? `FROM ${n.pm === 'bun' ? 'oven/bun:1' : `node:${php.nodeVersion}-slim`} AS assets` : null,
    n ? 'WORKDIR /app' : null,
    n ? nodeSetup(n) : null,
    n ? `COPY ${nodeCopy(n)} ./` : null,
    n ? `RUN ${nodeInstall(n, { prod: false })}` : null,
    n ? 'COPY . .' : null,
    n ? `RUN ${runScript(n.pm, 'build')}` : null,
    n ? '' : null,
    php.composer || n ? `# ${(php.composer ? 1 : 0) + (n ? 1 : 0) + 1}. Run: PHP with Apache on port 8080, as the unprivileged www-data user.` : '# PHP with Apache on port 8080, as the unprivileged www-data user.',
    `FROM php:${o.version}-apache`,
    php.exts.length ? 'COPY --from=mlocati/php-extension-installer:2 /usr/bin/install-php-extensions /usr/local/bin/' : null,
    php.exts.length ? `RUN install-php-extensions ${php.exts.join(' ')}` : null,
    php.publicRoot ? `ENV APACHE_DOCUMENT_ROOT=${root}` : null,
    php.publicRoot ? 'RUN sed -ri -e \'s!/var/www/html!${APACHE_DOCUMENT_ROOT}!g\' /etc/apache2/sites-available/*.conf \\' : null,
    php.publicRoot ? " && sed -ri -e 's!/var/www/!${APACHE_DOCUMENT_ROOT}!g' /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf" : null,
    "RUN a2enmod rewrite \\",
    " && sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf \\",
    " && sed -i 's/<VirtualHost \\*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf",
    'WORKDIR /var/www/html',
    'COPY --chown=www-data:www-data . .',
    php.composer ? 'COPY --from=vendor --chown=www-data:www-data /app/vendor ./vendor' : null,
    n ? 'COPY --from=assets --chown=www-data:www-data /app/public ./public' : null,
    volumeDirs(o, '/var/www/html', 'www-data'),
    'USER www-data',
    'EXPOSE 8080',
  );
}

function dotnetFile(p, o, dir, top) {
  const d = p.dotnet;
  const v = o.version;
  const modern = Number(String(v).split('.')[0]) >= 8;
  const publish = `RUN dotnet publish "${d.project}" -c Release -o /app/publish${d.wasm ? '' : ' -p:UseAppHost=false'}`;
  if (d.wasm)
    return lines(
      top,
      '',
      '# 1. Build: publish the app (Release): its files are in wwwroot.',
      `FROM mcr.microsoft.com/dotnet/sdk:${v} AS build`,
      'WORKDIR /src',
      'COPY . .',
      publish,
      '',
      '# 2. Serve: nginx with the published files, as an unprivileged user.',
      `FROM ${NGINX}`,
      `COPY ${dir}nginx.conf /etc/nginx/conf.d/default.conf`,
      'COPY --from=build /app/publish/wwwroot /usr/share/nginx/html',
      'EXPOSE 8080',
    );
  return lines(
    top,
    '',
    '# 1. Build: restore and publish the app (Release).',
    `FROM mcr.microsoft.com/dotnet/sdk:${v} AS build`,
    'WORKDIR /src',
    'COPY . .',
    publish,
    '',
    `# 2. Run: the ${d.web ? 'ASP.NET Core' : '.NET'} runtime with the app${modern ? ', as the unprivileged "app" user' : ''}.`,
    `FROM mcr.microsoft.com/dotnet/${d.web ? 'aspnet' : 'runtime'}:${v}`,
    'WORKDIR /app',
    'COPY --from=build /app/publish .',
    d.web ? (modern ? `ENV ASPNETCORE_HTTP_PORTS=${o.port}` : `ENV ASPNETCORE_URLS=http://+:${o.port}`) : null,
    modern ? volumeDirs(o, '/app', 'app') : null,
    modern ? 'USER app' : null,
    exposeLine(p, o),
    `ENTRYPOINT ["dotnet", ${JSON.stringify(`${d.name}.dll`)}]`,
  );
}

function goFile(p, o, top) {
  const g = p.go;
  const runImage = g.cgo ? DEBIAN : ALPINE;
  return lines(
    top,
    '',
    `# 1. Build: the program${g.cgo ? ' (with CGO: go-sqlite3 needs C)' : ', static (CGO off: it needs no C libraries)'}.`,
    `FROM golang:${o.version}-${g.cgo ? 'bookworm' : 'alpine'} AS build`,
    'WORKDIR /src',
    g.vendor ? null : `COPY go.mod ${g.sum ? 'go.sum ' : ''}./`,
    g.vendor ? null : 'RUN go mod download',
    'COPY . .',
    `RUN CGO_ENABLED=${g.cgo ? '1' : '0'} go build -trimpath -ldflags="-s -w" -o /out/app ${g.pkg}`,
    '',
    `# 2. Run: a small ${g.cgo ? 'Debian' : 'Alpine'} image with the program, as the unprivileged "app" user.`,
    `FROM ${runImage}`,
    g.cgo ? 'RUN useradd --system --uid 10001 app' : 'RUN adduser -D -H -u 10001 app',
    'WORKDIR /app',
    'COPY --from=build /out/app /usr/local/bin/app',
    g.assets.map((a) => `COPY --from=build /src/${a} ./${a}`),
    volumeDirs(o, '/app', 'app'),
    'USER app',
    exposeLine(p, o),
    'CMD ["app"]',
  );
}

function javaFile(p, o, top) {
  const j = p.java;
  const v = o.version;
  const pick = j.maven ? 'target' : 'build/libs';
  const jar = `cp "$(ls ${pick}/*.jar | grep -v -e '-plain' -e '-sources' -e '-javadoc' | head -n 1)" /app.jar`;
  let build;
  if (j.maven) build = [`FROM maven:3.9-eclipse-temurin-${v} AS build`, 'WORKDIR /src', 'COPY . .', j.quarkus ? 'RUN mvn -B -DskipTests package && cp -r target/quarkus-app /app' : `RUN mvn -B -DskipTests package && ${jar}`];
  else if (j.wrapper) build = [`FROM eclipse-temurin:${v}-jdk AS build`, 'WORKDIR /src', 'COPY . .', `RUN sed -i 's/\\r$//' gradlew && chmod +x gradlew && ./gradlew ${j.boot ? 'bootJar' : 'build -x test'} --no-daemon && ${jar}`];
  else build = [`FROM gradle:jdk${v} AS build`, 'WORKDIR /src', 'COPY . .', `RUN gradle ${j.boot ? 'bootJar' : 'build -x test'} --no-daemon && ${jar}`];
  return lines(
    top,
    '',
    `# 1. Build: the app with ${j.maven ? 'Maven' : 'Gradle'} (tests skipped: run them before building the image).`,
    build,
    '',
    '# 2. Run: the Java runtime (JRE) with the app, as the unprivileged "app" user.',
    `FROM eclipse-temurin:${v}-jre`,
    'RUN useradd --system --create-home --uid 10001 app',
    'WORKDIR /app',
    j.quarkus ? 'COPY --from=build --chown=app /app ./quarkus-app' : 'COPY --from=build /app.jar ./app.jar',
    volumeDirs(o, '/app', 'app'),
    'USER app',
    exposeLine(p, o),
    j.quarkus ? 'ENTRYPOINT ["java", "-jar", "quarkus-app/quarkus-run.jar"]' : 'ENTRYPOINT ["java", "-jar", "app.jar"]',
  );
}

function rustFile(p, o, top) {
  const r = p.rust;
  return lines(
    top,
    '',
    '# 1. Build: the program, in release mode.',
    `FROM rust:${o.version}-slim-bookworm AS build`,
    'RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*',
    'WORKDIR /src',
    'COPY . .',
    `RUN cargo build --release${r.lock ? ' --locked' : ''} && cp target/release/${r.bin} /app`,
    '',
    '# 2. Run: Debian slim with the program, as the unprivileged "app" user.',
    `FROM ${DEBIAN}`,
    'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 && rm -rf /var/lib/apt/lists/* \\',
    ' && useradd --system --uid 10001 app',
    'WORKDIR /app',
    'COPY --from=build /app /usr/local/bin/app',
    volumeDirs(o, '/app', 'app'),
    'USER app',
    exposeLine(p, o),
    'CMD ["app"]',
  );
}

function composeText(p, o, { inDocker = false, offline = false } = {}) {
  const volumes = (o.volumes ?? []).map((v) => ({ name: v.replace(/[^a-z0-9_-]/gi, '-').toLowerCase(), target: `${p.workdir}/${v}` }));
  const platform = PLATFORMS.includes(o.platform) ? o.platform : null;
  return lines(
    offline
      ? [`# Runs ${o.name} from its image, without internet (Tracker Editor wrote it). install.sh and`, '# install.ps1 load the image and start it: docker compose -f compose.yml up -d']
      : [`# Builds and runs ${o.name} (Tracker Editor wrote it). DOCKER.md says more.`, `# Start: docker compose${inDocker ? ' -f docker/docker-compose.yml' : ''} up -d --build    Stop: docker compose${inDocker ? ' -f docker/docker-compose.yml' : ''} down`],
    `name: ${o.name}`,
    'services:',
    `  ${o.name}:`,
    offline ? null : inDocker ? ['    build:', '      context: ..', '      dockerfile: docker/Dockerfile'] : '    build: .',
    `    image: ${o.name}:latest`,
    offline ? '    pull_policy: never' : null,
    offline && platform ? `    platform: ${platform}` : null,
    servesPort(p, o) ? ['    ports:', `      - "${o.hostPort}:${fixedPort(p) ? 8080 : o.port}"`] : null,
    '    restart: unless-stopped',
    p.init ? '    init: true' : null,
    o.env && p.env ? ['    env_file:', `      - path: ${!offline && inDocker ? '../.env' : '.env'}`, '        required: false'] : null,
    volumes.length ? ['    volumes:', volumes.map((v) => `      - ${v.name}:${v.target}`)] : null,
    volumes.length ? ['', 'volumes:', volumes.map((v) => `  ${v.name}:`)] : null,
  );
}

const IGNORE_KIND = {
  node: ['node_modules', 'npm-debug.log*', 'yarn-error.log*', '.pnpm-store', '.npm', 'coverage'],
  python: ['__pycache__', '*.py[cod]', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '*.egg-info', 'htmlcov', '.coverage'],
  php: ['vendor', 'node_modules', '.phpunit.result.cache'],
  dotnet: ['**/bin', '**/obj', '*.user', '.vs'],
  go: ['*.exe', '*.test'],
  java: ['target', 'build', '.gradle', '*.class'],
  rust: ['target'],
  static: ['node_modules'],
};

function dockerignoreText(p, o) {
  const extra = [...(IGNORE_KIND[p.kind] ?? []), ...(p.node?.excludes ?? []), ...(p.php?.assets ? ['public/build', 'public/hot'] : [])];
  return lines(
    '# What Docker leaves out when it builds the image: faster builds, a smaller image, no secrets in it.',
    '.git',
    '.gitignore',
    '.dockerignore',
    'Dockerfile*',
    'docker-compose*.yml',
    'docker-compose*.yaml',
    'compose*.yml',
    'compose*.yaml',
    'DOCKER.md',
    'docker/Dockerfile*',
    'docker/*compose*.yml',
    'docker/DOCKER.md',
    'docker/offline',
    '# Settings with passwords stay out: the container gets them from .env when it runs.',
    '.env',
    '.env.local',
    '.env.*.local',
    '*.log',
    '.DS_Store',
    'Thumbs.db',
    '.vscode',
    '.idea',
    extra.length ? `# ${p.label}` : null,
    [...new Set(extra)],
  );
}

// ---- DOCKER.md and the offline package ----

const PS = (path) => path.replace(/\//g, '\\');

/** The command that builds the offline package in a terminal (posix, powershell, cmd, wsl). */
export function offlineBuildLine(plan, kind = 'posix', { envExample = plan.env && plan.env !== '.env' ? plan.env : null } = {}) {
  const name = plan.name;
  const build =
    plan.platform === 'native'
      ? `docker compose${plan.location === 'docker' ? ` -f ${plan.compose}` : ''} build`
      : `docker buildx build --platform ${plan.platform} --tag ${name}:latest --load --file ${plan.dockerfile} .`;
  if (kind === 'powershell')
    return `${build}; if ($LASTEXITCODE -eq 0) { ${envExample ? `Copy-Item -Force ${envExample} docker/offline/.env.example; ` : ''}docker save --output ${plan.archive}.tar ${name}:latest }; if ($LASTEXITCODE -eq 0) { Write-Host 'The offline package is ready: docker/offline' }`;
  if (kind === 'cmd') return `${build} && ${envExample ? `copy /Y ${envExample} ${PS('docker/offline/.env.example')} >nul && ` : ''}docker save --output ${plan.archive}.tar ${name}:latest && echo The offline package is ready: ${PS('docker/offline')}`;
  return `${build} && ${envExample ? `cp -f ${envExample} docker/offline/.env.example && ` : ''}docker save ${name}:latest | gzip > ${plan.archive}.tar.gz && echo "The offline package is ready: docker/offline"`;
}

function guideText(p, o, plan) {
  const up = plan.up;
  const svc = o.name;
  const where = o.location === 'docker' ? 'docker/' : '';
  const env = o.env && p.env && p.env !== '.env' ? p.env : null;
  const fileRows = [
    [`${where}Dockerfile`, 'How the image is built: the app and everything it needs'],
    p.node?.front?.spa || p.dotnet?.wasm ? [`${where}nginx.conf`, 'How nginx serves the built pages'] : null,
    [plan.compose, `How it runs: ${plan.web ? `port ${o.hostPort}, ` : ''}restarts${o.volumes?.length ? ', data kept in volumes' : ''}${env ? ', settings from .env' : ''}`],
    [o.location === 'docker' ? 'docker/Dockerfile.dockerignore' : '.dockerignore', 'What stays out of the image (secrets, caches, installed packages)'],
    o.offline ? ['docker/offline/', 'The package for a server without internet'] : null,
  ].filter(Boolean);
  const offline = plan.platform === 'native' ? 'this computer’s kind of processor' : plan.platform;
  return lines(
    `# Running ${o.name} with Docker`,
    '',
    `Tracker Editor wrote these files for ${o.name} (${p.label}: ${p.what}). With Docker installed, one command builds it and starts it${plan.url ? ` at ${plan.url}` : ''}; it starts again by itself when the computer restarts.`,
    '',
    '| File | What it is |',
    '| --- | --- |',
    fileRows.map(([f, what]) => `| \`${f}\` | ${what} |`),
    '',
    '## 1. Install Docker (once)',
    '',
    '- **Windows 10 or 11**: install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/). It uses WSL 2: say yes if it asks to turn it on, then restart. Or, in PowerShell: `winget install -e --id Docker.DockerDesktop`',
    '- **Mac**: install [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) (Apple chip or Intel chip). Or, with Homebrew: `brew install --cask docker`',
    '- **Linux**: install Docker Engine: `curl -fsSL https://get.docker.com | sudo sh`, then `sudo usermod -aG docker $USER` and log out and in again (so `docker` works without `sudo`). Other ways: [Docker Engine](https://docs.docker.com/engine/install/).',
    '',
    'Start Docker Desktop (Windows, Mac), then check that it works (PowerShell on Windows, Terminal on Mac and Linux):',
    '',
    '```',
    'docker version',
    'docker compose version',
    '```',
    '',
    '## 2. Start it',
    '',
    env ? [`First make your settings file from the example, and fill it in:`, '', `- Windows (PowerShell): \`Copy-Item ${env} .env\``, `- Mac, Linux: \`cp ${env} .env\``, ''] : null,
    'In this project’s folder:',
    '',
    '```',
    up,
    '```',
    '',
    `${plan.url ? `Then open ${plan.url}. ` : ''}The first build downloads what it needs and takes a few minutes; later ones are quicker.`,
    '',
    '## 3. Everyday commands',
    '',
    'The same in PowerShell, the Command Prompt and Terminal, in this project’s folder:',
    '',
    '| To | Run |',
    '| --- | --- |',
    `| See whether it runs | \`${plan.down.replace(' down', ' ps')}\` |`,
    `| See what it prints (logs) | \`${plan.logs}\` (Ctrl+C stops watching) |`,
    `| Stop it | \`${plan.down}\` |`,
    `| Start it again | \`${plan.up.replace(' --build', '')}\` |`,
    `| Update it after changing the code | \`${plan.up}\` |`,
    `| A shell inside it | \`${plan.down.replace(' down', ` exec ${svc} sh`)}\` |`,
    o.volumes?.length ? `| Remove it **and its data** | \`${plan.down} -v\` (deletes the volumes) |` : null,
    '',
    o.volumes?.length ? [`What the app writes in ${o.volumes.map((v) => `\`${v}/\``).join(', ')} is kept in Docker volumes (${o.volumes.map((v) => `\`${o.name}_${v}\``).join(', ')}): it survives updates and restarts, and goes only with \`down -v\`.`, ''] : null,
    '## 4. A server without internet',
    '',
    o.offline
      ? [
          'On a computer with internet, in this project’s folder, build the package (Tracker Editor’s Dockerize dialog has a button for it):',
          '',
          `- Windows (PowerShell): \`${offlineBuildLine(plan, 'powershell')}\``,
          `- Mac, Linux: \`${offlineBuildLine(plan, 'posix')}\``,
          '',
          `It puts the image in \`docker/offline\` (\`${o.name}.tar.gz\`, or \`${o.name}.tar\` from PowerShell), built for ${offline}${plan.platform === 'linux/amd64' ? ' (most servers: Intel and AMD)' : plan.platform === 'linux/arm64' ? ' (ARM servers: Raspberry Pi, AWS Graviton)' : ''}.`,
          '',
          'Copy the whole `docker/offline` folder to the server (a USB drive, `scp`, a shared folder). On the server, in that folder:',
          '',
          '- Linux, Mac: `sh install.sh` (`sudo sh install.sh` if your user cannot use docker)',
          '- Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`',
          '',
          `It loads the image and starts it${plan.url ? ` (${plan.url} on the server)` : ''}. To update: build the package again, copy it over, and run the install again${o.volumes?.length ? '; the data in its volumes is kept' : ''}.`,
          '',
          'Docker must be on the server too. Without internet there:',
          '',
          '- Linux: on a computer with internet, download the packages for the server’s system from https://download.docker.com/linux/ (`containerd.io`, `docker-ce`, `docker-ce-cli`, `docker-buildx-plugin`, `docker-compose-plugin`), copy them over and install them (`sudo dpkg -i *.deb`, or `sudo dnf install ./*.rpm`).',
          '- Windows, Mac: the Docker Desktop installer works without internet.',
        ]
      : 'To install it on a server without internet, open Dockerize again in Tracker Editor and tick **Make it installable offline**: it writes a package (the image and an install script for Linux, Mac and Windows) to copy to the server.',
    '',
    '## What Docker needs here',
    '',
    '- **Docker Engine with Compose** (`docker compose`): needed. Docker Desktop has both; on Linux, the get.docker.com script installs both.',
    '- **WSL 2** (Windows): Docker Desktop runs Linux containers in it; turn it on when it asks.',
    `- **Start Docker when the computer starts** (Docker Desktop: Settings > General > Start Docker Desktop when you sign in; Linux: \`sudo systemctl enable docker\`): with \`restart: unless-stopped\`, ${o.name} comes back after a restart.`,
    '- **Buildx** (included): only to build the offline package for another kind of processor. On a Mac with an Apple chip, Settings > General > "Use Rosetta for x86_64/amd64 emulation" makes those builds faster; on Linux they need QEMU once: `docker run --privileged --rm tonistiigi/binfmt --install all`.',
    '- Not needed: Kubernetes, Swarm, a Docker Hub account.',
    '',
    '## If something goes wrong',
    '',
    plan.web ? `- **Port ${o.hostPort} is already in use**: change the first number in \`ports:\` in \`${plan.compose}\` (\`"${Number(o.hostPort) + 1}:${fixedPort(p) ? 8080 : o.port}"\`), run \`${plan.up}\` again and open http://localhost:${Number(o.hostPort) + 1}.` : null,
    '- **Cannot connect to the Docker daemon**: start Docker Desktop (Linux: `sudo systemctl start docker`).',
    '- **permission denied** (Linux): `sudo usermod -aG docker $USER`, then log out and in again.',
    '- **exec format error**: the image was built for another kind of processor than the computer’s: build it for that one (amd64 or arm64).',
    `- **It starts but the page does not open**: \`${plan.logs}\` shows why.`,
    p.notes?.length ? ['', '## Check these', '', p.notes.map((n) => `- ${n}`)] : null,
  );
}

function installSh(p, o) {
  const name = o.name;
  return lines(
    '#!/bin/sh',
    `# Installs ${name} from this folder, without internet: loads its Docker image and starts it.`,
    '# Needs Docker with Compose on this computer. Run it in this folder: sh install.sh',
    '# (on Linux with sudo if your user cannot use docker: sudo sh install.sh)',
    'set -e',
    'cd "$(dirname "$0")"',
    'if ! command -v docker >/dev/null 2>&1; then',
    '  echo "Docker is not installed on this computer: install it first (README.txt says how)." >&2',
    '  exit 1',
    'fi',
    `image=$(ls -t ${name}.tar.gz ${name}.tar 2>/dev/null | head -n 1)`,
    'if [ -z "$image" ]; then',
    `  echo "${name}.tar.gz is not here: build the offline package first, then copy this whole folder." >&2`,
    '  exit 1',
    'fi',
    'echo "Loading the image from $image (this takes a moment)..."',
    'docker load --input "$image"',
    'if [ -f .env.example ] && [ ! -f .env ]; then',
    '  cp .env.example .env',
    '  echo "Made .env from .env.example: check its settings (then run this again to use them)."',
    'fi',
    'docker compose --file compose.yml up --detach',
    servesPort(p, o) ? `echo "${name} is running: http://localhost:${o.hostPort}"` : `echo "${name} is running. What it prints: docker compose -f compose.yml logs -f"`,
  );
}

function installPs1(p, o) {
  const name = o.name;
  return lines(
    `# Installs ${name} from this folder, without internet: loads its Docker image and starts it.`,
    '# Needs Docker Desktop on this computer. Run it in PowerShell, in this folder:',
    '#   powershell -ExecutionPolicy Bypass -File install.ps1',
    "$ErrorActionPreference = 'Stop'",
    'Set-Location -LiteralPath $PSScriptRoot',
    'if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {',
    "  Write-Host 'Docker is not installed on this computer: install Docker Desktop first (README.txt says how).'",
    '  exit 1',
    '}',
    `$image = Get-ChildItem -Path '${name}.tar.gz', '${name}.tar' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1`,
    'if (-not $image) {',
    `  Write-Host '${name}.tar.gz is not here: build the offline package first, then copy this whole folder.'`,
    '  exit 1',
    '}',
    'Write-Host "Loading the image from $($image.Name) (this takes a moment)..."',
    'docker load --input $image.FullName',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    "if ((Test-Path '.env.example') -and -not (Test-Path '.env')) {",
    "  Copy-Item '.env.example' '.env'",
    "  Write-Host 'Made .env from .env.example: check its settings (then run this again to use them).'",
    '}',
    'docker compose --file compose.yml up --detach',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    servesPort(p, o) ? `Write-Host '${name} is running: http://localhost:${o.hostPort}'` : `Write-Host '${name} is running. What it prints: docker compose -f compose.yml logs -f'`,
  );
}

function offlineReadme(p, o) {
  const name = o.name;
  const title = `${name}: the offline package`;
  return lines(
    title,
    '='.repeat(title.length),
    '',
    `This folder installs ${name} on a computer without internet. That computer needs`,
    'Docker (with Compose) installed.',
    '',
    '1. Build the package on a computer with internet, in the project\'s folder (DOCKER.md',
    `   there says how, or Tracker Editor's Dockerize dialog). It writes ${name}.tar.gz`,
    `   (or ${name}.tar from PowerShell) into this folder.`,
    '2. Copy this whole folder to the server (a USB drive, scp, a shared folder).',
    '3. On the server, in this folder:',
    '     Linux, Mac:  sh install.sh        (sudo sh install.sh if needed)',
    '     Windows:     powershell -ExecutionPolicy Bypass -File install.ps1',
    servesPort(p, o) ? `4. Open http://localhost:${o.hostPort} on the server (or http://<the server's name>:${o.hostPort}).` : '4. It runs in the background: docker compose -f compose.yml logs -f shows what it prints.',
    '',
    'In this folder:',
    '  docker compose -f compose.yml ps          is it running?',
    '  docker compose -f compose.yml logs -f     what it prints',
    '  docker compose -f compose.yml down        stop it',
    '  docker compose -f compose.yml up -d       start it again',
    '',
    `To update: build the package again, copy the new ${name}.tar.gz here and run the`,
    `install again.${o.volumes?.length ? ` The data in its volumes (${o.volumes.join(', ')}) is kept.` : ''}`,
    '',
    'Installing Docker without internet:',
    '  Linux: on a computer with internet, download the packages for the server\'s system',
    '  from https://download.docker.com/linux/ (containerd.io, docker-ce, docker-ce-cli,',
    '  docker-buildx-plugin, docker-compose-plugin), copy them over and install them',
    '  (sudo dpkg -i *.deb, or sudo dnf install ./*.rpm).',
    '  Windows, Mac: the Docker Desktop installer works without internet.',
  );
}

/** What the model is asked when the person wants the files reviewed. */
export function reviewQuestion(plan) {
  const names = plan.files.map((f) => f.path).join(', ');
  return `Review the Docker files Tracker Editor wrote for this project (${names}). Check them against the project's own files: the base image and version, how dependencies are installed, the build, the start command, the port, and what .dockerignore leaves out. Fix what does not fit, and keep it as simple as it is.`;
}
