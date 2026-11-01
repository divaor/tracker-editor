// The Tests panel (Running tests): the last run (what ran, with which framework, how it went),
// its failures first with the assertion's message and a link to the line, the passed and
// skipped ones folded away; Run again, the file's tests, the model's explanation of a failure.
import { html, useState } from '../../vendor/preact-htm.js';
import { FRAMEWORKS, firstMessageLine, summaryText } from '../testRun.js';
import { Icon } from './icons.js';

const baseName = (p) => String(p).split(/[\\/]/).pop();
const ICONS = { passed: 'check', failed: 'xCircle', skipped: 'skipForward' };

function Failure({ t, run, actions }) {
  const [open, setOpen] = useState(true);
  const message = String(t.message ?? '').trim();
  return html`<div class="test-row failed">
    <div class="test-row-head">
      <button type="button" class="icon-btn xs" aria-label=${open ? 'Fold' : 'Unfold'} onClick=${() => setOpen(!open)}><${Icon} name=${open ? 'chevronDown' : 'chevronRight'} size=${12} /></button>
      <${Icon} name="xCircle" size=${14} />
      <span class="test-name" title=${[...(t.chain ?? []), t.name].join(' › ')}>${[...(t.chain ?? []), t.name].join(' › ')}</span>
      ${t.at && html`<button type="button" class="btn link small" title="Go to where it failed" onClick=${() => actions.openTestPlace(run, t.at)}>line ${t.at.line}</button>`}
    </div>
    <p class="test-message small">${firstMessageLine(message)}</p>
    ${open && message && html`<pre class="test-detail">${message.length > 6000 ? `${message.slice(0, 6000)}\n…` : message}</pre>`}
    <div class="test-row-actions">
      <button type="button" class="btn ghost xs" title="Run only this test again" onClick=${() => actions.runTests({ scope: 'name', key: run.key, name: t.name, chain: t.chain })}><${Icon} name="play" size=${12} />Run it</button>
      ${t.at && html`<button type="button" class="btn ghost xs" title="The model explains the failure and how to fix it" onClick=${() => actions.explainTestFailure(run, t)}><${Icon} name="sparkle" size=${12} />Explain</button>`}
    </div>
  </div>`;
}

/** `run`: the last run ({ key, path, framework, label, status, results, code, output, error }). */
export function TestsPanel({ run, actions, onClose }) {
  const [showAll, setShowAll] = useState(false);
  const results = run?.results;
  const failed = results?.tests.filter((t) => t.status === 'failed') ?? [];
  const others = results?.tests.filter((t) => t.status !== 'failed') ?? [];
  const label = run ? FRAMEWORKS[run.framework]?.label ?? run.framework : '';
  return html`<aside class="panel tests-panel" aria-label="Tests">
    <div class="panel-head">
      <h2><${Icon} name="checklist" size=${16} />Tests${label && html`<span class="muted small">${label}</span>`}</h2>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Run again" title="Run again (the same tests)" disabled=${!run || run.status === 'running'} onClick=${() => actions.runTests({ scope: 'again' })}><${Icon} name="rotate" size=${15} /></button>
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body tests-body">
      ${!run && html`<p class="muted small">Open a test file and press <kbd>Ctrl+F5</kbd> for the test at the cursor, <kbd>Ctrl+Shift+F5</kbd> for the whole file, or click ▶ next to a test's line number. Jest, Vitest, Mocha, node:test, pytest, unittest, go test, cargo test, PHPUnit, Pest and dotnet test.</p>`}
      ${run &&
      html`<div class="tests-run">
          <p class="tests-what small"><span title=${run.path}>${run.label}</span><span class="muted"> · ${baseName(run.path)}</span></p>
          ${run.status === 'running' && html`<p class="git-progress small" role="status"><span class="spinner" aria-hidden="true" />Running in the Tests terminal…</p>`}
          ${run.status === 'stopped' && html`<p class="muted small">The run was stopped before it ended.</p>`}
          ${run.status === 'done' &&
          html`<p class=${`tests-summary ${results.failed ? 'bad' : results.tests.length ? 'good' : ''}`} role="status">
            <${Icon} name=${results.failed ? 'xCircle' : results.tests.length ? 'check' : 'info'} size=${16} />${summaryText(results)}${run.code ? html`<span class="muted small"> · exit code ${run.code}</span>` : ''}
          </p>`}
          ${run.status === 'done' && !results.tests.length &&
          html`<div class="notice small"><${Icon} name="info" size=${14} /><span>No test results came back${run.code ? ': the command failed before running tests (is the framework installed in this project?)' : ''}. What it printed is in the Tests terminal.${run.output ? html`<pre class="test-detail">${run.output.split('\n').slice(-12).join('\n')}</pre>` : ''}</span></div>`}
          ${run.error && html`<p class="notice error small"><${Icon} name="alert" size=${14} /><span>${run.error}</span></p>`}
        </div>
        ${failed.map((t, i) => html`<${Failure} key=${`f${i}`} t=${t} run=${run} actions=${actions} />`)}
        ${others.length > 0 &&
        html`<details class="tests-others" open=${showAll || !failed.length} onToggle=${(e) => setShowAll(e.currentTarget.open)}>
          <summary class="small muted">${others.filter((t) => t.status === 'passed').length} passed${others.some((t) => t.status === 'skipped') ? `, ${others.filter((t) => t.status === 'skipped').length} skipped` : ''}</summary>
          ${others.map(
            (t, i) => html`<div class=${`test-row ${t.status}`} key=${`o${i}`}>
              <div class="test-row-head"><${Icon} name=${ICONS[t.status]} size=${13} /><span class="test-name" title=${[...(t.chain ?? []), t.name].join(' › ')}>${[...(t.chain ?? []), t.name].join(' › ')}</span></div>
            </div>`,
          )}
        </details>`}
        <div class="card-actions tests-actions">
          <button type="button" class="btn sm" disabled=${run.status === 'running'} title="All the tests in this file" onClick=${() => actions.runTests({ scope: 'file', key: run.key })}><${Icon} name="play" size=${13} />Run the file’s tests</button>
          ${failed.length > 1 && html`<button type="button" class="btn ghost sm" disabled=${run.status === 'running'} title="Only the first failed test, again" onClick=${() => actions.runTests({ scope: 'name', key: run.key, name: failed[0].name, chain: failed[0].chain })}>Run the first failure</button>`}
        </div>`}
    </div>
  </aside>`;
}
