// Transfers (desktop): copies to, from and between servers that go on in the
// background (main.cjs startTransfer). The jobs and their progress come from the
// main process; the Transfers card and the folders view read them here. The wording
// helpers are pure, so the Node tests can check them.
import { formatBytes } from './format.js';

let jobs = [];
const listeners = new Set();
let wired = false;
const bridge = () => window.desktop?.folders;

export const transfers = () => jobs;
export const running = (job) => job.state === 'running';

/** `callback(jobs, job)` on every change (`job`: the one that changed). */
export function onTransfers(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Follows the main process's jobs; call once. */
export function watchTransfers() {
  if (!bridge()?.onTransfer || wired) return () => {};
  wired = true;
  bridge()
    .transfers()
    .then((list) => {
      jobs = list;
      listeners.forEach((l) => l(jobs, null));
    })
    .catch(() => {});
  return bridge().onTransfer((job) => {
    const at = jobs.findIndex((j) => j.id === job.id);
    jobs = at === -1 ? [job, ...jobs] : jobs.map((j) => (j.id === job.id ? job : j));
    listeners.forEach((l) => l(jobs, job));
  });
}

export const stopTransfer = (id) => bridge()?.stopTransfer(id);

/** Takes a finished job off the list. */
export function dismissTransfer(id) {
  jobs = jobs.filter((j) => j.id !== id || running(j));
  listeners.forEach((l) => l(jobs, null));
}

const VERBS = {
  upload: ['Uploading', 'Uploaded'],
  download: ['Downloading', 'Downloaded'],
  copy: ['Copying', 'Copied'],
};

/**
 * How a job reads: { title, detail, percent (0–100, or null while it is being
 * counted) }. `where(dir)` names the folder it goes to; `now` for the speed.
 */
export function describeTransfer(job, { where = (dir) => dir, now = Date.now() } = {}) {
  const [doing, did] = VERBS[job.kind] ?? VERBS.copy;
  const what = job.names.length === 1 ? job.names[0] : `${job.names.length} items`;
  const to = where(job.dir);
  const moving = job.op === 'move';
  const percent = job.total > 0 ? Math.min(100, Math.floor((job.sent / job.total) * 100)) : job.files ? (job.filesDone === job.files ? 100 : 0) : null;
  if (job.state === 'running') {
    const seconds = Math.max(0.5, (now - job.startedAt) / 1000);
    const speed = job.sent / seconds;
    const parts = [
      percent === null ? 'Counting the files…' : `${percent}%`,
      job.total ? `${formatBytes(job.sent)} of ${formatBytes(job.total)}` : '',
      speed > 1024 && job.sent ? `${formatBytes(speed)}/s` : '',
      job.files > 1 ? `file ${Math.min(job.filesDone + 1, job.files)} of ${job.files}` : '',
    ];
    return { title: `${moving ? 'Moving' : doing} ${what} to ${to}`, detail: parts.filter(Boolean).join(' · '), percent: percent ?? 0 };
  }
  if (job.state === 'done') return { title: `${moving ? 'Moved' : did} ${what} to ${to}`, detail: job.total ? formatBytes(job.total) : '', percent: 100 };
  const got = job.result?.length ?? 0;
  if (job.state === 'stopped') return { title: `Stopped: ${what} to ${to}`, detail: got ? `${got} of ${job.names.length} got there; the file it was on was removed there.` : 'Nothing got there.', percent };
  return { title: `Not ${moving ? 'moved' : did.toLowerCase()}: ${what} to ${to}`, detail: job.error, percent };
}
