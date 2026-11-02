#!/usr/bin/env node
// Builds and runs what Dockerize writes, for real projects of each kind (scripts/docker-projects.mjs):
// each project is written to a folder and made ready as its author would have (a lock file, made in
// a container), read by scanProject, detectProject, defaultOptions and dockerPlan as the dialog
// reads it, its files written, then the plan's own command (docker compose up -d --build) and its
// pages asked for until they answer with what the project says. Also checked: the app does not run
// as root, and .env stayed out of the image. Needs Docker with Compose, and Node.js.
// CI runs one project per job (.github/workflows/docker-check.yml). Here:
//   node scripts/docker-check.mjs [names…]   (all of them without names; --keep leaves them running)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultOptions, detectProject, dockerPlan, optionProblem, scanProject } from '../app/js/dockerize.js';
import { PROJECTS } from './docker-projects.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const names = args.filter((a) => !a.startsWith('--'));
const unknown = names.filter((n) => !PROJECTS[n]);
if (unknown.length) {
  console.error(`Not a project here: ${unknown.join(', ')}. The projects: ${Object.keys(PROJECTS).join(', ')}`);
  process.exit(2);
}
const chosen = names.length ? names : Object.keys(PROJECTS);
const WAIT_MS = 240_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => console.log(line);
const group = (title) => (process.env.GITHUB_ACTIONS ? say(`::group::${title}`) : say(`\n== ${title}`));
const endGroup = () => process.env.GITHUB_ACTIONS && say('::endgroup::');

/** Runs a program, its output shown as it comes; the exit code. */
function run(program, argv, { cwd, quiet = false } = {}) {
  if (!quiet) say(`$ ${[program, ...argv].join(' ')}`);
  const r = spawnSync(program, argv, { cwd, stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (r.error) throw r.error;
  return quiet ? { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` } : { code: r.status };
}

/** The folder as Dockerize's dialog reads it (folders.list and disk.read). */
function folderIo(root) {
  return {
    list: async (rel) =>
      fs.readdirSync(path.join(root, rel), { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory(), size: d.isFile() ? fs.statSync(path.join(root, rel, d.name)).size : 0 })),
    read: async (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
  };
}

/** A step that makes the project ready (a lock file), in a container, as the person running this. */
function prepare(dir, step) {
  const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
  const env = Object.entries({ HOME: '/tmp', ...(step.env ?? {}) }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const { code } = run('docker', ['run', '--rm', ...user, ...env, '-v', `${dir}:/w`, '-w', '/w', step.image, 'sh', '-c', step.run]);
  if (code !== 0) throw new Error(`making it ready failed: ${step.run}`);
}

/** Asks for `url` until it answers 200 with `has` in it, or the time is up: { ok, status, body }. */
async function ask(url, has, until) {
  let last = { ok: false, status: 0, body: '' };
  while (Date.now() < until) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await res.text();
      last = { ok: res.status === 200 && body.includes(has), status: res.status, body };
      if (last.ok) return last;
    } catch (err) {
      last = { ok: false, status: 0, body: String(err.cause?.code ?? err.message) };
    }
    await sleep(2000);
  }
  return last;
}

async function check(name) {
  const p = PROJECTS[name];
  const problems = [];
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'docker-check-'));
  const dir = path.join(root, name);
  for (const [rel, text] of Object.entries(p.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  group(`${name}: made ready`);
  for (const step of p.prepare ?? []) prepare(dir, step);
  endGroup();

  const project = detectProject(await scanProject(folderIo(dir)), { name });
  const o = { ...defaultOptions(project), ...(p.options ?? {}) };
  const wrong = optionProblem(project, o);
  if (wrong) throw new Error(`the choices: ${wrong}`);
  const plan = dockerPlan(project, o);
  for (const f of plan.files) {
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.text);
  }
  say(`${name}: ${project.label}, ${project.what}${project.version ? ` (${project.version})` : ''}; ${plan.url ?? 'no page'}`);
  group(`${name}: ${plan.dockerfile}`);
  say(fs.readFileSync(path.join(dir, plan.dockerfile), 'utf8'));
  endGroup();

  const compose = (...more) => ['compose', ...(plan.location === 'docker' ? ['-f', plan.compose] : []), ...more];
  const started = Date.now();
  group(`${name}: ${plan.up}`);
  const up = run('docker', compose('up', '-d', '--build'), { cwd: dir });
  endGroup();
  const buildSeconds = Math.round((Date.now() - started) / 1000);
  if (up.code !== 0) problems.push(`${plan.up} failed (exit ${up.code})`);
  else {
    const until = Date.now() + WAIT_MS;
    for (const page of p.pages) {
      let url = `${plan.url}${page.path ?? ''}`;
      if (page.asset) {
        // A file the page names (the built script): found in the page first.
        const home = await ask(plan.url, '', until);
        const found = page.asset.exec(home.body)?.[0];
        if (!found) {
          problems.push(`no ${page.asset} in the page`);
          continue;
        }
        url = `${plan.url}${found}`;
      }
      const got = await ask(url, page.has, until);
      if (got.ok) say(`ok   ${url} has “${page.has}”`);
      else problems.push(`${url}: ${got.status || 'no answer'} ${got.body.slice(0, 300).replace(/\s+/g, ' ')}`);
    }
    // Who the app runs as, and no .env inside: in the running container.
    const uid = run('docker', compose('exec', '-T', o.name, 'id', '-u'), { cwd: dir, quiet: true });
    if (uid.code !== 0 || uid.out.trim() === '0') problems.push(`runs as ${uid.code === 0 ? 'root' : `? (${uid.out.trim()})`}`);
    else say(`ok   runs as uid ${uid.out.trim()}`);
    const env = run('docker', compose('exec', '-T', o.name, 'sh', '-c', `test ! -e ${project.workdir}/.env`), { cwd: dir, quiet: true });
    if (env.code !== 0) problems.push(`.env is in the image (${project.workdir})`);
    else say('ok   .env stayed out of the image');
  }
  const size = run('docker', ['image', 'inspect', `${o.name}:latest`, '--format', '{{.Size}}'], { quiet: true });
  const mb = size.code === 0 ? Math.round(Number(size.out.trim()) / 1e6) : null;
  if (problems.length || process.env.GITHUB_ACTIONS) {
    group(`${name}: the container's output`);
    run('docker', compose('logs', '--no-color', '--tail', '200'), { cwd: dir });
    endGroup();
  }
  if (!keep) run('docker', compose('down', '--volumes', '--remove-orphans'), { cwd: dir, quiet: true });
  return { name, what: `${project.label}: ${project.what}`, problems, buildSeconds, mb };
}

const results = [];
for (const name of chosen) {
  try {
    results.push(await check(name));
  } catch (err) {
    results.push({ name, what: '', problems: [err.message], buildSeconds: null, mb: null });
  }
}
say('');
for (const r of results) say(`${r.problems.length ? 'FAIL' : 'ok  '} ${r.name}${r.what ? ` (${r.what})` : ''}${r.problems.length ? `\n     ${r.problems.join('\n     ')}` : ''}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map((r) => `| ${r.problems.length ? '✗' : '✓'} | ${r.name} | ${r.what} | ${r.buildSeconds ?? ''} s | ${r.mb ?? ''} MB | ${r.problems.join('<br>').replace(/\|/g, '\\|')} |`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['| | Project | Detected | Build | Image | Problems |', '| --- | --- | --- | --- | --- | --- |', ...rows, ''].join('\n'));
}
const failed = results.filter((r) => r.problems.length).length;
say(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
