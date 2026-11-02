// The Git panel's Conflicts section (0.49): each file a merge, rebase, cherry-pick, revert or a
// stash put back left in conflict, by its kind (gitConflicts.js CONFLICT_KINDS, from status v2's
// XY): open it (its blocks have their bars in the text), the merge view, one side for the whole
// file (Use current / Use incoming: checkout --ours / --theirs, then staged), Keep the file or
// Delete it when one side deleted it, and Mark resolved (staged; asked first while conflict blocks
// are still in it, unsaved edits saved first: actions.conflictReady). Git runs through the panel's
// `run` (its progress and problems); the panel's notice offers Continue once none is left.
import { html } from '../../vendor/preact-htm.js';
import { conflictKind, conflictWords } from '../gitConflicts.js';
import { diskKey } from '../store.js';
import { FileIcon } from './fileIcon.js';
import { Icon } from './icons.js';

const baseName = (p) => String(p).split(/[\\/]/).pop();
const folderOfRel = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
// A path inside the repository as a path here (gitPanel.js fullPath's rule).
const pathIn = (root, rel) => (/^[A-Za-z]:|\\/.test(root) ? `${root.replace(/[\\/]+$/, '')}\\${rel.replace(/\//g, '\\')}` : `${root.replace(/\/+$/, '')}/${rel}`);

// What Keep and Delete mean for each kind of file one side deleted.
const KEEP = {
  DU: 'Keep the file as the incoming side changed it (it is in the folder now)',
  UD: 'Keep the file as the current side changed it (it is in the folder now)',
  AU: 'Keep the file the current side added',
  UA: 'Keep the file the incoming side added',
};
const DELETE = {
  DU: 'Delete it, as the current side did',
  UD: 'Delete it, as the incoming side did',
  AU: 'Delete it (only the current side has it)',
  UA: 'Delete it (only the incoming side has it)',
  DD: 'Both sides deleted it: take the deletion',
};

/** The files in conflict of the repository at `root` (status.conflicts), each with its ways out. */
export function ConflictsSection({ root, status, inProgress, busy, run, actions }) {
  const list = Object.entries(status.conflicts ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (!list.length) return null;
  const words = conflictWords(inProgress, {});
  const said = (what) => (words[what] ? ` (${words[what]})` : '');
  const act = async (rel, what) => {
    const path = pathIn(root, rel);
    const name = baseName(rel);
    if (what === 'merge-view') return actions.openMergeView(diskKey(path));
    if (what === 'ours' || what === 'theirs') {
      if (!(await actions.conflictReady(path, 'take'))) return;
      const r = await run({ op: 'conflict-take', side: what, paths: [rel] }, 'resolve');
      if (!r.ok) return;
      await actions.conflictDone(path, 'take');
      return actions.toast(`${name}: the ${what === 'ours' ? 'current' : 'incoming'} side taken, marked resolved`);
    }
    if (what === 'keep') {
      const r = await run({ op: 'stage', paths: [rel] }, 'resolve');
      return r.ok && actions.toast(`Kept ${name}: marked resolved`);
    }
    if (what === 'delete') {
      if (!(await actions.conflictReady(path, 'remove'))) return;
      const r = await run({ op: 'conflict-remove', paths: [rel] }, 'resolve');
      if (!r.ok) return;
      await actions.conflictDone(path, 'remove');
      return actions.toast(`Deleted ${name}: marked resolved`);
    }
    if (!(await actions.conflictReady(path, 'resolve'))) return;
    const r = await run({ op: 'stage', paths: [rel] }, 'resolve');
    if (r.ok) actions.toast(`Marked ${name} resolved`);
  };
  const button = (label, title, run, { icon = null, primary = false } = {}) =>
    html`<button type="button" class=${`btn ${primary ? 'primary' : 'ghost'} xs`} disabled=${busy} title=${title} onClick=${run}>${icon && html`<${Icon} name=${icon} size=${13} />`}${label}</button>`;
  return html`<section class="git-section git-conflicts" aria-label="Files in conflict">
    <h3 class="git-section-head">Conflicts<span class="muted small">${list.length}</span></h3>
    <p class="muted small git-conflicts-help">
      ${words.current ? `Current: ${words.current}. Incoming: ${words.incoming}. ` : ''}Open a file to keep each block’s current change, incoming change or both from its bar, or take one side for the whole file; then mark it resolved.
    </p>
    ${list.map(([rel, xy]) => {
      const kind = conflictKind(xy);
      const exists = xy !== 'DD';
      const path = pathIn(root, rel);
      return html`<div class="git-conflict" key=${rel}>
        <div class="git-file code-C">
          <button type="button" class="git-file-name" disabled=${!exists} title=${`${rel} · ${kind.label}${exists ? ' · click to open it: each conflict block has its bar' : ''}`} onClick=${() => actions.openDiskPath(path)}>
            <${FileIcon} name=${baseName(rel)} size=${14} />
            <span class="git-file-base">${baseName(rel)}</span>
            <span class="git-file-dir muted small">${folderOfRel(rel)}</span>
          </button>
          <span class="git-badge git-C" title=${kind.label}>${xy}</span>
        </div>
        <div class="git-conflict-row">
          <span class="muted small git-conflict-kind">${kind.label}</span>
          ${kind.choices.includes('ours') &&
          html`${button('Use current', `Replace the whole file with the current side${said('current')} and mark it resolved`, () => act(rel, 'ours'), { icon: 'arrowUp' })}
            ${button('Use incoming', `Replace the whole file with the incoming side${said('incoming')} and mark it resolved`, () => act(rel, 'theirs'), { icon: 'arrowDown' })}
            ${button('Merge view', 'The current side, the result and the incoming side in three columns', () => act(rel, 'merge-view'), { icon: 'columns' })}
            ${button('Mark resolved', 'Stage the file as it is now (asks first while conflict blocks are still in it)', () => act(rel, 'resolve'), { icon: 'check', primary: true })}`}
          ${kind.choices.includes('keep') && button('Keep the file', KEEP[xy] ?? 'Keep the file as it is in the folder', () => act(rel, 'keep'), { icon: 'check' })}
          ${kind.choices.includes('delete') && button('Delete it', DELETE[xy] ?? 'Delete the file', () => act(rel, 'delete'), { icon: 'trash' })}
        </div>
      </div>`;
    })}
  </section>`;
}
