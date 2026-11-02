// Dockerize a project (desktop, folders on this computer): the dialog. It reads the project
// (dockerize.js scanProject, through the folders bridge), says what kind it is and whether
// Docker is here and running, lets the person change the details, shows each file it would
// write (an existing one with how it differs: kept unless they choose to replace it), writes
// them inside the folder, and offers what comes next: run it now and build the offline package
// (typed into a terminal, where they see it run), open DOCKER.md, have the model review them.
import { html, useEffect, useMemo, useState } from '../../vendor/preact-htm.js';
import { defaultOptions, detectProject, dockerPlan, findProjectRoot, fixedPort, optionProblem, scanEntry, scanProject } from '../dockerize.js';
import { childPath } from '../folderCompare.js';
import { baseName } from '../folders.js';
import { diffBlocks } from '../gitStatus.js';
import { Check, Field, Modal, Segmented } from './components.js';
import { Icon } from './icons.js';

const errorText = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const INSTALL_URL = 'https://docs.docker.com/get-started/get-docker/';
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const KIND_ICONS = { node: 'code', python: 'code', php: 'code', dotnet: 'code', go: 'code', java: 'code', rust: 'code', static: 'doc' };

/** What Docker here says, in a notice: running, not running (and why), not installed. */
function DockerState({ info, platform, checking, onCheck }) {
  if (info === undefined) return html`<p class="notice dkz-docker"><${Icon} name="sync" size=${15} /><span>Looking for Docker…</span></p>`;
  const again = html`<button type="button" class="btn sm dkz-again" disabled=${checking} onClick=${onCheck}>${checking ? 'Checking…' : 'Check again'}</button>`;
  const anyway = 'The files are written anyway.';
  if (info.error) return html`<p class="notice warn dkz-docker"><${Icon} name="alert" size=${15} /><span>Could not ask Docker: ${info.error}. ${anyway} ${again}</span></p>`;
  if (!info.installed)
    return html`<p class="notice warn dkz-docker" data-docker="missing"><${Icon} name="alert" size=${15} /><span>Docker is not installed on this computer. Install <a href=${INSTALL_URL} target="_blank" rel="noopener">${platform === 'linux' ? 'Docker Engine (or Docker Desktop)' : 'Docker Desktop'}</a> to run it here; DOCKER.md says how on each system. ${anyway} ${again}</span></p>`;
  if (!info.running) {
    const start = platform === 'linux' ? html`start it (<code>sudo systemctl start docker</code>, or Docker Desktop)` : 'start Docker Desktop';
    const why =
      info.problem === 'permission'
        ? html`Docker runs, but this user may not use it: <code>sudo usermod -aG docker $USER</code>, then log out and in again.`
        : info.problem === 'slow'
          ? html`Docker did not answer in time: it may be starting.`
          : info.problem === 'not-running'
            ? html`Docker${info.client ? ` ${info.client}` : ''} is installed, but it is not running: ${start}.`
            : html`Docker did not answer${info.message ? html`: <q>${info.message}</q>` : ''}.`;
    return html`<p class="notice warn dkz-docker" data-docker="stopped"><${Icon} name="alert" size=${15} /><span>${why} ${anyway} ${again}</span></p>`;
  }
  return html`<p class="notice ok dkz-docker" data-docker="running"><${Icon} name="check" size=${15} /><span>Docker ${info.server?.version || info.client} is running${info.compose ? ` · Compose ${info.compose}` : ''}${info.buildx ? ` · Buildx ${info.buildx}` : ''}.${
    info.compose ? '' : html` <strong>Docker Compose is missing</strong>: update Docker Desktop, or install the <code>docker-compose-plugin</code> package.`
  }</span></p>`;
}

/** How an existing file differs from the new one: the changed lines, numbered. */
function DiffView({ before, after }) {
  const blocks = diffBlocks(before, after);
  const a = before.split('\n');
  const b = after.split('\n');
  if (!blocks) return html`<p class="small muted">Too different to show line by line: here is the new text.</p><pre class="dkz-pre">${after}</pre>`;
  const shown = blocks.slice(0, 24);
  return html`<div class="dkz-diff" aria-label="How yours differs from the new one">
    ${shown.map(
      (k) => html`<div class="dkz-hunk" key=${`${k.aFrom}-${k.bFrom}`}>
        <span class="small muted">line ${k.bFrom + 1}</span>
        ${k.aTo > k.aFrom && html`<pre class="del">${a.slice(k.aFrom, k.aTo).map((l) => `- ${l}`).join('\n')}</pre>`}
        ${k.bTo > k.bFrom && html`<pre class="add">${b.slice(k.bFrom, k.bTo).map((l) => `+ ${l}`).join('\n')}</pre>`}
      </div>`,
    )}
    ${blocks.length > shown.length && html`<p class="small muted">… and ${blocks.length - shown.length} more changes.</p>`}
  </div>`;
}

const STATES = { new: 'new', same: 'the same as yours', differs: 'yours differs', unreadable: 'yours is kept' };

/**
 * The dialog. `dir`: the project's folder (with `fromFile`, the folder of the open file: the
 * project is looked for from there up). `canAsk`: a model answers at once (review, unknown kinds).
 */
export function DockerizeDialog({ dir, fromFile = false, canAsk = false, actions, onClose }) {
  const bridge = window.desktop;
  const platform = bridge?.platform ?? '';
  const [found, setFound] = useState(null); // { root, scan, project } or { error }
  const [docker, setDocker] = useState(undefined);
  const [checking, setChecking] = useState(false);
  const [opts, setOpts] = useState(null);
  const [replace, setReplace] = useState(() => new Set()); // existing files to write over
  const [shownFile, setShownFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { written, kept, failed }

  const askDocker = () => {
    setChecking(true);
    bridge.docker
      .info()
      .then(setDocker, (err) => setDocker({ error: errorText(err) }))
      .finally(() => setChecking(false));
  };
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const list = async (d) => (await bridge.folders.list(d))?.entries ?? [];
        const root = fromFile ? await findProjectRoot(dir, list) : dir;
        const io = { list: (rel) => list(rel ? childPath(root, rel) : root), read: async (rel) => (await bridge.disk.read(childPath(root, rel))).text };
        const scan = await scanProject(io);
        const project = detectProject(scan, { name: baseName(root) });
        if (!live) return;
        setFound({ root, scan, project });
        if (project.kind !== 'unknown') setOpts(defaultOptions(project));
      } catch (err) {
        if (live) setFound({ error: errorText(err) });
      }
    })();
    askDocker();
    return () => {
      live = false;
    };
  }, [dir]);

  const project = found?.project;
  const root = found?.root ?? dir;
  const name = baseName(root);
  const composeName = found?.scan ? (COMPOSE_NAMES.find((n) => scanEntry(found.scan, n)) ?? '') : '';
  const plan = useMemo(() => (project && opts && project.kind !== 'unknown' ? dockerPlan(project, opts, { composeName }) : null), [project, opts, composeName]);
  const rows = (plan?.files ?? []).map((f) => {
    const entry = scanEntry(found.scan, f.path);
    const old = found.scan.texts[f.path];
    const state = !entry ? 'new' : old === undefined ? 'unreadable' : old === f.text ? 'same' : 'differs';
    return { ...f, state, old };
  });
  const toWrite = rows.filter((r) => r.state === 'new' || (r.state === 'differs' && replace.has(r.path)));
  const problem = project && opts ? optionProblem(project, opts) : '';
  const set = (patch) => setOpts((o) => ({ ...o, ...patch }));

  const create = async () => {
    if (busy || problem) return;
    setBusy(true);
    const written = [];
    const failed = [];
    const made = new Set();
    const folderFor = async (rel) => {
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        const sub = parts.slice(0, i + 1).join('/');
        if (made.has(sub) || scanEntry(found.scan, sub)?.dir) continue;
        try {
          await bridge.folders.newFolder(i ? childPath(root, parts.slice(0, i).join('/')) : root, parts[i]);
        } catch (err) {
          if (!/already exists/i.test(errorText(err))) throw err;
        }
        made.add(sub);
      }
    };
    for (const row of toWrite) {
      try {
        const at = row.path.lastIndexOf('/');
        const folderRel = at < 0 ? '' : row.path.slice(0, at);
        if (folderRel) await folderFor(folderRel);
        if (row.state === 'new') await bridge.folders.newFile(folderRel ? childPath(root, folderRel) : root, row.path.slice(at + 1), { text: row.text });
        else {
          // Written over only as it was shown: a change made meanwhile stays.
          const now = await bridge.disk.read(childPath(root, row.path));
          if (now.text !== row.old) throw new Error('it changed since it was read; open Dockerize again to see how');
          const r = await bridge.disk.write(childPath(root, row.path), row.text, { expectedMtime: now.mtimeMs, eol: 'lf', bom: false, encoding: 'utf-8' });
          if (r?.conflict) throw new Error('it changed while it was being written; nothing was written');
        }
        written.push(row.path);
      } catch (err) {
        failed.push({ path: row.path, message: errorText(err) });
      }
    }
    setDone({ written, kept: rows.filter((r) => !toWrite.includes(r)).map((r) => ({ path: r.path, same: r.state === 'same' })), failed });
    setBusy(false);
  };

  const close = (then) => () => {
    onClose();
    then?.();
  };
  const guidePath = plan?.files.find((f) => f.path.endsWith('DOCKER.md'))?.path;
  const ready = docker?.running;

  // ---- Unknown kinds, failures, reading ----
  if (!found || found.error || project.kind === 'unknown') {
    const ask = () =>
      actions.assistFiles({
        folder: root,
        question: `Dockerize this project for the easiest installation: write a Dockerfile (several stages, a slim image pinned to a version, an unprivileged user), a docker-compose.yml (one service, its port, restart: unless-stopped, volumes and env_file only when needed), a .dockerignore, and a short DOCKER.md with the commands to run it on Windows, Mac and Linux.`,
      });
    return html`<${Modal} title=${`Dockerize ${name}`} onClose=${onClose} className="dockerize-dialog" wide=${true}
      footer=${html`${found?.project && canAsk && html`<button type="button" class="btn" onClick=${close(ask)}><${Icon} name="sparkle" size=${15} />Ask the model to write them</button>`}<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Close</button>`}>
      ${!found && html`<p class="muted small dkz-reading">Reading the project…</p>`}
      ${found?.error && html`<p class="notice error" role="alert"><${Icon} name="alert" size=${15} /><span>${found.error}</span></p>`}
      ${project?.kind === 'unknown' &&
      html`<p class="notice warn" data-kind="unknown"><${Icon} name="info" size=${15} /><span>Tracker Editor does not know how to run this kind of project in Docker. ${project.reason}</span></p>
        <p class="small">${canAsk ? 'The model can look at the project and write the files: each one waits for your Apply.' : 'With a model (Settings → Model), it could look at the project and write them for you.'}</p>`}
      ${found?.project && html`<${DockerState} info=${docker} platform=${platform} checking=${checking} onCheck=${askDocker} />`}
    </${Modal}>`;
  }

  // ---- Written: what comes next ----
  if (done) {
    const offline = plan.offline;
    return html`<${Modal} title=${`Dockerize ${name}`} onClose=${onClose} className="dockerize-dialog" wide=${true}
      footer=${html`<span class="spacer" /><button type="button" class="btn primary" onClick=${onClose}>Done</button>`}>
      ${done.written.length > 0 && html`<p class="notice ok" data-done="written"><${Icon} name="check" size=${15} /><span>Written: ${done.written.map((p, i) => html`${i ? ', ' : ''}<code>${p}</code>`)}.</span></p>`}
      ${done.kept.length > 0 && html`<p class="small muted">Kept as they are: ${done.kept.map((k, i) => html`${i ? ', ' : ''}<code>${k.path}</code>${k.same ? ' (the same)' : ''}`)}.</p>`}
      ${done.failed.map((f) => html`<p class="notice error small" role="alert" key=${f.path}><${Icon} name="alert" size=${14} /><span><code>${f.path}</code>: ${f.message}</span></p>`)}
      <${DockerState} info=${docker} platform=${platform} checking=${checking} onCheck=${askDocker} />
      <h3 class="dkz-head">What next</h3>
      <div class="dkz-next">
        <button type="button" class="btn primary" disabled=${!ready} title=${ready ? plan.up : 'Docker must be running'} onClick=${close(() => actions.dockerRun(root, plan))}><${Icon} name="play" size=${15} />Run it now</button>
        <span class="small muted"><code>${plan.up}</code>${plan.url ? html` in a terminal, then open <strong>${plan.url}</strong>` : ' in a terminal'}</span>
        ${offline && html`<button type="button" class="btn" disabled=${!ready} title=${ready ? '' : 'Docker must be running'} onClick=${close(() => actions.dockerOffline(root, plan))}><${Icon} name="archive" size=${15} />Build the offline package</button>
          <span class="small muted">The image into <code>docker/offline</code>, built for ${plan.platform === 'native' ? 'this computer' : plan.platform}: then copy that folder to the server and run its install script.</span>`}
        ${guidePath && html`<button type="button" class="btn" onClick=${close(() => actions.openDiskPath(childPath(root, guidePath)))}><${Icon} name="doc" size=${15} />Open DOCKER.md</button>
          <span class="small muted">How to install Docker and run it on Windows, Mac and Linux${offline ? ', and the offline steps' : ''}.</span>`}
        ${canAsk && html`<button type="button" class="btn" onClick=${close(() => actions.dockerReview(root, plan))}><${Icon} name="sparkle" size=${15} />Review with the model</button>
          <span class="small muted">It checks the files against the project and proposes fixes, each waiting for your Apply.</span>`}
      </div>
    </${Modal}>`;
  }

  // ---- The details, the files ----
  const fixed = fixedPort(project);
  const versionLabel = project.kind === 'static' ? null : `${project.node?.pm === 'bun' ? 'Bun image' : project.label} version`;
  const appPort = (value) => set(String(opts.hostPort) === String(opts.port) ? { port: value, hostPort: value } : { port: value });
  const arch = docker?.arch || docker?.server?.arch || '';
  return html`<${Modal} title=${`Dockerize ${name}`} onClose=${onClose} className="dockerize-dialog" wide=${true}
    footer=${html`<span class="small muted dkz-where">${root}</span><span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="submit" form="dockerize-form" class="btn primary" disabled=${busy || Boolean(problem)}>${busy ? 'Writing…' : toWrite.length ? `Create ${toWrite.length} file${toWrite.length === 1 ? '' : 's'}` : 'Go on with them as they are'}</button>`}>
    <form id="dockerize-form" class="dockerize-form" onSubmit=${(e) => (e.preventDefault(), create())}>
      <div class="dkz-kind" data-kind=${project.kind}>
        <${Icon} name=${KIND_ICONS[project.kind] ?? 'code'} size=${20} />
        <div>
          <strong>${project.label}: ${project.what}</strong>
          <span class="small muted">${[...project.found, project.version && `${project.label === 'Bun' ? 'Bun' : project.label} ${project.version} (${project.versionFrom})`].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
      <${DockerState} info=${docker} platform=${platform} checking=${checking} onCheck=${askDocker} />

      <div class="field-grid dkz-grid">
        <${Field} label="Image name" hint="Also the name of the service and of the Compose project">
          <input value=${opts.name} spellcheck="false" autocomplete="off" aria-invalid=${/image name/.test(problem)} onInput=${(e) => set({ name: e.currentTarget.value.trim().toLowerCase() })} />
        </${Field}>
        ${versionLabel &&
        html`<${Field} label=${versionLabel} hint=${`From ${project.versionFrom}`}>
          <input value=${opts.version} spellcheck="false" autocomplete="off" onInput=${(e) => set({ version: e.currentTarget.value.trim() })} />
        </${Field}>`}
        <${Field} label="Port on this computer" hint=${`Open it at http://localhost:${opts.hostPort || '…'}${fixed ? ` (${project.kind === 'php' ? 'Apache' : 'nginx'} listens on 8080 inside)` : ''}`}>
          <input value=${opts.hostPort} inputmode="numeric" autocomplete="off" aria-invalid=${/ports/.test(problem)} onInput=${(e) => set({ hostPort: e.currentTarget.value.trim() })} />
        </${Field}>
        ${!fixed &&
        html`<${Field} label="Port the app listens on" hint=${project.portFrom ? `From ${project.portFrom}; empty if it serves nothing` : 'Empty: it serves nothing on a port'}>
          <input value=${opts.port} inputmode="numeric" autocomplete="off" placeholder="none" onInput=${(e) => appPort(e.currentTarget.value.trim())} />
        </${Field}>`}
        ${project.start !== null &&
        project.start !== undefined &&
        html`<${Field} label="Start command" hint="What the container runs" wide=${true}>
          <input value=${opts.start} spellcheck="false" autocomplete="off" class="dkz-mono" aria-invalid=${/start command/.test(problem)} onInput=${(e) => set({ start: e.currentTarget.value })} />
        </${Field}>`}
        ${project.out &&
        html`<${Field} label="Built files" hint="The folder the build writes the site to" wide=${true}>
          <input value=${opts.out} spellcheck="false" autocomplete="off" class="dkz-mono" onInput=${(e) => set({ out: e.currentTarget.value.trim() })} />
        </${Field}>`}
      </div>
      ${problem && html`<p class="small error-text" role="alert">${problem}</p>`}

      ${(project.volumes.length > 0 || project.env) &&
      html`<div class="dkz-checks">
        ${project.volumes.map(
          (v) => html`<label class="dkz-check" key=${v}><input type="checkbox" checked=${opts.volumes.includes(v)} onChange=${(e) => set({ volumes: e.currentTarget.checked ? [...opts.volumes, v] : opts.volumes.filter((x) => x !== v) })} />
            <span><code>${v}/</code> kept in a volume <small class="muted">what the app writes there survives updates</small></span></label>`,
        )}
        ${project.env &&
        html`<label class="dkz-check"><input type="checkbox" checked=${opts.env} onChange=${(e) => set({ env: e.currentTarget.checked })} />
          <span>Settings from <code>.env</code> <small class="muted">${project.env === '.env' ? 'it stays out of the image; the container reads it when it starts' : `made from ${project.env}; it stays out of the image, the container reads it when it starts`}</small></span></label>`}
      </div>`}

      <div class="dkz-options">
        <div class="dkz-option"><span class="field-label">Where the files go</span>
          <${Segmented} small=${true} label="Where the files go" value=${opts.location} onChange=${(location) => set({ location })}
            options=${[{ id: 'root', label: 'In the project’s folder' }, { id: 'docker', label: 'In a docker folder' }]} />
        </div>
        <${Check} checked=${opts.offline} onChange=${(offline) => set({ offline })} label="Make it installable offline too"
          hint="A package to copy to a server without internet: the image, and an install script for Linux, Mac and Windows" />
        ${opts.offline &&
        html`<div class="dkz-option"><span class="field-label">Built for</span>
          <${Segmented} small=${true} label="Built for" value=${opts.platform} onChange=${(p) => set({ platform: p })}
            options=${[{ id: 'linux/amd64', label: 'Most servers (amd64)' }, { id: 'linux/arm64', label: 'ARM servers (arm64)' }, { id: 'native', label: `This computer’s${arch ? ` (${arch})` : ''}` }]} />
        </div>`}
      </div>

      <h3 class="dkz-head">The files</h3>
      <ul class="dkz-files">
        ${rows.map((r) => {
          const open = shownFile === r.path;
          return html`<li class="dkz-file" key=${r.path} data-state=${r.state} data-path=${r.path}>
            <div class="dkz-file-row">
              <button type="button" class="dkz-file-name" aria-expanded=${open} onClick=${() => setShownFile(open ? null : r.path)}>
                <${Icon} name=${open ? 'chevronDown' : 'chevronRight'} size=${14} /><code>${r.path}</code>
              </button>
              <span class="small muted dkz-about">${r.about}</span>
              <span class=${`dkz-state ${r.state}`}>${r.state === 'differs' && replace.has(r.path) ? 'replaced' : STATES[r.state]}</span>
              ${r.state === 'differs' &&
              html`<${Segmented} small=${true} label=${`${r.path}: keep yours or replace it`} value=${replace.has(r.path) ? 'replace' : 'keep'}
                onChange=${(v) => setReplace((s) => { const next = new Set(s); if (v === 'replace') next.add(r.path); else next.delete(r.path); return next; })}
                options=${[{ id: 'keep', label: 'Keep yours' }, { id: 'replace', label: 'Replace' }]} />`}
            </div>
            ${open &&
            html`<div class="dkz-preview">
              ${r.state === 'differs' ? html`<${DiffView} before=${r.old} after=${r.text} />` : r.state === 'same' ? html`<p class="small muted">The same as the one there.</p>` : r.state === 'unreadable' ? html`<p class="small muted">The one there could not be read (too large, or not text): it is kept.</p>` : html`<pre class="dkz-pre">${r.text}</pre>`}
            </div>`}
          </li>`;
        })}
      </ul>

      ${project.notes.length > 0 &&
      html`<h3 class="dkz-head">Check these</h3>
        <ul class="dkz-notes small">${project.notes.map((n) => html`<li key=${n}>${n}</li>`)}</ul>`}
    </form>
  </${Modal}>`;
}
