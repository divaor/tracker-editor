// Docker on this computer (electron/docker.cjs): installed, the engine running or why not,
// Compose and Buildx; always `docker` with fixed arguments. Also run on the phone's Node.js
// (npm run test:phone-node), since main.cjs loads it there too.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { dockerInfo, dockerEnv, parseVersion, engineProblem, VERSION_ARGS } = require('../electron/docker.cjs');

const CLIENT = { Platform: { Name: 'Docker Engine - Community' }, Version: '27.3.1', ApiVersion: '1.47', Os: 'linux', Arch: 'amd64', Context: 'default' };
const SERVER = { Platform: { Name: 'Docker Engine - Community' }, Version: '27.3.1', Os: 'linux', Arch: 'arm64' };

/** A docker that answers each command from `answers` ({ 'version': { stdout } | { error } }); records the calls. */
function fakeDocker(answers) {
  const calls = [];
  const runDocker = async (args) => {
    calls.push(args);
    const a = answers[args[0]];
    if (!a) throw Object.assign(new Error('unknown command'), { code: 1, stdout: '', stderr: `docker: '${args[0]}' is not a docker command.` });
    if (a.error) throw Object.assign(new Error('failed'), a.error);
    return { stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  };
  return { calls, runDocker };
}

test('no docker program: not installed', async () => {
  const { runDocker, calls } = fakeDocker({ version: { error: { code: 'ENOENT' } } });
  assert.deepEqual(await dockerInfo({ runDocker }), { installed: false });
  assert.deepEqual(calls, [VERSION_ARGS]);
});

test('the engine answers: its versions, Compose and Buildx', async () => {
  const { runDocker, calls } = fakeDocker({
    version: { stdout: `${JSON.stringify({ Client: CLIENT, Server: SERVER })}\n` },
    compose: { stdout: 'v2.29.7\n' },
    buildx: { stdout: 'github.com/docker/buildx v0.17.1-desktop.1 abc123\n' },
  });
  const info = await dockerInfo({ runDocker });
  assert.deepEqual(info, { installed: true, running: true, client: '27.3.1', arch: 'arm64', server: { version: '27.3.1', os: 'linux', arch: 'arm64' }, compose: '2.29.7', buildx: '0.17.1', problem: '', message: '' });
  assert.deepEqual(calls, [VERSION_ARGS, ['compose', 'version', '--short'], ['buildx', 'version']], 'only fixed arguments');
});

test('the engine is not running: said so, with Docker’s own words', async () => {
  const stderr = 'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory\n';
  const { runDocker } = fakeDocker({
    version: { error: { code: 1, stdout: `${JSON.stringify({ Client: CLIENT, Server: null })}\n`, stderr } },
    compose: { stdout: '2.29.7\n' },
    buildx: { error: { code: 1 } },
  });
  const info = await dockerInfo({ runDocker });
  assert.equal(info.installed, true);
  assert.equal(info.running, false);
  assert.equal(info.client, '27.3.1');
  assert.equal(info.server, null);
  assert.equal(info.arch, 'amd64', 'the program’s, without the engine');
  assert.equal(info.compose, '2.29.7');
  assert.equal(info.buildx, '');
  assert.equal(info.problem, 'not-running');
  assert.match(info.message, /^failed to connect to the docker API/);
});

test('why the engine does not answer: permission, Docker Desktop not started, too slow', async () => {
  assert.equal(engineProblem('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock'), 'permission');
  assert.equal(engineProblem('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'), 'not-running');
  assert.equal(engineProblem('error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/version": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'), 'not-running');
  assert.equal(engineProblem('something else'), 'other');
  const { runDocker } = fakeDocker({ version: { error: { code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' } } });
  const info = await dockerInfo({ runDocker });
  assert.equal(info.problem, 'slow');
  assert.equal(info.message, 'Docker did not answer in time.');
});

test('parseVersion: the JSON line, or null', () => {
  assert.deepEqual(parseVersion(`WARNING: x\n${JSON.stringify({ Client: CLIENT, Server: null })}`), { client: { version: '27.3.1', os: 'linux', arch: 'amd64' }, server: null });
  assert.equal(parseVersion('Client: Docker Engine'), null);
  assert.equal(parseVersion('{not json'), null);
});

test('dockerEnv: Docker Desktop’s folders after PATH’s own, once each', () => {
  const mac = dockerEnv({ PATH: '/usr/bin:/bin' }, { platform: 'darwin', home: '/Users/me' });
  assert.deepEqual(mac.PATH.split(':'), ['/usr/bin', '/bin', '/Users/me/.docker/bin', '/usr/local/bin', '/opt/homebrew/bin', '/Applications/Docker.app/Contents/Resources/bin']);
  const linux = dockerEnv({ PATH: '/usr/local/bin:/usr/bin' }, { platform: 'linux', home: '/home/me' });
  assert.deepEqual(linux.PATH.split(':'), ['/usr/local/bin', '/usr/bin', '/snap/bin', '/home/me/.docker/bin', '/home/me/bin']);
  const win = dockerEnv({ Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, { platform: 'win32', home: 'C:\\Users\\me' });
  assert.equal(win.PATH, undefined, 'Windows keeps its own spelling');
  assert.deepEqual(win.Path.split(';'), ['C:\\Windows', 'C:\\Program Files\\Docker\\Docker\\resources\\bin']);
});

test('the docker installed here, if any, is read the same way', { skip: spawnSync('docker', ['--version']).status !== 0 && 'no docker here' }, async () => {
  const info = await dockerInfo({ env: dockerEnv() });
  assert.equal(info.installed, true);
  assert.match(info.client, /^\d+\.\d+/);
  if (!info.running) assert.ok(['not-running', 'permission', 'slow', 'other'].includes(info.problem));
});
