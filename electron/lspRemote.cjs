// Language servers on SSH servers: the server runs there, over an exec channel of the same
// connection as the files (no pty: its stdin and stdout carry the messages), and sees the
// files under their own paths there (remote://id/x is file:///x to it). What runs is found by
// one shell script per start (probeScript): the project folder by the catalog's markers, the
// programs on the login shell's PATH (and the usual install places) or in the project's
// node_modules/.bin, and TypeScript's versions. Nothing is installed there and only catalog
// programs run (never one the page names). Pure apart from channelProcess; tested.
const { EventEmitter } = require('node:events');
const { posix } = require('node:path');

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Where servers are usually installed, after the login shell's own PATH.
const EXTRA_PATH = ['$HOME/.local/bin', '$HOME/.npm-global/bin', '$HOME/go/bin', '$HOME/.cargo/bin', '$HOME/.dotnet/tools', '/usr/local/bin', '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin'];

// Program names a probe asks about: plain names only (they go into the script as they are).
const PROGRAM = /^[A-Za-z0-9._+-]{1,80}$/;
const MARKER = /^[A-Za-z0-9._*?+-]{1,100}$/;

/**
 * The shell script that looks around a file on the server: `file` (its path there), `markers`
 * (the catalog's: names, `*.ext` patterns, or groups of them tried in order), `stop` (a folder
 * the search does not go above; '' = the home folder when the file is inside it), `scope`
 * ('folder': a light server, for the Git repository the file is in, else its folder),
 * `programs` (names to find), `verify` (those to run with --version: a stand-in that fails does
 * not count), `typescript` (report the project's and the global TypeScript's versions).
 */
function probeScript({ file, markers = [], stop = '', scope = '', programs = [], verify = [], typescript = false }) {
  const groups = (markers.length && Array.isArray(markers[0]) ? markers : [markers]).map((g) => g.filter((m) => MARKER.test(m)));
  const names = programs.filter((n) => PROGRAM.test(n));
  const start = posix.dirname(posix.normalize(String(file))) || '/';
  const lines = [
    // The login shell's PATH (between marks: profiles may print), then the one this command
    // got, then the usual places.
    `L=$("\${SHELL:-/bin/sh}" -ilc 'printf "\\n__TE_PATH__%s\\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^__TE_PATH__//p' | tail -n 1)`,
    `PATH="\${L:+$L:}$PATH:${EXTRA_PATH.join(':')}"`,
    'export PATH',
    `printf 'path\\t%s\\n' "$PATH"`,
    `printf 'home\\t%s\\n' "$HOME"`,
    `start=${shellQuote(start)}`,
    `stop=${shellQuote(stop)}`,
    '[ -n "$stop" ] || stop=$HOME',
    // A stop the file is not inside does not count (the search goes up to /).
    'case "$start/" in "${stop%/}"/*) ;; *) stop=/ ;; esac',
    'root=',
    'git=',
  ];
  groups.forEach((group, i) => {
    if (!group.length) return;
    lines.push(
      `if [ -z "$root" ]; then d=$start; while :; do`,
      `  for m in ${group.map(shellQuote).join(' ')}; do for p in "$d"/$m; do [ -e "$p" ] && { root=$d; break 3; }; done; done`,
      ...(i === 0 ? ['  [ -z "$git" ] && [ -e "$d/.git" ] && git=$d'] : []),
      '  { [ "$d" = "$stop" ] || [ "$d" = / ]; } && break',
      '  d=$(dirname "$d")',
      'done; fi',
    );
  });
  if (groups.every((g) => !g.length)) lines.push('d=$start; while :; do [ -e "$d/.git" ] && { git=$d; break; }; { [ "$d" = "$stop" ] || [ "$d" = / ]; } && break; d=$(dirname "$d"); done');
  lines.push(
    scope === 'folder' ? 'root=' : '',
    '[ -n "$root" ] || root=${git:-$start}',
    `printf 'root\\t%s\\n' "$root"`,
    'cd "$root" 2>/dev/null',
  );
  for (const n of names) {
    lines.push(
      `p=$(command -v ${n} 2>/dev/null) && [ -n "$p" ] && printf 'on\\t%s\\t%s\\n' ${n} "$p"`,
      `[ -x "$root/node_modules/.bin/${n}" ] && printf 'bin\\t%s\\t%s\\n' ${n} "$root/node_modules/.bin/${n}"`,
    );
  }
  for (const n of verify.filter((v) => names.includes(v))) lines.push(`p=$(command -v ${n} 2>/dev/null) && "$p" --version </dev/null >/dev/null 2>&1 && printf 'works\\t%s\\n' "$p"`);
  if (typescript) {
    lines.push(
      `v=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$root/node_modules/typescript/package.json" 2>/dev/null | head -n 1)`,
      `[ -n "$v" ] && printf 'ts\\t%s\\n' "$v"`,
      `v=$(tsc --version </dev/null 2>/dev/null | sed -n 's/^Version //p' | head -n 1)`,
      `[ -n "$v" ] && printf 'tsc\\t%s\\n' "$v"`,
      // The TypeScript installed for everyone (typescript-language-server needs its tsserver.js):
      // next to tsc, or next to typescript-language-server.
      `for t in tsc typescript-language-server; do p=$(command -v $t 2>/dev/null) && r=$(readlink -f "$p" 2>/dev/null) || continue; case $t in tsc) f=\${r%/bin/tsc}/lib/tsserver.js ;; *) f=\${r%/node_modules/typescript-language-server/*}/node_modules/typescript/lib/tsserver.js ;; esac; [ -f "$f" ] && { printf 'tsserver\\t%s\\n' "$f"; break; }; done`,
    );
  }
  lines.push(`printf 'done\\n'`);
  return lines.filter(Boolean).join('\n');
}

/** What a probe printed: { path, home, root, on: {name: path}, bins: {name: path}, works: Set, ts, tsc, tsserver, complete }. */
function parseProbe(text) {
  const out = { path: '', home: '', root: '', on: {}, bins: {}, works: new Set(), ts: '', tsc: '', tsserver: '', complete: false };
  for (const line of String(text).split('\n')) {
    const [kind, a = '', b = ''] = line.replace(/\r$/, '').split('\t');
    if (['path', 'home', 'root', 'ts', 'tsc', 'tsserver'].includes(kind)) out[kind] = a;
    else if (kind === 'on' && b) out.on[a] = b;
    else if (kind === 'bin' && b) out.bins[a] = b;
    else if (kind === 'works') out.works.add(a);
    else if (kind === 'done') out.complete = true;
  }
  return out;
}

const versionOf = (version) => ({ version, major: Number(String(version).split('.')[0]) || 0 });

/**
 * The helpers a catalog entry's find(ctx) uses, answered from a probe (programs there run as
 * they are: their #! line picks Node, Python…).
 */
function remoteContext(probe) {
  return {
    root: probe.root,
    remote: true,
    projectBin: (name) => probe.bins[name] ?? null,
    onPath: async (name) => probe.on[name] ?? null,
    runnable: (found) => ({ command: found }),
    works: async (found) => probe.works.has(found),
    typescriptIn: (dir) => (dir === probe.root && probe.ts ? { ...versionOf(probe.ts), tsserver: null, server: { command: posix.join(dir, 'node_modules', '.bin', 'tsc') } } : null),
    typescriptOf: (tsc) => (probe.tsc ? { ...versionOf(probe.tsc), tsserver: probe.tsserver || null, server: { command: tsc } } : null),
    siblingTsserver: () => probe.tsserver || null,
  };
}

/** The command an exec channel runs: the server in its project folder, with the probe's PATH. */
function remoteCommand({ root, command, args = [], path = '' }) {
  return `${path ? `PATH=${shellQuote(path)}; export PATH; ` : ''}cd ${shellQuote(root)} 2>/dev/null; exec ${[command, ...args].map(shellQuote).join(' ')}`;
}

/**
 * An ssh2 exec channel with the face lsp.cjs expects of a process: stdout, stderr, stdin.write,
 * 'exit' (code) and 'error' events, kill(). Closing the channel ends the server's stdin, which
 * ends it (and stopProcess asks it to shut down first).
 */
function channelProcess(stream) {
  const proc = new EventEmitter();
  let code = null;
  let ended = false;
  proc.pid = null;
  proc.stdout = stream;
  proc.stderr = stream.stderr;
  proc.stdin = {
    write: (data) => stream.write(data),
    on: () => proc.stdin,
  };
  stream.on('exit', (c) => {
    if (typeof c === 'number') code = c;
  });
  stream.on('close', () => {
    if (ended) return;
    ended = true;
    proc.emit('exit', code);
  });
  stream.on('error', (err) => proc.emit('error', err));
  proc.kill = () => {
    try {
      stream.signal?.('KILL');
    } catch {
      // not every server takes signals: closing ends it
    }
    try {
      stream.close();
    } catch {
      // closed already
    }
  };
  return proc;
}

module.exports = { probeScript, parseProbe, remoteContext, remoteCommand, channelProcess, shellQuote, EXTRA_PATH };
