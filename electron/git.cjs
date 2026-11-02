// Git for folders on this computer, on SSH servers and in places (Docker containers, WSL
// distributions), desktop: the repository a folder is in, `git status` for it, a file's text at
// the last commit, and the commands that change things (stage, commit, branches, stash, fetch,
// pull, push…), run by `act`. Every git invocation goes through a runner: `localRunner` runs the
// git program installed here; `shellRunner` runs the one on a server or in a place, through a
// fixed sh script whose values travel base64-encoded (remote.cjs runArgs: an SSH exec channel of
// the connection, or docker exec / wsl.exe), so no path, branch or message ever becomes shell
// text. The page names a folder and an action, never a command: the arguments are made here from
// the checked action. Without git, or outside a repository, reading answers null. Reading uses
// GIT_OPTIONAL_LOCKS=0, so it never takes the index lock another Git program may need. Nothing
// ever waits for a question: no prompts (a credential helper or an SSH agent signs in, or the
// command fails saying so), no editor (messages are given), and every command has a time limit.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const posix = path.posix;

function run(args, cwd, { encoding = 'utf8', timeout = 15000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding, timeout, maxBuffer, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr: String(stderr ?? '') })) : resolve(stdout),
    );
  });
}

// For the commands that change things: Git's own locks, and never a prompt or an editor.
function writeEnv(env = process.env) {
  const out = { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GCM_INTERACTIVE: env.GCM_INTERACTIVE ?? 'auto' };
  delete out.GIT_OPTIONAL_LOCKS;
  // ssh asks for nothing in a terminal (keys from the agent, hosts already known).
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) out.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return out;
}

/** Calls `onProgress(line)` with each line of what comes in chunks (--progress writes "\r" between updates). */
function progressLines(onProgress) {
  let partial = '';
  return (chunk) => {
    const parts = (partial + chunk.toString()).split(/\r\n|\r|\n/);
    partial = parts.pop();
    for (const line of parts) if (line.trim()) onProgress(line);
  };
}

/**
 * Runs git and collects what it says: { stdout, stderr }; rejects with them (`err.stdout`,
 * `err.stderr`). `input` goes to its stdin; `onProgress(line)` gets each line of stderr as it
 * comes (--progress writes "\r" between updates).
 */
function runWrite(args, cwd, { input = null, timeout = 120_000, onProgress = null, env = writeEnv() } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('git', args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(Object.assign(err, { stdout: '', stderr: '' }));
    }
    let stdout = '';
    let stderr = '';
    const progress = onProgress ? progressLines(onProgress) : null;
    const timer = setTimeout(() => proc.kill(), timeout);
    // Text as it comes, a character never cut in two between chunks (names and messages in UTF-8).
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => {
      stderr += d;
      progress?.(d);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { stdout, stderr }));
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(Object.assign(new Error(signal ? `git ${args[0]} took too long and was stopped` : `git ${args[0]} failed (${code})`), { code, stdout, stderr }));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input ?? undefined);
  });
}

// ---- Runners: where git runs, and the few files Git with the model reads and writes ---------
//
// A runner is { kind ('local' | 'shell'), path (node's path, or path.posix there), where() (a
// name for messages, or null here), git(args, cwd, { encoding, timeout, maxBuffer }) → stdout
// (reading), gitWrite(args, cwd, { input, timeout, onProgress }) → { stdout, stderr } (writing),
// exists(paths) → [boolean], readFile(path, max) → { size, bytes } | null, writeFile(path,
// bytes), realpath(path), readInRepo(root, rel, max) → { size, bytes } (never outside the
// repository: links followed and checked), installHint() → { command, manager, asRoot } | null }.
// git's failures reject with { code, stdout, stderr } as runWrite's do; no git program: code
// 'ENOENT'; a server or place that went away meanwhile: `lost`; one that could not be reached:
// `offline`; too slow: `timedOut`.

/** git and the files on this computer. `runGit` / `runGitWrite` stand in for the real ones in tests. */
function localRunner({ runGit = run, runGitWrite = runWrite } = {}) {
  return {
    kind: 'local',
    path,
    where: null,
    git: runGit,
    gitWrite: runGitWrite,
    async exists(paths) {
      return paths.map((p) => fs.existsSync(p));
    },
    async readFile(p, max = 8 * 1024 * 1024) {
      let fd;
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) return null;
        fd = fs.openSync(p, 'r');
        const buf = Buffer.alloc(Math.min(st.size, max));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return { size: st.size, bytes: buf.subarray(0, n) };
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
        throw err;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    },
    async writeFile(p, bytes) {
      fs.writeFileSync(p, bytes);
    },
    async realpath(p) {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return path.resolve(p);
      }
    },
    async readInRepo(root, rel, max) {
      const real = fs.realpathSync(path.join(root, rel));
      const top = fs.realpathSync(root);
      if (real !== top && !real.startsWith(top + path.sep)) throw new Error('Not a file of this repository');
      const stat = fs.statSync(real);
      if (!stat.isFile()) throw new Error('Not a file');
      const fd = fs.openSync(real, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size, max));
        fs.readSync(fd, buf, 0, buf.length, 0);
        return { size: stat.size, bytes: buf };
      } finally {
        fs.closeSync(fd);
      }
    },
    installHint: async () => null,
  };
}

// The scripts run on a server or in a place (shellRunner), fixed text: what they work on comes in
// as values. remote.cjs puts places.cjs's PRELUDE before them and sends them, and the first two
// arguments, base64-encoded. SHELL_PROLOGUE takes those two: where the values are ('argv': the
// next argument; 'stdin': the first line of the input, when they are long) and the values, each
// with ":" before it, separated by \037 (a value never holds a NUL, a line break or \037); then
// "$@" is the values. It prints a start mark (a login shell's profile may print before it) and,
// whatever happens, an end mark with the exit code (a channel cut short has none), and puts the
// usual install places after PATH (git from Homebrew, Linuxbrew, ~/.local/bin). Only what POSIX
// sh and busybox have (Alpine images, macOS servers): no GNU-only flags.
const SHELL_PROLOGUE = `trap 'printf "\\036TE>%s\\n" "$?"' EXIT
printf '\\036TE<\\n'
from=$(arg "$1") || exit 97
if [ "$from" = stdin ]; then IFS= read -r all || exit 97; else all=$(arg "$2") || exit 97; fi
set --
if [ -n "$all" ]; then IFS=$(printf '\\037'); set -f; set -- $all; set +f; unset IFS; fi
k=$#
while [ "$k" -gt 0 ]; do a=$1; shift; set -- "$@" "\${a#:}"; k=$((k - 1)); done
unset CDPATH
PATH="$PATH:/usr/local/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/snap/bin:$HOME/.local/bin:$HOME/bin"
export PATH
`;

// Exit codes of the scripts (as places.cjs's): 40 not found, 41 a folder, 42 no permission, 44
// failed, 45 not a folder (git's folder), 47 outside the repository, 96 no git, 97 no base64.
const SHELL_SCRIPTS = {
  // git in a folder: $1 'read' or 'write', $2 the folder, then git's arguments. The repository is
  // the folder's (a GIT_DIR or GIT_WORK_TREE set there does not count). Reading takes no optional
  // locks; writing gets no editor, and ssh in batch mode unless the server says how to run ssh
  // itself (GIT_SSH_COMMAND, GIT_SSH or core.sshCommand). Never a prompt: no terminal,
  // GIT_TERMINAL_PROMPT=0, Git Credential Manager not interactive.
  git: `how=$1
dir=$2
shift 2
cd -- "$dir" 2>/dev/null || exit 45
command -v git >/dev/null 2>&1 || exit 96
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
LC_ALL=C
GIT_TERMINAL_PROMPT=0
GCM_INTERACTIVE=never
export LC_ALL GIT_TERMINAL_PROMPT GCM_INTERACTIVE
if [ "$how" = write ]; then
  unset GIT_OPTIONAL_LOCKS
  GIT_EDITOR=true
  GIT_MERGE_AUTOEDIT=no
  export GIT_EDITOR GIT_MERGE_AUTOEDIT
  if [ -z "$GIT_SSH_COMMAND$GIT_SSH" ] && [ -z "$(git config --get core.sshCommand 2>/dev/null)" ]; then
    GIT_SSH_COMMAND='ssh -o BatchMode=yes'
    export GIT_SSH_COMMAND
  fi
else
  GIT_OPTIONAL_LOCKS=0
  export GIT_OPTIONAL_LOCKS
fi
git "$@"`,

  // Which of the paths are there: 1 or 0, a line each.
  exists: `for p do if [ -e "$p" ] || [ -h "$p" ]; then echo 1; else echo 0; fi; done`,

  // A file: its size on a line, then its first $2 bytes.
  read: `p=$1
max=$2
[ -e "$p" ] || exit 40
[ -d "$p" ] && exit 41
[ -r "$p" ] || exit 42
n=$(wc -c < "$p" | tr -d ' \\t') || exit 44
printf '%s\\n' "$n"
head -c "$max" < "$p"`,

  // A file written with the input.
  write: `cat > "$1" || exit 44`,

  // A folder's real path.
  realpath: `cd -P -- "$1" 2>/dev/null || exit 40
pwd -P`,

  // A file in the repository $1 (its path inside it $2), links followed and checked: never
  // outside it. Its size on a line, then its first $3 bytes.
  inrepo: `root=$1
f=$1/$2
max=$3
top=$(cd -P -- "$root" 2>/dev/null && pwd -P) || exit 40
i=0
while [ -h "$f" ]; do
  i=$((i + 1))
  [ "$i" -gt 40 ] && exit 47
  t=$(readlink -- "$f") || exit 44
  case $t in /*) f=$t ;; *) f=$(dirname -- "$f")/$t ;; esac
done
d=$(cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd -P) || exit 40
real=$d/$(basename -- "$f")
case $real in "$top"/*) ;; *) exit 47 ;; esac
[ -e "$real" ] || exit 40
[ -f "$real" ] || exit 41
[ -r "$real" ] || exit 42
n=$(wc -c < "$real" | tr -d ' \\t') || exit 44
printf '%s\\n' "$n"
head -c "$max" < "$real"`,

  // What installing git would take there: the package managers, root or not, sudo, the system.
  install: `for m in apt-get dnf yum microdnf apk zypper pacman brew; do command -v "$m" >/dev/null 2>&1 && printf 'pm/%s\\n' "$m"; done
printf 'uid/%s\\n' "$(id -u 2>/dev/null)"
command -v sudo >/dev/null 2>&1 && echo sudo
if [ -r /etc/os-release ]; then sed -n 's/^ID=//p' /etc/os-release | tr -d '"' | head -n 1 | sed 's/^/os\\//'; fi
printf 'uname/%s\\n' "$(uname -s 2>/dev/null)"`,
};

const START_MARK = Buffer.from('\x1eTE<\n', 'latin1');
const END_MARK = /\x1eTE>(\d+)\n$/;
// Values longer than this many bytes (a long list of paths) go on stdin rather than the command
// line (base64 makes them a third longer; a Windows command line holds 32 K characters for
// docker.exe and wsl.exe, one SSH packet 256 KB).
const ARGS_INLINE = 12_000;
const lastLine = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? '';

/** What the install script printed → { managers, root, sudo, os, system }. */
function parseInstallProbe(text) {
  const out = { managers: [], root: false, sudo: false, os: '', system: '' };
  for (const line of String(text).split('\n')) {
    if (line.startsWith('pm/')) out.managers.push(line.slice(3));
    else if (line.startsWith('uid/')) out.root = line.slice(4).trim() === '0';
    else if (line === 'sudo') out.sudo = true;
    else if (line.startsWith('os/')) out.os = line.slice(3).trim().toLowerCase();
    else if (line.startsWith('uname/')) out.system = line.slice(6).trim();
  }
  return out;
}

const INSTALL_LINES = {
  'apt-get': ['apt-get update', 'apt-get install -y git'],
  dnf: ['dnf install -y git'],
  yum: ['yum install -y git'],
  microdnf: ['microdnf install -y git'],
  apk: ['apk add git'],
  zypper: ['zypper install -y git'],
  pacman: ['pacman -S --noconfirm git'],
};
const BY_SYSTEM = { alpine: 'apk', debian: 'apt-get', ubuntu: 'apt-get', linuxmint: 'apt-get', raspbian: 'apt-get', fedora: 'dnf', rhel: 'dnf', centos: 'yum', rocky: 'dnf', almalinux: 'dnf', amzn: 'yum', ol: 'dnf', opensuse: 'zypper', 'opensuse-leap': 'zypper', 'opensuse-tumbleweed': 'zypper', sles: 'zypper', arch: 'pacman', manjaro: 'pacman' };

/**
 * The command that installs git there, to type into its terminal (never run here): { command,
 * manager, asRoot (no sudo there: run it as root) }, or null when it is not known. The package
 * manager found first (apt-get, dnf, yum, microdnf, apk, zypper, pacman, Homebrew), else the one
 * of the system /etc/os-release names; sudo before it unless root (never for Homebrew).
 */
function installCommand({ managers = [], root = false, sudo = false, os = '', system = '' } = {}) {
  const manager = managers.find((m) => m === 'brew' || INSTALL_LINES[m]) ?? BY_SYSTEM[os] ?? (system === 'Darwin' ? 'xcode' : null);
  if (!manager) return null;
  if (manager === 'brew') return { command: 'brew install git', manager, asRoot: false };
  if (manager === 'xcode') return { command: 'xcode-select --install', manager, asRoot: false };
  const lines = INSTALL_LINES[manager];
  const withSudo = !root && sudo;
  return { command: lines.map((l) => (withSudo ? `sudo ${l}` : l)).join(' && '), manager, asRoot: !root && !sudo };
}

/**
 * git and the files it needs on an SSH server or in a place. `run(script, args, opts)` runs a
 * fixed script there with its arguments base64-encoded (remote.cjs `runArgs` for one connection:
 * { code, stdout, stderr }); `where()` names the place in messages ("build-box", "web-1 (Docker)").
 */
function shellRunner({ run: runScript, where = () => 'the server' }) {
  // One of SHELL_SCRIPTS with `values` (as "$1"…): { code, stdout, stderr } with the marks taken off.
  async function call(name, values, { input = null, timeout = 30000, onStderr = null } = {}) {
    for (const v of values) if (/[\0\n\x1f]/.test(String(v))) throw new Error('A name with a line break or a control character cannot be used there.');
    const blob = values.map((v) => `:${v}`).join('\x1f');
    const viaStdin = Buffer.byteLength(blob, 'utf8') > ARGS_INLINE;
    const data = input === null || input === undefined ? null : Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
    const stdin = viaStdin ? Buffer.concat([Buffer.from(`${blob}\n`, 'utf8'), data ?? Buffer.alloc(0)]) : data;
    const got = await runScript(SHELL_PROLOGUE + SHELL_SCRIPTS[name], viaStdin ? ['stdin'] : ['argv', blob], { input: stdin, timeout, onStderr });
    const stdout = Buffer.isBuffer(got.stdout) ? got.stdout : Buffer.from(String(got.stdout ?? ''));
    const stderr = Buffer.isBuffer(got.stderr) ? got.stderr.toString('utf8') : String(got.stderr ?? '');
    const at = stdout.indexOf(START_MARK);
    const end = END_MARK.exec(stdout.subarray(Math.max(0, stdout.length - 16)).toString('latin1'));
    if (at < 0 || !end) {
      const said = lastLine(stderr);
      // Nothing runs there this way (`unusable`: not taken for "no repository" or "no git").
      if (got.code === 97 || (at < 0 && !said && got.code === 0)) throw Object.assign(new Error(`The command did not run on ${where()}: it needs sh and base64 there (busybox and coreutils have both).`), { unusable: true });
      if (at < 0) throw Object.assign(new Error(`The command did not run on ${where()}${said ? `: ${said}` : ` (code ${got.code})`}.`), { unusable: true });
      throw Object.assign(new Error(`The command on ${where()} stopped before it finished${said ? `: ${said}` : ''}.`), { lost: true });
    }
    return { code: Number(end[1]), stdout: stdout.subarray(at + START_MARK.length, stdout.length - end[0].length), stderr };
  }
  const failed = (got, what) => Object.assign(new Error(`${what} on ${where()}${lastLine(got.stderr) ? `: ${lastLine(got.stderr)}` : ` (code ${got.code})`}`), { code: got.code, stdout: '', stderr: got.stderr });
  async function gitCall(how, args, cwd, { input = null, timeout, onProgress = null }) {
    const got = await call('git', [how, cwd, ...args], { input, timeout, onStderr: onProgress ? progressLines(onProgress) : null });
    if (got.code === 96) throw Object.assign(new Error(`Git is not installed on ${where()}`), { code: 'ENOENT', stdout: '', stderr: '' });
    if (got.code === 45) throw Object.assign(new Error(`${cwd} is not a folder on ${where()}`), { code: 45, stdout: '', stderr: `fatal: cannot change to '${cwd}': No such folder` });
    return got;
  }
  // A size line, then the bytes.
  const sized = (got) => {
    const nl = got.stdout.indexOf(10);
    return { size: Number(got.stdout.subarray(0, Math.max(nl, 0)).toString('latin1')) || 0, bytes: nl < 0 ? Buffer.alloc(0) : got.stdout.subarray(nl + 1) };
  };
  return {
    kind: 'shell',
    path: posix,
    where,
    async git(args, cwd, { encoding = 'utf8', timeout = 15000 } = {}) {
      const got = await gitCall('read', args, cwd, { timeout });
      const stdout = encoding === 'buffer' ? got.stdout : got.stdout.toString('utf8');
      if (got.code !== 0) throw Object.assign(new Error(`git ${args[0]} failed (${got.code})`), { code: got.code, stdout: encoding === 'buffer' ? '' : stdout, stderr: got.stderr });
      return stdout;
    },
    async gitWrite(args, cwd, { input = null, timeout = 120_000, onProgress = null } = {}) {
      const got = await gitCall('write', args, cwd, { input, timeout, onProgress });
      const out = { stdout: got.stdout.toString('utf8'), stderr: got.stderr };
      if (got.code !== 0) throw Object.assign(new Error(`git ${args[0]} failed (${got.code})`), { code: got.code, ...out });
      return out;
    },
    async exists(paths) {
      if (!paths.length) return [];
      const got = await call('exists', paths, { timeout: 15000 });
      if (got.code !== 0) throw failed(got, 'Could not look at the files');
      const lines = got.stdout.toString('utf8').split('\n');
      return paths.map((_, i) => lines[i] === '1');
    },
    async readFile(p, max = 8 * 1024 * 1024) {
      const got = await call('read', [p, String(max)], { timeout: 30000 });
      if (got.code === 40 || got.code === 41) return null;
      if (got.code !== 0) throw failed(got, `Could not read ${posix.basename(p)}`);
      return sized(got);
    },
    async writeFile(p, bytes) {
      const got = await call('write', [p], { input: bytes, timeout: 30000 });
      if (got.code !== 0) throw failed(got, `Could not write ${posix.basename(p)}`);
    },
    async realpath(p) {
      const got = await call('realpath', [p], { timeout: 15000 });
      return got.code === 0 ? got.stdout.toString('utf8').replace(/\n$/, '') || p : p;
    },
    async readInRepo(root, rel, max) {
      const got = await call('inrepo', [root, rel, String(max)], { timeout: 30000 });
      if (got.code === 47) throw new Error('Not a file of this repository');
      if (got.code === 41) throw new Error('Not a file');
      if (got.code === 40) throw new Error(`${rel}: no such file`);
      if (got.code !== 0) throw failed(got, `Could not read ${rel}`);
      return sized(got);
    },
    async installHint() {
      const got = await call('install', [], { timeout: 15000 });
      return got.code === 0 ? installCommand(parseInstallProbe(got.stdout.toString('utf8'))) : null;
    },
  };
}

// What the page may name: paths inside the repository (with "/"), branches, stashes.
const safeRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length < 4096 && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.split('/').includes('..') && !/[\0\r\n]/.test(rel);
const safeBranch = (name) => typeof name === 'string' && name.length > 0 && name.length < 256 && !name.startsWith('-') && !/[\0\r\n\s~^:?*[\\]|\.\.|@\{/.test(name);
const safeStash = (ref) => typeof ref === 'string' && /^stash@\{\d{1,4}\}$/.test(ref);
const safeRemote = (name) => typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name) && !name.startsWith('-');
// A commit, branch, tag or "HEAD~2", "origin/main", "stash@{1}", "@{u}": never an option, a path or a range.
const safeRev = (rev) => typeof rev === 'string' && rev.length > 0 && rev.length < 200 && !rev.startsWith('-') && /^[\w./@{}~^+-]+$/.test(rev) && !rev.includes('..');
// "main..feature" or "a...b" too (for log and diff).
const safeRange = (range) => typeof range === 'string' && (safeRev(range) || (/^[^.]+\.{2,3}[^.]+$/.test(range) && range.split(/\.{2,3}/).every(safeRev)));
const safeTag = (name) => safeBranch(name) && name.length < 120;
// A line for .gitignore: one line, not a comment-out of the whole file.
const safePattern = (p) => typeof p === 'string' && p.trim().length > 0 && p.length <= 200 && !/[\0\r\n]/.test(p);

/** What Git said, cut to `max` characters (what goes to the model or the page stays small). */
const cap = (text, max = 40_000) => {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters left out)` : t;
};
/** A remote's address without a user name or password in it (https://user:token@host/…). */
const cleanUrl = (url) => String(url).replace(/^([a-z][\w+.-]*:\/\/)[^/@\s]*@/i, '$1');
const BACKUP_REFS = 'refs/tracker-editor/backups';
const MAX_BACKUPS = 50;
// Blame: texts up to this size (bytes), and a commit named by its hash only.
const BLAME_MAX = 2 * 1024 * 1024;
const safeHash = (rev) => typeof rev === 'string' && /^[0-9a-f]{4,64}$/i.test(rev);

// The history view's commits (gitStatus.js parseHistory): a record per commit (\x1e), its fields
// split by \x1f (written as %x1e/%x1f: the values a shell runner passes may not hold them).
const HISTORY_FORMAT = '%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%D%x1f%s';
/** What the history is searched for: one line, short, '' for nothing. */
const historyWords = (text) => String(text ?? '').replace(/[\0-\x1f]+/g, ' ').trim().slice(0, 200);
/** `git diff --name-status -z` → { files: [{ status (A, M, D, R…), path, from? }] (300 at most), more }. */
function nameStatus(out, max = 300) {
  const parts = String(out).split('\0').filter(Boolean);
  const files = [];
  let more = 0;
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const entry = /^[RC]/.test(status) ? { status: status[0], from: parts[i++], path: parts[i++] } : { status: status[0], path: parts[i++] };
    if (files.length < max) files.push(entry);
    else more++;
  }
  return { files, more };
}

// A merge, rebase, cherry-pick or revert left halfway: the file each leaves in the .git folder.
const IN_PROGRESS = [['MERGE_HEAD', 'merge'], ['REBASE_HEAD', 'rebase'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']];
const BACKUP_FILE = 'tracker-editor-backups.json';
// No git program: not asked again for a while (installing it needs no restart).
const MISSING_MS = 30_000;

/**
 * Git through `runner` (localRunner by default; shellRunner for a server or a place):
 * `parseStatus` is gitStatus.js's (the page's module), `parse` its other parsers. `runGit` /
 * `runGitWrite` stand in for the local runner's git in tests.
 */
function createGit({ parseStatus, parse = {}, runner = null, runGit: runGitHere = run, runGitWrite: runWriteHere = runWrite } = {}) {
  const r = runner ?? localRunner({ runGit: runGitHere, runGitWrite: runWriteHere });
  const p = r.path;
  const runGit = (args, cwd, opts) => r.git(args, cwd, opts);
  const runGitWrite = (args, cwd, opts) => r.gitWrite(args, cwd, opts);
  // A server or place that went away, could not be reached, or cannot run git this way (a Windows
  // server, no sh there): said as it is, never taken as "no repository" or "no git".
  const gone = (err) => Boolean(err?.lost || err?.offline || err?.unusable);
  const roots = new Map(); // folder → { root (or null), at }
  let missing = 0; // when git was found missing (0: it was not)
  const ROOT_MS = 30_000;
  const oneLine = (out) => String(out).replace(/\r?\n$/, '');

  /**
   * The top folder of the repository `dir` is in, or null. Named as the page names `dir` when it
   * is the same folder (a link above the repository: git gives the real path).
   */
  async function repoOf(dir) {
    if (missing && Date.now() - missing < MISSING_MS) return null;
    const known = roots.get(dir);
    if (known && Date.now() - known.at < ROOT_MS) return known.root;
    let root = null;
    try {
      const [top, cdup = ''] = String(await runGit(['rev-parse', '--show-toplevel', '--show-cdup'], dir, { timeout: 5000 })).split('\n').map((l) => l.replace(/\r$/, ''));
      missing = 0;
      root = p.resolve(top);
      const named = p.resolve(dir, cdup || '.');
      if (named !== root && (await r.realpath(named)) === root) root = named;
    } catch (err) {
      if (gone(err)) throw err;
      if (err.code === 'ENOENT') missing = Date.now();
    }
    roots.set(dir, { root, at: Date.now() });
    return root;
  }

  const tryGit = async (args, root, opts) => {
    try {
      return await runGit(args, root, { timeout: 10000, ...opts });
    } catch (err) {
      if (gone(err)) throw err;
      return '';
    }
  };
  /** Where Git keeps `names` for the repository (rev-parse --git-path, one call): full paths, or [] when it cannot say. */
  const gitPaths = async (root, names) => {
    const out = await tryGit(['rev-parse', ...names.flatMap((n) => ['--git-path', n])], root, { timeout: 5000 });
    const lines = String(out).split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
    return lines.length === names.length ? lines.map((l) => p.resolve(root, l)) : [];
  };
  /** What is halfway in `root` (of `list`), in its order. */
  const halfway = async (root, list = IN_PROGRESS) => {
    const paths = await gitPaths(root, list.map(([n]) => n));
    if (!paths.length) return [];
    const there = await r.exists(paths);
    return list.filter((_, i) => there[i]).map(([, op]) => op);
  };

  /**
   * The shape of a repository for the model (Git with the model): status, branches, the graph
   * of recent commits on all of them, stashes, a merge or rebase halfway, remotes (addresses
   * without passwords), the reflog's last moves, tags, who commits, and our backups.
   */
  async function snapshot(root, parse) {
    const names = IN_PROGRESS.map(([n]) => n);
    const [statusOut, graph, branchesOut, stashOut, remotes, reflog, tags, name, email, kept] = await Promise.all([
      tryGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], root),
      tryGit(['log', '--graph', `--exclude=${BACKUP_REFS}/*`, '--all', '--date-order', '--decorate=short', '--format=%h%d %s · %an, %cr', '-n', '60'], root),
      tryGit(['for-each-ref', '--format=%(refname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:relative)%00%(HEAD)', 'refs/heads', 'refs/remotes'], root),
      tryGit(['stash', 'list', '--format=%gd%x00%s%x00%cr'], root),
      tryGit(['remote', '-v'], root),
      tryGit(['reflog', 'show', '--date=relative', '--format=%h %gd %gs', '-n', '20'], root),
      tryGit(['tag', '--sort=-creatordate', '--format=%(refname:short) %(objectname:short) %(creatordate:relative)'], root),
      tryGit(['config', 'user.name'], root),
      tryGit(['config', 'user.email'], root),
      gitPaths(root, [...names, BACKUP_FILE]),
    ]);
    const there = await r.exists([...kept.slice(0, names.length), p.join(root, '.gitignore')]);
    const ignore = Boolean(there.at(-1));
    const inProgress = kept.length ? (IN_PROGRESS.find((_, i) => there[i])?.[1] ?? null) : null;
    const status = statusOut ? parseStatus(statusOut) : null;
    const remoteList = [...new Set(remotes.split('\n').filter(Boolean).map((l) => {
      const [rname, url] = l.split(/\s+/);
      return `${rname} ${cleanUrl(url ?? '')}`;
    }))];
    return {
      root,
      status,
      graph: cap(graph, 12_000),
      branches: branchesOut && parse.parseBranches ? parse.parseBranches(branchesOut) : { local: [], remote: [] },
      stashes: stashOut && parse.parseStashes ? parse.parseStashes(stashOut) : [],
      inProgress,
      remotes: remoteList,
      reflog: cap(reflog, 4000),
      tags: tags.split('\n').filter(Boolean).slice(0, 10),
      identity: { name: Boolean(name.trim()), email: Boolean(email.trim()) },
      gitignore: ignore,
      backups: (await readBackups(root, kept[names.length])).slice(0, 10).map(({ tips, ...b }) => b),
    };
  }

  // Backups (Git with the model): before a step that changes history or files, the commit HEAD
  // is on (a ref of ours, so Git never collects it) and the changes not committed (`git stash
  // create`: a commit, the files untouched), listed in a file in the .git folder.
  const backupFile = async (root) => p.resolve(root, oneLine(await runGit(['rev-parse', '--git-path', BACKUP_FILE], root, { timeout: 5000 })));
  async function readBackups(root, known = null) {
    try {
      const got = await r.readFile(known || (await backupFile(root)), 8 * 1024 * 1024);
      const list = got ? JSON.parse(got.bytes.toString('utf8')) : [];
      return Array.isArray(list) ? list : [];
    } catch (err) {
      if (gone(err)) throw err;
      return [];
    }
  }
  async function makeBackup(root, label, keep = []) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const head = (await tryGit(['rev-parse', '--verify', '-q', 'HEAD'], root)).trim();
    const branch = (await tryGit(['symbolic-ref', '--short', '-q', 'HEAD'], root)).trim();
    const changes = (await tryGit(['stash', 'create', `Tracker Editor backup: ${label}`], root)).trim();
    // Where every branch was (a deleted one is made again by the undo); the ones a step is about
    // to delete or rename (`keep`) get a ref of ours, so their commits stay.
    const tips = {};
    for (const line of (await tryGit(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], root)).split('\n')) {
      const [name, sha] = line.split(' ');
      if (name && sha) tips[name] = sha;
    }
    const kept = (Array.isArray(keep) ? keep : []).filter((b) => safeBranch(b) && tips[b]).slice(0, 20);
    if (head) await runGitWrite(['update-ref', '-m', `Tracker Editor backup: ${label}`, `${BACKUP_REFS}/${id}`, head], root);
    if (changes) await runGitWrite(['update-ref', '-m', 'Tracker Editor backup (changes)', `${BACKUP_REFS}/${id}-changes`, changes], root);
    for (const [i, b] of kept.entries()) await runGitWrite(['update-ref', '-m', `Tracker Editor backup: ${b}`, `${BACKUP_REFS}/${id}-kept-${i}`, tips[b]], root);
    const entry = { id, at: new Date().toISOString(), label, head, branch, changes, tips, kept: kept.length, keptNames: kept };
    const list = [entry, ...(await readBackups(root))];
    for (const old of list.slice(MAX_BACKUPS)) {
      await tryGit(['update-ref', '-d', `${BACKUP_REFS}/${old.id}`], root);
      await tryGit(['update-ref', '-d', `${BACKUP_REFS}/${old.id}-changes`], root);
      for (let i = 0; i < (old.kept ?? 0); i++) await tryGit(['update-ref', '-d', `${BACKUP_REFS}/${old.id}-kept-${i}`], root);
    }
    await r.writeFile(await backupFile(root), Buffer.from(JSON.stringify(list.slice(0, MAX_BACKUPS), null, 1), 'utf8'));
    return entry;
  }
  /**
   * Back to a backup: a merge or rebase halfway is aborted, the branch made again if it was
   * deleted, checked out, moved to the commit it was on, and the changes put back. Itself
   * backed up first, so the undo can be undone.
   */
  async function undoBackup(root, id) {
    const entry = (await readBackups(root)).find((b) => b.id === id);
    if (!entry) throw new Error('That backup is gone');
    const before = await makeBackup(root, `before undoing “${entry.label}”`);
    const w = (args, opts) => runGitWrite(args, root, opts);
    for (const op of await halfway(root, IN_PROGRESS.filter(([n]) => n !== 'REBASE_HEAD'))) await w([op, '--abort']).catch(() => {});
    // Branches deleted since are made again where they were (the others stay where they are now).
    for (const [b, sha] of Object.entries(entry.tips ?? {})) {
      if (!safeBranch(b) || (await tryGit(['rev-parse', '--verify', '-q', `refs/heads/${b}`], root)).trim()) continue;
      // Its commit may be gone (collected): then it stays gone.
      if ((await tryGit(['rev-parse', '--verify', '-q', `${sha}^{commit}`], root)).trim()) await w(['branch', b, sha]).catch(() => {});
    }
    if (entry.head) {
      if (entry.branch) {
        const exists = (await tryGit(['rev-parse', '--verify', '-q', `refs/heads/${entry.branch}`], root)).trim();
        if (!exists) await w(['branch', entry.branch, entry.head]);
        const now = (await tryGit(['symbolic-ref', '--short', '-q', 'HEAD'], root)).trim();
        if (now !== entry.branch) await w(['switch', '-f', entry.branch]);
      } else {
        await w(['switch', '-f', '--detach', entry.head]);
      }
      await w(['reset', '-q', '--hard', entry.head]);
    }
    // The branches the step moved (move-branch, delete-branch, rename-branch) go back where they were.
    for (const b of entry.keptNames ?? []) {
      if (b === entry.branch || !safeBranch(b) || !entry.tips?.[b]) continue;
      await w(['branch', '-f', b, entry.tips[b]]).catch(() => {});
    }
    if (entry.changes) await w(['stash', 'apply', '--index', entry.changes]).catch(() => w(['stash', 'apply', entry.changes]));
    return { restored: entry, backup: before };
  }

  // ---- History (the history view, ui/gitHistory.js): commits a page at a time ----
  /**
   * Commits for the history view, newest first in topo order: `limit` (200, at most 1,000) after
   * the first `skip`. `ref`: a branch, tag or commit (else every branch, remote branch and tag,
   * and HEAD); `query`: words its message holds, in any case (all of them); `author`: part of the
   * author's name or address; `path`: a file or folder inside the repository (the commits that
   * changed it, their parents rewritten so the graph joins up); `follow`: that file through its
   * renames (each commit with the file's name then: `path`, `status`, `from`). → { commits
   * (gitStatus.js parseHistory), more, head (HEAD's commit), branch (the one checked out, or ''),
   * empty (no commit yet) }. Our backups and the stash are never named among a commit's refs.
   */
  async function historyOf(root, action) {
    const limit = Math.min(Math.max(Math.floor(Number(action.limit)) || 200, 1), 1000);
    const skip = Math.min(Math.max(Math.floor(Number(action.skip)) || 0, 0), 100_000_000);
    const ref = action.ref == null || action.ref === '' ? null : action.ref;
    if (ref != null && !safeRev(ref)) throw new Error('Not a branch or commit');
    const path = action.path == null || action.path === '' ? null : action.path;
    if (path != null && !safeRel(path)) throw new Error('Not a file of this repository');
    // What is searched for: one line each, short (a value for git, never an option: it follows "=").
    const words = historyWords(action.query).split(/\s+/).filter(Boolean).slice(0, 12);
    const author = historyWords(action.author);
    const [head, branch] = await Promise.all([tryGit(['rev-parse', '--verify', '-q', 'HEAD'], root, { timeout: 5000 }), tryGit(['symbolic-ref', '--short', '-q', 'HEAD'], root, { timeout: 5000 })]);
    if (!head.trim()) return { commits: [], more: false, head: '', branch: branch.trim(), empty: true };
    const follow = Boolean(path && action.follow);
    const args = ['log', '--topo-order', '--no-color', '--decorate=full', `--decorate-refs-exclude=${BACKUP_REFS}/*`, '--decorate-refs-exclude=refs/stash', `--format=${HISTORY_FORMAT}`, `--skip=${skip}`, '-n', String(limit + 1)];
    if (words.length || author) args.push('--fixed-strings', '--regexp-ignore-case');
    for (const word of words) args.push(`--grep=${word}`);
    if (words.length > 1) args.push('--all-match');
    if (author) args.push(`--author=${author}`);
    if (follow) args.push('--follow', '--name-status');
    else if (path) args.push('--parents');
    args.push(...(ref ? [ref] : ['--branches', '--remotes', '--tags', 'HEAD']), '--', ...(path ? [path] : []));
    const out = await runGit(args, root, { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    const commits = parse.parseHistory ? parse.parseHistory(out) : [];
    return { commits: commits.slice(0, limit), more: commits.length > limit, head: head.trim(), branch: branch.trim() };
  }

  return {
    repoOf,
    /** `git status` for the repository `dir` is in: { root, branch, upstream, ahead, behind, files } or null. */
    async status(dir) {
      const root = await repoOf(dir);
      if (!root) return null;
      try {
        const out = await runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], root);
        return { root, ...parseStatus(out) };
      } catch (err) {
        if (gone(err)) throw err;
        return null;
      }
    },
    /** A file's bytes at the last commit (HEAD): { root, rel, bytes }, or null (not in a repository, or new). */
    async headBytes(file) {
      const root = await repoOf(p.dirname(file));
      if (!root) return null;
      const rel = p.relative(root, file).split(p.sep).join('/');
      if (!rel || rel.startsWith('..')) return null;
      try {
        const bytes = await runGit(['show', `HEAD:${rel}`], root, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
        return { root, rel, bytes };
      } catch (err) {
        if (gone(err)) throw err;
        return null;
      }
    },
    /** The branch checked out in the repository `root` ('detached' when none), or ''. */
    async branch(root) {
      try {
        const name = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, { timeout: 5000 })).trim();
        return name === 'HEAD' ? 'detached' : name;
      } catch (err) {
        if (gone(err)) throw err;
        return '';
      }
    },
    /**
     * Does what the page asks in the repository `root` (from repoOf; the main process checked the
     * folder): `action.op` and its fields, checked here. Answers what the op gives, or throws
     * with `stdout`/`stderr` (gitError on the page says it in words). `onProgress(line)`: Git's
     * progress for fetch, pull and push.
     */
    async act(root, action, { onProgress = null } = {}) {
      const w = (args, opts = {}) => runGitWrite(args, root, { onProgress, ...opts });
      const rels = (list) => {
        if (!Array.isArray(list) || !list.length || list.length > 5000 || !list.every(safeRel)) throw new Error('Not files of this repository');
        return list;
      };
      const hasHead = async () => {
        try {
          await runGit(['rev-parse', '--verify', '-q', 'HEAD'], root, { timeout: 5000 });
          return true;
        } catch (err) {
          if (gone(err)) throw err;
          return false;
        }
      };
      switch (action?.op) {
        case 'stage':
          // Deletions and new files too.
          return w(['add', '-A', '--', ...rels(action.paths)]);
        case 'stage-all':
          return w(['add', '-A']);
        case 'unstage':
          // A repository without a commit yet has nothing to go back to: out of the index.
          return (await hasHead()) ? w(['restore', '--staged', '--', ...rels(action.paths)]) : w(['rm', '--cached', '-r', '-q', '--', ...rels(action.paths)]);
        case 'unstage-all':
          return (await hasHead()) ? w(['reset', '-q']) : w(['rm', '--cached', '-r', '-q', '.']);
        case 'commit': {
          const message = String(action.message ?? '').replace(/\r\n?/g, '\n');
          if (!message.trim() && !action.amend) throw Object.assign(new Error('No message'), { stderr: 'Aborting commit due to empty commit message.' });
          const args = ['commit', ...(action.amend ? ['--amend'] : []), ...(message.trim() ? ['-F', '-'] : ['--no-edit'])];
          return w(args, { input: message.trim() ? message : null });
        }
        case 'last-message':
          return (await hasHead()) ? (await runGit(['log', '-1', '--format=%B'], root, { timeout: 5000 })).replace(/\n+$/, '') : '';
        case 'branches': {
          const out = await runGit(['for-each-ref', '--format=%(refname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:relative)%00%(HEAD)', 'refs/heads', 'refs/remotes'], root);
          return parse.parseBranches ? parse.parseBranches(out) : out;
        }
        case 'switch': {
          if (!safeBranch(action.name)) throw new Error('Not a branch name');
          if (action.create) {
            if (action.from && !safeBranch(action.from)) throw new Error('Not a branch name');
            // Git's own check of the name, before anything changes.
            await runGit(['check-ref-format', '--branch', action.name], root, { timeout: 5000 });
            // From another branch ("origin/dev"): not following it, so its first push makes a branch of its own name.
            return w(['switch', '-c', action.name, ...(action.from ? ['--no-track', action.from] : [])]);
          }
          // A remote branch ("origin/x") gets a local one that follows it.
          if (action.track) return w(['switch', '--track', action.name]);
          return w(['switch', action.name]);
        }
        case 'fetch':
          return w(['fetch', '--all', '--prune', '--progress'], { timeout: 300_000 });
        case 'pull': {
          const how = { merge: ['--no-rebase'], rebase: ['--rebase'] }[action.how] ?? ['--ff-only'];
          return w(['pull', ...how, '--progress'], { timeout: 300_000 });
        }
        case 'push': {
          const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, { timeout: 5000 })).trim();
          let upstream = '';
          try {
            upstream = (await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root, { timeout: 5000 })).trim();
          } catch {
            // none yet
          }
          // Force: only with a lease (refused when the remote has commits this computer has not seen).
          const force = action.force ? ['--force-with-lease'] : [];
          if (upstream) return w(['push', '--progress', ...force], { timeout: 300_000 });
          // The first push of a branch: to the remote named (or the only one, or origin), followed from then on.
          const remotes = (await runGit(['remote'], root, { timeout: 5000 })).split('\n').filter(Boolean);
          const remote = safeRemote(action.remote) && remotes.includes(action.remote) ? action.remote : remotes.length === 1 ? remotes[0] : remotes.includes('origin') ? 'origin' : '';
          if (!remote || branch === 'HEAD') throw Object.assign(new Error('No remote'), { stderr: remote ? 'fatal: You are not currently on a branch.' : 'fatal: No configured push destination.' });
          return w(['push', '--progress', ...force, '-u', remote, 'HEAD'], { timeout: 300_000 });
        }
        case 'stashes': {
          const out = await runGit(['stash', 'list', '--format=%gd%x00%s%x00%cr'], root);
          return parse.parseStashes ? parse.parseStashes(out) : out;
        }
        case 'stash': {
          const message = String(action.message ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
          return w(['stash', 'push', ...(action.untracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])]);
        }
        case 'stash-apply':
        case 'stash-pop':
        case 'stash-drop':
          if (!safeStash(action.ref)) throw new Error('Not a stash');
          return w(['stash', action.op.slice(6), action.ref]);
        case 'in-progress':
          // A merge or a rebase left halfway (conflicts): what can be aborted.
          return (await halfway(root))[0] ?? null;
        case 'abort': {
          const op = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[action.what];
          if (!op) throw new Error('Nothing to abort');
          return w([op, '--abort']);
        }
        // ---- Looking (Git with the model): what it asks to see, cut to size ----
        case 'log': {
          const count = Math.min(Math.max(Number(action.count) || 30, 1), 200);
          const range = action.range ?? action.ref;
          if (range != null && !safeRange(range)) throw new Error('Not a commit or range');
          const paths = action.paths ? rels(action.paths) : [];
          if (!(await hasHead())) return '(no commits yet)';
          const out = await runGit(['log', '--graph', '--date-order', '--decorate=short', '--format=%h%d %s · %an, %cr', '-n', String(count), ...(action.all ? [`--exclude=${BACKUP_REFS}/*`, '--all'] : range ? [range] : []), '--', ...paths], root);
          return cap(out);
        }
        case 'show': {
          if (!safeRev(action.rev)) throw new Error('Not a commit');
          return cap(await runGit(['show', '--stat', '--patch', '--format=fuller', '--no-color', action.rev, '--'], root));
        }
        case 'diff': {
          const paths = action.paths ? rels(action.paths) : [];
          const revs = [action.from, action.to].filter((r) => r != null);
          if (!revs.every(safeRange)) throw new Error('Not a commit');
          const args = ['diff', '--no-color', ...(action.stat ? ['--stat'] : []), ...(action.staged ? ['--cached'] : []), ...revs, '--', ...paths];
          return cap(await runGit(args, root)) || '(no differences)';
        }
        case 'file-at': {
          if (!safeRev(action.rev) || !safeRel(action.path)) throw new Error('Not a file at a commit');
          return cap(await runGit(['show', `${action.rev}:${action.path}`], root));
        }
        case 'read': {
          // A file as it is now in the repository's folder (never outside it: links are followed and checked).
          if (!safeRel(action.path)) throw new Error('Not a file of this repository');
          const got = await r.readInRepo(root, action.path, 64 * 1024);
          return cap(got.bytes.toString('utf8'), 40_000) + (got.size > got.bytes.length ? `\n… (the file is ${got.size} bytes; the rest left out)` : '');
        }
        case 'reflog': {
          const count = Math.min(Math.max(Number(action.count) || 30, 1), 200);
          if (action.ref != null && !safeRev(action.ref)) throw new Error('Not a branch');
          try {
            return cap(await runGit(['reflog', 'show', '--date=relative', '--format=%h %gd %gs', '-n', String(count), ...(action.ref ? [action.ref] : [])], root));
          } catch {
            return '(no reflog)';
          }
        }
        // ---- The history view (ui/gitHistory.js): commits, a commit's details, files at a commit ----
        case 'history':
          return historyOf(root, action);
        case 'commit-info':
          // A commit picked in the history: its whole message, who and when, the files it changed.
          return this.commitInfo(root, action.hash);
        case 'file-text':
          // A file at a commit, as bytes (main.cjs decodes it as the editor reads files), or null when it was not there.
          return this.fileAt(root, action.hash, action.path);
        case 'changed-since': {
          // The files that differ between a commit and the working tree now (tracked files).
          if (!safeHash(action.hash)) throw new Error('Not a commit');
          return nameStatus(await runGit(['diff', '--no-color', '--name-status', '-z', '-M', action.hash, '--'], root, { timeout: 30_000 }));
        }
        case 'branch-at': {
          // A new branch at a commit, the one checked out left as it is (Create a branch here).
          if (!safeBranch(action.name) || !safeRev(action.rev)) throw new Error('Not a branch name or commit');
          await runGit(['check-ref-format', '--branch', action.name], root, { timeout: 5000 });
          return w(['branch', '--no-track', action.name, action.rev]);
        }
        case 'snapshot':
          return snapshot(root, parse);
        case 'backups':
          return readBackups(root);
        // ---- Changing things the panel has no button for (Git with the model) ----
        case 'merge': {
          if (!safeRev(action.rev)) throw new Error('Not a branch or commit');
          const how = { 'ff-only': ['--ff-only'], 'no-ff': ['--no-ff'], squash: ['--squash'] }[action.how] ?? [];
          return w(['merge', ...how, '--no-edit', action.rev]);
        }
        case 'rebase': {
          if (!safeRev(action.onto)) throw new Error('Not a branch or commit');
          return w(['rebase', action.onto]);
        }
        case 'continue': {
          const op = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[action.what];
          if (!op) throw new Error('Nothing to continue');
          return w(op === 'merge' ? ['commit', '--no-edit'] : [op, '--continue']);
        }
        case 'rebase-skip':
          return w(['rebase', '--skip']);
        case 'reset': {
          const mode = { soft: '--soft', mixed: '--mixed', hard: '--hard' }[action.mode];
          if (!mode || !safeRev(action.rev)) throw new Error('Not a reset');
          return w(['reset', '-q', mode, action.rev]);
        }
        case 'revert': {
          if (!safeRev(action.rev)) throw new Error('Not a commit');
          // A merge commit: which parent's side to keep (1: the branch it was merged into).
          const mainline = [1, 2].includes(action.mainline) ? ['-m', String(action.mainline)] : [];
          return w(['revert', '--no-edit', ...mainline, action.rev]);
        }
        case 'cherry-pick':
          // One commit, or a range ("origin/main..main": the commits main has that origin/main lacks).
          if (!safeRange(action.rev)) throw new Error('Not a commit');
          return w(['cherry-pick', action.rev]);
        case 'move-branch':
          // Another branch (not the one checked out) moved to a commit: "put main back where origin/main is".
          if (!safeBranch(action.name) || !safeRev(action.to)) throw new Error('Not a branch or commit');
          return w(['branch', '-f', action.name, action.to]);
        case 'delete-branch':
          if (!safeBranch(action.name)) throw new Error('Not a branch name');
          return w(['branch', action.force ? '-D' : '-d', action.name]);
        case 'rename-branch': {
          if (!safeBranch(action.to) || (action.from != null && !safeBranch(action.from))) throw new Error('Not a branch name');
          await runGit(['check-ref-format', '--branch', action.to], root, { timeout: 5000 });
          return w(['branch', '-m', ...(action.from ? [action.from] : []), action.to]);
        }
        case 'restore': {
          // Throws away changes to files (back to the index, or to a commit's version).
          if (action.from != null && !safeRev(action.from)) throw new Error('Not a commit');
          return w(['restore', ...(action.from ? [`--source=${action.from}`, '--staged'] : []), '--worktree', '--', ...rels(action.paths)]);
        }
        case 'tag': {
          if (!safeTag(action.name) || (action.rev != null && !safeRev(action.rev))) throw new Error('Not a tag');
          const message = String(action.message ?? '').trim();
          return w(['tag', ...(message ? ['-a', '-F', '-'] : []), action.name, ...(action.rev ? [action.rev] : [])], { input: message || null });
        }
        case 'ignore': {
          const patterns = Array.isArray(action.patterns) ? action.patterns.filter(safePattern).slice(0, 50) : [];
          if (!patterns.length) throw new Error('No patterns');
          const file = p.join(root, '.gitignore');
          // None yet: ''.
          const got = await r.readFile(file, 4 * 1024 * 1024);
          if (got && got.size > got.bytes.length) throw new Error('The .gitignore is too large to change here');
          const text = got ? got.bytes.toString('utf8') : '';
          const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
          const added = patterns.map((x) => x.trim()).filter((x) => !have.has(x));
          if (added.length) {
            const eol = text.includes('\r\n') ? '\r\n' : '\n';
            await r.writeFile(file, Buffer.from(`${text}${text && !text.endsWith('\n') ? eol : ''}${added.join(eol)}${eol}`, 'utf8'));
          }
          return { added, already: patterns.length - added.length };
        }
        case 'untrack':
          // Out of Git (and the next commit), kept on disk: for files .gitignore should have caught.
          return w(['rm', '-r', '--cached', '-q', '--', ...rels(action.paths)]);
        case 'backup':
          return makeBackup(root, String(action.label ?? '').slice(0, 200), action.keep);
        case 'undo':
          return undoBackup(root, String(action.id ?? ''));
        default:
          throw new Error(`Unknown Git action: ${action?.op}`);
      }
    },
    /** The text staged for a file (the index), as bytes: { root, rel, bytes } or null (not staged, or not in a repository). */
    async indexBytes(file) {
      const root = await repoOf(p.dirname(file));
      if (!root) return null;
      const rel = p.relative(root, file).split(p.sep).join('/');
      if (!safeRel(rel)) return null;
      try {
        return { root, rel, bytes: await runGit(['show', `:${rel}`], root, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }) };
      } catch (err) {
        if (gone(err)) throw err;
        return null;
      }
    },
    /** Stages `bytes` as a file's text (one change of it staged): written as a blob, put in the index with the file's mode. */
    async setIndexBytes(file, bytes) {
      const root = await repoOf(p.dirname(file));
      if (!root) throw new Error('Not in a Git repository');
      const rel = p.relative(root, file).split(p.sep).join('/');
      if (!safeRel(rel)) throw new Error('Not a file of this repository');
      const sha = (await runGitWrite(['hash-object', '-w', '--stdin', `--path=${rel}`], root, { input: bytes })).stdout.trim();
      const staged = (await runGit(['ls-files', '-s', '--', rel], root, { timeout: 5000 })).trim();
      const mode = /^(\d{6}) /.exec(staged)?.[1] ?? '100644';
      await runGitWrite(['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`], root);
      return { root, rel };
    },
    /**
     * Who changed each line of `rel` (a path inside the repository `root`) and when: `git blame
     * --porcelain` of `bytes`, the editor's text as the file would be on disk (its line endings and
     * encoding), given on stdin, so lines not saved or not committed yet are not committed yet.
     * { root, rel, head (HEAD's commit, '' before the first), hash (sha1 of the bytes), me: { name,
     * email } (who commits here), commits, lines } (gitStatus.js parseBlame), or with `untracked`
     * (not in the last commit: every line is new). `known` ({ hash, head } of an answer before):
     * { same: true } while neither changed. Over `max` bytes: { tooBig, size, max }, nothing run.
     */
    async blame(root, rel, bytes, { known = null, max = BLAME_MAX, timeout = 15_000 } = {}) {
      if (!safeRel(rel)) throw new Error('Not a file of this repository');
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''));
      const hash = require('node:crypto').createHash('sha1').update(data).digest('hex');
      const head = (await tryGit(['rev-parse', '--verify', '-q', 'HEAD'], root, { timeout: 5000 })).trim();
      if (known && known.hash === hash && known.head === head) return { same: true, hash, head };
      if (data.length > max) return { tooBig: true, size: data.length, max, hash, head };
      const [name, email] = await Promise.all([tryGit(['config', 'user.name'], root, { timeout: 5000 }), tryGit(['config', 'user.email'], root, { timeout: 5000 })]);
      const base = { root, rel, head, hash, me: { name: name.trim(), email: email.trim() } };
      if (!head) return { ...base, untracked: true };
      try {
        // Reading: no lock of Git's taken, nothing asked.
        const { stdout } = await runGitWrite(['blame', '--porcelain', '--contents', '-', '--', rel], root, { input: data, timeout, env: { ...writeEnv(), GIT_OPTIONAL_LOCKS: '0' } });
        const parsed = parse.parseBlame ? parse.parseBlame(stdout) : { commits: {}, lines: [] };
        return { ...base, ...parsed };
      } catch (err) {
        // A file not in the last commit (new, or the repository has none).
        if (/no such path .* in HEAD|no such ref: HEAD|bad revision 'HEAD'/i.test(String(err.stderr ?? ''))) return { ...base, untracked: true };
        throw err;
      }
    },
    /**
     * A commit, to show it: { hash, parents, author, mail, time, committer, committerMail,
     * committerTime, message (whole), files: [{ status (A, M, D, R…), path, from? }] } (what it
     * changed, against its first parent; 300 at most, `more` for the rest), or null.
     */
    async commitInfo(root, rev) {
      if (!safeHash(rev)) throw new Error('Not a commit');
      let out;
      try {
        out = await runGit(['show', '-s', '--no-color', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B', rev, '--'], root, { timeout: 10_000 });
      } catch {
        return null;
      }
      const [hash, parents, author, mail, time, committer, committerMail, committerTime, ...message] = out.split('\0');
      const parentList = parents.split(' ').filter(Boolean);
      const files = [];
      let more = 0;
      try {
        const diff = await runGit(['diff-tree', '--no-commit-id', '-r', '-z', '--name-status', '-M', ...(parentList.length ? [parentList[0]] : ['--root']), hash], root, { timeout: 10_000 });
        const parts = diff.split('\0').filter(Boolean);
        for (let i = 0; i < parts.length; ) {
          const status = parts[i++];
          const two = /^[RC]/.test(status);
          const entry = two ? { status: status[0], from: parts[i++], path: parts[i++] } : { status: status[0], path: parts[i++] };
          if (files.length < 300) files.push(entry);
          else more++;
        }
      } catch {
        // the files stay unknown
      }
      return { hash, parents: parentList, author, mail, time: Number(time) || 0, committer, committerMail, committerTime: Number(committerTime) || 0, message: message.join('\0').replace(/\s+$/, ''), files, more };
    },
    /** A file's bytes at a commit: `rel` (a path inside the repository) at `rev` (a hash), or null when it is not there. */
    async fileAt(root, rev, rel, { maxBuffer = 32 * 1024 * 1024 } = {}) {
      if (!safeHash(rev) || !safeRel(rel)) throw new Error('Not a file at a commit');
      try {
        return await runGit(['show', `${rev}:${rel}`], root, { encoding: 'buffer', maxBuffer });
      } catch {
        return null;
      }
    },
    /** Forgets which folders are in which repository (a repository was made or removed), and that git was missing. */
    forget: () => {
      roots.clear();
      missing = 0;
    },
    /**
     * What making `dir` a repository would mean: { installed (the git program is there), root
     * (the repository `dir` is in already, or null), defaultBranch (the person's
     * init.defaultBranch, or ''), version }; where git is missing on a server or in a place,
     * `install` too: the command that installs it there (installCommand), when known.
     */
    async info(dir) {
      let version = '';
      try {
        version = /(\d+\.\d+(\.\d+)?)/.exec(await runGit(['--version'], dir, { timeout: 5000 }))?.[1] ?? '';
        missing = 0;
      } catch (err) {
        if (err.code === 'ENOENT') missing = Date.now();
        // Why nothing ran there (it went away, it runs Windows, it has no sh): said as it is.
        else if (gone(err)) throw err;
      }
      if (missing) {
        const install = await r.installHint().catch((err) => {
          if (gone(err)) throw err;
          return null;
        });
        return { installed: false, root: null, defaultBranch: '', ...(install ? { install } : {}) };
      }
      roots.delete(dir);
      const root = await repoOf(dir);
      const named = (await tryGit(['config', '--get', 'init.defaultBranch'], dir)).trim();
      return { installed: true, root, defaultBranch: safeBranch(named) ? named : '', ...(version ? { version } : {}) };
    },
    /**
     * Makes `dir` a Git repository (git init), its first branch named `branch` (else Git's own
     * choice): { root, branch }. Refuses a folder that is a repository's top already; one inside
     * another repository becomes a repository of its own (the page says so first).
     */
    async init(dir, { branch = '' } = {}) {
      if (branch && !safeBranch(branch)) throw new Error('Not a branch name');
      roots.delete(dir);
      const before = await repoOf(dir);
      if (missing) throw new Error(`Git is not installed ${r.where ? `on ${r.where()}` : 'on this computer'}`);
      const key = async (x) => {
        const real = await r.realpath(x);
        return r.kind === 'local' && process.platform === 'win32' ? real.toLowerCase() : real;
      };
      if (before && (await key(before)) === (await key(dir))) throw new Error('This folder is a Git repository already');
      // Git's own check of the name, before anything is made.
      if (branch) await runGit(['check-ref-format', '--branch', branch], dir, { timeout: 5000 });
      await runGitWrite(['init', '-q'], dir);
      if (branch) await runGitWrite(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], dir);
      roots.clear();
      const root = await repoOf(dir);
      return { root, branch: (await tryGit(['symbolic-ref', '--short', 'HEAD'], dir)).trim() };
    },
    get missing() {
      return Boolean(missing);
    },
    /** Where git runs: 'local' or 'shell' (a server or a place). */
    get kind() {
      return r.kind;
    },
  };
}

module.exports = { createGit, localRunner, shellRunner, installCommand, parseInstallProbe, SHELL_PROLOGUE, SHELL_SCRIPTS, ARGS_INLINE, writeEnv, safeRel, safeBranch, safeRev, safeRange, cleanUrl };
