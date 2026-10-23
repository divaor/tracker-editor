// The Transfers card (desktop): uploads, downloads and copies between servers that go
// on in the background, each with its progress and Stop. It shows while one runs and
// for a moment after; failed or stopped ones stay until dismissed.
import { html, useEffect, useReducer, useState } from '../../vendor/preact-htm.js';
import { baseName } from '../folders.js';
import { server } from '../servers.js';
import { describeTransfer, dismissTransfer, onTransfers, running, stopTransfer, transfers } from '../transfers.js';
import { isRemotePath, remoteParts } from '../where.js';
import { Icon } from './icons.js';

const DONE_SHOWN_MS = 6000;

/** A folder as the card names it: "name" here, "server: name" on a server. */
export function whereName(dir) {
  if (!isRemotePath(dir)) return baseName(dir);
  const { id, path } = remoteParts(dir);
  const host = server(id)?.name || 'the server';
  return path === '/' ? host : `${host}: ${baseName(path)}`;
}

export function TransfersCard({ onShow }) {
  const [, rerender] = useReducer((x) => x + 1, 0);
  const [small, setSmall] = useState(false);
  useEffect(() => onTransfers(rerender), []);
  const jobs = transfers();
  // Finished ones go a moment after they finish; the speed shown needs a tick too.
  useEffect(() => {
    const done = jobs.filter((j) => j.state === 'done');
    const timers = done.map((j) => setTimeout(() => dismissTransfer(j.id), Math.max(0, j.endedAt + DONE_SHOWN_MS - Date.now())));
    const tick = jobs.some(running) ? setInterval(rerender, 1000) : null;
    return () => (timers.forEach(clearTimeout), clearInterval(tick));
  }, [jobs]);
  if (!jobs.length) return null;
  const now = Date.now();
  const active = jobs.filter(running);
  const total = active.reduce((n, j) => n + (j.total || 0), 0);
  const sent = active.reduce((n, j) => n + (j.sent || 0), 0);
  const overall = total ? Math.floor((sent / total) * 100) : 0;
  const heading = active.length ? `${active.length === 1 ? 'Transfer' : `${active.length} transfers`}${total ? ` · ${overall}%` : ''}` : 'Transfers';

  return html`<section class="transfers ${small ? 'small' : ''}" aria-label="Transfers">
    <header class="transfers-head">
      <${Icon} name=${active.some((j) => j.kind === 'download') && !active.some((j) => j.kind !== 'download') ? 'download' : 'upload'} size=${15} />
      <span class="transfers-title">${heading}</span>
      <button type="button" class="icon-btn sm" aria-label=${small ? 'Show the transfers' : 'Make smaller'} title=${small ? 'Show the transfers' : 'Make smaller'} aria-expanded=${!small} onClick=${() => setSmall(!small)}>
        <${Icon} name=${small ? 'chevronRight' : 'chevronDown'} size=${15} />
      </button>
      ${!active.length && html`<button type="button" class="icon-btn sm" aria-label="Close" title="Close" onClick=${() => jobs.forEach((j) => dismissTransfer(j.id))}><${Icon} name="x" size=${15} /></button>`}
    </header>
    ${small
      ? active.length > 0 && html`<div class="transfer-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${overall}><span style=${{ width: `${overall}%` }}></span></div>`
      : html`<ul class="transfer-list">
          ${jobs.map((job) => {
            const { title, detail, percent } = describeTransfer(job, { where: whereName, now });
            const tone = job.state === 'failed' ? 'error' : job.state === 'stopped' ? 'warn' : job.state === 'done' ? 'ok' : '';
            return html`<li class="transfer ${tone}" key=${job.id} data-state=${job.state}>
              <div class="transfer-line">
                <span class="transfer-name" title=${title}>${title}</span>
                ${job.state === 'done' && onShow && html`<button type="button" class="btn link sm" onClick=${() => onShow(job.dir)}>Show</button>`}
                ${running(job)
                  ? html`<button type="button" class="icon-btn sm" aria-label="Stop" title="Stop: what got there stays, the file it is on is removed there" onClick=${() => stopTransfer(job.id)}><${Icon} name="stop" size=${14} /></button>`
                  : html`<button type="button" class="icon-btn sm" aria-label="Dismiss" title="Dismiss" onClick=${() => dismissTransfer(job.id)}><${Icon} name="x" size=${14} /></button>`}
              </div>
              ${running(job) && html`<div class="transfer-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${percent} aria-label=${title}><span style=${{ width: `${percent}%` }}></span></div>`}
              ${detail && html`<div class="transfer-detail" title=${job.current ? `Now: ${job.current}` : ''}>${detail}</div>`}
            </li>`;
          })}
        </ul>`}
  </section>`;
}
