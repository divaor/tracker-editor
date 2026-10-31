// Run this file (desktop): the command for a file by its type, typed into a terminal in
// the file's folder. Pure: the tests use it. Commands can be changed in Settings.

/** Default commands by extension; {file} is the quoted path, {name} the quoted name, {dir} its folder. */
export const RUN_COMMANDS = {
  py: { posix: 'python3 {file}', win: 'python {file}' },
  js: 'node {file}',
  mjs: 'node {file}',
  cjs: 'node {file}',
  ts: 'npx tsx {file}',
  sh: 'bash {file}',
  bash: 'bash {file}',
  zsh: 'zsh {file}',
  ps1: { posix: 'pwsh -File {file}', win: 'powershell -ExecutionPolicy Bypass -File {file}' },
  bat: { win: 'cmd /c {file}' },
  cmd: { win: 'cmd /c {file}' },
  go: 'go run {file}',
  rb: 'ruby {file}',
  php: 'php {file}',
  pl: 'perl {file}',
  lua: 'lua {file}',
  r: 'Rscript {file}',
  java: 'java {file}',
  kts: 'kotlin {file}',
  swift: 'swift {file}',
  dart: 'dart run {file}',
  rs: { posix: 'rustc {file} -o /tmp/run-$$ && /tmp/run-$$' },
  c: { posix: 'cc {file} -o /tmp/run-$$ && /tmp/run-$$' },
  html: null, // opened in the browser instead
};

/** The shell a terminal runs: 'powershell' or 'cmd' (Windows), else 'posix'. */
export function shellKind(shell = '', platform = 'linux') {
  const name = shell.split(/[\\/]/).pop().toLowerCase();
  if (/^(pwsh|powershell)(\.exe)?$/.test(name)) return 'powershell';
  if (/^cmd(\.exe)?$/.test(name)) return 'cmd';
  if (!name && platform === 'win32') return 'powershell';
  return 'posix';
}

/**
 * A Windows path as WSL sees it: C:\\x\\y → /mnt/c/x/y; \\\\wsl.localhost\\Ubuntu\\home → /home.
 */
export function wslPath(p) {
  const s = String(p);
  if (/^[A-Za-z]:[\\/]/.test(s)) return `/mnt/${s[0].toLowerCase()}${s.slice(2).replace(/\\/g, '/')}`;
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(\\.*)?$/i.exec(s);
  if (unc) return (unc[1] ?? '/').replace(/\\/g, '/');
  return s.replace(/\\/g, '/');
}

/** A path quoted for a shell ('wsl': a posix shell inside WSL, the path as it sees it). */
export function quoteFor(kind, p) {
  if (kind === 'wsl') return quoteFor('posix', wslPath(p));
  if (kind === 'powershell') return `'${p.replace(/'/g, "''")}'`;
  if (kind === 'cmd') return `"${p.replace(/"/g, '')}"`;
  return /^[\w./@:+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

const extOf = (name) => (/\.([^.\\/]+)$/.exec(name)?.[1] ?? '').toLowerCase();

/**
 * The command that runs `file` ({ path, dir, name }) in a terminal: null when its type has
 * none here. `custom` (Settings: extension → command) wins over the defaults; `platform`
 * picks Windows or the others' default; `shell` is the terminal's (for quoting).
 */
export function runCommandFor(file, { platform = 'linux', shell = '', kind: given = '', custom = {} } = {}) {
  const ext = extOf(file.name);
  // WSL runs Linux's commands, wherever its terminal is opened from.
  const win = platform === 'win32' && given !== 'wsl';
  const entry = ext in custom ? custom[ext] : RUN_COMMANDS[ext];
  const template = typeof entry === 'string' ? entry : entry ? (win ? entry.win : entry.posix) : null;
  if (!template) return null;
  const kind = given || shellKind(shell, platform);
  // PowerShell runs a quoted program only after "&"; the programs here are plain names.
  return template.replace(/\{file\}/g, quoteFor(kind, file.path)).replace(/\{name\}/g, quoteFor(kind, file.name)).replace(/\{dir\}/g, quoteFor(kind, file.dir));
}

/** The line typed into the terminal: into the file's folder first, then the command. */
export function runLine({ command, dir, kind = 'posix' }) {
  if (!dir) return command;
  if (kind === 'powershell') return `Set-Location -LiteralPath ${quoteFor(kind, dir)}; ${command}`;
  if (kind === 'cmd') return `cd /d ${quoteFor(kind, dir)} && ${command}`;
  if (kind === 'wsl') return `cd -- ${quoteFor(kind, dir)} && ${command}`;
  return `cd -- ${quoteFor(kind, dir)} && ${command}`;
}

/**
 * The "Run commands" setting: one "extension: command" per line ("py: uv run {file}");
 * blank lines and lines starting with # are skipped. An empty command turns a type off.
 */
export function parseRunCommands(text = '') {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^\.?([\w+-]+)\s*:\s*(.*)$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}
