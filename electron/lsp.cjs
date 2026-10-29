// Language servers (desktop): the programs that understand code (TypeScript's, Pyright…),
// spoken to over stdio with the Language Server Protocol. This module finds them on the
// computer (CATALOG: what is on PATH or in the project, never a program the page names),
// picks the project folder, starts one per (server, folder), frames the messages and keeps
// the processes in check (six at most, restarted after a crash, stopped after three).
// Servers run in one of three places: here for files on this computer; on an SSH server for
// files there (lspRemote.cjs: found and started over the same connection); and here for the
// synced files and tracker documents, each as a file that exists only in the editor (a path
// under the notes folder, `note`). The page's CodeMirror client (app/js/lsp.js) talks through
// main.cjs's lsp:* IPC.
const { spawn: spawnProcess, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeScript, parseProbe, remoteContext, remoteCommand, channelProcess } = require('./lspRemote.cjs');

// ---- Messages: "Content-Length: n\r\n\r\n" then n bytes of JSON ----

const MAX_MESSAGE = 64 * 1024 * 1024;

/** A message with its header, ready for the server's stdin. */
function frame(text) {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Reads framed messages from the server's stdout, in whatever chunks they arrive (split
 * headers, several messages in one chunk, characters cut in two): `onMessage(text)` for each.
 * `onError(message)` when the stream is not LSP (the reader stops then).
 */
function createReader(onMessage, onError = () => {}) {
  let buffer = Buffer.alloc(0);
  let broken = false;
  return (chunk) => {
    if (broken) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > 8192) fail('A header without its end');
        return;
      }
      const header = buffer.subarray(0, end).toString('ascii');
      const m = /(?:^|\r\n)content-length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
      if (!m) return fail(`Not a language server message: ${header.slice(0, 80)}`);
      const length = Number(m[1]);
      if (length > MAX_MESSAGE) return fail('A message too large');
      if (buffer.length < end + 4 + length) return;
      const body = buffer.subarray(end + 4, end + 4 + length).toString('utf8');
      buffer = buffer.subarray(end + 4 + length);
      onMessage(body);
    }
  };
  function fail(message) {
    broken = true;
    buffer = Buffer.alloc(0);
    onError(message);
  }
}

// ---- Which server, and where it is ----

// Schemas for well-known JSON files (the JSON server fetches them from schemastore.org); a
// file's own "$schema" works too.
const SCHEMA_STORE = 'https://json.schemastore.org';
const JSON_SCHEMAS = [
  [['package.json'], 'package.json'],
  [['tsconfig.json', 'tsconfig.*.json'], 'tsconfig.json'],
  [['jsconfig.json', 'jsconfig.*.json'], 'jsconfig.json'],
  [['.eslintrc', '.eslintrc.json'], 'eslintrc.json'],
  [['.prettierrc', '.prettierrc.json'], 'prettierrc.json'],
  [['.babelrc', '.babelrc.json', 'babel.config.json'], 'babelrc.json'],
  [['composer.json'], 'composer.json'],
  [['lerna.json'], 'lerna.json'],
  [['renovate.json', '.renovaterc', '.renovaterc.json'], 'renovate.json'],
  [['vercel.json'], 'now.json'],
  [['turbo.json'], 'turbo.json'],
  [['.swcrc'], 'swcrc.json'],
  [['nest-cli.json'], 'nest-cli.json'],
  [['angular.json'], 'angular.json'],
  [['firebase.json'], 'firebase.json'],
  [['appsettings.json', 'appsettings.*.json'], 'appsettings.json'],
  [['launchSettings.json'], 'launchsettings.json'],
  [['global.json'], 'global.json'],
  [['devcontainer.json', '.devcontainer.json'], 'devcontainer.json'],
  [['manifest.json', '*.webmanifest'], 'web-manifest-combined.json'],
].map(([fileMatch, name]) => ({ fileMatch, url: `${SCHEMA_STORE}/${name}` }));

// YAML files Kubernetes reads, by where they usually live; GitHub Actions, Compose files and
// the rest are recognized by the schema store's own list.
const KUBERNETES_GLOBS = ['k8s/**/*.yaml', 'k8s/**/*.yml', 'kubernetes/**/*.yaml', 'kubernetes/**/*.yml', 'manifests/**/*.yaml', 'manifests/**/*.yml', '**/*.k8s.yaml', '**/*.k8s.yml'];

// A server installed with npm (or in the project's node_modules): `name` started with `args`.
const npmServer = (name, args, label = name) =>
  Object.assign(
    async function find(ctx) {
      const found = ctx.projectBin(name) ?? (await ctx.onPath(name));
      return found ? { name: label, ...ctx.runnable(found), args } : null;
    },
    { programs: [name] },
  );

/**
 * The servers this app knows. `find(ctx)` looks for one on this computer (ctx: the project
 * folder and helpers) and says how to start it: { name, command, args } or, for a script
 * Node runs, { name, script, args } (run on Electron's own Node: no Node.js needed).
 * `install`: the commands Set up… offers (by platform when they differ); `note`: what else to
 * know. `scope: 'folder'`: one server for the whole folder opened (light servers for single
 * files: JSON, CSS…) rather than one per project inside it. `settings` answer the server's
 * workspace/configuration and also go to it once started (didChangeConfiguration, which the
 * JSON server reads them from); `init` are its initializationOptions. `markers` are file names
 * or patterns (*.csproj), or groups of them tried in order (the first group anywhere up the
 * folders wins). `programs`: the names find() looks for, which a probe on an SSH server asks
 * about (npmServer's carry theirs); `verify`: those run with --version there first.
 */
const CATALOG = [
  {
    id: 'typescript',
    label: 'TypeScript',
    exts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    languageIds: { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact' },
    markers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    programs: ['typescript-language-server', 'tsc'],
    // TypeScript 7 has its language server built in (tsc --lsp).
    install: ['npm install -g typescript'],
    // Answers to workspace/configuration, by section: F2 renames the symbol everywhere rather
    // than giving an import a local alias (VS Code's default).
    settings: Object.fromEntries(['js/ts', 'typescript', 'javascript'].map((section) => [section, { preferences: { useAliasesForRenames: false } }])),
    async find(ctx) {
      // The project's own TypeScript first: 7 and later speak LSP themselves; older ones
      // through typescript-language-server (the project's, or one installed for everyone).
      const own = ctx.typescriptIn(ctx.root);
      if (own && own.major >= 7) return { name: `TypeScript ${own.version}`, ...own.server, args: ['--lsp', '--stdio'] };
      const tls = ctx.projectBin('typescript-language-server') ?? (await ctx.onPath('typescript-language-server'));
      const preferences = { useAliasesForRenames: false };
      if (own && tls) return { name: `TypeScript ${own.version}`, ...ctx.runnable(tls), args: ['--stdio'], init: { preferences } };
      const tsc = await ctx.onPath('tsc');
      const global = tsc && ctx.typescriptOf(tsc);
      if (global && global.major >= 7) return { name: `TypeScript ${global.version}`, ...global.server, args: ['--lsp', '--stdio'] };
      if (tls) {
        // An older TypeScript next to it (installed together for everyone).
        const fallback = global?.tsserver ?? ctx.siblingTsserver(tls);
        return { name: global ? `TypeScript ${global.version}` : 'typescript-language-server', ...ctx.runnable(tls), args: ['--stdio'], init: { preferences, ...(fallback ? { tsserver: { fallbackPath: fallback } } : {}) } };
      }
      return null;
    },
  },
  {
    id: 'python',
    label: 'Python (Pyright)',
    exts: ['.py', '.pyi'],
    languageIds: { '.py': 'python', '.pyi': 'python' },
    markers: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'setup.cfg', 'requirements.txt'],
    install: ['npm install -g pyright', 'pip install pyright'],
    programs: ['pyright-langserver', 'basedpyright-langserver'],
    async find(ctx) {
      for (const name of ['pyright-langserver', 'basedpyright-langserver']) {
        const found = ctx.projectBin(name) ?? (await ctx.onPath(name));
        if (found) return { name: name.startsWith('based') ? 'basedpyright' : 'Pyright', ...ctx.runnable(found), args: ['--stdio'] };
      }
      return null;
    },
  },
  {
    id: 'go',
    label: 'Go (gopls)',
    exts: ['.go'],
    languageIds: { '.go': 'go' },
    markers: ['go.work', 'go.mod'],
    install: ['go install golang.org/x/tools/gopls@latest'],
    note: 'It needs Go (go.dev/dl).',
    programs: ['gopls'],
    async find(ctx) {
      const found = await ctx.onPath('gopls');
      return found ? { name: 'gopls', ...ctx.runnable(found), args: [] } : null;
    },
  },
  {
    id: 'rust',
    label: 'Rust (rust-analyzer)',
    exts: ['.rs'],
    languageIds: { '.rs': 'rust' },
    markers: ['Cargo.toml'],
    install: ['rustup component add rust-analyzer'],
    note: 'It needs Rust (rustup.rs).',
    programs: ['rust-analyzer'],
    verify: ['rust-analyzer'],
    async find(ctx) {
      const found = await ctx.onPath('rust-analyzer');
      // rustup puts a stand-in on PATH that fails until the component is added.
      if (!found || !(await ctx.works(found, ['--version']))) return null;
      return { name: 'rust-analyzer', ...ctx.runnable(found), args: [] };
    },
  },
  {
    id: 'c',
    label: 'C and C++ (clangd)',
    exts: ['.c', '.h', '.cc', '.cpp', '.cxx', '.c++', '.hh', '.hpp', '.hxx', '.h++', '.ipp', '.inl'],
    languageIds: { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.c++': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.h++': 'cpp', '.ipp': 'cpp', '.inl': 'cpp' },
    markers: ['compile_commands.json', 'compile_flags.txt', '.clangd'],
    install: { win32: ['winget install LLVM.LLVM'], darwin: ['xcode-select --install', 'brew install llvm'], default: ['sudo apt install clangd', 'sudo dnf install clang-tools-extra'] },
    note: 'For a project built with CMake or make, a compile_commands.json (cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON) tells it the flags.',
    programs: ['clangd'],
    async find(ctx) {
      const found = await ctx.onPath('clangd');
      return found ? { name: 'clangd', ...ctx.runnable(found), args: [] } : null;
    },
  },
  {
    id: 'java',
    label: 'Java (jdtls)',
    exts: ['.java'],
    languageIds: { '.java': 'java' },
    // A Gradle build's top folder first (its settings file), else the nearest project.
    markers: [['settings.gradle', 'settings.gradle.kts'], ['pom.xml', 'build.gradle', 'build.gradle.kts', '.project']],
    install: { darwin: ['brew install jdtls'], win32: ['scoop install jdtls'], default: ['brew install jdtls'] },
    note: 'It needs a recent Java (25 for current versions: the one JAVA_HOME names, else java on PATH) and Python 3, which starts it. Or download it from download.eclipse.org/jdtls/milestones, unpack it and put its bin folder on PATH. It keeps what it learns about each project in its own cache folder, not in the project. The first time it reads a project can take a minute.',
    programs: ['jdtls'],
    async find(ctx) {
      const found = await ctx.onPath('jdtls');
      return found ? { name: 'jdtls', ...ctx.runnable(found), args: [] } : null;
    },
  },
  {
    id: 'csharp',
    label: 'C# (csharp-ls)',
    exts: ['.cs', '.csx'],
    languageIds: { '.cs': 'csharp', '.csx': 'csharp' },
    // The solution first: the nearest project alone misses the others it uses.
    markers: [['*.sln', '*.slnx'], ['*.csproj']],
    install: ['dotnet tool install --global csharp-ls'],
    note: 'It needs the .NET SDK (dotnet.microsoft.com/download). The newest csharp-ls wants the newest SDK; with .NET 8 add --version 0.16.0. dotnet puts it in ~/.dotnet/tools, which the editor looks in.',
    programs: ['csharp-ls'],
    async find(ctx) {
      const found = await ctx.onPath('csharp-ls');
      return found ? { name: 'csharp-ls', ...ctx.runnable(found), args: [] } : null;
    },
  },
  {
    id: 'json',
    label: 'JSON',
    exts: ['.json', '.jsonc', '.code-workspace'],
    languageIds: { '.json': 'json', '.jsonc': 'jsonc', '.code-workspace': 'jsonc' },
    markers: [],
    scope: 'folder',
    install: ['npm install -g vscode-langservers-extracted'],
    note: 'The same package gives CSS and HTML their servers. Schemas for package.json, tsconfig.json and other well-known files come from schemastore.org.',
    init: { provideFormatter: true },
    settings: { json: { validate: { enable: true }, format: { enable: true }, schemas: JSON_SCHEMAS } },
    find: npmServer('vscode-json-language-server', ['--stdio'], 'JSON'),
  },
  {
    id: 'css',
    label: 'CSS, SCSS and Less',
    exts: ['.css', '.scss', '.less'],
    languageIds: { '.css': 'css', '.scss': 'scss', '.less': 'less' },
    markers: [],
    scope: 'folder',
    install: ['npm install -g vscode-langservers-extracted'],
    note: 'The same package gives JSON and HTML their servers.',
    init: { provideFormatter: true },
    settings: Object.fromEntries(['css', 'scss', 'less'].map((section) => [section, { validate: true, lint: {} }])),
    find: npmServer('vscode-css-language-server', ['--stdio'], 'CSS'),
  },
  {
    id: 'html',
    label: 'HTML',
    exts: ['.html', '.htm', '.xhtml'],
    languageIds: { '.html': 'html', '.htm': 'html', '.xhtml': 'html' },
    markers: [],
    scope: 'folder',
    install: ['npm install -g vscode-langservers-extracted'],
    note: 'The same package gives JSON and CSS their servers.',
    init: { provideFormatter: true, embeddedLanguages: { css: true, javascript: true }, configurationSection: ['html', 'css', 'javascript'] },
    settings: { html: { format: { enable: true }, validate: { scripts: true, styles: true }, suggest: { html5: true } }, css: { validate: true }, javascript: { validate: { enable: true } } },
    find: npmServer('vscode-html-language-server', ['--stdio'], 'HTML'),
  },
  {
    id: 'yaml',
    label: 'YAML',
    exts: ['.yaml', '.yml'],
    languageIds: { '.yaml': 'yaml', '.yml': 'yaml' },
    markers: [],
    scope: 'folder',
    install: ['npm install -g yaml-language-server'],
    note: 'GitHub Actions workflows, Compose files and many others are checked against their schemas (schemastore.org); Kubernetes files in k8s/, kubernetes/ or manifests/ folders, or named *.k8s.yaml. A first line "# yaml-language-server: $schema=<url>" picks one for any file.',
    settings: { yaml: { validate: true, hover: true, completion: true, format: { enable: true }, schemaStore: { enable: true }, schemas: { kubernetes: KUBERNETES_GLOBS } } },
    find: npmServer('yaml-language-server', ['--stdio'], 'YAML'),
  },
  {
    id: 'bash',
    label: 'Bash',
    exts: ['.sh', '.bash'],
    languageIds: { '.sh': 'shellscript', '.bash': 'shellscript' },
    markers: [],
    scope: 'folder',
    install: ['npm install -g bash-language-server'],
    note: 'Its problems come from ShellCheck: install it too (winget install koalaman.shellcheck, brew install shellcheck, or sudo apt install shellcheck).',
    find: npmServer('bash-language-server', ['start'], 'Bash'),
  },
];

/** The commands Set up… offers for an entry on this platform. */
const installFor = (entry, platform = process.platform) => (Array.isArray(entry.install) ? entry.install : (entry.install?.[platform] ?? entry.install?.default ?? []));

/** The entry for a file, by its extension: the person's own servers first, then the catalog. */
const catalogFor = (file, entries = CATALOG) => {
  const ext = path.extname(String(file)).toLowerCase();
  return entries.find((e) => e.exts.includes(ext)) ?? null;
};

/** The folder a server runs for: the project (markers), or the whole folder opened for `scope: 'folder'` servers. */
function rootFor(entry, file, { stop = '', exists = fs.existsSync } = {}) {
  if (entry.scope === 'folder' && stop && isInside(stop, path.dirname(file))) return path.resolve(stop);
  return findRoot(file, entry.markers, { stop, exists });
}

// ---- Servers the person adds (Settings → Language servers), kept in prefs.json ----

/**
 * "--stdio --log 'a b'" → ['--stdio', '--log', 'a b']: quotes group, as a shell would; inside
 * double quotes only \" is special, so Windows paths keep their backslashes.
 */
function parseArgs(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of String(text ?? '').matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : (m[2] ?? m[3]));
  return out;
}

/**
 * A server the person described, checked: { id, label, exts, command, args, markers }. Throws
 * with what is wrong. Extensions as ".lua, .luau" (or without dots); args as text or a list.
 */
function cleanCustom(def) {
  const label = String(def?.label ?? '').trim();
  if (!label || label.length > 40) throw new Error('Give it a name (up to 40 characters).');
  const exts = [...new Set(String(Array.isArray(def.exts) ? def.exts.join(',') : (def.exts ?? '')).split(/[\s,;]+/).filter(Boolean).map((e) => `.${e.replace(/^\*?\./, '').toLowerCase()}`))];
  if (!exts.length || exts.length > 12 || exts.some((e) => !/^\.[a-z0-9_+-]{1,15}$/.test(e))) throw new Error('Give the file extensions it is for, like .lua or .lua, .luau.');
  const command = String(def.command ?? '').trim();
  if (!command || command.length > 500 || /[\r\n\0]/.test(command)) throw new Error('Give the program to run: its name (found on PATH) or its full path.');
  const args = Array.isArray(def.args) ? def.args.map(String) : parseArgs(def.args);
  if (args.length > 30 || args.some((a) => a.length > 300 || /[\r\n\0]/.test(a))) throw new Error('Too many arguments, or one too long.');
  const markers = String(Array.isArray(def.markers) ? def.markers.join(',') : (def.markers ?? '')).split(/[\s,;]+/).filter(Boolean).slice(0, 10);
  if (markers.some((m) => m.length > 100 || /[\\/]|^\.\.?$/.test(m))) throw new Error('Project markers are file names, like stylua.toml or .luarc.json.');
  const id = /^[a-z0-9-]{1,40}$/.test(def.id ?? '') ? def.id : label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'server';
  return { id, label, exts, command, args, markers };
}

/** A custom server as a catalog entry: it runs exactly the program it names. */
function customEntry(def) {
  return {
    id: `custom:${def.id}`,
    label: def.label,
    custom: true,
    command: [def.command, ...def.args].join(' '),
    exts: def.exts,
    languageIds: Object.fromEntries(def.exts.map((e) => [e, e.slice(1)])),
    markers: def.markers ?? [],
    scope: def.markers?.length ? undefined : 'folder',
    install: [],
    async find(ctx) {
      const found = path.isAbsolute(def.command) ? (isFile(def.command) ? def.command : null) : await ctx.onPath(def.command);
      return found ? { name: def.label, ...ctx.runnable(found), args: def.args } : null;
    },
  };
}

/**
 * The project a file belongs to: the nearest folder up from it with one of `markers` (or a
 * .git), never above `stop` (the folder the person picked); else the file's own folder.
 * Markers may be patterns (*.sln: `list` gives a folder's names), or groups tried in order.
 */
function findRoot(file, markers, { stop = '', exists = fs.existsSync, list = listNames } = {}) {
  const start = path.dirname(file);
  const limit = stop && isInside(stop, start) ? path.resolve(stop) : null;
  const groups = markers.length && Array.isArray(markers[0]) ? markers : [markers];
  const has = (dir, m) => (/[*?]/.test(m) ? list(dir).some((name) => globRegex(m).test(name)) : exists(path.join(dir, m)));
  let gitRoot = null;
  for (const [i, group] of groups.entries()) {
    for (let dir = start; ; dir = path.dirname(dir)) {
      if (group.some((m) => has(dir, m))) return dir;
      if (i === 0 && !gitRoot && exists(path.join(dir, '.git'))) gitRoot = dir;
      if (!limit || dir === limit || path.dirname(dir) === dir) break;
    }
  }
  return gitRoot ?? start;
}
const globRegex = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
function listNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
const isInside = (parent, child) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** A program on PATH: the first folder holding `name` (on Windows, with PATHEXT's extensions). */
function searchPath(name, { env = process.env, platform = process.platform, exists = isFile } = {}) {
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  const exts = platform === 'win32' ? ['.cmd', '.exe', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter((e) => e && e !== '.cmd' && e !== '.exe'), ''] : [''];
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * How to run a program that was found: Node scripts (an npm link, or the script an npm
 * .cmd shim names) on Electron's own Node; other .cmd and .bat files through cmd.exe (Node
 * starts them no other way); anything else as it is, by the path it was found at (rustup's
 * rust-analyzer is a link to rustup, which picks the program by the name it is run as).
 */
function runnable(found, { platform = process.platform, realpath = (p) => fs.realpathSync(p), read = (p) => fs.readFileSync(p, 'utf8').slice(0, 4096) } = {}) {
  let real = found;
  try {
    real = realpath(found);
  } catch {
    // keep the path as found
  }
  if (/\.(c|m)?js$/i.test(real)) return { script: real };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(real)) {
    const shim = /"%~?dp0%?\\([^"]+)"\s+%\*/i.exec(safeRead(read, real));
    if (shim) return { script: path.win32.join(path.win32.dirname(real), shim[1]) };
    return { command: real, shell: true };
  }
  if (platform !== 'win32' && /^#!.*\bnode\b/.test(safeRead(read, real).split('\n')[0])) return { script: real };
  return { command: found };
}
const safeRead = (read, p) => {
  try {
    return read(p);
  } catch {
    return '';
  }
};

/**
 * The TypeScript in a folder's node_modules: { version, major, tsserver, server }. TypeScript 7
 * is a native program (`server`: its tsc, from the package for this platform, else the script
 * that starts it); older ones have tsserver.js, which typescript-language-server uses.
 */
function typescriptIn(dir, opts) {
  return typescriptPackage(path.join(dir, 'node_modules', 'typescript'), opts);
}
function typescriptPackage(dir, { read = (p) => fs.readFileSync(p, 'utf8'), exists = isFile, resolve = require.resolve, platform = process.platform, arch = process.arch } = {}) {
  try {
    const { version } = JSON.parse(read(path.join(dir, 'package.json')));
    const major = Number(String(version).split('.')[0]);
    const tsserver = path.join(dir, 'lib', 'tsserver.js');
    let server = null;
    if (major >= 7) {
      let exe = null;
      try {
        const pkg = resolve(`@typescript/typescript-${platform}-${arch}/package.json`, { paths: [dir] });
        exe = path.join(path.dirname(pkg), 'lib', platform === 'win32' ? 'tsc.exe' : 'tsc');
      } catch {
        // not installed for this platform: the script finds it, or says why
      }
      server = exe && exists(exe) ? { command: exe } : { script: path.join(dir, 'lib', 'tsc.js') };
    }
    return { version, major, tsserver: exists(tsserver) ? tsserver : null, server };
  } catch {
    return null;
  }
}

/** The PATH of a login shell (macOS and Linux): apps started from the dock or menu get less. */
let loginPath = null;
function shellPath({ env = process.env, platform = process.platform, run = execFile } = {}) {
  if (platform === 'win32') return Promise.resolve('');
  loginPath ??= new Promise((resolve) => {
    const shell = env.SHELL || '/bin/sh';
    run(shell, ['-ilc', 'printf "\\n__TE_PATH__%s\\n" "$PATH"'], { timeout: 4000, env: { ...env, TERM: 'dumb' } }, (_err, stdout) => {
      resolve(/__TE_PATH__(.*)/.exec(String(stdout ?? ''))?.[1]?.trim() ?? '');
    });
  });
  return loginPath;
}
/**
 * PATH with the login shell's folders (`extra`) and the usual install places (`known`) added
 * after the app's own.
 */
function searchEnv(env, extra, platform = process.platform, known = true) {
  const sep = platform === 'win32' ? ';' : ':';
  const home = os.homedir();
  // npm's global folder, Go's, Cargo's and dotnet's tool folders, LLVM's (clangd), scoop's shims.
  const goBin = env.GOPATH ? [path.join(String(env.GOPATH).split(sep)[0], 'bin')] : [];
  const places = !known
    ? []
    : platform === 'win32'
      ? [env.APPDATA && path.win32.join(env.APPDATA, 'npm'), ...goBin, env.USERPROFILE && path.win32.join(env.USERPROFILE, 'go', 'bin'), env.USERPROFILE && path.win32.join(env.USERPROFILE, '.cargo', 'bin'), env.USERPROFILE && path.win32.join(env.USERPROFILE, '.dotnet', 'tools'), env.USERPROFILE && path.win32.join(env.USERPROFILE, 'scoop', 'shims'), env.ProgramFiles && path.win32.join(env.ProgramFiles, 'LLVM', 'bin')]
      : [
          path.join(home, '.local', 'bin'),
          path.join(home, '.npm-global', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
          ...goBin,
          path.join(home, 'go', 'bin'),
          path.join(home, '.cargo', 'bin'),
          path.join(home, '.dotnet', 'tools'),
          ...(platform === 'darwin' ? ['/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin', '/Library/Developer/CommandLineTools/usr/bin'] : []),
        ];
  const dirs = [...String(env.PATH ?? env.Path ?? '').split(sep), ...String(extra || '').split(sep), ...places].filter(Boolean);
  const out = { ...env, PATH: [...new Set(dirs)].join(sep) };
  if (platform === 'win32' && env.Path !== undefined) delete out.Path;
  return out;
}

/** The server's environment: the app's, without Electron's variables (nor an AppImage's libraries). */
function serverEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null || /^(ELECTRON_|CHROME_)|^(APPIMAGE|APPDIR|ARGV0|OWD)$/.test(k)) continue;
    out[k] = v;
  }
  if (env.APPDIR && out.LD_LIBRARY_PATH) {
    const kept = out.LD_LIBRARY_PATH.split(':').filter((p) => p && !p.startsWith(env.APPDIR));
    if (kept.length) out.LD_LIBRARY_PATH = kept.join(':');
    else delete out.LD_LIBRARY_PATH;
  }
  return out;
}

/**
 * Looks for the server for a file's project: { entry, root, found, env } (found null when
 * missing). `login: false` looks only on `env`'s PATH (the tests); `root` sets the folder.
 */
async function locate(file, { stop = '', root: rootGiven = '', env = process.env, platform = process.platform, login = true, entries = CATALOG, nodePath = process.execPath, run = execFile } = {}) {
  const entry = catalogFor(file, entries);
  if (!entry) return null;
  const root = rootGiven || rootFor(entry, file, { stop });
  const searchIn = searchEnv(env, login ? await shellPath({ env, platform }) : '', platform, login);
  const binIn = (dir, name) => {
    const bin = path.join(dir, 'node_modules', '.bin', name);
    for (const candidate of platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`] : [bin]) if (isFile(candidate)) return candidate;
    return null;
  };
  const ctx = {
    root,
    projectBin: (name) => binIn(root, name),
    onPath: async (name) => searchPath(name, { env: searchIn, platform }),
    runnable: (found) => runnable(found, { platform }),
    // Whether a program found runs at all (`args`: something quick, like --version).
    works: (found, args) =>
      new Promise((resolve) => {
        const how = runnable(found, { platform });
        const [command, argv, extra] = how.script ? [nodePath, [how.script, ...args], { ELECTRON_RUN_AS_NODE: '1' }] : [how.command, args, {}];
        run(command, argv, { timeout: 8000, windowsHide: true, shell: Boolean(how.shell), env: { ...serverEnv(searchIn), ...extra } }, (err) => resolve(!err));
      }),
    typescriptIn: (dir) => typescriptIn(dir),
    // `tsc` found on PATH → the TypeScript package it belongs to.
    typescriptOf: (tsc) => {
      const script = runnable(tsc, { platform }).script;
      return script ? typescriptPackage(path.resolve(path.dirname(script), '..')) : null;
    },
    // typescript-language-server installed for everyone → the TypeScript installed next to it.
    siblingTsserver: (tls) => {
      const script = runnable(tls, { platform }).script;
      const parts = script ? script.split(/[\\/]node_modules[\\/]/) : [];
      return parts.length > 1 ? (typescriptIn(parts.slice(0, -1).join(`${path.sep}node_modules${path.sep}`))?.tsserver ?? null) : null;
    },
  };
  const found = await entry.find(ctx);
  return { entry, root, found, env: searchIn };
}


// ---- Running them ----

const MAX_SERVERS = 6;
const STDERR_LINES = 200;
const CRASH_WINDOW = 5 * 60 * 1000;
const MAX_QUEUED = 200; // messages kept for a server still starting on an SSH server

/**
 * The running servers. `send(sender, channel, payload)` reaches the page; `spawn` and
 * `nodePath` (the program that runs Node scripts: Electron with ELECTRON_RUN_AS_NODE) stand in
 * for the real ones in the tests. `remote` (main.cjs, over remote.cjs): `run(id, script)` →
 * its output, `exec(id, command)` → an exec channel, `label(id)`, `connected(id)`.
 */
function createLspHost({ send, spawn = spawnProcess, nodePath = process.execPath, env = process.env, platform = process.platform, now = Date.now, locateServer = locate, catalog = () => CATALOG, remote = null } = {}) {
  const servers = new Map(); // id → server
  let nextId = 1;

  const status = (s, state, message = '') => {
    s.state = state;
    s.message = message;
    send(s.sender, 'lsp:status', { id: s.id, state, message, server: s.name, generation: s.generation });
  };

  // Each start is a new process: the page connects to it again (initialize, open files).
  function newGeneration(s) {
    s.generation = (s.generation ?? 0) + 1;
    s.queue = [];
    s.stopping = false;
  }

  function launch(s) {
    if (s.where.kind === 'remote') return launchRemote(s);
    const { found } = s;
    const base = serverEnv(s.env);
    // A .cmd or .bat that is not an npm shim goes through cmd.exe (shell), its path quoted.
    const program = found.shell ? `"${found.command}"` : found.command;
    const [command, args, extraEnv] = found.script ? [nodePath, [found.script, ...found.args], { ELECTRON_RUN_AS_NODE: '1' }] : [program, found.args, {}];
    s.commandLine = [found.script ? 'node' : command, ...(found.script ? [found.script, ...found.args] : args)].join(' ');
    let proc;
    try {
      proc = spawn(command, args, { cwd: s.root, env: { ...base, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: Boolean(found.shell) });
    } catch (err) {
      status(s, 'stopped', `Could not start ${s.name}: ${err.message}`);
      return;
    }
    newGeneration(s);
    wire(s, proc);
    status(s, 'starting');
  }

  // On an SSH server: an exec channel of the files' connection runs it there. Messages the
  // page sends meanwhile wait for the channel.
  async function launchRemote(s) {
    const { found, where } = s;
    s.commandLine = `${[found.command, ...found.args].join(' ')} (on ${where.name})`;
    newGeneration(s);
    const generation = s.generation;
    status(s, 'starting');
    let stream;
    try {
      stream = await remote.exec(where.id, remoteCommand({ root: s.root, command: found.command, args: found.args, path: s.path }));
    } catch (err) {
      if (s.generation === generation && !s.removed) status(s, 'stopped', `Could not start ${s.name} on ${where.name}: ${err.message}`);
      return;
    }
    if (s.removed || s.generation !== generation) {
      stream.close();
      return;
    }
    wire(s, channelProcess(stream));
  }

  function wire(s, proc) {
    s.proc = proc;
    const read = createReader(
      (text) => send(s.sender, 'lsp:message', { id: s.id, data: text }),
      (problem) => {
        addStderr(s, `[Tracker Editor] ${problem}`);
        proc.kill();
      },
    );
    proc.stdout.on('data', read);
    let partial = '';
    proc.stderr?.on('data', (chunk) => {
      const lines = (partial + chunk.toString('utf8')).split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) addStderr(s, line);
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => {
      addStderr(s, `[Tracker Editor] ${err.message}`);
      exited(s, proc, null);
    });
    proc.on('exit', (code) => exited(s, proc, code));
    // What the page sent while it was starting.
    for (const text of s.queue.splice(0)) proc.stdin.write(frame(text));
  }

  function addStderr(s, line) {
    s.stderr.push(line);
    if (s.stderr.length > STDERR_LINES) s.stderr.splice(0, s.stderr.length - STDERR_LINES);
  }

  function exited(s, proc, code) {
    if (s.proc !== proc) return;
    s.proc = null;
    if (s.stopping || s.removed) {
      if (!s.removed) status(s, 'stopped', '');
      return;
    }
    // The connection went: it starts again once the person reconnects (Restart), not by itself.
    if (s.where.kind === 'remote' && !remote.connected(s.where.id)) return status(s, 'stopped', `The connection to ${s.where.name} closed. Restart ${s.name} once it is connected again.`);
    const t = now();
    s.crashes = s.crashes.filter((c) => t - c < CRASH_WINDOW).concat(t);
    if (s.crashes.length >= 3) return status(s, 'stopped', `${s.name} stopped working (it ended ${s.crashes.length} times in 5 minutes${code != null ? `, last with code ${code}` : ''}). Restart it from the Language servers panel.`);
    const wait = 1000 * 2 ** (s.crashes.length - 1);
    status(s, 'restarting', `${s.name} ended${code != null ? ` (code ${code})` : ''}; starting it again…`);
    s.retry = setTimeout(() => {
      if (!s.removed && !s.proc) launch(s);
    }, wait);
    s.retry.unref?.();
  }

  function stopProcess(s) {
    clearTimeout(s.retry);
    const proc = s.proc;
    s.stopping = true;
    if (!proc) return;
    try {
      proc.stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', id: '__shutdown__', method: 'shutdown', params: null })));
      proc.stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: null })));
    } catch {
      // gone already
    }
    const kill = setTimeout(() => {
      if (s.proc === proc) proc.kill();
    }, 2000);
    kill.unref?.();
  }

  // The seventh server stops the one used longest ago.
  function makeRoom() {
    const live = [...servers.values()].filter((s) => !s.removed);
    if (live.length < MAX_SERVERS) return;
    const oldest = live.sort((a, b) => a.used - b.used)[0];
    stop(oldest.id, `${oldest.name} was stopped: at most ${MAX_SERVERS} language servers run at once.`);
  }

  const sameWhere = (a, b) => a.kind === b.kind && (a.kind !== 'remote' || a.id === b.id);
  function running(sender, entry, root, where) {
    for (const s of servers.values()) {
      if (s.entry.id === entry.id && s.root === root && s.sender === sender && sameWhere(s.where, where) && !s.removed) {
        s.used = now();
        return s;
      }
    }
    return null;
  }

  /**
   * The server for a file, started when needed: its info, `{ none }` (no server for this
   * kind of file) or `{ missing }` (none installed: what Set up… offers). `stop`: the folder
   * the project search does not go above (on an SSH server, '' is its home folder). `remote`:
   * the SSH connection the file is on (`file` its path there); `note`: `file` exists only in the
   * editor, and `root` is the notes folder.
   */
  async function start(sender, file, { stop: stopDir = '', remote: connId = '', note = false, root: noteRoot = '' } = {}) {
    // Servers of your own were confirmed to run on this computer: not on SSH servers.
    const entries = connId ? catalog().filter((e) => !e.custom) : catalog();
    const entry = catalogFor(file, entries);
    if (!entry) return { none: true };
    const languageId = entry.languageIds[path.extname(file).toLowerCase()];
    if (connId) return startRemote(sender, file, entry, languageId, connId, stopDir);
    const where = note ? { kind: 'notes' } : { kind: 'local' };
    const root = note ? noteRoot : rootFor(entry, file, { stop: stopDir });
    // Stopped after crashes: Restart in the panel brings it back, not every file opened.
    const known = running(sender, entry, root, where);
    if (known) return info(known, languageId);
    const located = await locateServer(file, { stop: stopDir, root: note ? noteRoot : '', env, platform, entries, nodePath });
    if (!located?.found) return { missing: { id: entry.id, language: entry.label, install: installFor(entry, platform), note: entry.note ?? '', custom: Boolean(entry.custom), command: entry.command ?? '', root, where } };
    return add({ entry, root, found: located.found, env: located.env ?? env, sender, where }, languageId);
  }

  async function startRemote(sender, file, entry, languageId, connId, stopDir) {
    if (!remote) return { none: true };
    const where = { kind: 'remote', id: connId, name: remote.label(connId) };
    const script = probeScript({ file, markers: entry.markers, stop: stopDir, scope: entry.scope, programs: entry.programs ?? entry.find.programs ?? [], verify: entry.verify ?? [], typescript: entry.id === 'typescript' });
    let probe;
    try {
      probe = parseProbe(await remote.run(connId, script));
    } catch (err) {
      throw new Error(`Could not look for ${entry.label} on ${where.name}: ${err.message}`);
    }
    if (!probe.complete || !probe.root) throw new Error(`Could not look for ${entry.label} on ${where.name}: its shell did not answer as expected.`);
    const known = running(sender, entry, probe.root, where);
    if (known) return info(known, languageId);
    const found = await entry.find(remoteContext(probe));
    if (!found) return { missing: { id: entry.id, language: entry.label, install: installFor(entry, 'linux'), note: entry.note ?? '', custom: false, command: '', root: probe.root, where } };
    return add({ entry, root: probe.root, found, path: probe.path, sender, where }, languageId);
  }

  function add(fields, languageId) {
    makeRoom();
    const s = { id: `lsp${nextId++}`, name: fields.found.name, stderr: [], crashes: [], used: now(), state: 'starting', message: '', generation: 0, queue: [], ...fields };
    servers.set(s.id, s);
    launch(s);
    return info(s, languageId);
  }

  const info = (s, languageId) => ({
    id: s.id,
    server: s.name,
    language: s.entry.label,
    root: s.root,
    languageId,
    where: s.where,
    init: s.entry.init || s.found.init ? { ...s.entry.init, ...s.found.init } : null,
    settings: s.entry.settings ?? null,
    state: s.state,
    message: s.message,
    generation: s.generation ?? 0,
  });

  // `sender` (the page asking): only its own servers.
  const own = (id, sender) => {
    const s = servers.get(id);
    return s && (!sender || s.sender === sender) ? s : null;
  };

  function write(id, text, sender) {
    const s = own(id, sender);
    if (!s || typeof text !== 'string' || text.length > MAX_MESSAGE) return false;
    s.used = now();
    if (!s.proc) {
      // Starting on an SSH server: it gets them once its channel is open.
      if (s.where.kind !== 'remote' || s.state !== 'starting' || s.queue.length >= MAX_QUEUED) return false;
      s.queue.push(text);
      return true;
    }
    try {
      s.proc.stdin.write(frame(text));
      return true;
    } catch {
      return false;
    }
  }

  function stop(id, message = '', sender) {
    const s = own(id, sender);
    if (!s) return false;
    s.removed = true;
    stopProcess(s);
    servers.delete(id);
    send(s.sender, 'lsp:status', { id, state: 'removed', message, server: s.name });
    return true;
  }

  function restart(id, sender) {
    const s = own(id, sender);
    if (!s) return false;
    s.crashes = [];
    const relaunch = () => {
      if (!s.removed) launch(s);
    };
    if (s.proc) {
      const proc = s.proc;
      stopProcess(s);
      proc.once('exit', () => setTimeout(relaunch, 50));
    } else relaunch();
    return true;
  }

  const list = (sender) =>
    [...servers.values()]
      .filter((s) => !sender || s.sender === sender)
      .map((s) => ({ id: s.id, server: s.name, language: s.entry.label, root: s.root, where: s.where, state: s.state, message: s.message, command: s.commandLine, pid: s.proc?.pid ?? null, stderr: s.stderr.slice(-60) }));

  const stopAll = (sender) => {
    for (const s of [...servers.values()]) if (!sender || s.sender === sender) stop(s.id);
  };
  /** Stops the servers of a catalog entry (a custom server changed or was removed). */
  const stopEntry = (entryId, message = '') => {
    for (const s of [...servers.values()]) if (s.entry.id === entryId) stop(s.id, message);
  };
  /** Stops the servers on an SSH server (it was disconnected or removed). */
  const stopRemote = (connId, message = '') => {
    for (const s of [...servers.values()]) if (s.where.kind === 'remote' && s.where.id === connId) stop(s.id, message);
  };

  return { start, write, stop, restart, list, stopAll, stopEntry, stopRemote };
}

module.exports = { frame, createReader, CATALOG, JSON_SCHEMAS, catalogFor, installFor, findRoot, rootFor, searchPath, runnable, typescriptIn, searchEnv, serverEnv, shellPath, locate, createLspHost, parseArgs, cleanCustom, customEntry, MAX_SERVERS };
