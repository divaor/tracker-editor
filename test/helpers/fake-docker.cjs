#!/usr/bin/env node
// A stand-in for the docker command line (no engine needed), for the tests of Docker places
// (electron/places.cjs) and for end-to-end checks. Its "containers" are described by the JSON
// file FAKE_DOCKER_STATE names: { daemon?: false, log?: path, containers: [{ Name, Image, State
// ('running' | 'exited' | 'paused'), WorkingDir, Home, Path, User, Ports, Labels }] }. A
// container's files are this machine's: `exec` runs the command here, in its WorkingDir (or
// -w), with its Home and its Path (a folder of busybox's applets makes it an Alpine), its
// stdin, stdout and stderr (a pseudo-terminal's with -t, as node-pty gives one). Like docker
// it refuses options it does not know and -t without a terminal, and answers ps, inspect,
// start, stop, rm and events (die/destroy/pause, as the state file changes; with --since, from
// the state then, kept in its `history`: [{ at (ms), states: { name: State } }], each the states
// just before a change). Each run's arguments go to the log file, one JSON line each.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const STATE = process.env.FAKE_DOCKER_STATE;
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { containers: [] };
  }
};
// A change is kept in the history (what docker events --since replays from).
const write = (state) => {
  const before = read();
  state.history = [...(before.history ?? []), { at: Date.now(), states: Object.fromEntries(before.containers.map((c) => [c.Name, c.State])) }].slice(-50);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
};
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const args = process.argv.slice(2);
// No arguments (docker's own prints its help; `node --test` runs this file so): nothing to do.
if (!args.length) {
  process.stdout.write('Usage:  docker [OPTIONS] COMMAND (a stand-in for the tests)\n');
  process.exit(0);
}
const state = read();
if (state.log) fs.appendFileSync(state.log, `${JSON.stringify(args)}\n`);
if (state.daemon === false) fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?');

const idOf = (c) => (c.Id ??= require('node:crypto').createHash('sha256').update(c.Name).digest('hex'));
const find = (name) => state.containers.find((c) => c.Name === name || idOf(c).startsWith(name));
const statusOf = (c) => (c.State === 'running' ? 'Up 5 minutes' : c.State === 'paused' ? 'Up 5 minutes (Paused)' : 'Exited (0) 2 minutes ago');

const [command, ...rest] = args;
if (command === 'version') {
  process.stdout.write('29.0.0\n');
} else if (command === 'ps') {
  const all = rest.includes('-a') || rest.includes('--all');
  const format = rest[rest.indexOf('--format') + 1];
  if (format !== '{{json .}}') fail('fake docker: only --format {{json .}}', 125);
  for (const c of state.containers.filter((x) => all || x.State === 'running')) {
    process.stdout.write(`${JSON.stringify({ ID: idOf(c), Names: c.Name, Image: c.Image ?? 'alpine', State: c.State, Status: statusOf(c), Ports: c.Ports ?? '', Labels: c.Labels ?? '', RunningFor: '5 minutes ago' })}\n`);
  }
} else if (command === 'inspect') {
  const name = rest[rest.length - 1];
  const c = find(name);
  if (!c) fail(`Error: No such container: ${name}`);
  const full = { Id: idOf(c), Name: `/${c.Name}`, State: { Status: c.State, Running: c.State === 'running' || c.State === 'paused', Paused: c.State === 'paused' }, Config: { Image: c.Image, WorkingDir: c.WorkingDir, User: c.User ?? '' } };
  const format = rest.includes('--format') ? rest[rest.indexOf('--format') + 1] : null;
  if (format === '{{json .State}}') process.stdout.write(`${JSON.stringify(full.State)}\n`);
  else if (!format) process.stdout.write(`${JSON.stringify([full], null, 2)}\n`);
  else fail('fake docker: unknown --format', 125);
} else if (command === 'start' || command === 'stop' || command === 'pause' || command === 'unpause') {
  for (const name of rest) {
    const c = find(name);
    if (!c) fail(`Error response from daemon: No such container: ${name}`);
    c.State = command === 'start' || command === 'unpause' ? 'running' : command === 'pause' ? 'paused' : 'exited';
    process.stdout.write(`${name}\n`);
  }
  write(state);
} else if (command === 'rm') {
  state.containers = state.containers.filter((c) => !rest.includes(c.Name));
  write(state);
} else if (command === 'events') {
  // Follows the state file: a container that stops or goes says so, as docker events does.
  const filters = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--filter') filters.push(rest[++i]);
  const names = filters.filter((f) => f.startsWith('container=')).map((f) => f.slice(10));
  const kinds = filters.filter((f) => f.startsWith('event=')).map((f) => f.slice(6));
  // --since: the states as they were then (the first change after it kept them).
  const since = rest.includes('--since') ? Number(rest[rest.indexOf('--since') + 1]) * 1000 : null;
  const then = since === null ? null : (read().history ?? []).find((h) => h.at >= since);
  let before = new Map(then ? Object.entries(then.states) : read().containers.map((c) => [c.Name, c.State]));
  const say = (name, action) => {
    if ((names.length && !names.includes(name)) || (kinds.length && !kinds.includes(action))) return;
    process.stdout.write(`${JSON.stringify({ status: action, id: name, Type: 'container', Action: action, Actor: { ID: name, Attributes: { name } }, time: Math.floor(Date.now() / 1000) })}\n`);
  };
  setInterval(() => {
    const now = new Map(read().containers.map((c) => [c.Name, c.State]));
    for (const [name, was] of before) {
      const is = now.get(name);
      if (is === undefined) {
        if (was === 'running') say(name, 'die');
        say(name, 'destroy');
      } else if (was === 'running' && is === 'exited') say(name, 'die');
      else if (was === 'running' && is === 'paused') say(name, 'pause');
    }
    before = now;
  }, 100);
} else if (command === 'exec') {
  let interactive = false;
  let tty = false;
  let user = '';
  let workdir = '';
  const env = {};
  let i = 0;
  for (; i < rest.length && rest[i].startsWith('-'); i++) {
    const a = rest[i];
    if (a === '-i' || a === '--interactive') interactive = true;
    else if (a === '-t' || a === '--tty') tty = true;
    else if (a === '-it' || a === '-ti') interactive = tty = true;
    else if (a === '-u' || a === '--user') user = rest[++i];
    else if (a === '-w' || a === '--workdir') workdir = rest[++i];
    else if (a === '-e' || a === '--env') {
      const [k, ...v] = rest[++i].split('=');
      env[k] = v.join('=');
    } else fail(`unknown shorthand flag: '${a.replace(/^-+/, '')}' in ${a}\nSee 'docker exec --help'.`, 125);
  }
  const name = rest[i];
  const cmd = rest.slice(i + 1);
  if (!name || !cmd.length) fail('"docker exec" requires at least 2 arguments.', 125);
  const c = find(name);
  if (!c) fail(`Error response from daemon: No such container: ${name}`);
  if (c.State === 'paused') fail(`Error response from daemon: container ${idOf(c)} is paused, unpause the container before exec`);
  if (c.State !== 'running') fail(`Error response from daemon: container ${idOf(c)} is not running`);
  if (tty && !process.stdin.isTTY) fail('the input device is not a TTY');
  if (user && c.Users && !c.Users.includes(user)) fail(`unable to find user ${user}: no matching entries in passwd file`, 126);
  const childEnv = { PATH: c.Path ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: c.Home ?? '/root', HOSTNAME: idOf(c).slice(0, 12), ...(tty ? { TERM: 'xterm' } : {}), ...env };
  const child = spawn(cmd[0], cmd.slice(1), { cwd: workdir || c.WorkingDir || '/', env: childEnv, stdio: [interactive ? 'inherit' : 'ignore', 'inherit', 'inherit'] });
  child.on('error', (err) => fail(`OCI runtime exec failed: exec failed: unable to start container process: exec: "${cmd[0]}": executable file not found in $PATH: unknown (${err.code})`, 126));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + 9 : 0)));
} else {
  fail(`docker: unknown command: docker ${command ?? ''}`, 125);
}
