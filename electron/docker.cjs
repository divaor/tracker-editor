// Docker on this computer (desktop), for Dockerize (ui/dockerize.js): whether the docker program
// is installed, whether its engine answers, and its Compose and Buildx. It runs `docker` with
// fixed arguments and a time limit, as git.cjs runs git: the page names no program and no
// arguments, and nothing is built or started here (the dialog types those commands into a
// terminal, where the person sees them run).

const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const VERSION_ARGS = ['version', '--format', '{{json .}}'];

function run(args, { env = process.env, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { env, timeout, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })) : resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });
}

/**
 * `env` with the folders Docker Desktop and the usual installs put the docker program in added
 * to PATH (an app started from the dock or the Start menu gets a short one).
 */
function dockerEnv(env = process.env, { platform = process.platform, home = os.homedir() } = {}) {
  const sep = platform === 'win32' ? ';' : ':';
  const places =
    platform === 'win32'
      ? [env.ProgramFiles && path.win32.join(env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin'), env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Docker', 'Docker', 'resources', 'bin')]
      : platform === 'darwin'
        ? [path.posix.join(home, '.docker', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/Applications/Docker.app/Contents/Resources/bin']
        : ['/usr/bin', '/usr/local/bin', '/snap/bin', path.posix.join(home, '.docker', 'bin'), path.posix.join(home, 'bin')];
  const key = platform === 'win32' && env.PATH === undefined && env.Path !== undefined ? 'Path' : 'PATH';
  const dirs = [...String(env[key] ?? '').split(sep), ...places].filter(Boolean);
  return { ...env, [key]: [...new Set(dirs)].join(sep) };
}

/** What `docker version --format '{{json .}}'` printed: { client, server } ({ version, os, arch } or null), or null. */
function parseVersion(text) {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try {
    const v = JSON.parse(line);
    const part = (p) => (p && typeof p === 'object' && p.Version ? { version: String(p.Version), os: String(p.Os ?? ''), arch: String(p.Arch ?? '') } : null);
    return { client: part(v.Client), server: part(v.Server) };
  } catch {
    return null;
  }
}

/** Why the engine did not answer, from what docker said: 'permission', 'not-running' or 'other'. */
function engineProblem(stderr) {
  const t = String(stderr ?? '');
  if (/permission denied/i.test(t)) return 'permission';
  if (/cannot connect|failed to connect|daemon running|error during connect|dial unix|docker_engine|dockerDesktopLinuxEngine|cannot find the file specified/i.test(t)) return 'not-running';
  return 'other';
}

const firstLine = (t) =>
  String(t ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 300) ?? '';

/**
 * Docker here: { installed: false } without the program; else { installed: true, running, client
 * (its version), arch, server ({ version, os, arch }) or null, compose and buildx (their versions, ''
 * when missing), problem, message }: when the engine does not answer, `problem` says why
 * ('not-running', 'permission', 'slow': no answer in time, 'other') and `message` is Docker's
 * own first line about it.
 */
async function dockerInfo({ runDocker = run, env = process.env, timeout = 8000 } = {}) {
  let out;
  let failed = null;
  try {
    out = await runDocker(VERSION_ARGS, { env, timeout });
  } catch (err) {
    if (err.code === 'ENOENT') return { installed: false };
    failed = err;
    out = { stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
  const v = parseVersion(out.stdout);
  const running = Boolean(v?.server);
  const problem = running ? '' : failed?.killed ? 'slow' : engineProblem(out.stderr);
  // The plugins answer without the engine.
  const [compose, buildx] = await Promise.all([
    runDocker(['compose', 'version', '--short'], { env, timeout }).then(
      (r) => /^v?(\d+\.\d+[\w.+-]*)/.exec(r.stdout.trim())?.[1] ?? '',
      () => '',
    ),
    runDocker(['buildx', 'version'], { env, timeout }).then(
      (r) => /\bv?(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? '',
      () => '',
    ),
  ]);
  return {
    installed: true,
    running,
    client: v?.client?.version ?? '',
    // The kind of processor (amd64, arm64): the engine's, else the program's.
    arch: (running ? v.server.arch : v?.client?.arch) || '',
    server: running ? v.server : null,
    compose,
    buildx,
    problem,
    message: running ? '' : firstLine(out.stderr) || (problem === 'slow' ? 'Docker did not answer in time.' : ''),
  };
}

module.exports = { dockerInfo, dockerEnv, parseVersion, engineProblem, VERSION_ARGS };
