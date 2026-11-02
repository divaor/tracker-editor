// Docker containers and WSL distributions as places (electron/places.cjs, through remote.cjs):
// the command lines and their encoding (names that would break quoting: spaces, quotes, $,
// backticks, ;, a leading dash, Unicode; a NUL or a line break refused), how Windows would
// quote them, the checks on what is saved, what the programs answer (docker ps, inspect,
// errors, WSL's UTF-16), finding the programs, and every call of a session against a fake
// docker and a fake wsl.exe (test/helpers) whose "containers" are folders here, with this
// machine's sh (dash here) and again with only busybox's applets, as on Alpine: listings,
// reads, writes with their conflicts, folders, renames, removal, permissions, transfers with
// progress, trees, a terminal in a pseudo-terminal, a language server's channel, a container
// that stops, the remote.cjs API over all of it, and a language server started inside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const places = require('../electron/places.cjs');
const { createRemote, toUri } = require('../electron/remote.cjs');
const lsp = require('../electron/lsp.cjs');
const FAKE_DOCKER = fileURLToPath(new URL('./helpers/fake-docker.cjs', import.meta.url));
const FAKE_WSL = fileURLToPath(new URL('./helpers/fake-wsl.cjs', import.meta.url));
const FAKE_LSP = fileURLToPath(new URL('./helpers/fake-lsp.cjs', import.meta.url));

// The scripts run here as a container runs them: a POSIX sh with Linux's stat -c, base64 -d and
// head -c (GNU's or busybox's). Not on Windows, nor on a Mac's BSD tools.
const linuxTools = process.platform !== 'win32' && spawnSync('sh', ['-c', 'stat -c %s / >/dev/null && printf x | base64 | base64 -d >/dev/null && head -c 1 /dev/null'], { encoding: 'utf8' }).status === 0;
const scripts = { skip: !linuxTools && 'the scripts need a POSIX sh with Linux’s stat, base64 and head (as a container has)' };
const BUSYBOX = ['/usr/bin/busybox', '/bin/busybox'].find((p) => fs.existsSync(p));
let pty = null;
try {
  pty = require('@lydell/node-pty');
} catch {
  // no terminal test without it
}

const decode = (arg) => Buffer.from(arg, 'base64').toString('utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

// Names that would break a command line or a shell if they were ever pasted into one.
const NASTY = ['a b', `q'u"o`, 'd$HOME', '`id`', 'semi;colon', '-rf', 'ünïcødé 名前', 'back\\slash', 'star*?[x]', 'tab\there', '$(touch pwned)', "it's", '  spaces  '];

// ---- The command lines -----------------------------------------------------------------------

test('arguments are base64 of ":" + the value, whatever it holds; a NUL or a line break is refused', () => {
  for (const name of [...NASTY, '', '/']) {
    const arg = places.encodeArg(name);
    assert.match(arg, /^[A-Za-z0-9+/]+=*$/, 'only base64’s letters reach the command line');
    assert.equal(decode(arg), `:${name}`);
  }
  assert.throws(() => places.encodeArg('a\nb'), /line break/);
  assert.throws(() => places.encodeArg('a\0b'), /line break/);
  assert.throws(() => places.checkPath('relative/path'), /cannot be used/);
  assert.throws(() => places.checkPath('/a\nb'), /cannot be used/);
  assert.equal(places.checkPath('/app/a b'), '/app/a b');
});

test('the command line: docker exec or wsl.exe, then sh running the decoded script; every word from the checked record', () => {
  const docker = { protocol: 'docker', container: 'web-1', user: '' };
  const argv = places.placeArgs(docker, places.SCRIPTS.stat, ['/app/a b']);
  assert.deepEqual(argv.slice(0, 7), ['exec', '-i', 'web-1', 'sh', '-c', places.BOOT, 'sh']);
  assert.equal(decode(argv[7]), places.PRELUDE + places.SCRIPTS.stat);
  assert.equal(decode(argv[8]), ':/app/a b');
  assert.deepEqual(places.placePrefix({ ...docker, user: 'node' }), ['exec', '-i', '-u', 'node', 'web-1']);
  assert.deepEqual(places.placePrefix({ ...docker, user: '1000:1000' }, { tty: true }), ['exec', '-i', '-t', '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor', '-u', '1000:1000', 'web-1']);
  assert.deepEqual(places.placePrefix({ protocol: 'wsl', distro: 'Ubuntu-24.04', user: '' }), ['-d', 'Ubuntu-24.04', '--exec']);
  assert.deepEqual(places.placePrefix({ protocol: 'wsl', distro: 'Debian', user: 'me' }), ['-d', 'Debian', '-u', 'me', '--exec']);
  // A record changed by hand never gets an option or a second word in.
  for (const container of ['-it', '--privileged', 'a b', 'x;rm', '']) assert.throws(() => places.placePrefix({ ...docker, container }), /cannot be used/);
  for (const user of ['-root', 'a b', 'u;x']) assert.throws(() => places.placePrefix({ ...docker, user }), /cannot be used/);
  assert.throws(() => places.placePrefix({ protocol: 'wsl', distro: '--system' }), /cannot be used/);
  assert.throws(() => places.placePrefix({ protocol: 'sftp' }), /Not a Docker/);
});

test('nothing quoting could change: only BOOT has spaces, and it has no quote or backslash', () => {
  assert.doesNotMatch(places.BOOT, /["'\\]/);
  for (const name of Object.keys(places.SCRIPTS)) {
    const argv = places.placeArgs({ protocol: 'docker', container: 'web-1', user: 'www-data' }, places.SCRIPTS[name], NASTY);
    for (const word of argv) if (word !== places.BOOT) assert.match(word, /^[A-Za-z0-9+/=_.:-]+$/, word);
  }
});

// libuv's quote_cmd_arg (how Node puts arguments on a Windows command line) and the MSVCRT rules
// docker.exe (Go) and wsl.exe read them back with; also a sloppy reader that knows only quotes.
function quoteWindows(arg) {
  if (!arg) return '""';
  if (!/[ \t"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = '';
  let quoteHit = true;
  for (let i = arg.length; i > 0; i--) {
    out += arg[i - 1];
    if (quoteHit && arg[i - 1] === '\\') out += '\\';
    else if (arg[i - 1] === '"') {
      quoteHit = true;
      out += '\\';
    } else quoteHit = false;
  }
  return `"${[...out].reverse().join('')}"`;
}
function parseWindows(line) {
  const args = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') {
        let n = 0;
        while (line[i] === '\\') n++, i++;
        if (line[i] === '"') {
          arg += '\\'.repeat(Math.floor(n / 2));
          if (n % 2) arg += '"';
          else quoted = !quoted;
        } else {
          arg += '\\'.repeat(n);
          i--;
        }
      } else if (c === '"') quoted = !quoted;
      else if ((c === ' ' || c === '\t') && !quoted) break;
      else arg += c;
    }
    args.push(arg);
  }
  return args;
}
const parseSloppy = (line) => (line.match(/"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^"|"$/g, ''));

test('Windows: the command line Node makes for docker.exe and wsl.exe reads back word for word, even by a sloppy reader', () => {
  for (const conn of [{ protocol: 'docker', container: 'web-1', user: 'node' }, { protocol: 'wsl', distro: 'Ubuntu', user: '' }]) {
    for (const name of ['write', 'list', 'shell']) {
      const argv = places.placeArgs(conn, places.SCRIPTS[name], NASTY, { tty: name === 'shell' });
      const line = argv.map(quoteWindows).join(' ');
      assert.deepEqual(parseWindows(line), argv);
      assert.deepEqual(parseSloppy(line), argv);
    }
  }
  // The quoting itself, on the cases libuv documents.
  assert.equal(quoteWindows('hello"world'), '"hello\\"world"');
  assert.equal(quoteWindows('hello world\\'), '"hello world\\\\"');
  assert.deepEqual(parseWindows(quoteWindows('a "b" \\c\\')), ['a "b" \\c\\']);
});

test('what is saved: a container or a distribution picked by name, an optional user', () => {
  assert.deepEqual(places.cleanPlace({ protocol: 'docker', container: ' web-1 ' }), { container: 'web-1', user: '' });
  assert.deepEqual(places.cleanPlace({ protocol: 'docker', container: '/shop_db.1', user: 'postgres' }), { container: 'shop_db.1', user: 'postgres' });
  assert.deepEqual(places.cleanPlace({ protocol: 'docker', container: 'a1b2c3d4e5f6', user: '1000:1000' }), { container: 'a1b2c3d4e5f6', user: '1000:1000' });
  assert.deepEqual(places.cleanPlace({ protocol: 'wsl', distro: 'Ubuntu-22.04' }), { distro: 'Ubuntu-22.04', user: '' });
  for (const container of ['', '-rm', '--privileged', 'a b', 'x;y', '../x', 'a/b', '$(id)', 'é']) assert.throws(() => places.cleanPlace({ protocol: 'docker', container }), /Pick a container/, container);
  for (const user of ['a b', '-u', 'root;id', 'x:y:z']) assert.throws(() => places.cleanPlace({ protocol: 'docker', container: 'web', user }), /user is a name/, user);
  assert.throws(() => places.cleanPlace({ protocol: 'wsl', distro: '-d' }), /Pick a WSL/);
  assert.throws(() => places.cleanPlace({ protocol: 'ftp' }), /Not a Docker/);
});

// ---- What the programs say -------------------------------------------------------------------

test('docker ps: names, images, state, ports and the compose project; running first', () => {
  const lines = [
    { ID: 'aaa111aaa111ffff', Names: 'shop-db-1', Image: 'postgres:16', State: 'exited', Status: 'Exited (0) 3 hours ago', Ports: '', Labels: 'com.docker.compose.project=shop,com.docker.compose.service=db' },
    { ID: 'bbb222bbb222ffff', Names: 'shop-web-1', Image: 'node:22-alpine', State: 'running', Status: 'Up 2 minutes', Ports: '0.0.0.0:3000->3000/tcp', Labels: 'com.docker.compose.project=shop,com.docker.compose.service=web,x=a=b' },
    { ID: 'ccc', Names: '/legacy', Image: 'alpine', Status: 'Up 1 second' },
    { ID: 'ddd', Names: '-bad name', Image: 'x', Status: 'Up' },
  ].map((o) => JSON.stringify(o));
  const found = places.parsePs([...lines, 'not json', ''].join('\n'));
  assert.deepEqual(found.map((c) => [c.name, c.running]), [['legacy', true], ['shop-web-1', true], ['shop-db-1', false]]);
  const web = found.find((c) => c.name === 'shop-web-1');
  assert.deepEqual([web.image, web.project, web.service, web.ports, web.id], ['node:22-alpine', 'shop', 'web', '0.0.0.0:3000->3000/tcp', 'bbb222bbb222']);
  assert.equal(found.find((c) => c.name === 'legacy').state, 'running', 'an older docker without State: from its Status');
});

test('listings, stats and the programs’ errors are read back', () => {
  const { lists, complete } = places.parseListing(
    ['dir//app', 'ok', 'e/81a4/12/1700000000/node/node/a b', 'e/a1ff/3/1700000000/root/root/ldir', 'e/41ed/4096/1700000001/UNKNOWN/UNKNOWN/sub', 'e/41ed/4096/1/root/root/.', 'D/ldir', 'end', 'dir//gone', 'x/40', 'dir//f', 'x/45', 'done', ''].join('\n'),
  );
  assert.equal(complete, true);
  const app = lists.get('/app').entries;
  assert.deepEqual(app.map((e) => [e.name, e.dir, e.link, e.size, e.mtimeMs, e.mode]), [['a b', false, false, 12, 1700000000000, 0o644], ['ldir', true, true, 0, 1700000000000, 0o777], ['sub', true, false, 0, 1700000001000, 0o755]]);
  assert.equal(app[0].path, '/app/a b');
  assert.deepEqual([app[0].owner, app[2].owner], ['node', '']);
  assert.equal(lists.get('/gone').error, 40);
  assert.equal(lists.get('/f').error, 45);
  assert.equal(places.parseListing('dir//app\nok\n').complete, false);
  assert.deepEqual(places.parseStat('st/41ed/4096/1700000000/1000/1000\n'), { dir: true, size: 0, mtimeMs: 1700000000000, mode: 0o755, uid: 1000, gid: 1000 });
  assert.equal(places.parseStat('none\n'), null);
  const docker = { protocol: 'docker', container: 'web-1', user: 'app' };
  assert.match(places.cliProblem('Error response from daemon: No such container: web-1\n', docker).message, /not there any more/);
  const stopped = places.cliProblem('Error response from daemon: container 4f1e is not running\n', docker);
  assert.deepEqual([stopped.lost, stopped.stopped], [true, true]);
  for (const down of ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', 'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running', 'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'])
    assert.match(places.cliProblem(down, docker).message, /Docker is not running/);
  assert.match(places.cliProblem('unable to find user app: no matching entries in passwd file', docker).message, /no user app/);
  assert.match(places.cliProblem('OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown', docker).message, /no shell/);
  assert.equal(places.cliProblem('sh: 1: cannot create /x: Permission denied', docker), null, 'a script’s own error is not the program’s');
  // wsl.exe writes its own errors in UTF-16.
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n', 'utf16le')]);
  assert.match(places.outputText(utf16), /^There is no distribution/);
  assert.match(places.cliProblem(utf16, { protocol: 'wsl', distro: 'Arch' }).message, /no distribution named Arch/);
});

test('several files read in one command are told apart by their sizes; one that changed meanwhile says so', () => {
  const buf = Buffer.concat([
    Buffer.from('f/3/1700000000/81a4\n'),
    Buffer.from('a\nb'),
    Buffer.from('\nt/3/1700000000\nx/42\nbig/9999/1700000000/81a4\nf/2/1700000000/81a4\nxy\nt/5/1700000001\ndone\n'),
  ]);
  const { results, complete } = places.parseReadMany(buf, 4);
  assert.equal(complete, true);
  assert.deepEqual([results[0].bytes.toString(), results[0].st.size, results[0].st.mtimeMs, results[0].st.mode], ['a\nb', 3, 1700000000000, 0o644]);
  assert.deepEqual(results[1], { error: 42 });
  assert.deepEqual([results[2].truncated, results[2].st.size], [true, 9999]);
  assert.deepEqual(results[3], { changed: true });
  // Cut short (the command ended early): what came whole is kept, the rest is not trusted.
  const cut = places.parseReadMany(buf.subarray(0, 25), 4);
  assert.deepEqual([cut.results.length, cut.complete], [0, false]);
});

test('finding docker: PATH, then the login shell’s, then the usual places; on Windows docker.exe only; not on a phone', async () => {
  const has = (...files) => (p) => files.includes(p);
  const linux = await places.findDocker({ platform: 'linux', env: { PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' }, exists: has('/usr/bin/docker'), loginPath: async () => '' });
  assert.equal(linux.program, '/usr/bin/docker');
  assert.equal(linux.env.ELECTRON_RUN_AS_NODE, undefined, 'Electron’s own variables stay out');
  const mac = await places.findDocker({ platform: 'darwin', env: { PATH: '/usr/bin:/bin' }, home: '/Users/me', exists: has('/Users/me/.docker/bin/docker'), loginPath: async () => '/opt/homebrew/bin:/usr/bin' });
  assert.equal(mac.program, '/Users/me/.docker/bin/docker');
  assert.ok(mac.env.PATH.split(':').includes('/opt/homebrew/bin'), 'its plugins and credential helpers are found on the login shell’s PATH');
  const byLogin = await places.findDocker({ platform: 'darwin', env: { PATH: '/usr/bin' }, exists: has('/opt/orbit/bin/docker'), loginPath: async () => '/opt/orbit/bin' });
  assert.equal(byLogin.program, '/opt/orbit/bin/docker');
  const win = await places.findDocker({ platform: 'win32', env: { Path: 'C:\\tools;C:\\Program Files\\Docker\\Docker\\resources\\bin', ProgramFiles: 'C:\\Program Files' }, exists: has('C:\\tools\\docker.cmd', 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe') });
  assert.equal(win.program, 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', 'a .cmd would go through cmd.exe: never');
  assert.equal(win.env.Path, undefined);
  assert.equal(await places.findDocker({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: has(), loginPath: async () => '' }), null);
  assert.equal(await places.findDocker({ platform: 'android', env: { PATH: '/system/bin' }, exists: () => true }), null);
  assert.equal(places.findWsl({ platform: 'win32', env: { SystemRoot: 'C:\\WINDOWS' }, exists: has('C:\\WINDOWS\\System32\\wsl.exe') }).program, 'C:\\WINDOWS\\System32\\wsl.exe');
  assert.equal(places.findWsl({ platform: 'linux', env: {}, exists: () => true }), null);
});

// ---- Against the fake docker -------------------------------------------------------------------

/**
 * A made-up container: its working folder and home are folders here, `docker` a fake on its own
 * folder; `busybox`: its PATH holds only busybox's applets (an Alpine). Returns { root, app,
 * home, tool, state(), setState(fn), runs() }.
 */
function fakeDocker({ busybox = false, containers = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'places-')));
  const bin = path.join(root, 'bin');
  const app = path.join(root, 'ctr', 'app');
  const home = path.join(root, 'ctr', 'home');
  for (const d of [bin, app, home]) fs.mkdirSync(d, { recursive: true });
  let containerPath;
  if (busybox) {
    containerPath = path.join(root, 'bb');
    fs.mkdirSync(containerPath);
    const list = spawnSync(BUSYBOX, ['--list'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    for (const name of list) fs.symlinkSync(BUSYBOX, path.join(containerPath, name));
  }
  const launcher = (file, target) => fs.writeFileSync(path.join(bin, file), `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, { mode: 0o755 });
  launcher('docker', FAKE_DOCKER);
  launcher('wsl.exe', FAKE_WSL);
  const statePath = path.join(root, 'docker.json');
  const log = path.join(root, 'docker.log');
  fs.writeFileSync(statePath, JSON.stringify({ log, containers: [{ Name: 'web-1', Image: 'node:22-alpine', State: 'running', WorkingDir: app, Home: home, ...(containerPath ? { Path: containerPath } : {}), Ports: '0.0.0.0:3000->3000/tcp', Labels: 'com.docker.compose.project=shop' }, ...containers] }));
  const state = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return {
    root,
    app,
    home,
    bin,
    containerPath,
    tool: { program: path.join(bin, 'docker'), env: { ...process.env, FAKE_DOCKER_STATE: statePath } },
    state,
    // As the fake's own commands do: the states before the change go to its history (docker events --since).
    setState(fn) {
      const s = state();
      const before = Object.fromEntries(s.containers.map((c) => [c.Name, c.State]));
      fn(s);
      s.history = [...(s.history ?? []), { at: Date.now(), states: before }];
      fs.writeFileSync(statePath, JSON.stringify(s));
    },
    runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}
const dockerConn = (extra = {}) => ({ id: 'abcde12345', name: 'web-1', protocol: 'docker', container: 'web-1', user: '', ...extra });

const variants = [{ label: 'sh and Linux’s tools', busybox: false }, { label: 'busybox only (Alpine)', busybox: true, skip: !BUSYBOX && 'no busybox here' }];

for (const variant of variants) {
  const opts = { skip: scripts.skip || variant.skip };

  test(`a session (${variant.label}): it opens, lists every kind of name, reads and stats`, opts, async () => {
    const w = fakeDocker({ busybox: variant.busybox });
    const s = new places.ExecSession(dockerConn(), { tool: w.tool });
    await s.open();
    assert.equal(await s.home(), w.app, 'a container starts in its working folder');
    for (const name of NASTY) fs.writeFileSync(path.join(w.app, name), `text of ${name}`);
    fs.writeFileSync(path.join(w.app, '.hidden'), 'h');
    fs.writeFileSync(path.join(w.app, 'line\nbreak'), 'x');
    fs.mkdirSync(path.join(w.app, 'sub dir'));
    fs.writeFileSync(path.join(w.app, 'sub dir', 'inner.txt'), 'inner');
    fs.symlinkSync('sub dir', path.join(w.app, 'to-sub'));
    fs.symlinkSync('nowhere', path.join(w.app, 'dangling'));
    fs.chmodSync(path.join(w.app, 'a b'), 0o640);
    const entries = await s.list(w.app);
    const names = entries.map((e) => e.name);
    for (const name of [...NASTY, '.hidden', 'sub dir', 'to-sub', 'dangling']) assert.ok(names.includes(name), `${name} is listed`);
    assert.ok(!names.some((n) => n.includes('\n')), 'a name with a line break is left out (no path here can hold one)');
    const by = (n) => entries.find((e) => e.name === n);
    assert.deepEqual([by('a b').dir, by('a b').size, by('a b').mode, by('a b').path], [false, 'text of a b'.length, 0o640, path.join(w.app, 'a b')]);
    assert.deepEqual([by('sub dir').dir, by('to-sub').dir, by('to-sub').link, by('dangling').dir, by('dangling').link], [true, true, true, false, true]);
    assert.ok(Math.abs(by('a b').mtimeMs - fs.statSync(path.join(w.app, 'a b')).mtimeMs) < 1000);
    assert.equal(by('a b').owner, os.userInfo().username);
    // Stats, through links; a link leading nowhere is itself; nothing there is null.
    assert.equal((await s.stat(path.join(w.app, 'to-sub'))).dir, true);
    assert.equal((await s.stat(path.join(w.app, 'dangling'))).dir, false);
    assert.equal(await s.stat(path.join(w.app, 'nothing')), null);
    // Reads: whole, the end of a large one, a part.
    for (const name of NASTY) assert.equal((await s.read(path.join(w.app, name))).toString('utf8'), `text of ${name}`);
    const big = Buffer.from(Array.from({ length: 5000 }, (_, i) => `line ${i}\n`).join(''));
    fs.writeFileSync(path.join(w.app, 'big.log'), big);
    const tail = await s.readFile(path.join(w.app, 'big.log'), { max: 1000, keep: 100 });
    assert.deepEqual([tail.truncated, tail.st.size, tail.bytes.length], [true, big.length, 100]);
    assert.equal(tail.bytes.toString(), big.subarray(big.length - 100).toString());
    assert.equal((await s.readRange(path.join(w.app, 'big.log'), 7, 6)).toString(), big.subarray(7, 13).toString());
    // Binary bytes come back as they are.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    fs.writeFileSync(path.join(w.app, 'bytes.bin'), bytes);
    assert.deepEqual(await s.read(path.join(w.app, 'bytes.bin')), bytes);
    // Files asked for at the same moment come in one command, each whole (any byte, a line break too).
    const lines = Buffer.from('a\nb\n\nt/9/9\n');
    fs.writeFileSync(path.join(w.app, 'lines.txt'), lines);
    const before = w.runs().length;
    const [r1, r2, r3, r4, r5] = await Promise.allSettled(['bytes.bin', 'lines.txt', 'big.log', 'nothing', 'sub dir'].map((n) => s.readUpTo(path.join(w.app, n), 4096)));
    assert.equal(w.runs().length - before, 1, 'one command for the five');
    assert.deepEqual([r1.value.bytes, r1.value.truncated, r1.value.st.size], [bytes, false, 256]);
    assert.deepEqual(r2.value.bytes, lines);
    assert.deepEqual([r3.value.truncated, r3.value.bytes.length, r3.value.st.size], [true, 0, big.length]);
    assert.ok(r4.reason.notFound);
    assert.match(r5.reason.message, /is a folder/);
    await assert.rejects(s.read(path.join(w.app, 'nothing')), (err) => err.notFound && /Not found in web-1/.test(err.message));
    await assert.rejects(s.read(path.join(w.app, 'sub dir')), /is a folder/);
    await assert.rejects(s.list(path.join(w.app, 'a b')), /is not a folder/);
    await assert.rejects(s.list(path.join(w.app, 'missing')), (err) => err.notFound);
    s.close();
  });

  test(`a session (${variant.label}): saving checks the file did not change, keeps what it is, and never cuts it off`, opts, async () => {
    const w = fakeDocker({ busybox: variant.busybox });
    const s = new places.ExecSession(dockerConn(), { tool: w.tool });
    await s.open();
    const file = path.join(w.app, 'notes.md');
    // A new file: through a .part file, which goes.
    const made = await s.writeChecked(file, Buffer.from('one\n'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\n');
    assert.equal(made.size, 4);
    assert.deepEqual(fs.readdirSync(w.app), ['notes.md']);
    // Unchanged since read: saved, in place (the same file: its mode and links kept).
    fs.chmodSync(file, 0o600);
    fs.linkSync(file, path.join(w.app, 'hard-link.md'));
    const ino = fs.statSync(file).ino;
    const saved = await s.writeChecked(file, Buffer.from('two two\n'), { expectedMtime: made.mtimeMs, expectedSize: made.size });
    assert.equal(saved.conflict, undefined);
    assert.deepEqual([fs.readFileSync(file, 'utf8'), fs.statSync(file).ino, fs.statSync(file).mode & 0o777, fs.readFileSync(path.join(w.app, 'hard-link.md'), 'utf8')], ['two two\n', ino, 0o600, 'two two\n']);
    // Changed there meanwhile (the size, or the time): a conflict, and nothing written.
    fs.writeFileSync(file, 'changed elsewhere\n');
    const conflict = await s.writeChecked(file, Buffer.from('mine\n'), { expectedMtime: saved.mtimeMs, expectedSize: saved.size });
    assert.equal(conflict.conflict, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed elsewhere\n');
    const past = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, past, past);
    assert.equal((await s.writeChecked(file, Buffer.from('mine\n'), { expectedMtime: saved.mtimeMs })).conflict, true, 'same size, another time');
    // Through a link: the file it leads to, the link stays.
    fs.symlinkSync('notes.md', path.join(w.app, 'link.md'));
    await s.writeChecked(path.join(w.app, 'link.md'), Buffer.from('via link\n'));
    assert.equal(fs.lstatSync(path.join(w.app, 'link.md')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'via link\n');
    // Bytes that did not all arrive (fewer than said): the file is left as it was, the part goes.
    const cut = await s.script('write', [file, path.join(w.app, '.notes.md.part-test'), '', '', '100'], { input: Buffer.from('only this') });
    assert.equal(cut.code, places.CODES.SHORT);
    assert.equal(fs.readFileSync(file, 'utf8'), 'via link\n');
    assert.ok(!fs.readdirSync(w.app).some((n) => n.includes('.part-')), 'no part left behind');
    await assert.rejects(s.writeChecked(path.join(w.app, 'no-folder', 'x.txt'), Buffer.from('x')), /web-1:/);
    // Names that would break a shell, made, renamed and read back.
    for (const name of NASTY) {
      const p = path.join(w.app, `${name}.txt`);
      await s.writeChecked(p, Buffer.from(name));
      assert.equal(fs.readFileSync(p, 'utf8'), name);
    }
    assert.ok(!fs.existsSync(path.join(w.app, 'pwned')), 'nothing in a name ever ran');
    s.close();
  });

  test(`a session (${variant.label}): folders, renames, removal, permissions, trees and sizes`, opts, async () => {
    const w = fakeDocker({ busybox: variant.busybox });
    const s = new places.ExecSession(dockerConn(), { tool: w.tool });
    await s.open();
    const dir = path.join(w.app, 'new folder');
    await s.mkdir(dir);
    assert.ok(fs.statSync(dir).isDirectory());
    await assert.rejects(s.mkdir(dir), /already exists there/);
    fs.writeFileSync(path.join(w.app, 'a.txt'), 'a');
    fs.writeFileSync(path.join(w.app, 'b.txt'), 'b');
    await assert.rejects(s.rename(path.join(w.app, 'a.txt'), path.join(w.app, 'b.txt')), /already exists there/, 'never over another file');
    await s.rename(path.join(w.app, 'a.txt'), path.join(w.app, '-rf $(x).txt'));
    assert.equal(fs.readFileSync(path.join(w.app, '-rf $(x).txt'), 'utf8'), 'a');
    await assert.rejects(s.rename(path.join(w.app, 'gone.txt'), path.join(w.app, 'c.txt')), (err) => err.notFound);
    // Another case of the same name: a new name here (this folder minds case)…
    await s.rename(path.join(w.app, 'b.txt'), path.join(w.app, 'B.txt'));
    assert.deepEqual(fs.readdirSync(w.app).filter((n) => n.toLowerCase() === 'b.txt'), ['B.txt']);
    // …and two names of one file (a hard link) are not taken for a folder that ignores case: nothing is lost.
    fs.linkSync(path.join(w.app, 'B.txt'), path.join(w.app, 'b.txt'));
    await assert.rejects(s.rename(path.join(w.app, 'b.txt'), path.join(w.app, 'B.txt')), /web-1/);
    assert.deepEqual(fs.readdirSync(w.app).filter((n) => n.toLowerCase().startsWith('.b') || n.toLowerCase() === 'b.txt').sort(), ['B.txt', 'b.txt']);
    fs.rmSync(path.join(w.app, 'b.txt'));
    // Removal: a link goes, not what it leads to; a folder with what is in it.
    fs.mkdirSync(path.join(dir, 'deep', 'er'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'deep', 'er', 'f.txt'), 'f');
    fs.symlinkSync(dir, path.join(w.app, 'link-to-folder'));
    await s.remove(path.join(w.app, 'link-to-folder'));
    assert.ok(fs.existsSync(path.join(dir, 'deep', 'er', 'f.txt')));
    // A tree, a level of folders per command; its size.
    const before = w.runs().length;
    const tree = await s.listTree(w.app, (rel) => rel.endsWith('f.txt'));
    assert.deepEqual(Object.keys(tree).sort(), ['-rf $(x).txt', 'B.txt', 'new folder', 'new folder/deep', 'new folder/deep/er']);
    assert.ok(w.runs().length - before <= 4, `one command per level (${w.runs().length - before})`);
    assert.deepEqual(await s.folderSize(w.app), { size: 3, files: 3, folders: 3, truncated: false });
    const walked = await s.walk(dir);
    assert.deepEqual(walked.map((e) => path.relative(w.app, e.path)), ['new folder', 'new folder/deep', 'new folder/deep/er', 'new folder/deep/er/f.txt']);
    await s.chmod(path.join(dir, 'deep', 'er', 'f.txt'), 0o640);
    assert.equal(fs.statSync(path.join(dir, 'deep', 'er', 'f.txt')).mode & 0o777, 0o640);
    await assert.rejects(s.chmod(dir, 'rwx'), /not a permission/);
    await s.remove(dir);
    assert.ok(!fs.existsSync(dir));
    await assert.rejects(s.remove(dir), (err) => err.notFound);
    fs.mkdirSync(path.join(w.app, 'empty'));
    await s.rmdir(path.join(w.app, 'empty'));
    assert.ok(!fs.existsSync(path.join(w.app, 'empty')));
    // Folders asked for at the same moment are listed by one command.
    fs.mkdirSync(path.join(w.app, 'x'));
    fs.mkdirSync(path.join(w.app, 'y'));
    const at = w.runs().length;
    const [x, y, top] = await Promise.all([s.list(path.join(w.app, 'x')), s.list(path.join(w.app, 'y')), s.list(w.app)]);
    assert.deepEqual([x.length, y.length, top.length], [0, 0, 4]);
    assert.equal(w.runs().length - at, 1);
    s.close();
  });

  test(`a session (${variant.label}): transfers with progress, whole files for mirrors`, opts, async () => {
    const w = fakeDocker({ busybox: variant.busybox });
    const s = new places.ExecSession(dockerConn(), { tool: w.tool });
    await s.open();
    const here = fs.mkdtempSync(path.join(os.tmpdir(), 'places-here-'));
    const local = path.join(here, 'data.bin');
    const data = Buffer.alloc(3 * 1024 * 1024 + 7, 0);
    for (let i = 0; i < data.length; i += 997) data[i] = i % 251;
    fs.writeFileSync(local, data);
    const seen = [];
    await s.putFile(local, path.join(w.app, '.data.bin.part-aaaaaa'), { onBytes: (n) => seen.push(n) });
    assert.deepEqual(fs.readFileSync(path.join(w.app, '.data.bin.part-aaaaaa')), data);
    assert.equal(seen.at(-1), data.length);
    const back = [];
    await s.getFile(path.join(w.app, '.data.bin.part-aaaaaa'), path.join(here, 'back.bin'), { onBytes: (n) => back.push(n) });
    assert.deepEqual(fs.readFileSync(path.join(here, 'back.bin')), data);
    assert.equal(back.at(-1), data.length);
    await assert.rejects(s.getFile(path.join(w.app, '.data.bin.part-aaaaaa'), path.join(here, 'back.bin')), /EEXIST/, 'never over a file here');
    // Stopped: it ends at once.
    const stop = new AbortController();
    const going = s.putFile(local, path.join(w.app, 'stopped.part'), { signal: stop.signal, onBytes: () => stop.abort() });
    await assert.rejects(going, (err) => err.stopped);
    await s.uploadFrom(local, path.join(w.app, 'mirrored.bin'));
    assert.deepEqual(fs.readFileSync(path.join(w.app, 'mirrored.bin')), data);
    fs.writeFileSync(path.join(here, 'over.bin'), 'old');
    await s.downloadTo(path.join(w.app, 'mirrored.bin'), path.join(here, 'over.bin'));
    assert.deepEqual(fs.readFileSync(path.join(here, 'over.bin')), data);
    s.close();
  });
}

test('a session: a language server’s channel and probe, and a terminal in a pseudo-terminal', { skip: scripts.skip || (!pty && 'no node-pty') }, async () => {
  const w = fakeDocker();
  const s = new places.ExecSession(dockerConn(), { tool: w.tool });
  await s.open();
  // The probe: its output.
  assert.equal(await s.runScript('printf "%s|%s" "$HOME" "$1"'), `${w.home}|`);
  // A channel: input in, output out, its end and code.
  const channel = await s.exec("read line; echo \"got $line\"; echo oops >&2; exit 3");
  let out = '';
  let err = '';
  channel.on('data', (d) => (out += d));
  channel.stderr.on('data', (d) => (err += d));
  const code = new Promise((r) => channel.on('exit', r));
  channel.write('hello\n');
  assert.equal(await code, 3);
  assert.equal(out.trim(), 'got hello');
  assert.equal(err.trim(), 'oops');
  // A terminal: docker exec -it in node-pty, in the folder asked for.
  const sub = path.join(w.app, 'sub folder');
  fs.mkdirSync(sub);
  const term = await s.shell({ cols: 100, rows: 30, cwd: sub });
  assert.equal(term.shell, 'posix');
  let screen = '';
  term.on('data', (d) => (screen += d));
  term.write('echo "at:$(pwd)"\r');
  assert.ok(await until(() => screen.includes(`at:${sub}`), 10000), screen);
  term.setWindow(40, 120);
  const closed = new Promise((r) => term.once('close', r));
  term.write('exit\r');
  await closed;
  const tty = w.runs().find((r) => r.includes('-t'));
  assert.deepEqual(tty.slice(0, 7), ['exec', '-i', '-t', '-e', 'TERM=xterm-256color', '-e', 'COLORTERM=truecolor']);
  s.close();
});

test('a container that stops, goes, or a Docker that is not running: said at once, never a hang', { skip: scripts.skip }, async () => {
  const w = fakeDocker({ containers: [{ Name: 'db-1', State: 'exited', WorkingDir: '/', Home: '/' }] });
  const said = [];
  const s = new places.ExecSession(dockerConn(), { tool: w.tool, onClose: (m) => said.push(m) });
  await s.open();
  await s.list(w.app);
  w.setState((st) => (st.containers[0].State = 'exited'));
  assert.ok(await until(() => said.length), 'Docker’s events say it');
  assert.deepEqual(said, ['The container web-1 stopped.']);
  assert.equal(s.alive, false);
  await assert.rejects(s.list(w.app), /not connected/);
  // Opening it again: why not.
  await assert.rejects(new places.ExecSession(dockerConn(), { tool: w.tool }).open(), (err) => err.stopped && /not running/.test(err.message));
  await assert.rejects(new places.ExecSession(dockerConn({ container: 'nope' }), { tool: w.tool }).open(), /The container nope is not there any more/);
  // Stopped while a session was open but its events did not say (an exec fails): lost then.
  w.setState((st) => (st.containers[0].State = 'running'));
  const t = new places.ExecSession(dockerConn(), { tool: w.tool, onClose: (m) => said.push(m) });
  await t.open();
  t.stopWatching();
  w.setState((st) => (st.containers[0].State = 'exited'));
  await assert.rejects(t.stat(w.app), (err) => err.stopped && /not running/.test(err.message));
  assert.equal(t.alive, false);
  // Removed.
  w.setState((st) => (st.containers[0].State = 'running'));
  const r = new places.ExecSession(dockerConn(), { tool: w.tool, onClose: (m) => said.push(m) });
  await r.open();
  w.setState((st) => (st.containers = st.containers.filter((c) => c.Name !== 'web-1')));
  // Docker says it died, then that it was removed: the first is enough.
  assert.ok(await until(() => said.length === 3));
  assert.match(said[2], /The container web-1 (stopped|was removed)\./);
  assert.equal(r.alive, false);
  // Docker's engine not running.
  w.setState((st) => (st.daemon = false));
  await assert.rejects(new places.ExecSession(dockerConn(), { tool: w.tool }).open(), /Docker is not running/);
  // No docker at all.
  await assert.rejects(new places.ExecSession(dockerConn(), { tool: null }).open(), /Docker is not on this computer/);
});

test('what can be opened: containers (stopped ones too), a stopped one started; none without Docker', { skip: scripts.skip }, async () => {
  const w = fakeDocker({ containers: [{ Name: 'shop-db-1', Image: 'postgres:16', State: 'exited', WorkingDir: '/', Home: '/' }] });
  const tools = places.createPlaceTools({ docker: w.tool, wsl: null });
  const found = await places.listPlaces(tools);
  assert.deepEqual(found.docker.map((c) => [c.name, c.running, c.project]), [['web-1', true, 'shop'], ['shop-db-1', false, '']]);
  assert.equal(found.wsl, null);
  assert.equal(await places.startContainer(tools, 'shop-db-1'), true);
  assert.equal(w.state().containers[1].State, 'running');
  await assert.rejects(places.startContainer(tools, 'not-listed'), /no container named not-listed/);
  await assert.rejects(places.startContainer(tools, '--privileged'), /cannot be used/);
  assert.ok(!w.runs().some((r) => r.includes('run') || r.includes('cp')), 'nothing but ps, inspect, start and exec');
  w.setState((st) => (st.daemon = false));
  const down = await places.listPlaces(tools);
  assert.equal(down.docker, null);
  assert.match(down.notes.docker, /Docker is not running/);
  assert.deepEqual(await places.listPlaces(places.createPlaceTools({ docker: null, wsl: null })), { docker: null, wsl: null, notes: {} });
});

test('WSL: its distributions in UTF-16, a session in one, and one that is not there', { skip: scripts.skip }, async () => {
  const w = fakeDocker();
  const distroHome = path.join(w.root, 'wsl-home');
  fs.mkdirSync(distroHome);
  const statePath = path.join(w.root, 'wsl.json');
  fs.writeFileSync(statePath, JSON.stringify({ log: path.join(w.root, 'wsl.log'), distros: [{ name: 'Ubuntu-24.04', home: distroHome }, { name: 'Debian', home: distroHome }, { name: '-odd', home: distroHome }] }));
  const tool = { program: path.join(w.bin, 'wsl.exe'), env: { ...process.env, FAKE_WSL_STATE: statePath } };
  const tools = places.createPlaceTools({ platform: 'win32', docker: null, wsl: tool });
  const found = await places.listPlaces(tools);
  assert.deepEqual(found.wsl, ['Ubuntu-24.04', 'Debian']);
  const conn = { id: 'wsl0000001', name: 'Ubuntu-24.04', protocol: 'wsl', distro: 'Ubuntu-24.04', user: '' };
  const s = new places.ExecSession(conn, { tool });
  await s.open();
  assert.equal(await s.home(), distroHome, 'a distribution starts in its home folder');
  await s.writeChecked(path.join(distroHome, 'hello.py'), Buffer.from('print("hi")\n'));
  assert.deepEqual((await s.list(distroHome)).map((e) => e.name), ['hello.py']);
  const args = fs.readFileSync(path.join(w.root, 'wsl.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual(args.slice(0, 7), ['-d', 'Ubuntu-24.04', '--exec', 'sh', '-c', places.BOOT, 'sh']);
  s.close();
  await assert.rejects(new places.ExecSession({ ...conn, distro: 'Arch', name: 'Arch' }, { tool }).open(), /no distribution named Arch/);
});

// ---- Through remote.cjs, as main.cjs uses it ---------------------------------------------------

function remoteWith(w, events = []) {
  let data = {};
  return createRemote({
    store: { read: () => data, write: (d) => (data = JSON.parse(JSON.stringify(d))) },
    secrets: { get: () => '', set: () => {} },
    askHostKey: async () => false,
    onStatus: (s) => events.push(s),
    placeTools: places.createPlaceTools({ docker: w.tool, wsl: null }),
  });
}

test('remote.cjs: a Docker place set up, opened, its files read, saved (and refused when changed), copied both ways', { skip: scripts.skip }, async () => {
  const w = fakeDocker();
  const events = [];
  const remote = remoteWith(w, events);
  assert.throws(() => remote.saveConnection({ protocol: 'docker', container: '-it' }), /Pick a container/);
  const conn = remote.saveConnection({ protocol: 'docker', container: 'web-1', host: 'ignored', port: 22, autoSave: true });
  assert.deepEqual([conn.name, conn.protocol, conn.container, conn.host, conn.path, conn.autoSave], ['web-1', 'docker', 'web-1', '', '', true]);
  const tried = await remote.test({ protocol: 'docker', container: 'web-1' });
  assert.equal(tried.path, w.app);
  const { root, state } = await remote.connect(conn.id);
  assert.deepEqual([root, state], [toUri(conn.id, w.app), 'connected']);
  assert.ok(events.some((e) => e.id === conn.id && e.state === 'connected'));
  assert.match(remote.label(root), /^web-1: /);
  assert.equal(remote.isFtp(root), false);
  // Files as disk tabs see them.
  const made = await remote.newFile(root, 'app.js', { text: 'console.log(1);\n' });
  assert.equal(made, toUri(conn.id, path.join(w.app, 'app.js')));
  const read = await remote.read(made);
  assert.deepEqual([read.text, read.eol, read.size, read.name], ['console.log(1);\n', 'lf', 16, 'app.js']);
  const saved = await remote.write(made, 'console.log(2);\n', { eol: 'crlf', expectedMtime: read.mtimeMs, expectedSize: read.size });
  assert.equal(fs.readFileSync(path.join(w.app, 'app.js'), 'utf8'), 'console.log(2);\r\n');
  fs.appendFileSync(path.join(w.app, 'app.js'), '// someone else\n');
  const refused = await remote.write(made, 'mine\n', { expectedMtime: saved.mtimeMs, expectedSize: saved.size });
  assert.equal(refused.conflict, true);
  assert.match(fs.readFileSync(path.join(w.app, 'app.js'), 'utf8'), /someone else/);
  assert.equal((await remote.write(made, 'forced\n', { force: true, expectedMtime: saved.mtimeMs })).conflict, undefined);
  assert.equal(fs.readFileSync(path.join(w.app, 'app.js'), 'utf8'), 'forced\n');
  assert.deepEqual(await remote.stat(made), { mtimeMs: (await remote.stat(made)).mtimeMs, size: 7 });
  assert.equal((await remote.readBytes(made, 100)).toString(), 'forced\n');
  await assert.rejects(remote.readBytes(made, 3), /too large/);
  // Folders.
  const folder = await remote.newFolder(root, 'src');
  const renamed = await remote.rename(made, 'main.js');
  const [moved] = await remote.moveWithin([renamed], folder);
  assert.equal(moved.to, toUri(conn.id, path.join(w.app, 'src', 'main.js')));
  const listing = await remote.list(root);
  assert.deepEqual(listing.entries.map((e) => [e.name, e.dir, e.path]), [['src', true, toUri(conn.id, path.join(w.app, 'src'))]]);
  const props = await remote.properties(folder);
  assert.deepEqual([props.name, props.dir, props.owner], ['src', true, os.userInfo().username]);
  assert.deepEqual(await remote.folderSize(root), { size: 7, files: 1, folders: 1, truncated: false });
  assert.equal(await remote.chmod([folder], 0o750, { recursive: true }), 2);
  assert.equal(fs.statSync(path.join(w.app, 'src')).mode & 0o777, 0o750);
  assert.deepEqual(Object.keys(await remote.listTree(root)).sort(), ['src', 'src/main.js']);
  // Copies between this computer and the place, with a transfer's progress, and back.
  const here = fs.mkdtempSync(path.join(os.tmpdir(), 'places-copy-'));
  fs.mkdirSync(path.join(here, 'docs'));
  fs.writeFileSync(path.join(here, 'docs', 'readme.md'), '# hi\n');
  const job = { signal: new AbortController().signal, files: 0, bytesSeen: 0, plan: () => {}, start: () => {}, bytes: (n) => (job.bytesSeen = n), fileDone: () => job.files++ };
  const up = await remote.copyInto([path.join(here, 'docs')], root, { job });
  assert.equal(up[0].to, toUri(conn.id, path.join(w.app, 'docs')));
  assert.equal(fs.readFileSync(path.join(w.app, 'docs', 'readme.md'), 'utf8'), '# hi\n');
  assert.equal(job.files, 1);
  const down = await remote.downloadInto([toUri(conn.id, path.join(w.app, 'src'))], here, (dir, name) => path.join(dir, name), { job });
  assert.equal(fs.readFileSync(path.join(down[0].to, 'main.js'), 'utf8'), 'forced\n');
  assert.ok(!fs.readdirSync(path.join(w.app, 'docs')).some((n) => n.includes('.part-')));
  await remote.remove([toUri(conn.id, path.join(w.app, 'docs'))]);
  assert.ok(!fs.existsSync(path.join(w.app, 'docs')));
  // Programs there: a probe's output, a channel, a terminal.
  assert.equal((await remote.run(conn.id, 'echo "$HOME"')).trim(), w.home);
  const channel = await remote.exec(conn.id, 'cat');
  let echoed = '';
  channel.on('data', (d) => (echoed += d));
  channel.write('ping\n');
  assert.ok(await until(() => echoed === 'ping\n'));
  channel.close();
  // The container stops: disconnected, with why; then connecting says it is not running.
  w.setState((st) => (st.containers[0].State = 'exited'));
  assert.ok(await until(() => events.some((e) => e.state === 'disconnected' && /stopped/.test(e.error))));
  assert.equal(remote.isConnected(conn.id), false);
  await assert.rejects(remote.read(toUri(conn.id, path.join(w.app, 'src', 'main.js'))), /is not running/);
  assert.equal(remote.status(conn.id).state, 'error');
  w.setState((st) => (st.containers[0].State = 'running'));
  assert.equal((await remote.connect(conn.id)).state, 'connected');
  remote.disconnect(conn.id);
  assert.equal(remote.deleteConnection(conn.id), true);
  assert.deepEqual(remote.connections(), []);
});

test('remote.cjs: what can be opened, starting a container, the kinds offered', { skip: scripts.skip }, async () => {
  const w = fakeDocker({ containers: [{ Name: 'job', State: 'exited', WorkingDir: '/', Home: '/' }] });
  const remote = remoteWith(w);
  assert.deepEqual(await remote.placeKinds(), { docker: true, wsl: false });
  assert.deepEqual((await remote.places()).docker.map((c) => c.name), ['web-1', 'job']);
  await remote.startContainer('job');
  assert.equal(w.state().containers[1].State, 'running');
});

test('a language server inside a container: found by the probe, started over the channel, answering', { skip: scripts.skip }, async () => {
  const w = fakeDocker();
  // Pyright in the container: the fake server behind its name.
  const bin = path.join(w.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pyright-langserver'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_LSP}" "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(w.app, 'pkg'));
  fs.writeFileSync(path.join(w.app, 'pyproject.toml'), '[project]\n');
  fs.writeFileSync(path.join(w.app, 'pkg', 'main.py'), 'x = 1\n');
  w.setState((st) => (st.containers[0].Path = `${bin}:/usr/bin:/bin`));
  const remote = remoteWith(w);
  const conn = remote.saveConnection({ protocol: 'docker', container: 'web-1' });
  const events = [];
  const host = lsp.createLspHost({
    send: (_sender, channel, payload) => events.push({ channel, payload }),
    remote: { run: (id, script) => remote.run(id, script), exec: (id, command) => remote.exec(id, command), label: (id) => remote.connections().find((c) => c.id === id)?.name, connected: (id) => remote.isConnected(id) },
  });
  const sender = { id: 'page' };
  const started = await host.start(sender, path.join(w.app, 'pkg', 'main.py'), { remote: conn.id, stop: w.app });
  assert.equal(started.server, 'Pyright');
  assert.equal(started.root, w.app);
  assert.deepEqual(started.where, { kind: 'remote', id: conn.id, name: 'web-1' });
  host.write(started.id, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: null, capabilities: {} } }), sender);
  const answer = await until(() => events.find((e) => e.channel === 'lsp:message' && e.payload.data.includes('"id":1')), 15000);
  assert.equal(JSON.parse(answer.payload.data).result.serverInfo.name, 'fake-lsp');
  host.stopRemote(conn.id);
  remote.disconnectAll();
});

// ---- The page: how places are named and what they offer ----------------------------------------

test('the page names places clearly, with their own icon, and knows which have a shell', async () => {
  const where = await import('../app/js/where.js');
  const docker = { id: 'p1', name: 'web-1', protocol: 'docker', container: 'shop-web-1', user: 'node' };
  const wsl = { id: 'p2', name: 'Ubuntu', protocol: 'wsl', distro: 'Ubuntu-24.04', user: '' };
  const sftp = { id: 's1', name: 'Box', protocol: 'sftp', host: 'box.example.com', port: 22, user: 'me' };
  const ftp = { id: 'f1', name: 'Site', protocol: 'ftp', host: 'files.example.com', port: 21, user: '' };
  assert.deepEqual([where.connLabel(docker), where.connLabel(wsl), where.connLabel(sftp), where.connLabel(null)], ['web-1 (Docker)', 'Ubuntu (WSL)', 'Box', 'Server']);
  assert.deepEqual([where.connIcon(docker), where.connIcon(wsl), where.connIcon(sftp)], ['container', 'linux', 'server']);
  assert.equal(where.connDetail(docker), 'Docker container shop-web-1 · as node');
  assert.equal(where.connDetail(wsl), 'WSL distribution Ubuntu-24.04');
  assert.equal(where.connDetail(sftp), 'SFTP · me@box.example.com');
  assert.deepEqual([docker, wsl, sftp, ftp].map(where.hasShell), [true, true, true, false]);
  assert.deepEqual([docker, wsl, sftp].map(where.isPlace), [true, true, false]);
  assert.equal(where.protocolName('docker'), 'Docker');
  // Copy path: docker cp's form, and the one Windows opens for WSL.
  assert.equal(where.remoteAddress('remote://p1/app/src/x.js', docker), 'shop-web-1:/app/src/x.js');
  assert.equal(where.remoteAddress('remote://p2/home/me/x.py', wsl), '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\x.py');
  // A tab's state says where: in the container, in WSL; a container that stopped is not connected.
  const text = (place, disk, extra = {}) => where.whereState({ kind: 'remote', disk: { path: 'remote://p1/a', ...disk }, server: { state: 'connected', error: '', place, ...extra } }).text;
  assert.deepEqual([text('docker', {}), text('docker', { dirty: true }), text('docker', { conflict: true }), text('docker', { missing: true })], ['Saved in the container', 'Not saved in the container', 'Changed in the container', 'Not in the container']);
  assert.deepEqual([text('wsl', {}), text('', {}), text('', { dirty: true })], ['Saved in WSL', 'Saved on the server', 'Not saved to the server']);
  assert.equal(text('docker', {}, { state: 'disconnected', error: 'The container shop-web-1 stopped.' }), 'Not connected');
  assert.equal(text('docker', { dirty: true }, { state: 'disconnected', error: 'The container shop-web-1 stopped.' }), 'Not connected · not saved');
  assert.equal(text('docker', {}, { state: 'disconnected', error: '' }), 'Saved in the container', 'disconnected by hand (or not yet connected): as it was');
});
