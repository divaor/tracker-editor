// Line endings in the page: what saving a file asks first (mixed line endings nobody chose; a
// Windows-1252 file given characters it cannot hold) and Folders' Line endings (counts first, then
// the files converted, with Stop and Undo).
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { EOL_HINTS, EOL_NAMES, eolCounts, mixedWords } from '../lineEndings.js';
import { isRemotePath, remoteParts } from '../where.js';
import { server } from '../servers.js';
import { Modal, toast } from './components.js';
import { Icon } from './icons.js';

const count = (n, word) => `${n.toLocaleString('en')} ${word}${n === 1 ? '' : 's'}`;

/**
 * A file with mixed line endings about to be saved: keep each line's own (lines added or changed
 * get the most common), or make all of them one kind. `onChoose('keep' | 'crlf' | 'lf')`.
 */
export function MixedSaveDialog({ tab, onChoose, onClose }) {
  const counts = tab.mixed ?? {};
  const most = EOL_NAMES[tab.eol] ?? EOL_NAMES.lf;
  return html`<${Modal} title="Mixed line endings" onClose=${onClose} className="eol-dialog"
    footer=${html`<button type="button" class="btn ghost" onClick=${onClose}>Cancel</button><span class="spacer" />
      <button type="button" class="btn" title=${EOL_HINTS.lf} onClick=${() => onChoose('lf')}>All Unix (LF)</button>
      <button type="button" class="btn" title=${EOL_HINTS.crlf} onClick=${() => onChoose('crlf')}>All Windows (CRLF)</button>
      <button type="button" class="btn primary" onClick=${() => onChoose('keep')}>Keep each line’s own</button>`}>
    <p><strong>${tab.name}</strong> has lines ending in different ways: ${mixedWords(counts)}${counts.cr ? ' (CR alone: old Macs)' : ''}.</p>
    <p class="muted small">Keep each line’s own: the lines you did not change keep theirs; new and changed lines get ${most}, the most common. All Windows or all Unix: every line gets those (a change Git shows on every line that had the other kind). Saving does not ask again for this file.</p>
  </${Modal}>`;
}

/** A Windows-1252 file given characters it cannot hold: save it as UTF-8 instead, or not now. */
export function EncodingSaveDialog({ tab, chars, onSave, onClose }) {
  const shown = chars.map((c) => `“${c}”`).join(' ');
  return html`<${Modal} title="Not in Windows-1252" onClose=${onClose} className="eol-dialog"
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" onClick=${onSave}>Save as UTF-8</button>`}>
    <p><strong>${tab.name}</strong> is a Windows-1252 file, which cannot hold ${shown}${chars.length >= 5 ? ' and maybe more' : ''}.</p>
    <p class="muted small">Saved as UTF-8 it keeps every character (most programs read UTF-8; old Windows ones may show its accents wrongly). Cancel: nothing is saved; take those characters out to keep it Windows-1252.</p>
  </${Modal}>`;
}

let jobs = 0;
const jobId = () => `eol${Date.now().toString(36)}${(jobs++).toString(36)}`;

/**
 * Folders' Line endings for the picked files and folders: counts every text file in them (a dry
 * run), shows how many would change to `initial` (or the other kind, switched here), then converts
 * them; Stop while it runs; the toast's Undo puts them back. `skip`: open tabs with unsaved edits
 * (left out); `onDone(paths)`: files written (their clean tabs read again).
 */
export function ConvertEolDialog({ paths, initial = 'crlf', hidden = false, skip = [], onDone, onClose }) {
  const bridge = window.desktop.folders;
  const [target, setTarget] = useState(initial);
  const [scan, setScan] = useState(null); // { id, files, skipped, truncated, stopped }
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(null); // { done, total, what: 'counting' | 'converting' }
  const running = useRef(null);
  const where = isRemotePath(paths[0]) ? server(remoteParts(paths[0]).id)?.name ?? 'the server' : null;
  useEffect(() => {
    const off = bridge.onEolProgress?.((p) => p.id === running.current?.id && setProgress({ ...p, what: running.current.what }));
    const id = jobId();
    running.current = { id, what: 'counting' };
    setProgress({ done: 0, total: 0, what: 'counting' });
    bridge
      .eolScan(id, paths, { hidden, skip })
      .then((r) => setScan({ id, ...r }), (err) => setError(err.message))
      .finally(() => {
        running.current = null;
        setProgress(null);
      });
    return () => {
      off?.();
      if (running.current) bridge.eolStop(running.current.id);
    };
  }, []);
  const counts = scan ? eolCounts(scan.files, target) : null;
  const skipped = scan ? Object.values(scan.skipped).reduce((a, b) => a + b, 0) : 0;
  const stop = () => running.current && bridge.eolStop(running.current.id);
  const convert = async () => {
    const id = jobId();
    running.current = { id, what: 'converting' };
    setProgress({ done: 0, total: counts.change, what: 'converting' });
    try {
      const r = await bridge.eolConvert(scan.id, id, target, { skip });
      running.current = null;
      onClose();
      onDone?.(r.done);
      const left = r.skipped.length ? ` ${count(r.skipped.length, 'file')} left as they were (${[...new Set(r.skipped.map((s) => s.reason))].slice(0, 3).join(', ')}).` : '';
      const partial = r.undoId && r.undoable < r.done.length ? ` Undo puts back the first ${r.undoable.toLocaleString('en')}.` : '';
      toast(`${r.stopped ? 'Stopped: ' : ''}${count(r.done.length, 'file')} now ${EOL_NAMES[target]}.${left}${partial}`, {
        kind: r.skipped.length ? 'error' : 'info',
        timeout: 12000,
        ...(r.undoId
          ? {
              action: {
                label: 'Undo',
                run: async () => {
                  try {
                    const back = await bridge.eolUndo(r.undoId);
                    onDone?.(back.restored);
                    toast(back.skipped.length ? `Put back ${count(back.restored.length, 'file')}; ${count(back.skipped.length, 'file')} changed since and stayed.` : `Put back ${count(back.restored.length, 'file')}.`, { kind: back.skipped.length ? 'error' : 'info' });
                  } catch (err) {
                    toast(err.message, { kind: 'error' });
                  }
                },
              },
            }
          : {}),
      });
    } catch (err) {
      running.current = null;
      setProgress(null);
      setError(err.message);
    }
  };
  const busy = Boolean(progress);
  const reasons = scan
    ? [
        scan.skipped.binary && `${count(scan.skipped.binary, 'file')} not text`,
        scan.skipped.notText && `${count(scan.skipped.notText, 'file')} not text by name (pictures, archives…)`,
        scan.skipped.large && `${count(scan.skipped.large, 'file')} too large`,
        scan.skipped.unreadable && `${count(scan.skipped.unreadable, 'file')} or folder${scan.skipped.unreadable === 1 ? '' : 's'} not readable`,
        scan.skipped.open && `${count(scan.skipped.open, 'file')} open with unsaved edits`,
      ].filter(Boolean)
    : [];
  const what = paths.length === 1 ? html`<strong>${paths[0].split(/[\\/]/).pop() || paths[0]}</strong>` : count(paths.length, 'item');
  return html`<${Modal} title="Line endings" onClose=${busy && progress.what === 'converting' ? () => {} : onClose} className="eol-dialog eol-convert"
    footer=${html`${busy ? html`<button type="button" class="btn" onClick=${stop}><${Icon} name="stop" size=${15} />Stop</button>` : html`<button type="button" class="btn ghost" onClick=${onClose}>Cancel</button>`}<span class="spacer" />
      <button type="button" class="btn primary" disabled=${busy || !counts?.change} onClick=${convert}>${counts?.change ? `Convert ${count(counts.change, 'file')}` : 'Convert'}</button>`}>
    <div class="eol-targets" role="radiogroup" aria-label="Line endings">
      ${['crlf', 'lf'].map(
        (id) => html`<button type="button" key=${id} role="radio" aria-checked=${target === id} class=${`eol-target ${target === id ? 'on' : ''}`} disabled=${busy && progress.what === 'converting'} onClick=${() => setTarget(id)}>
          <strong>${EOL_NAMES[id]}</strong><span class="muted small">${EOL_HINTS[id]}</span>
        </button>`,
      )}
    </div>
    <p>The text files in ${what}${where ? html` on <strong>${where}</strong>` : ''}, and in the folders inside (not .git, node_modules and such; no links followed).</p>
    ${error && html`<p class="notice error-text"><${Icon} name="alert" size=${15} /><span>${error}</span></p>`}
    ${progress?.what === 'counting' && html`<p class="muted"><span class="fcmp-busy" aria-hidden="true" /> Counting${progress.total ? `: ${progress.done.toLocaleString('en')} of ${progress.total.toLocaleString('en')} files read` : '…'}</p>`}
    ${scan &&
    html`<ul class="eol-counts">
      <li><strong>${count(counts.change, 'file')}</strong> to change${counts.mixed ? html` (${counts.mixed.toLocaleString('en')} with mixed endings)` : ''}</li>
      <li>${count(counts.right, 'file')} already ${EOL_NAMES[target]} (or with no line break)</li>
      ${skipped > 0 && html`<li class="muted">Left out: ${reasons.join('; ')}</li>`}
    </ul>
    ${scan.truncated && html`<p class="notice"><${Icon} name="alert" size=${15} /><span>Only the first ${count(scan.files.length + skipped, 'file')} were looked at: pick fewer folders for the rest.</span></p>`}
    ${scan.stopped && html`<p class="notice"><${Icon} name="alert" size=${15} /><span>Counting was stopped: only the files read so far are counted.</span></p>`}`}
    ${progress?.what === 'converting' && html`<p class="muted"><span class="fcmp-busy" aria-hidden="true" /> Converting: ${progress.done.toLocaleString('en')} of ${progress.total.toLocaleString('en')}</p>`}
    <p class="muted small">Each file keeps its encoding and BOM; one that changes meanwhile is left alone. Undo, in the message after, puts them back.</p>
  </${Modal}>`;
}
