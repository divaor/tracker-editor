// Docker containers and WSL distributions as places (desktop), like servers: files and a terminal
// there, reached through a program on this computer (the docker command line, wsl.exe) rather
// than a network connection. remote.cjs uses an ExecSession as it uses an SftpSession, so
// remote://<id>/<path> works the same: tabs, Folders, find in a folder, properties, copies and
// moves between places, the folder comparison, two panes, terminals and language servers.
//
// Each operation is one short POSIX sh script run inside with `sh -c BOOT sh <script> <args…>`.
// The scripts are fixed text in this file, never made from what the page sends. Paths and names go
// in as arguments, each base64-encoded (and refused with a NUL or a line break), and BOOT decodes
// the script itself: neither ever passes through a command line's quoting (Windows' rules for
// docker.exe and wsl.exe) or a shell's parsing. BOOT holds no quote and no backslash, so quoting it
// can only wrap it. The scripts use what busybox has too (Alpine images): stat -c, base64 -d, cat,
// head -c, tail -c, mv, rm, mkdir; no find -printf, no stat --printf, no GNU-only flags.
//
// Nothing beyond `exec` into a container or distribution the person picked runs, plus `start` of
// a stopped container they picked: no images are run, nothing is mounted, no docker cp. The program
// is found here (PATH, the login shell's PATH, the usual places), never named by the page.
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const posix = nodePath.posix;
const PLACE_PROTOCOLS = ['docker', 'wsl'];
const PLACE_LABEL = { docker: 'Docker', wsl: 'WSL' };
const isPlace = (protocol) => PLACE_PROTOCOLS.includes(protocol);
// Docker's own rule for names (and its ids, hex); WSL's distributions; a user name or uid[:gid].
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$/;
const MAX_LIST_DIRS = 2000; // folders listed by one script
const PARALLEL = 6; // commands at once per place
const stoppedError = () => Object.assign(new Error('Stopped.'), { stopped: true });

// ---- What goes on the command line ---------------------------------------------------------

/** Decodes the script (its first argument) and runs it: no quote, no backslash, nothing quoting could change. */
const BOOT = 'set -f;IFS=;eval $(printf %s $1|base64 -d)';

// Before every script: the shell as usual again, its own text dropped from the arguments, and
// `arg` to decode one (each is ":" + the value, so none is ever empty).
const PRELUDE = [
  'unset IFS',
  'set +f',
  'shift',
  "arg() { _a=$(printf '%s' \"$1\" | base64 -d) || return 97; printf '%s' \"${_a#:}\"; }",
  '',
].join('\n');

/** An argument for a script: base64 of ":" + the value. A NUL or a line break is refused. */
function encodeArg(value) {
  const text = String(value ?? '');
  if (text.includes('\0') || text.includes('\n')) throw placeError('A name with a line break cannot be used there.');
  return Buffer.from(`:${text}`, 'utf8').toString('base64');
}
const encodeScript = (script) => Buffer.from(PRELUDE + script, 'utf8').toString('base64');

/** A path inside a place: absolute, without a NUL or a line break. */
function checkPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0') || p.includes('\n')) throw placeError('That path cannot be used there.');
  return p;
}

/** The arguments before `sh` for one place: `tty` for a terminal. Every word comes from the checked record. */
function placePrefix(conn, { tty = false } = {}) {
  if (conn.protocol === 'docker') {
    if (!CONTAINER.test(conn.container ?? '')) throw placeError('That container name cannot be used.');
    if (conn.user && !USER.test(conn.user)) throw placeError('That user name cannot be used.');
    return ['exec', '-i', ...(tty ? ['-t', '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor'] : []), ...(conn.user ? ['-u', conn.user] : []), conn.container];
  }
  if (conn.protocol === 'wsl') {
    if (!DISTRO.test(conn.distro ?? '')) throw placeError('That distribution name cannot be used.');
    if (conn.user && !USER.test(conn.user)) throw placeError('That user name cannot be used.');
    return ['-d', conn.distro, ...(conn.user ? ['-u', conn.user] : []), '--exec'];
  }
  throw placeError('Not a Docker container or a WSL distribution.');
}

/** The whole command line after the program: the place's prefix, then sh running `script` with `args`. */
function placeArgs(conn, script, args = [], opts = {}) {
  return [...placePrefix(conn, opts), 'sh', '-c', BOOT, 'sh', encodeScript(script), ...args.map(encodeArg)];
}

/**
 * The checked fields of a place's connection: { container } or { distro }, and `user` ('' = the
 * container's or the distribution's own).
 */
function cleanPlace(input) {
  const user = String(input.user ?? '').trim();
  if (user && !USER.test(user)) throw new Error('The user is a name or a number (like node, www-data or 1000:1000), without spaces.');
  if (input.protocol === 'docker') {
    const container = String(input.container ?? '').trim().replace(/^\//, '');
    if (!CONTAINER.test(container)) throw new Error('Pick a container from the list (its name has letters, digits, dots, dashes and underscores).');
    return { container, user };
  }
  if (input.protocol === 'wsl') {
    const distro = String(input.distro ?? '').trim();
    if (!DISTRO.test(distro)) throw new Error('Pick a WSL distribution from the list.');
    return { distro, user };
  }
  throw new Error('Not a Docker container or a WSL distribution.');
}

// ---- The scripts (fixed; each argument is decoded with `arg`) --------------------------------
// Exit codes: 40 not found, 41 a folder, 42 permission denied, 43 already there, 44 failed (its
// stderr says why), 45 not a folder, 46 the data did not arrive whole, 97 no base64.

const CODES = { NOTFOUND: 40, ISDIR: 41, DENIED: 42, EXISTS: 43, FAILED: 44, NOTDIR: 45, SHORT: 46, NOBASE64: 97 };

const SCRIPTS = {
  // Who and where: the home folder, the folder an exec starts in (a container's WORKDIR), the
  // tools the other scripts need.
  hello: `printf 'home/%s\\n' "$HOME"
printf 'pwd/%s\\n' "$(pwd)"
printf 'uid/%s\\n' "$(id -u 2>/dev/null)"
for c in stat cat head tail mv rm mkdir rmdir chmod; do command -v "$c" >/dev/null 2>&1 || printf 'missing/%s\\n' "$c"; done
echo ok`,

  // One file or folder, through a link (the link itself when it leads nowhere): st/<mode hex>/<size>/<mtime>/<uid>/<gid>, or none.
  stat: `p=$(arg "$1") || exit 97
if [ ! -e "$p" ] && [ ! -h "$p" ]; then echo none; exit 0; fi
stat -L -c 'st/%f/%s/%Y/%u/%g' -- "$p" 2>/dev/null || stat -c 'st/%f/%s/%Y/%u/%g' -- "$p" || exit 44`,

  // Folders listed one after the other; their paths come on stdin (a count, then one per line,
  // so nothing waits for the end of the input). Per folder: dir/<path>, then x/<code> or the
  // entries (e/<mode hex>/<size>/<mtime>/<owner>/<group>/<name>, links as themselves; D/<name>
  // for a link to a folder), then end. Names with a line break are left out (no path here
  // can hold one). One stat for all the entries, or (too many for one command line) through
  // xargs; one each only when a name has a line break.
  list: `nl='
'
fmt='e/%f/%s/%Y/%U/%G/%n'
read -r count || exit 44
i=0
while [ "$i" -lt "$count" ] && IFS= read -r d; do
  i=$((i + 1))
  printf 'dir/%s\\n' "$d"
  if [ ! -e "$d" ]; then echo x/40; continue; fi
  if [ ! -d "$d" ]; then echo x/45; continue; fi
  if ! cd "$d" 2>/dev/null || [ ! -r . ]; then echo x/42; continue; fi
  echo ok
  bad=
  for f in * .*; do case $f in *"$nl"*) bad=1; break ;; esac; done
  if [ -z "$bad" ]; then
    stat -c "$fmt" -- * .* 2>/dev/null
    if [ $? -ge 126 ]; then printf '%s\\0' * .* | xargs -0 stat -c "$fmt" -- 2>/dev/null; fi
  else
    for f in * .*; do case $f in *"$nl"*) ;; *) stat -c "$fmt" -- "$f" 2>/dev/null ;; esac; done
  fi
  for f in * .*; do [ -h "$f" ] && [ -d "$f" ] && case $f in *"$nl"*) ;; *) printf 'D/%s\\n' "$f" ;; esac; done
  echo end
done
echo done`,

  // A file: st/<size>/<mtime>/<mode hex>, then its bytes; past <max> bytes only its last <keep>.
  read: `p=$(arg "$1") || exit 97
max=$(arg "$2") || exit 97
keep=$(arg "$3") || exit 97
[ -e "$p" ] || exit 40
[ -d "$p" ] && exit 41
[ -r "$p" ] || exit 42
s=$(stat -L -c '%s/%Y/%f' -- "$p") || exit 44
printf 'st/%s\\n' "$s"
n=\${s%%/*}
if [ "$n" -gt "$max" ]; then tail -c "$keep" -- "$p" || exit 44; else cat -- "$p" || exit 44; fi`,

  // Part of a file: <count> bytes from byte <from> (counted from 1).
  range: `p=$(arg "$1") || exit 97
from=$(arg "$2") || exit 97
n=$(arg "$3") || exit 97
[ -e "$p" ] || exit 40
[ -d "$p" ] && exit 41
[ -r "$p" ] || exit 42
tail -c "+$from" -- "$p" | head -c "$n"`,

  // Saves a file from stdin (exactly <n> bytes). Through a link, as SFTP does. With <mtime>
  // (and <size>), only when the file is still as it was read: else conflict/<mtime>/<size>. The
  // bytes go to <part> first, so a cut-off transfer never touches the file; then into the file
  // itself, which keeps its owner, permissions, hard links and a bind mount of it (a new file
  // takes the part's place). A folder that takes no new file gets the bytes straight away.
  write: `t=$(arg "$1") || exit 97
part=$(arg "$2") || exit 97
em=$(arg "$3") || exit 97
es=$(arg "$4") || exit 97
n=$(arg "$5") || exit 97
if [ -h "$t" ]; then r=$(readlink -f -- "$t" 2>/dev/null) && [ -n "$r" ] && t=$r; fi
if [ -d "$t" ]; then head -c "$n" >/dev/null; exit 41; fi
if [ -n "$em" ] && [ -e "$t" ]; then
  now=$(stat -c '%Y/%s' -- "$t") || { head -c "$n" >/dev/null; exit 44; }
  if [ "\${now%/*}" != "$em" ] || { [ -n "$es" ] && [ "\${now#*/}" != "$es" ]; }; then
    head -c "$n" >/dev/null
    printf 'conflict/%s\\n' "$now"
    exit 0
  fi
fi
if : > "$part" 2>/dev/null; then
  if ! head -c "$n" > "$part"; then rm -f -- "$part"; exit 44; fi
  if [ "$(stat -c %s -- "$part")" != "$n" ]; then rm -f -- "$part"; exit 46; fi
  if [ -e "$t" ]; then
    if ! cat -- "$part" > "$t"; then rm -f -- "$part"; exit 44; fi
    rm -f -- "$part"
  elif ! mv -f -- "$part" "$t"; then rm -f -- "$part"; exit 44; fi
else
  head -c "$n" > "$t" || exit 44
fi
stat -c 'ok/%Y/%s' -- "$t"`,

  // Bytes from stdin straight into <path> (a transfer's own .part file), exactly <n> of them.
  put: `p=$(arg "$1") || exit 97
n=$(arg "$2") || exit 97
if ! head -c "$n" > "$p"; then rm -f -- "$p"; exit 44; fi
if [ "$(stat -c %s -- "$p")" != "$n" ]; then rm -f -- "$p"; exit 46; fi
echo ok`,

  // A file for a transfer: st/<size>, then its bytes.
  get: `p=$(arg "$1") || exit 97
[ -e "$p" ] || exit 40
[ -d "$p" ] && exit 41
[ -r "$p" ] || exit 42
printf 'st/%s\\n' "$(stat -L -c %s -- "$p")"
cat -- "$p" || exit 44`,

  mkdir: `p=$(arg "$1") || exit 97
if [ -e "$p" ] || [ -h "$p" ]; then exit 43; fi
mkdir -- "$p" || exit 44
echo ok`,

  rmdir: `p=$(arg "$1") || exit 97
[ -d "$p" ] || exit 45
rmdir -- "$p" || exit 44
echo ok`,

  // Never over something there. A name that differs only in case (<tmp> given) on a folder that
  // ignores case (both names are the same file) goes through <tmp>; anything else in the way
  // is put back.
  rename: `f=$(arg "$1") || exit 97
t=$(arg "$2") || exit 97
tmp=$(arg "$3") || exit 97
[ -e "$f" ] || [ -h "$f" ] || exit 40
if [ -e "$t" ] || [ -h "$t" ]; then
  if [ -n "$tmp" ] && [ ! -h "$f" ] && [ ! -h "$t" ] && [ "$f" -ef "$t" ]; then
    mv -- "$f" "$tmp" || exit 44
    if ! mv -- "$tmp" "$t" 2>/dev/null || [ -e "$tmp" ]; then mv -- "$tmp" "$f"; exit 44; fi
    echo ok
    exit 0
  fi
  exit 43
fi
mv -- "$f" "$t" || exit 44
echo ok`,

  // A file, a link (not what it leads to) or a folder with what is in it, for good.
  remove: `p=$(arg "$1") || exit 97
[ -e "$p" ] || [ -h "$p" ] || exit 40
rm -rf -- "$p" || exit 44
if [ -e "$p" ] || [ -h "$p" ]; then exit 44; fi
echo ok`,

  chmod: `p=$(arg "$1") || exit 97
m=$(arg "$2") || exit 97
chmod "$m" "$p" || exit 44
echo ok`,

  // A terminal: in <dir> when it is there (else the home folder), the person's login shell
  // (from /etc/passwd, else bash, else sh) as a login shell.
  shell: `d=$(arg "$1") || exit 97
if [ -n "$d" ]; then cd "$d" 2>/dev/null || cd 2>/dev/null; fi
u=$(id -u 2>/dev/null)
s=$(awk -F: -v u="$u" '$3 == u { print $7; exit }' /etc/passwd 2>/dev/null)
case $s in */nologin | */false | */sync) s= ;; esac
for c in "$s" "$SHELL" /bin/bash /usr/bin/bash /bin/zsh /bin/ash /bin/sh; do
  if [ -n "$c" ] && [ -x "$c" ]; then exec "$c" -l; fi
done
exec sh`,
};

// ---- Reading what the scripts and the programs say -------------------------------------------

/** An error with a message for the person (remote.cjs passes it on as it is). */
function placeError(message, extra = {}) {
  return Object.assign(new Error(message), { place: true, ...extra });
}

/** Text from a program's error output: wsl.exe writes its own messages in UTF-16. */
function outputText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf ?? ''));
  const zeros = b.subarray(0, 400).filter((c) => c === 0).length;
  return (zeros > 4 ? b.toString('utf16le') : b.toString('utf8')).replace(/\0/g, '').replace(/^\ufeff/, '');
}
const lastLine = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? '';

/**
 * What the docker command line or wsl.exe said when it could not reach the place: { message,
 * lost (the session is over: stopped, removed, the engine gone), stopped (a container that is
 * there but not running) }, or null when it is about the script instead.
 */
function cliProblem(stderr, conn) {
  const text = outputText(stderr);
  const user = conn?.user || '';
  if (conn?.protocol === 'wsl') {
    const d = conn.distro;
    if (/no distribution with the supplied name|DISTRO_NOT_FOUND/i.test(text)) return { message: `WSL has no distribution named ${d} any more.`, lost: true };
    if (/USER_NOT_FOUND|user not found/i.test(text)) return { message: `${d} has no user ${user || 'by that name'}. Change the user in its settings.`, lost: true };
    if (/WSL_E_|Wsl\/|not installed|Windows Subsystem for Linux/i.test(text)) return { message: lastLine(text) || 'WSL did not start.', lost: true };
    return null;
  }
  const c = conn?.container ?? '';
  if (/No such container/i.test(text)) return { message: `The container ${c} is not there any more (removed?). Pick another one in its settings.`, lost: true };
  if (/is paused/i.test(text)) return { message: `The container ${c} is paused. Unpause it, then connect again.`, lost: true, stopped: true };
  if (/is not running|is restarting/i.test(text)) return { message: `The container ${c} is not running. Start it, then connect again.`, lost: true, stopped: true };
  if (/permission denied.*docker\.sock|permission denied while trying to connect/i.test(text)) return { message: 'Your user may not use Docker here (on Linux: add it to the docker group, then sign in again).', lost: true };
  if (/Cannot connect to the Docker daemon|failed to connect to the docker API|error during connect|daemon is not running|docker_engine|dockerDesktopLinuxEngine|Is the docker daemon running/i.test(text)) return { message: 'Docker is not running on this computer. Start Docker Desktop (or the docker service), then connect again.', lost: true };
  if (/unable to find user|no matching entries in passwd/i.test(text)) return { message: `The container ${c} has no user ${user || 'by that name'}. Change the user in its settings.`, lost: true };
  if (/executable file not found|exec: "?sh"?:|no such file or directory: unknown/i.test(text)) return { message: `The container ${c} has no shell (sh), so its files cannot be reached (an image without one, like distroless or scratch).`, lost: true };
  if (/^Error response from daemon/im.test(text)) return { message: lastLine(text).replace(/^Error response from daemon:\s*/i, ''), lost: false };
  return null;
}

const MODE = { dir: 0o040000, link: 0o120000, type: 0o170000 };

/** `stat -c '%f/%s/%Y/…'` fields → { dir, size, mtimeMs, mode }. */
function statFields(hex, size, mtime) {
  const raw = parseInt(hex, 16) || 0;
  const dir = (raw & MODE.type) === MODE.dir;
  return { dir, size: dir ? 0 : Number(size) || 0, mtimeMs: (Number(mtime) || 0) * 1000, mode: raw & 0o7777, raw };
}

/** The stat script's answer: { dir, size, mtimeMs, mode, uid, gid } or null. */
function parseStat(text) {
  const line = String(text).split('\n').find((l) => l.startsWith('st/') || l === 'none');
  if (!line) throw placeError('The place did not answer as expected.');
  if (line === 'none') return null;
  const [, hex, size, mtime, uid, gid] = line.split('/');
  const { dir, size: n, mtimeMs, mode } = statFields(hex, size, mtime);
  return { dir, size: n, mtimeMs, mode, uid: Number(uid), gid: Number(gid) };
}

/**
 * The list script's answer → Map(dir → { entries } | { error: code }), entries as SftpSession's
 * list gives them ({ name, path, dir, size, mtimeMs, mode, owner, group, link }). `complete`:
 * whether it got to the end.
 */
function parseListing(text) {
  const out = new Map();
  let current = null;
  let links = null;
  let complete = false;
  const close = () => {
    if (current && !current.error) for (const e of current.entries) if (links.has(e.name)) e.dir = true;
  };
  for (const line of String(text).split('\n')) {
    if (line.startsWith('dir/')) {
      close();
      const dir = line.slice(4);
      current = { dir, entries: [] };
      links = new Set();
      out.set(dir, current);
    } else if (!current) {
      if (line === 'done') complete = true;
    } else if (line.startsWith('x/')) current.error = Number(line.slice(2)) || CODES.FAILED;
    else if (line.startsWith('e/')) {
      const parts = line.slice(2).split('/');
      if (parts.length < 6) continue;
      const [hex, size, mtime, owner, group] = parts;
      const name = parts.slice(5).join('/');
      if (!name || name === '.' || name === '..') continue;
      const { dir, size: n, mtimeMs, mode, raw } = statFields(hex, size, mtime);
      const link = (raw & MODE.type) === MODE.link;
      current.entries.push({ name, path: posix.join(current.dir, name), dir, size: n, mtimeMs, mode, owner: owner === 'UNKNOWN' ? '' : owner, group: group === 'UNKNOWN' ? '' : group, link });
    } else if (line.startsWith('D/')) links.add(line.slice(2));
    else if (line === 'end') {
      close();
      current = null;
    } else if (line === 'done') complete = true;
  }
  close();
  for (const v of out.values()) {
    v.entries?.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of v.entries ?? []) if (e.dir) e.size = 0;
  }
  return { lists: out, complete };
}

/** `docker ps --format '{{json .}}'` → [{ name, id, image, state, status, ports, project, service }], running first. */
function parsePs(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const name = String(j.Names ?? '').split(',')[0].replace(/^\//, '').trim();
    if (!CONTAINER.test(name)) continue;
    const labels = Object.fromEntries(
      String(j.Labels ?? '')
        .split(',')
        .map((kv) => kv.split('='))
        .filter((kv) => kv.length >= 2)
        .map(([k, ...v]) => [k.trim(), v.join('=')]),
    );
    const status = String(j.Status ?? '');
    const state = String(j.State ?? '').toLowerCase() || (/^up\b/i.test(status) ? 'running' : 'exited');
    out.push({
      name,
      id: String(j.ID ?? '').slice(0, 12),
      image: String(j.Image ?? ''),
      state,
      running: state === 'running',
      status,
      ports: String(j.Ports ?? ''),
      project: labels['com.docker.compose.project'] ?? '',
      service: labels['com.docker.compose.service'] ?? '',
    });
  }
  return out.sort((a, b) => Number(b.running) - Number(a.running) || a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
}

// ---- Finding the programs ---------------------------------------------------------------------

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The app's environment for the programs, without Electron's own variables. */
function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) if (v != null && !/^(ELECTRON_|CHROME_)/.test(k)) out[k] = v;
  return out;
}

/**
 * The docker command line: { program, env } (env: PATH with the folders looked in, for its
 * plugins and credential helpers), or null. On PATH, the login shell's PATH (macOS apps started
 * from the Dock get little), then where Docker Desktop, OrbStack, Rancher Desktop and Colima put
 * it. On Windows only docker.exe (never a .cmd or .bat, which go through cmd.exe).
 */
async function findDocker({ env = process.env, platform = process.platform, exists = isFile, loginPath = null, home = os.homedir() } = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) return null;
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const join = win ? nodePath.win32.join : posix.join;
  const login = win ? '' : await (loginPath ?? (() => require('./lsp.cjs').shellPath({ env, platform })))();
  const known = win
    ? [env.ProgramFiles && join(env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Rancher Desktop', 'resources', 'resources', 'win32', 'bin')]
    : ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin', join(home, '.docker', 'bin'), join(home, '.orbstack', 'bin'), join(home, '.rd', 'bin'), ...(platform === 'darwin' ? ['/Applications/Docker.app/Contents/Resources/bin'] : [])];
  const dirs = [...new Set([...String(env.PATH ?? env.Path ?? '').split(sep), ...String(login || '').split(sep), ...known].filter(Boolean).map((d) => d.replace(/^"|"$/g, '')))];
  const name = win ? 'docker.exe' : 'docker';
  for (const dir of dirs) {
    const program = join(dir, name);
    if (exists(program)) {
      const out = { ...cleanEnv(env), PATH: dirs.join(sep) };
      if (win && out.Path !== undefined) delete out.Path;
      return { program, env: out };
    }
  }
  return null;
}

/** wsl.exe (Windows only): { program, env }, or null. */
function findWsl({ env = process.env, platform = process.platform, exists = isFile } = {}) {
  if (platform !== 'win32') return null;
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const program = nodePath.win32.join(root, 'System32', 'wsl.exe');
  return exists(program) ? { program, env: cleanEnv(env) } : null;
}

/**
 * The programs places use, found when first asked (and looked for again while missing, so
 * installing Docker needs no restart). Tests give their own: `docker` / `wsl` ({ program, env }
 * or null), `listDistros`.
 */
function createPlaceTools({ env = process.env, platform = process.platform, docker, wsl, listDistros } = {}) {
  let dockerFound = null;
  let wslFound = null;
  return {
    platform,
    async docker() {
      if (docker !== undefined) return docker;
      dockerFound ??= await findDocker({ env, platform });
      return dockerFound;
    },
    async wsl() {
      if (wsl !== undefined) return wsl;
      wslFound ??= findWsl({ env, platform });
      return wslFound;
    },
    /** WSL's distributions (wsl.exe -l -q, in UTF-16). */
    async distros() {
      if (listDistros) return listDistros();
      const tool = await this.wsl();
      if (!tool) return [];
      const { listWslDistros } = require('./localShell.cjs');
      return listWslDistros({ env, run: (_file, args, opts, cb) => childProcess.execFile(tool.program, args, { ...opts, env: tool.env }, cb) });
    },
  };
}

/** Runs one of the programs (not inside a place): { code, stdout, stderr }. */
function runTool(tool, args, { timeout = 15000, spawn = childProcess.spawn } = {}) {
  return runCommand({ program: tool.program, args, env: tool.env, timeout, spawn });
}

/**
 * What can be opened: { docker: [containers] | null, wsl: [names] | null, notes: { docker?, wsl? } }.
 * null where the kind is not available (no docker command line or its engine not answering;
 * not Windows); a note says why when it helps (Docker installed but not running).
 */
async function listPlaces(tools, { spawn } = {}) {
  const out = { docker: null, wsl: null, notes: {} };
  const docker = await tools.docker();
  if (docker) {
    const r = await runTool(docker, ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { timeout: 12000, spawn }).catch((err) => ({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(err.message) }));
    if (r.code === 0) out.docker = parsePs(r.stdout.toString('utf8'));
    else out.notes.docker = r.timedOut ? 'Docker did not answer in time. Is Docker Desktop starting?' : (cliProblem(r.stderr, { protocol: 'docker' })?.message ?? `Docker answered: ${lastLine(outputText(r.stderr)) || 'nothing'}`);
  }
  if (await tools.wsl()) {
    out.wsl = (await tools.distros().catch(() => [])).filter((d) => DISTRO.test(d));
    if (!out.wsl.length) out.notes.wsl = 'WSL has no distribution installed yet: wsl --install sets one up.';
  }
  return out;
}

/** Starts a stopped container the person picked from the list (`known`: the names listed now). */
async function startContainer(tools, name, { spawn } = {}) {
  const docker = await tools.docker();
  if (!docker) throw new Error('Docker is not on this computer.');
  if (!CONTAINER.test(String(name ?? ''))) throw new Error('That container name cannot be used.');
  const listed = await listPlaces(tools, { spawn });
  if (!listed.docker?.some((c) => c.name === name)) throw new Error(listed.notes.docker || `There is no container named ${name}.`);
  const r = await runTool(docker, ['start', name], { timeout: 60000, spawn });
  if (r.code !== 0) throw new Error(cliProblem(r.stderr, { protocol: 'docker', container: name })?.message ?? (lastLine(outputText(r.stderr)) || `${name} did not start.`));
  return true;
}

// ---- Running a command -----------------------------------------------------------------------

/**
 * Runs `program` with `args`: { code, signal, stdout (Buffer), stderr (Buffer), timedOut, stopped }.
 * `input`: a Buffer or string for stdin, or a readable stream piped to it; `onStdout(chunk)`
 * takes the output instead of keeping it; `signal` stops it; `timeout` (ms, 0 = none) kills it.
 */
function runCommand({ program, args, env, input = null, timeout = 30000, onStdout = null, signal = null, spawn = childProcess.spawn, maxOut = 512 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(program, args, { env, cwd: os.homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const err = [];
    let outSize = 0;
    let errSize = 0;
    let timedOut = false;
    let stopped = false;
    let settled = false;
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // gone already
      }
    };
    const timer = timeout ? setTimeout(() => ((timedOut = true), kill()), timeout) : null;
    timer?.unref?.();
    const onAbort = () => ((stopped = true), kill());
    if (signal?.aborted) onAbort();
    signal?.addEventListener('abort', onAbort);
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // A file streamed in that the command did not take to its end is let go.
      if (input && typeof input.destroy === 'function') input.destroy();
      fn();
    };
    child.stdout.on('data', (chunk) => {
      if (onStdout) return onStdout(chunk);
      outSize += chunk.length;
      if (outSize > maxOut) return kill();
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (errSize < 65536) err.push(chunk);
      errSize += chunk.length;
    });
    child.on('error', (e) => settle(() => reject(e)));
    child.on('close', (code, sig) => settle(() => resolve({ code, signal: sig, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut, stopped })));
    child.stdin.on('error', () => {});
    if (input === null || input === undefined) child.stdin.end();
    else if (typeof input.pipe === 'function') {
      input.on('error', () => kill());
      input.pipe(child.stdin);
    } else child.stdin.end(input);
  });
}

/** A child process with the face of an ssh2 exec channel (lspRemote.cjs channelProcess takes it). */
function childChannel(child) {
  const stream = new EventEmitter();
  child.stdout.on('data', (d) => stream.emit('data', d));
  stream.stderr = child.stderr;
  stream.write = (data) => child.stdin.write(data);
  child.stdin.on('error', () => {});
  child.on('exit', (code) => stream.emit('exit', code));
  child.on('close', () => stream.emit('close'));
  child.on('error', (err) => stream.emit('error', err));
  stream.signal = (name) => {
    try {
      child.kill(`SIG${name}`);
    } catch {
      // gone already
    }
  };
  // Its input ends (a language server stops when it does), then it is killed if still there.
  stream.close = () => {
    try {
      child.stdin.end();
    } catch {
      // closed already
    }
    setTimeout(() => child.exitCode === null && child.signalCode === null && stream.signal('KILL'), 3000).unref?.();
  };
  return stream;
}

// ---- The session ------------------------------------------------------------------------------

/**
 * A Docker container or a WSL distribution with SftpSession's face (list, stat, read, write,
 * mkdir, rename, remove, chmod, putFile, getFile, shell, exec…), each call one script inside.
 * `tool` is the program ({ program, env }); `onClose(message)` says it is over (a container
 * that stopped or went, Docker no longer answering). `spawn` and `ptySpawn` stand in for the
 * real ones in the tests.
 */
class ExecSession {
  constructor(conn, { tool, onClose = () => {}, spawn = childProcess.spawn, ptySpawn = null } = {}) {
    this.conn = conn;
    this.tool = tool;
    this.onClose = onClose;
    this.spawn = spawn;
    this.ptySpawn = ptySpawn;
    this.closed = false;
    this.running = 0;
    this.waiting = [];
    this.listQueue = null;
  }

  get name() {
    return this.conn.name || this.conn.container || this.conn.distro || 'the place';
  }

  /** Whether it can still be used (false once the container stopped or went). */
  get alive() {
    return !this.closed;
  }

  async open() {
    const { conn } = this;
    if (!this.tool) throw placeError(conn.protocol === 'wsl' ? 'WSL is not on this computer.' : 'Docker is not on this computer (no docker command found). Install Docker Desktop, then connect again.');
    // Docker's events are followed from just before it is looked at, so a stop in between is heard.
    const since = (Date.now() / 1000 - 0.001).toFixed(3);
    if (conn.protocol === 'docker') {
      const state = await this.containerState();
      if (state.Paused) throw placeError(`The container ${conn.container} is paused. Unpause it, then connect again.`, { stopped: true });
      if (state.Running === false) throw placeError(`The container ${conn.container} is not running (${state.Status || 'stopped'}). Start it, then connect again.`, { stopped: true });
    }
    // The first command in a WSL distribution that is not running starts it: a moment more.
    const out = (await this.script('hello', [], { timeout: conn.protocol === 'wsl' ? 120000 : 30000 })).stdout.toString('utf8');
    const lines = out.split('\n');
    const value = (key) => lines.find((l) => l.startsWith(`${key}/`))?.slice(key.length + 1) ?? '';
    if (!lines.includes('ok')) throw await this.noScripts();
    const missing = lines.filter((l) => l.startsWith('missing/')).map((l) => l.slice(8));
    if (missing.length) throw placeError(`${this.name} has no ${missing.join(', ')}, which reaching its files needs.`);
    this.homeDir = value('home').startsWith('/') ? value('home') : '/';
    this.workDir = value('pwd').startsWith('/') ? value('pwd') : this.homeDir;
    if (conn.protocol === 'docker') this.watch(since);
    return this;
  }

  /** The container's state as docker inspect gives it ({ Status, Running, Paused, … }); throws when Docker cannot say. */
  async containerState() {
    const { conn } = this;
    const r = await runTool(this.tool, ['inspect', '--type', 'container', '--format', '{{json .State}}', conn.container], { timeout: 20000, spawn: this.spawn });
    if (r.timedOut) throw placeError('Docker did not answer in time. Is Docker Desktop starting?');
    if (r.code !== 0) throw placeError(cliProblem(r.stderr, conn)?.message ?? (lastLine(outputText(r.stderr)) || `Docker could not find ${conn.container}.`), { gone: true });
    try {
      return JSON.parse(r.stdout.toString('utf8').trim() || '{}') ?? {};
    } catch {
      return {}; // an older docker: the commands say what is wrong
    }
  }

  // The scripts ran but said nothing: no base64 there (BOOT needs it), else its shell is odd.
  async noScripts() {
    const r = await runCommand({ program: this.tool.program, args: [...placePrefix(this.conn), 'sh', '-c', 'command -v base64 >/dev/null 2>&1 || echo nobase64'], env: this.tool.env, timeout: 20000, spawn: this.spawn }).catch(() => null);
    if (r && /nobase64/.test(r.stdout.toString('utf8'))) return placeError(`${this.name} has no base64 command, which reaching its files needs (busybox and coreutils have it).`);
    return placeError(`${this.name} did not answer as expected (its sh may not be a POSIX shell).`);
  }

  // A container that stops or goes ends the session (Docker's events, as they happen, from
  // `since`). Each is checked with Docker first: an event from just before a restart is not one.
  watch(since = '') {
    const { conn } = this;
    let child;
    try {
      child = this.spawn(this.tool.program, ['events', ...(since ? ['--since', since] : []), '--filter', 'type=container', '--filter', `container=${conn.container}`, '--filter', 'event=die', '--filter', 'event=destroy', '--filter', 'event=pause', '--format', '{{json .}}'], { env: this.tool.env, cwd: os.homedir(), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return;
    }
    const started = Date.now();
    let rest = '';
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk.toString('utf8')).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const action = String(e.Action ?? e.status ?? '');
        const said = { die: 'stopped', destroy: 'was removed', pause: 'was paused' }[action];
        if (said) this.confirmGone(`The container ${conn.container} ${said}.`);
      }
    });
    child.on('error', () => {});
    // It never keeps the app (or a test) running by itself.
    child.unref?.();
    child.stdout.unref?.();
    // Docker itself went (its engine stopped): over too. One that cannot follow events at all
    // (it ends at once) is left to the commands' own errors.
    child.on('close', () => {
      if (this.watcher === child && !this.closed && Date.now() - started > 3000) this.lost('Docker stopped answering.');
    });
    this.watcher = child;
  }

  // An event said it stopped: so it is, unless Docker says it runs (an event from before a restart).
  async confirmGone(message) {
    if (this.closed || this.confirming) return;
    this.confirming = true;
    try {
      const state = await this.containerState().catch((err) => (err.gone ? null : {}));
      if (!state || state.Running === false || state.Paused) this.lost(message);
    } finally {
      this.confirming = false;
    }
  }

  stopWatching() {
    const child = this.watcher;
    this.watcher = null;
    try {
      child?.kill();
    } catch {
      // gone already
    }
  }

  /** Over (the container stopped, Docker went): said once, with why. */
  lost(message) {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    this.onClose(message);
  }

  close() {
    this.closed = true;
    this.stopWatching();
  }

  async windows() {
    return false;
  }

  /** Where the place starts: a container's working folder, a distribution's home folder. */
  async home() {
    return this.conn.protocol === 'docker' ? this.workDir || '/' : this.homeDir || '/';
  }

  // At most PARALLEL commands at once.
  async slot(fn) {
    if (this.running >= PARALLEL) await new Promise((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Runs one of SCRIPTS (or a script of the caller's: `raw`) with `args`; the result as runCommand gives it. */
  async script(name, args = [], { input = null, timeout = 30000, onStdout = null, signal = null, raw = null } = {}) {
    if (this.closed && name !== 'hello') throw placeError(`${this.name} is not connected.`);
    const argv = placeArgs(this.conn, raw ?? SCRIPTS[name], args);
    const r = await this.slot(() => runCommand({ program: this.tool.program, args: argv, env: this.tool.env, input, timeout, onStdout, signal, spawn: this.spawn })).catch((err) => {
      if (err.code === 'ENOENT') throw placeError(`${this.tool.program} is not there any more.`);
      throw err;
    });
    if (r.stopped) throw stoppedError();
    if (r.timedOut) throw placeError(`${this.name} did not answer in ${Math.round(timeout / 1000)} s.`);
    if (r.code !== 0) {
      const problem = cliProblem(r.stderr, this.conn);
      if (problem && (r.code < 40 || r.code > 46) && r.code !== 97) {
        if (problem.lost) this.lost(problem.message);
        throw placeError(problem.message, { stopped: Boolean(problem.stopped) });
      }
    }
    return r;
  }

  /** The script's result as an error for the person, by its exit code (null when it worked). */
  failure(r, p = '') {
    const base = posix.basename(p) || p || this.name;
    switch (r.code) {
      case 0:
        return null;
      case CODES.NOTFOUND:
        return placeError(`Not found in ${this.name}.`, { notFound: true });
      case CODES.ISDIR:
        return placeError(`${base} is a folder.`);
      case CODES.DENIED:
        return placeError(`${this.name} refused: no permission for ${base}.`);
      case CODES.EXISTS:
        return placeError(`${base} already exists there.`);
      case CODES.NOTDIR:
        return placeError(`${base} is not a folder.`);
      case CODES.SHORT:
        return placeError(`${base} did not arrive whole in ${this.name}; nothing was changed.`);
      case CODES.NOBASE64:
        return placeError(`${this.name} has no base64 command, which reaching its files needs (busybox and coreutils have it).`);
      default: {
        const why = lastLine(outputText(r.stderr)).replace(/^(sh|ash|dash|bash): (line )?\d*:?\s*/, '');
        return placeError(why ? `${this.name}: ${why}` : `${this.name}: the command failed (code ${r.code}).`);
      }
    }
  }

  async run(name, args, opts, p) {
    const r = await this.script(name, args, opts);
    const err = this.failure(r, p);
    if (err) throw err;
    return r;
  }

  async stat(p) {
    const r = await this.run('stat', [checkPath(p)], {}, p);
    return parseStat(r.stdout.toString('utf8'));
  }

  /** Folders listed in one go: [entries | Error] in their order. */
  async listMany(dirs) {
    const out = [];
    for (let i = 0; i < dirs.length; i += MAX_LIST_DIRS) {
      const part = dirs.slice(i, i + MAX_LIST_DIRS).map(checkPath);
      const r = await this.run('list', [], { input: `${part.length}\n${part.join('\n')}\n`, timeout: 60000 + part.length * 50 });
      const { lists, complete } = parseListing(r.stdout.toString('utf8'));
      if (!complete) throw r.stdout.length ? placeError(`${this.name} did not list everything.`) : await this.noScripts();
      for (const d of part) {
        const got = lists.get(d);
        out.push(!got ? placeError(`${this.name} did not list ${d}.`) : got.error ? this.failure({ code: got.error }, d) : got.entries);
      }
    }
    return out;
  }

  /** A folder's entries. Several asked at the same moment (a walk's next folders) go in one command. */
  list(dir) {
    checkPath(dir);
    if (!this.listQueue) {
      const queue = { dirs: [], waiters: [] };
      this.listQueue = queue;
      setImmediate(() => {
        if (this.listQueue === queue) this.listQueue = null;
        const dirs = [...new Set(queue.dirs)];
        this.listMany(dirs).then(
          (lists) => {
            const by = new Map(dirs.map((d, i) => [d, lists[i]]));
            for (const w of queue.waiters) {
              const got = by.get(w.dir);
              if (got instanceof Error) w.reject(got);
              else w.resolve(got.map((e) => ({ ...e })));
            }
          },
          (err) => queue.waiters.forEach((w) => w.reject(err)),
        );
      });
    }
    return new Promise((resolve, reject) => {
      this.listQueue.dirs.push(dir);
      this.listQueue.waiters.push({ dir, resolve, reject });
    });
  }

  /**
   * Everything under `root`, a level of folders per command: [{ rel, entry }] (the root left
   * out), without what `skip(rel, entry)` leaves out; links to folders are followed only with
   * `links`. More than `max` throws `tooMany`. A folder inside that cannot be read throws,
   * unless `tolerant` (then it is left out).
   */
  async walkTree(root, { skip = () => false, links = false, max = Infinity, tolerant = false } = {}) {
    const out = [];
    let level = [''];
    while (level.length) {
      const lists = await this.listMany(level.map((rel) => (rel ? posix.join(root, rel) : root)));
      const next = [];
      level.forEach((rel, i) => {
        if (lists[i] instanceof Error) {
          if (tolerant && rel) return;
          throw lists[i];
        }
        for (const entry of lists[i]) {
          const child = rel ? `${rel}/${entry.name}` : entry.name;
          if (skip(child, entry)) continue;
          out.push({ rel: child, entry });
          if (out.length > max) throw Object.assign(new Error(`Too many files (more than ${max.toLocaleString('en-US')}).`), { tooMany: true });
          if (entry.dir && (links || !entry.link)) next.push(child);
        }
      });
      level = next;
    }
    return out;
  }

  /** Everything under a folder for mirrors and comparisons: { rel: { dir, size, mtimeMs } } (links left out). */
  async listTree(root, skip = () => false, max = 50000) {
    const out = {};
    try {
      for (const { rel, entry } of await this.walkTree(root, { skip: (rel, e) => e.link || skip(rel), max })) out[rel] = { dir: entry.dir, size: entry.dir ? 0 : entry.size, mtimeMs: entry.mtimeMs };
    } catch (err) {
      if (err.tooMany) throw new Error(`Too many files to mirror (more than ${max.toLocaleString('en-US')}).`);
      throw err;
    }
    return out;
  }

  /** A file or folder and what is in it: [{ path, dir, mode, size }], it first (for copies; `links: false` for chmod). */
  async walk(p, { links = true, max = Infinity } = {}) {
    const st = await this.stat(p);
    if (!st) throw placeError(`Not found in ${this.name}.`, { notFound: true });
    const out = [{ path: p, dir: st.dir, mode: st.mode, size: st.dir ? 0 : st.size }];
    if (!st.dir) return out;
    try {
      for (const { entry } of await this.walkTree(p, { links, skip: (_r, e) => !links && e.link, max: max - 1 })) out.push({ path: entry.path, dir: entry.dir, mode: entry.mode, size: entry.dir ? 0 : entry.size });
    } catch (err) {
      if (err.tooMany) throw new Error(`Too many files at once (more than ${max.toLocaleString('en-US')}).`);
      throw err;
    }
    return out;
  }

  /** { size, files, folders, truncated } of a folder (links not followed). */
  async folderSize(p) {
    const out = { size: 0, files: 0, folders: 0, truncated: false };
    try {
      for (const { entry } of await this.walkTree(p, { max: 200000, tolerant: true })) {
        if (entry.dir && !entry.link) out.folders++;
        else if (!entry.dir) {
          out.files++;
          out.size += entry.size;
        }
      }
    } catch (err) {
      if (!err.tooMany) throw err;
      out.truncated = true;
    }
    return out;
  }

  /** A file and its stat in one command: { st: { size, mtimeMs, mode }, bytes, truncated } (past `max` bytes only the last `keep`). */
  async readFile(p, { max = Number.MAX_SAFE_INTEGER, keep = max } = {}) {
    const r = await this.run('read', [checkPath(p), String(max), String(keep)], { timeout: 120000 }, p);
    const nl = r.stdout.indexOf(10);
    const head = nl < 0 ? '' : r.stdout.subarray(0, nl).toString('utf8');
    if (!head.startsWith('st/')) throw await this.noScripts();
    const [, size, mtime, hex] = head.split('/');
    const st = statFields(hex, size, mtime);
    return { st: { size: Number(size) || 0, mtimeMs: st.mtimeMs, mode: st.mode, dir: false }, bytes: r.stdout.subarray(nl + 1), truncated: (Number(size) || 0) > max };
  }

  async read(p) {
    return (await this.readFile(p)).bytes;
  }

  async readRange(p, start, length) {
    const r = await this.run('range', [checkPath(p), String(Math.max(0, start) + 1), String(Math.max(0, length))], { timeout: 120000 }, p);
    return r.stdout;
  }

  /**
   * Saves bytes (a Buffer, or { path, size } of a file here, streamed) to `p`. With
   * `expectedMtime` (ms) and `expectedSize`: only when the file there did not change since it
   * was read, else { conflict, mtimeMs }. Returns { mtimeMs, size }.
   */
  async writeChecked(p, data, { expectedMtime, expectedSize, signal } = {}) {
    checkPath(p);
    const size = Buffer.isBuffer(data) ? data.length : data.size;
    const part = posix.join(posix.dirname(p), `.${posix.basename(p)}.part-${crypto.randomBytes(3).toString('hex')}`);
    const em = expectedMtime === undefined || expectedMtime === null ? '' : String(Math.round(Number(expectedMtime) / 1000));
    const es = em && expectedSize !== undefined && expectedSize !== null ? String(Number(expectedSize)) : '';
    const input = Buffer.isBuffer(data) ? data : fs.createReadStream(data.path);
    const r = await this.run('write', [p, part, em, es, String(size)], { input, timeout: 120000 + Math.round(size / 10000), signal }, p);
    const line = r.stdout.toString('utf8').split('\n').find((l) => l.startsWith('ok/') || l.startsWith('conflict/'));
    if (!line) throw await this.noScripts();
    const [kind, mtime, got] = line.split('/');
    if (kind === 'conflict') return { conflict: true, mtimeMs: Number(mtime) * 1000, size: Number(got) };
    return { mtimeMs: Number(mtime) * 1000, size: Number(got) };
  }

  async write(p, data) {
    await this.writeChecked(p, data);
  }

  async mkdir(p) {
    await this.run('mkdir', [checkPath(p)], {}, p);
  }

  async rmdir(p) {
    await this.run('rmdir', [checkPath(p)], {}, p);
  }

  async rename(from, to) {
    // Only a change of case may find "the same file" there (a folder that ignores case).
    const caseOnly = checkPath(from) !== checkPath(to) && from.toLowerCase() === to.toLowerCase();
    const tmp = caseOnly ? posix.join(posix.dirname(from), `.${posix.basename(from)}.rename-${crypto.randomBytes(3).toString('hex')}`) : '';
    await this.run('rename', [from, to, tmp], {}, to);
  }

  async remove(p) {
    await this.run('remove', [checkPath(p)], { timeout: 300000 }, p);
  }

  async chmod(p, mode) {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw placeError('That is not a permission.');
    await this.run('chmod', [checkPath(p), mode.toString(8)], {}, p);
  }

  /** A file here sent to `p` (a transfer's own .part name), reporting the bytes sent (`onBytes`); `signal` stops it. */
  async putFile(localPath, p, { onBytes = () => {}, signal } = {}) {
    const size = fs.statSync(localPath).size;
    const input = fs.createReadStream(localPath);
    let sent = 0;
    input.on('data', (chunk) => {
      sent += chunk.length;
      onBytes(sent);
    });
    await this.run('put', [checkPath(p), String(size)], { input, timeout: 0, signal }, p);
  }

  /** A file there written to `localPath` here, reporting the bytes so far (`onBytes`); the size is checked at the end. */
  async getFile(p, localPath, { onBytes = () => {}, signal, flags = 'wx' } = {}) {
    const fd = fs.openSync(localPath, flags);
    let head = Buffer.alloc(0);
    let size = null;
    let got = 0;
    let writeError = null;
    try {
      const r = await this.script('get', [checkPath(p)], {
        timeout: 0,
        signal,
        onStdout: (chunk) => {
          let data = chunk;
          if (size === null) {
            head = Buffer.concat([head, chunk]);
            const nl = head.indexOf(10);
            if (nl < 0) return;
            size = Number(head.subarray(0, nl).toString('utf8').replace(/^st\//, '')) || 0;
            data = head.subarray(nl + 1);
          }
          if (!data.length || writeError) return;
          try {
            fs.writeSync(fd, data);
          } catch (err) {
            writeError = err;
          }
          got += data.length;
          onBytes(got);
        },
      });
      const err = this.failure(r, p);
      if (err) throw err;
      if (writeError) throw writeError;
      if (size === null || got !== size) throw placeError(`${posix.basename(p)} did not arrive whole from ${this.name}.`);
    } finally {
      fs.closeSync(fd);
    }
  }

  // For mirrors: whole files, without progress.
  async downloadTo(p, localPath) {
    await this.getFile(p, localPath, { flags: 'w' });
  }

  async uploadFrom(localPath, p) {
    await this.writeChecked(p, { path: localPath, size: fs.statSync(localPath).size });
  }

  /** A terminal there, in `cwd`: node-pty runs docker exec -it or wsl.exe, with remote.openShell's face. */
  async shell({ cols = 80, rows = 24, cwd = '' } = {}) {
    if (this.closed) throw placeError(`${this.name} is not connected.`);
    const { ptyStream, spawnPty } = require('./localShell.cjs');
    const args = placeArgs(this.conn, SCRIPTS.shell, [cwd ? checkPath(cwd) : ''], { tty: true });
    const proc = (this.ptySpawn ?? spawnPty)(this.tool.program, args, { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: this.tool.env, useConpty: true });
    return ptyStream(proc, { shell: 'posix', label: `${this.name} (${PLACE_LABEL[this.conn.protocol]})` });
  }

  /** A command there without a terminal (a language server): its channel, as SftpSession's exec gives one. */
  async exec(command) {
    if (this.closed) throw placeError(`${this.name} is not connected.`);
    const child = this.spawn(this.tool.program, placeArgs(this.conn, String(command)), { env: this.tool.env, cwd: os.homedir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return childChannel(child);
  }

  /** A shell script there (a language server's probe): its output, `max` bytes at most, within `timeout` ms. */
  async runScript(script, { timeout = 30000, max = 256 * 1024 } = {}) {
    const r = await this.script('', [], { raw: String(script), timeout });
    return r.stdout.subarray(0, max).toString('utf8');
  }
}

module.exports = {
  PLACE_PROTOCOLS,
  PLACE_LABEL,
  isPlace,
  CONTAINER,
  DISTRO,
  USER,
  BOOT,
  PRELUDE,
  SCRIPTS,
  CODES,
  encodeArg,
  placePrefix,
  placeArgs,
  cleanPlace,
  checkPath,
  cliProblem,
  outputText,
  parseStat,
  parseListing,
  parsePs,
  findDocker,
  findWsl,
  createPlaceTools,
  listPlaces,
  startContainer,
  runCommand,
  childChannel,
  placeError,
  ExecSession,
};
