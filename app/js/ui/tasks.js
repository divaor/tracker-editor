// The tasks list (Terminal, part two): what the projects around the open file and the folders
// in Folders name for themselves (npm scripts, Makefile targets, pyproject.toml and Composer
// scripts, tasks.js), each run with a click in a terminal of its own in its project's folder.
import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { taskGroups } from '../tasks.js';
import { ClearButton, Modal } from './components.js';
import { Icon } from './icons.js';

const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/**
 * `dirs`: where to look (the open file's folder, the folders shown; here or remote://). `place(dir)`
 * names where a folder is ("This computer", a server's name). `onRun(group, task)` runs one.
 */
export function TasksDialog({ dirs, place, onRun, onClose }) {
  const [groups, setGroups] = useState(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    const bridge = window.desktop?.terminal;
    if (!bridge?.tasks) return setGroups([]);
    bridge.tasks(dirs).then(
      (files) => setGroups(taskGroups(files)),
      () => setGroups([]),
    );
  }, [dirs.join('\n')]);
  const f = filter.trim().toLowerCase();
  const shown = (groups ?? [])
    .map((g) => ({ ...g, tasks: g.tasks.filter((t) => !f || t.name.toLowerCase().includes(f) || t.detail.toLowerCase().includes(f)) }))
    .filter((g) => g.tasks.length);
  const run = (g, t) => {
    onClose();
    onRun(g, t);
  };
  return html`<${Modal} title="Tasks" onClose=${onClose} wide className="tasks-dialog">
    <div class="tasks-filter">
      <input placeholder="Find a task" value=${filter} aria-label="Find a task" autofocus
        onInput=${(e) => setFilter(e.currentTarget.value)}
        onKeyDown=${(e) => {
          if (e.key !== 'Enter') return;
          const first = shown[0];
          if (first) run(first, first.tasks[0]);
        }} />
      <${ClearButton} value=${filter} onClear=${() => setFilter('')} />
    </div>
    ${groups === null && html`<p class="muted small">Looking in the projects…</p>`}
    ${groups && !groups.length && html`<p class="muted small">No tasks found: none of these folders (or the ones above them, up to the folder you opened) has a package.json with scripts, a Makefile, a pyproject.toml with scripts, or a composer.json with scripts.</p>`}
    ${groups?.length > 0 && !shown.length && html`<p class="muted small">No task named like that.</p>`}
    <div class="tasks-list">
      ${shown.map(
        (g) => html`<section class="tasks-group" key=${`${g.dir}/${g.file}`}>
          <h3 class="tasks-group-head" title=${`${g.dir} · ${g.file}`}><${Icon} name="folder" size=${14} /><span>${baseName(g.dir)}</span><span class="muted small">${g.label} · ${place(g.dir)}</span></h3>
          ${g.tasks.map(
            (t) => html`<button type="button" class="tasks-row" key=${t.name} title=${`${[t.command.program, ...t.command.args].join(' ')}${t.detail ? `\n${t.detail}` : ''}`} onClick=${() => run(g, t)}>
              <${Icon} name="play" size=${13} /><span class="tasks-name">${t.name}</span><span class="tasks-detail muted small">${t.detail}</span>
            </button>`,
          )}
        </section>`,
      )}
    </div>
    <p class="muted small">Each task runs in a terminal of its own, in its project's folder; running it again types it there again. Enter runs the first one shown.</p>
  </${Modal}>`;
}
