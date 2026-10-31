// Git with the model (desktop, repositories on this computer): ask about the repository and
// have the model do things in it. Each question goes with a snapshot (git.cjs); the model's
// ```git-steps blocks (gitAssist.js) become cards: looking steps run at once and go back to
// it; steps that are easy to undo run by themselves; the others wait for Run (danger ones in
// red), each backed up first so Undo can bring things back. Steps run in order and stop at the
// first that fails or is skipped; the results go back to the model, which explains or fixes.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { gitMessages, outputOf, parsePlan, resultsMessage, toAction } from '../gitAssist.js';
import { renderMarkdown } from '../markdown.js';
import { connectionOf } from '../providers.js';
import { llmClient } from '../semantic.js';
import { getSettings } from '../settings.js';
import { toast } from './components.js';
import { Icon } from './icons.js';

const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
// The model answers, looks and answers again: at most this many times for one question.
const MAX_ROUNDS = 8;

const SUGGESTIONS = [
  'What state is my repository in? Anything I should do?',
  'Write a commit message for what I changed, and commit it',
  'Undo my last commit, keeping the changes',
  'Bring my branch up to date with main',
  'I lost some work. Help me get it back',
  'Which files should not be in Git? Add them to .gitignore',
];

const RISK = {
  look: { label: 'Looks', icon: 'eye' },
  auto: { label: 'Runs by itself', icon: 'play' },
  ask: { label: 'Asks first', icon: 'info' },
  danger: { label: 'Rewrites history or throws work away', icon: 'alert' },
};

/** While the answer streams: the words before the steps' block. */
const wordsSoFar = (text) => text.replace(/```[ \t]*(git-steps|json)[\s\S]*$/, '').trim();

function StepCard({ s, onDecide, onUndo, waiting }) {
  const r = RISK[s.risk] ?? RISK.ask;
  return html`<div class=${`gai-step risk-${s.risk} st-${s.status}`}>
    <div class="gai-step-head">
      <span class="gai-step-icon" title=${r.label}><${Icon} name=${s.status === 'ok' ? 'check' : s.status === 'failed' ? 'xCircle' : s.status === 'running' ? 'sync' : r.icon} size=${14} /></span>
      <span class="gai-step-text">${s.text}${s.why && html`<span class="muted small"> · ${s.why}</span>`}</span>
    </div>
    <code class="gai-cmd">${s.cmd}</code>
    ${s.risk === 'danger' && s.status === 'waiting' && html`<p class="gai-warn small"><${Icon} name="alert" size=${13} /><span>${s.step.op === 'push' ? 'This replaces the branch on the remote; it cannot be undone from here.' : s.backup ? 'A backup is taken first: Undo brings everything back.' : 'This cannot be undone from here.'}</span></p>`}
    ${waiting &&
    html`<div class="gai-step-actions">
      <button type="button" class=${`btn sm ${s.risk === 'danger' ? 'danger-solid' : 'primary'}`} onClick=${() => onDecide('run')}><${Icon} name="play" size=${13} />Run</button>
      <button type="button" class="btn ghost sm" title="Leave this step out (the ones after it wait too)" onClick=${() => onDecide('skip')}>Skip</button>
      <button type="button" class="btn ghost sm" title="Run none of the steps left" onClick=${() => onDecide('stop')}>Stop</button>
    </div>`}
    ${s.output && html`<details class="gai-out" open=${s.status === 'failed'}><summary class="small muted">${s.status === 'failed' ? 'What Git said' : s.look ? 'What it saw' : 'Output'}</summary><pre>${s.output}</pre></details>`}
    ${s.status === 'ok' && s.backupId && html`<div class="gai-step-actions"><button type="button" class="btn ghost xs" title="Back to how things were before this step (branch, commit, changes not committed)" onClick=${() => onUndo(s)}><${Icon} name="undo" size=${12} />Undo</button></div>`}
    ${s.status === 'skipped' && html`<p class="muted small">Skipped</p>`}
    ${s.status === 'stopped' && html`<p class="muted small">Not run</p>`}
  </div>`;
}

/**
 * `dir`: a folder in the repository. `start`: { question } to ask at once (an error from the
 * Git panel, a conflict). `actions.gitRun` runs the steps (it refuses those that change files
 * while a tab in the repository has unsaved edits).
 */
export function GitAssist({ dir, start = null, actions, onClose }) {
  const bridge = window.desktop?.git;
  const { llm } = getSettings();
  const ready = llm.enabled && llm.chatModel && connectionOf(llm) !== 'async';
  const [turns, setTurns] = useState([]); // [{ question, parts: [{ text } | { steps }], problems }]
  const [busy, setBusy] = useState(null); // null | 'asking' | 'running' | 'waiting'
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [repo, setRepo] = useState(null);
  const history = useRef([]); // the conversation for the model (without the snapshots)
  const controller = useRef(null);
  const decide = useRef(null); // resolves the step waiting for Run / Skip / Stop
  const input = useRef(null);
  const end = useRef(null);

  useLayoutEffect(() => input.current?.focus(), []);
  useEffect(() => {
    bridge?.status(dir).then((s) => setRepo(s), () => setRepo(null));
  }, [dir]);
  useEffect(() => () => (controller.current?.abort(), decide.current?.('stop')), []);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [turns, busy]);
  useLayoutEffect(() => {
    if (start?.question && ready) ask(start.question);
  }, []);
  // Escape closes it, unless something else used the key.
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // The last turn's parts, changed in place.
  const updateLast = (fn) => setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts.at(-1))] : ts));
  const setPart = (index, part) => updateLast((t) => ({ ...t, parts: t.parts.map((p, i) => (i === index ? part : p)) }));

  /** One answer from the model: streamed into a new part; resolves to the plan. */
  const modelTurn = async (userContent, snap, signal) => {
    const messages = snap ? gitMessages(userContent, snap, history.current) : [...gitMessages('', null, history.current).slice(0, -1), { role: 'user', content: userContent }];
    let partIndex = -1;
    updateLast((t) => {
      partIndex = t.parts.length;
      return { ...t, parts: [...t.parts, { text: '' }] };
    });
    let out = '';
    const reply = await llmClient().chat({
      model: llm.chatModel,
      purpose: 'ask',
      messages,
      signal,
      onToken: (tok) => {
        out += tok;
        setPart(partIndex, { text: wordsSoFar(out) });
      },
      onState: (p) => setPhase(p === 'done' ? '' : p),
    });
    const full = reply || out;
    history.current.push({ role: 'user', content: userContent }, { role: 'assistant', content: full });
    const plan = parsePlan(full);
    setPart(partIndex, { text: plan.text });
    if (plan.problems.length) updateLast((t) => ({ ...t, problems: [...(t.problems ?? []), ...plan.problems] }));
    return plan;
  };

  /** Runs the steps in order: looking and auto ones at once, the others after Run. */
  const runSteps = async (steps) => {
    let partIndex = -1;
    const cards = steps.map((d) => ({ ...d, status: 'pending', output: '' }));
    updateLast((t) => {
      partIndex = t.parts.length;
      return { ...t, parts: [...t.parts, { steps: cards }] };
    });
    const set = (i, patch) => {
      cards[i] = { ...cards[i], ...patch };
      setPart(partIndex, { steps: [...cards] });
    };
    let stopped = false;
    for (let i = 0; i < cards.length; i++) {
      const s = cards[i];
      if (stopped) {
        set(i, { status: 'stopped' });
        continue;
      }
      if (s.risk === 'ask' || s.risk === 'danger') {
        setBusy('waiting');
        set(i, { status: 'waiting' });
        const choice = await new Promise((resolve) => (decide.current = resolve));
        decide.current = null;
        if (choice !== 'run') {
          set(i, { status: choice === 'skip' ? 'skipped' : 'stopped' });
          stopped = true;
          if (choice === 'stop') return { results: cards, userStopped: true };
          continue;
        }
      }
      setBusy('running');
      set(i, { status: 'running' });
      let backupId = null;
      if (s.backup) {
        const b = await bridge.act(dir, { op: 'backup', label: s.cmd, keep: s.keep }).catch(() => null);
        if (!b?.ok) {
          set(i, { status: 'failed', output: `No backup could be taken, so the step was not run: ${b?.message ?? 'Git did not answer'}` });
          stopped = true;
          continue;
        }
        backupId = b.result.id;
      }
      const r = s.look ? await bridge.act(dir, toAction(s.step)).then((x) => (x.ok ? { ok: true, result: x.result } : { ok: false, error: { message: x.message, detail: x.stderr } })) : await actions.gitRun(dir, toAction(s.step));
      if (r.ok) set(i, { status: 'ok', output: outputOf(r.result), backupId });
      else {
        set(i, { status: 'failed', output: [r.error.message, r.error.detail].filter(Boolean).join('\n') });
        stopped = true;
      }
    }
    return { results: cards, userStopped: false };
  };

  const ask = async (q) => {
    if (!q.trim() || busy) return;
    controller.current?.abort();
    const signal = (controller.current = new AbortController()).signal;
    setError('');
    setQuestion('');
    setTurns((ts) => [...ts, { question: q, parts: [], problems: [] }]);
    setBusy('asking');
    try {
      const first = await bridge.act(dir, { op: 'snapshot' });
      if (!first?.ok) throw new Error(first?.message ?? 'Git did not answer');
      let plan = await modelTurn(q, first.result, signal);
      for (let round = 1; round < MAX_ROUNDS && plan.steps.length; round++) {
        const looks = plan.steps.filter((s) => s.look);
        const { results, userStopped } = await runSteps(looks.length ? looks : plan.steps);
        if (userStopped || signal.aborted) break;
        setBusy('asking');
        // After changes, the model sees the repository as it is now.
        const changed = !looks.length && results.some((r) => r.status === 'ok');
        const again = changed ? await bridge.act(dir, { op: 'snapshot' }) : null;
        const note = looks.length && looks.length < plan.steps.length ? '\n\n(The other steps in that block were not run: looking steps go in a block of their own. Propose them again if they are still right.)' : '';
        plan = await modelTurn(`${resultsMessage(results.map((r) => ({ cmd: r.cmd, outcome: r.status === 'ok' ? 'ok' : r.status === 'failed' ? 'failed' : r.status === 'skipped' ? 'skipped' : 'stopped', output: r.output })))}${note}`, again?.ok ? again.result : null, signal);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err.message);
    } finally {
      setBusy(null);
      setPhase('');
      actions.gitChanged();
      setTimeout(() => input.current?.focus(), 0);
    }
  };

  const undo = async (s) => {
    if (!confirm(`Go back to how things were before “${s.cmd}”? The branch, its commit and your changes not committed come back (what changed since is backed up too).`)) return;
    const r = await actions.gitRun(dir, { op: 'undo', id: s.backupId });
    toast(r.ok ? `Back to before ${s.cmd}` : r.error.message, { kind: r.ok ? 'info' : 'error' });
    if (r.ok) history.current.push({ role: 'user', content: `(I clicked Undo on “${s.cmd}”: the repository is back to how it was before it.)` }, { role: 'assistant', content: 'Understood.' });
  };

  const stop = () => {
    controller.current?.abort();
    decide.current?.('stop');
  };
  const name = repo?.root ? baseName(repo.root) : baseName(dir);

  const head = html`<div class="assist-head">
    <span class="assist-title"><${Icon} name="branch" size=${16} />Git with the model</span>
    <span class="assist-scope" title=${repo?.root ?? dir}>${name}${repo?.branch ? ` · ${repo.branch}` : ''}</span>
    <span class="spacer" />
    ${turns.length > 0 && html`<button type="button" class="btn ghost sm" title="Start over" disabled=${Boolean(busy)} onClick=${() => ((history.current = []), setTurns([]), setError(''))}>New</button>`}
    <button type="button" class="icon-btn sm" aria-label="Close" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
  </div>`;

  if (!ready) {
    return html`<aside class="assist-panel git-assist" role="dialog" aria-label="Git with the model">
      ${head}
      <div class="assist-body">
        <p>${llm.enabled && connectionOf(llm) === 'async' ? 'Git with the model needs a model that answers at once (on this computer, or an AI provider with your API key); a service that answers later cannot follow along step by step.' : 'Connect a model first: one on this computer (Ollama, LM Studio) or an AI provider with your API key (Claude, OpenAI, Gemini…).'}</p>
        <div class="card-actions"><button type="button" class="btn primary sm" onClick=${() => (onClose(), actions.showSettings())}>Set up in Settings</button></div>
      </div>
    </aside>`;
  }

  return html`<aside class="assist-panel git-assist" role="dialog" aria-label="Git with the model">
    ${head}
    <div class="assist-body">
      ${!turns.length &&
      html`<div class="gai-intro">
        <p class="small muted">Ask about this repository, or say what you want done. The model sees its branches, commits, changes and stash. It runs only what is easy to undo by itself; anything else waits for you to click Run, and is backed up first so you can undo it.</p>
        <div class="gai-suggest">${SUGGESTIONS.map((s) => html`<button type="button" class="chip" key=${s} onClick=${() => ask(s)}>${s}</button>`)}</div>
      </div>`}
      <div class="assist-thread" aria-live="polite">
        ${turns.map(
          (t, ti) => html`<div class="assist-turn" key=${ti}>
            <p class="assist-question">${t.question}</p>
            ${t.parts.map((p, pi) =>
              p.steps
                ? html`<div class="gai-steps" key=${pi}>${p.steps.map((s, si) => html`<${StepCard} key=${si} s=${s} waiting=${s.status === 'waiting'} onDecide=${(c) => decide.current?.(c)} onUndo=${undo} />`)}</div>`
                : p.text && html`<div class="answer markdown ask-answer" key=${pi} dangerouslySetInnerHTML=${{ __html: renderMarkdown(p.text) }} />`,
            )}
            ${t.problems?.length > 0 && html`<p class="notice small"><${Icon} name="info" size=${14} /><span>Left out: ${t.problems.join('; ')}</span></p>`}
          </div>`,
        )}
        ${busy === 'asking' && html`<p class="muted small assist-busy"><${Icon} name="sync" size=${14} /> Thinking…${phase ? ` (${phase})` : ''}</p>`}
        ${busy && busy !== 'waiting' && html`<button type="button" class="btn sm" onClick=${stop}><${Icon} name="stop" size=${14} />Stop</button>`}
        ${error && html`<p class="notice error"><${Icon} name="alert" size=${15} /><span>${error}</span></p>`}
        <span ref=${end} />
      </div>
    </div>
    <form class="ask-custom assist-ask" onSubmit=${(e) => (e.preventDefault(), ask(question))}>
      <div class="assist-input">
        <textarea ref=${input} rows="2" value=${question} aria-label="Your question about Git" disabled=${Boolean(busy)}
          placeholder=${turns.length ? 'Ask a follow-up…' : 'Ask about Git, or say what to do: “move my last commit to a new branch”'}
          onInput=${(e) => setQuestion(e.currentTarget.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask(question);
            }
          }} />
        <button type="submit" class="icon-btn primary" aria-label="Ask" title="Ask (Enter)" disabled=${!question.trim() || Boolean(busy)}><${Icon} name="send" size=${16} /></button>
      </div>
    </form>
  </aside>`;
}
