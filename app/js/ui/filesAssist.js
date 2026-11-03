// The model makes and changes files (the model panel's "Change files", Folders' "Ask the model
// about this folder…"): each question goes with a picture of the workspace (filesWork.js); the
// model's ```file-steps blocks (fileSteps.js) become cards. Looks run at once and go back to it;
// each change shows what it does (a new file's text, the lines an edit changes, a rename, a
// delete) and waits for Apply / Skip / Stop (or Apply all); a terminal step types its command for
// the person to run. The results and the files as they are now go back to the model, which goes
// on or explains. Each change can be undone from its card.
import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from '../../vendor/preact-htm.js';
import { filesGuide, filesMessages, MAX_ROUNDS, parsePlan, resultsMessage, wordsSoFar } from '../fileSteps.js';
import { renderMarkdown } from '../markdown.js';
import { connectionOf } from '../providers.js';
import { llmClient } from '../semantic.js';
import { getSettings } from '../settings.js';
import { binName } from './folders.js';
import { toast } from './components.js';
import { Icon } from './icons.js';
import { SymbolsNote } from './askSelection.js';
import { chatPreview, chatTitle, chatToResume, fitMessages, historyBudget, newChatId, settledSteps } from '../chats.js';
import { chats } from '../chatStore.js';
import { ChatButtons, ChatList, KeptNote, useChats } from './chats.js';

// The guide's section about this, loaded once: the model says how the cards work when asked.
let guideText = null;
const loadGuide = () =>
  (guideText ??= fetch('help/guide.md')
    .then((r) => (r.ok ? r.text() : ''))
    .then(filesGuide)
    .catch(() => ''));

const SUGGESTIONS = {
  folder: ['What is in this folder, and what does it do?', 'Add a README that explains this project', 'Make a small Node.js web server here (Express), with a page that says hello', 'Add a .gitignore that fits this project', 'Find the TODO comments and list them with their files'],
  file: ['Add short comments where this file is not obvious', 'Split this file into smaller modules', 'Write tests for this file next to it', 'Find and fix the bugs in this file'],
  notes: ['Make a note that sums up the notes of this project', 'Turn this note into a checklist', 'Fix the spelling in this note'],
};

const RISK = {
  look: { label: 'Looks', icon: 'eye' },
  ask: { label: 'Asks first', icon: 'edit' },
  danger: { label: 'Deletes', icon: 'trash' },
  type: { label: 'Typed for you to run', icon: 'terminal' },
};
const STATUS_ICON = { ok: 'check', failed: 'xCircle', running: 'sync', preparing: 'sync', typed: 'terminal', undone: 'undo' };

/** The preview on a change's card: what Apply does. */
function Preview({ s }) {
  const p = s.preview;
  const step = s.step;
  if (!p) return null;
  if (p.kind === 'new') {
    const lines = step.text.split('\n');
    const shown = lines.slice(0, 400).join('\n');
    return html`<details class="fai-new" open=${lines.length <= 14}>
      <summary class="small muted">The new file: ${lines.length} line${lines.length === 1 ? '' : 's'}</summary>
      <pre>${shown}${lines.length > 400 ? `\n… ${lines.length - 400} more lines` : ''}</pre>
    </details>`;
  }
  if (p.kind === 'edit')
    return html`<div class="fai-diff" aria-label="The lines it changes">
      ${p.rows.map(
        (r) => html`<div class="fai-hunk" key=${r.line}>
          <span class="fai-at small muted">line ${r.line}</span>
          ${r.before.join('\n') !== '' || r.after.join('\n') === '' ? html`<pre class="del">${r.before.map((l) => `- ${l}`).join('\n')}</pre>` : ''}
          ${r.after.join('\n') !== '' || r.before.join('\n') === '' ? html`<pre class="add">${r.after.map((l) => `+ ${l}`).join('\n')}</pre>` : ''}
        </div>`,
      )}
      ${p.dirty && html`<p class="small muted">It is open in a tab with edits not saved yet: the change goes into the tab, which you save.</p>`}
    </div>`;
  if (p.kind === 'rename') return html`<p class="fai-move small"><code>${step.from}</code> → <code>${step.to}</code></p>`;
  if (p.kind === 'delete')
    return html`<p class="gai-warn small"><${Icon} name="alert" size=${13} /><span>${p.dir ? `The folder ${step.path} and everything in it (${p.inside} item${p.inside === 1 ? '' : 's'} at its top)` : step.path} ${p.forGood ? 'is deleted for good (a server or the phone has no Recycle Bin).' : `goes to ${binName()}.`}${p.dir ? '' : ' Undo can make a text file again.'}</span></p>`;
  if (p.kind === 'folder') return html`<p class="small muted">${p.exists ? 'It is there already: nothing to do.' : 'A new, empty folder.'}</p>`;
  if (p.kind === 'terminal') return html`<pre class="fai-cmd">${step.command}</pre><p class="small muted">Typed in a terminal in this folder: you read it and press Enter to run it.</p>`;
  return null;
}

function StepCard({ s, waiting, many, onDecide, onUndo }) {
  const r = RISK[s.risk] ?? RISK.ask;
  const icon = STATUS_ICON[s.status] ?? r.icon;
  return html`<div class=${`gai-step fai-step risk-${s.risk} st-${s.status}`}>
    <div class="gai-step-head">
      <span class="gai-step-icon" title=${r.label}><${Icon} name=${icon} size=${14} /></span>
      <span class="gai-step-text">${s.text}${s.why && html`<span class="muted small"> · ${s.why}</span>`}</span>
    </div>
    ${s.status !== 'failed' && html`<${Preview} s=${s} />`}
    ${waiting &&
    html`<div class="gai-step-actions">
      ${s.risk === 'type'
        ? html`<button type="button" class="btn sm primary" onClick=${() => onDecide('apply')}><${Icon} name="terminal" size=${13} />Type it</button>`
        : html`<button type="button" class=${`btn sm ${s.risk === 'danger' ? 'danger-solid' : 'primary'}`} onClick=${() => onDecide('apply')}><${Icon} name=${s.risk === 'danger' ? 'trash' : 'check'} size=${13} />${s.risk === 'danger' ? 'Delete' : 'Apply'}</button>`}
      ${many > 1 && s.risk !== 'danger' && html`<button type="button" class="btn sm" title="Apply this and the changes after it (a delete still asks)" onClick=${() => onDecide('all')}>Apply all ${many}</button>`}
      <button type="button" class="btn ghost sm" title="Leave this one out" onClick=${() => onDecide('skip')}>Skip</button>
      <button type="button" class="btn ghost sm" title="Do none of the changes left" onClick=${() => onDecide('stop')}>Stop</button>
    </div>`}
    ${s.output && html`<details class="gai-out" open=${s.status === 'failed'}><summary class="small muted">${s.status === 'failed' ? 'Why not' : s.look ? 'What it found' : 'Done'}</summary><pre>${s.output}</pre></details>`}
    ${s.status === 'ok' && s.undo && html`<div class="gai-step-actions"><button type="button" class="btn ghost xs" title="Take this change back" onClick=${() => onUndo(s)}><${Icon} name="undo" size=${12} />Undo</button></div>`}
    ${s.status === 'shown' && html`<p class="muted small">For you to do (Only explain is on)</p>`}
    ${s.status === 'skipped' && html`<p class="muted small">Skipped</p>`}
    ${s.status === 'stopped' && html`<p class="muted small">Not done</p>`}
    ${s.status === 'undone' && html`<p class="muted small">Undone</p>`}
  </div>`;
}

/** The last words the model wrote in a chat's turns (the list's preview). */
const lastText = (turns) => [...turns].reverse().flatMap((t) => [...t.parts].reverse()).find((p) => p.text)?.text ?? '';

/**
 * `target`: { key } (a tab: its folder, or a synced note) or { folder }. `start`: { question } to
 * ask at once, or { resume } a kept chat to open. `actions.filesWork(target)` makes the work
 * (filesWork.js). The chat is kept (chatStore.js) and taken up again when it opens for the same
 * target, until New chat.
 */
export function FilesAssist({ target, start = null, actions, onClose }) {
  const { llm } = getSettings();
  const ready = llm.enabled && llm.chatModel && connectionOf(llm) !== 'async';
  const work = useMemo(() => actions.filesWork(target), []);
  const [turns, setTurns] = useState([]); // [{ question, parts: [{ text } | { steps }], problems }]
  const [busy, setBusy] = useState(null); // null | 'asking' | 'running' | 'waiting'
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [explainOnly, setExplainOnly] = useState(Boolean(start?.explainOnly));
  const history = useRef([]);
  const controller = useRef(null);
  const decide = useRef(null);
  const input = useRef(null);
  const end = useRef(null);
  // The chat kept for it (chatStore.js): null until the first question; `kept` when it came back from earlier.
  const [chatId, setChatId] = useState(null);
  const [chatMeta, setChatMeta] = useState(null);
  const [kept, setKept] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const chatRef = useRef({ id: null, meta: null });
  const turnsRef = useRef([]);
  turnsRef.current = turns;
  const explainRef = useRef(explainOnly);
  explainRef.current = explainOnly;
  const rows = useChats();
  const chatScope = `files:${target.key ?? target.folder ?? ''}`;
  const listRef = useRef(false);
  listRef.current = listOpen;

  useLayoutEffect(() => input.current?.focus(), []);
  // Closing keeps the chat as it is (a change waiting for Apply was not made).
  useEffect(() => () => (controller.current?.abort(), decide.current?.('stop'), persist()), []);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [turns, busy]);
  useLayoutEffect(() => {
    if (start?.question && ready && !work.unavailable) return void ask(start.question);
    let live = true;
    chats.ready().then(() => {
      if (!live) return;
      const id = start?.resume ?? chatToResume(chats.list(), { kind: 'files', key: target.key ?? null, folder: target.folder ?? null, current: chats.current(chatScope) });
      if (id) openChat(id);
    });
    return () => (live = false);
  }, []);
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (listRef.current) return setListOpen(false);
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /** A kept chat shown again: what was done stays as it ended (no Undo: that was the session's). */
  const openChat = async (id) => {
    const chat = await chats.load(id);
    if (!chat || chat.kind !== 'files' || !chat.state?.turns?.length) return false;
    chatRef.current = { id: chat.id, meta: chat };
    setChatId(chat.id);
    setChatMeta(chat);
    setKept(true);
    const restored = chat.state.turns.map((t) => ({ ...t, parts: settledSteps(t.parts) }));
    turnsRef.current = restored;
    setTurns(restored);
    history.current = chat.state.history ?? [];
    setExplainOnly(Boolean(chat.state.explainOnly));
    setError('');
    chats.setCurrent(chatScope, chat.id);
    setListOpen(false);
    return true;
  };
  const newChat = ({ keepList = false } = {}) => {
    history.current = [];
    chatRef.current = { id: null, meta: null };
    turnsRef.current = [];
    setTurns([]);
    setError('');
    setChatId(null);
    setChatMeta(null);
    setKept(false);
    if (!keepList) setListOpen(false);
    chats.setCurrent(chatScope, null);
    setTimeout(() => input.current?.focus(), 0);
  };
  /** Keeps the chat as it is now (a new one at its first question). */
  function persist() {
    const ts = turnsRef.current;
    if (!ts.length || work.unavailable) return;
    const { id: known, meta } = chatRef.current;
    const id = known ?? newChatId();
    const link = meta?.link ?? (target.folder ? actions.chatLinkFolder?.(target.folder) : actions.chatLink?.({ key: target.key }, target.key)) ?? null;
    chatRef.current = { id, meta: { ...(meta ?? {}), link } };
    chats.setCurrent(chatScope, id);
    const row = chats.row(id);
    const named = Boolean(row?.named);
    chats
      .save({
        id,
        kind: 'files',
        title: named ? row.title : chatTitle(ts[0].question),
        named,
        createdAt: meta?.createdAt,
        saved: Boolean(row?.saved),
        link,
        turns: ts.length,
        preview: chatPreview(lastText(ts)),
        state: { target, explainOnly: explainRef.current, turns: ts, history: history.current },
      })
      .then((chat) => {
        if (chatRef.current.id === id) chatRef.current.meta = chat;
      });
    setChatId(id);
  }
  /** A chat picked in the list: here when it is about the same files, else in its own panel. */
  const openFromList = async (row) => {
    const same = row.kind === 'files' && ((target.key && row.link?.key === target.key) || (target.folder && row.link?.folder === target.folder));
    if (same && (await openChat(row.id))) return;
    actions.openChat(row);
  };

  const updateLast = (fn) => setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts.at(-1))] : ts));
  const setPart = (index, part) => updateLast((t) => ({ ...t, parts: t.parts.map((p, i) => (i === index ? part : p)) }));

  /** One answer from the model, streamed into a new part; resolves to the plan. */
  const modelTurn = async (content, workspace, signal, opts) => {
    // A long chat: its oldest messages shortened to what fits.
    const messages = filesMessages(content, workspace, fitMessages(history.current, historyBudget(connectionOf(llm))), opts);
    let partIndex = -1;
    updateLast((t) => {
      partIndex = t.parts.length;
      return { ...t, parts: [...t.parts, { text: '' }] };
    });
    let out = '';
    const reply = await llmClient().chat({
      model: llm.chatModel,
      purpose: 'files',
      messages,
      signal,
      onToken: (tok) => {
        out += tok;
        setPart(partIndex, { text: wordsSoFar(out) });
      },
      onState: (p) => setPhase(p === 'done' ? '' : p),
    });
    const full = reply || out;
    history.current.push({ role: 'user', content: messages.at(-1).content }, { role: 'assistant', content: full });
    const plan = parsePlan(full);
    setPart(partIndex, { text: plan.text });
    if (plan.problems.length) updateLast((t) => ({ ...t, problems: [...(t.problems ?? []), ...plan.problems] }));
    // Kept after the render that shows it.
    setTimeout(persist, 0);
    return plan;
  };

  /** Looks at once; changes prepared (their previews), then each after Apply. */
  const runSteps = async (steps, { shownOnly = false } = {}) => {
    let partIndex = -1;
    const cards = steps.map((d) => ({ ...d, status: d.look ? 'pending' : 'preparing', output: '' }));
    updateLast((t) => {
      partIndex = t.parts.length;
      return { ...t, parts: [...t.parts, { steps: cards }] };
    });
    const set = (i, patch) => {
      cards[i] = { ...cards[i], ...patch };
      setPart(partIndex, { steps: [...cards] });
    };
    setBusy('running');
    // Every change's preview first, so the person sees the whole block before applying any.
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].look) continue;
      const p = await work.prepare(cards[i].step).catch((err) => ({ error: String(err?.message ?? err) }));
      set(i, p.error ? { status: 'failed', output: p.error } : { status: 'pending', preview: p.preview });
    }
    let all = false;
    let stopped = false;
    for (let i = 0; i < cards.length; i++) {
      const s = cards[i];
      if (s.status === 'failed') continue;
      if (stopped) {
        set(i, { status: 'stopped' });
        continue;
      }
      if (s.look) {
        set(i, { status: 'running' });
        try {
          set(i, { status: 'ok', output: await work.look(s.step) });
        } catch (err) {
          set(i, { status: 'failed', output: String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') });
        }
        continue;
      }
      if (shownOnly) {
        set(i, { status: 'shown' });
        continue;
      }
      if (!all || s.risk === 'danger' || s.risk === 'type') {
        setBusy('waiting');
        set(i, { status: 'waiting', many: cards.slice(i).filter((c) => !c.look && c.status !== 'failed' && c.risk !== 'type').length });
        const choice = await new Promise((resolve) => (decide.current = resolve));
        decide.current = null;
        if (choice === 'skip') {
          set(i, { status: 'skipped' });
          continue;
        }
        if (choice === 'stop') {
          set(i, { status: 'stopped' });
          stopped = true;
          continue;
        }
        if (choice === 'all') all = true;
      }
      setBusy('running');
      set(i, { status: 'running' });
      try {
        const r = await work.apply(s.step);
        set(i, { status: r.typed ? 'typed' : 'ok', output: r.output, undo: r.undo ?? null });
      } catch (err) {
        set(i, { status: 'failed', output: String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') });
      }
    }
    return { results: cards, userStopped: stopped };
  };

  const ask = async (q) => {
    if (!q.trim() || busy || work.unavailable) return;
    controller.current?.abort();
    const signal = (controller.current = new AbortController()).signal;
    setError('');
    setQuestion('');
    const first = !history.current.length;
    setTurns((ts) => [...ts, { question: q, parts: [], problems: [] }]);
    setBusy('asking');
    try {
      const opts = { explainOnly, guide: connectionOf(llm) !== 'local' ? await loadGuide() : '' };
      // The open file goes with the first question; later ones see the files as they are now.
      let picture = await work.picture({ withFile: first });
      // What the open file's language server knows about the names around the cursor, with the first question.
      const symbols = first && target.key ? await actions.symbolsFor?.({ key: target.key }).catch(() => null) : null;
      if (symbols) {
        picture = `${picture}\n\n${symbols.text}`;
        updateLast((t) => ({ ...t, symbols }));
      }
      if (signal.aborted) return;
      let plan = await modelTurn(q, picture, signal, opts);
      for (let round = 1; round < MAX_ROUNDS && plan.steps.length && !signal.aborted; round++) {
        const looks = plan.steps.filter((s) => s.look);
        const { results, userStopped } = await runSteps(looks.length ? looks : plan.steps, { shownOnly: explainOnly });
        if (userStopped || signal.aborted) break;
        if (!looks.length && results.every((r) => ['shown', 'skipped'].includes(r.status))) break;
        setBusy('asking');
        const changed = !looks.length && results.some((r) => r.status === 'ok');
        const note = looks.length && looks.length < plan.steps.length ? '\n\n(The changes in that block were not made: looking steps go in a block of their own. Propose them again if they are still right.)' : '';
        const outcome = (r) => (r.status === 'ok' || r.status === 'failed' || r.status === 'skipped' || r.status === 'stopped' || r.status === 'typed' || r.status === 'shown' ? r.status : 'stopped');
        const content = `${resultsMessage(results.map((r) => ({ text: r.text, outcome: outcome(r), output: r.output })))}${note}${changed ? `\n\nThe files now:\n${await work.tree()}` : ''}`;
        plan = await modelTurn(content, null, signal, opts);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err.message);
    } finally {
      setBusy(null);
      setPhase('');
      setTimeout(() => (persist(), input.current?.focus()), 0);
    }
  };

  const undo = async (s) => {
    const why = await s.undo().catch((err) => String(err?.message ?? err));
    if (why) return toast(`Not undone: ${why}`, { kind: 'error', timeout: 8000 });
    setTurns((ts) => ts.map((t) => ({ ...t, parts: t.parts.map((p) => (p.steps ? { steps: p.steps.map((c) => (c === s ? { ...c, status: 'undone', undo: null } : c)) } : p)) })));
    history.current.push({ role: 'user', content: `(I undid “${s.text}”: it is back to how it was before it.)` }, { role: 'assistant', content: 'Understood.' });
    toast(`Undone: ${s.text}`);
    setTimeout(persist, 0);
  };
  const stop = () => {
    controller.current?.abort();
    decide.current?.('stop');
  };

  const kind = work.unavailable ? 'file' : work.kind === 'notes' ? 'notes' : target.folder ? 'folder' : 'file';
  const head = html`<div class="assist-head">
    <span class="assist-title"><${Icon} name="filePlus" size=${16} />Files with the model</span>
    <span class="assist-scope" title=${work.base?.where ?? ''}>${work.label ?? ''}</span>
    <span class="spacer" />
    ${ready && !work.unavailable && html`<${ChatButtons} chatId=${chatId} saved=${Boolean(rows.find((r) => r.id === chatId)?.saved)} listOpen=${listOpen} busy=${Boolean(busy)} onToggleList=${() => setListOpen(!listOpen)} onNew=${() => newChat()} />`}
    ${turns.length > 0 && !chatId && html`<button type="button" class="btn ghost sm" title="Start over" disabled=${Boolean(busy)} onClick=${newChat}>New</button>`}
    <button type="button" class="icon-btn sm" aria-label="Close" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
  </div>`;

  if (!ready || work.unavailable) {
    return html`<aside class="assist-panel files-assist" role="dialog" aria-label="Files with the model">
      ${head}
      <div class="assist-body">
        <p>${work.unavailable || (llm.enabled && connectionOf(llm) === 'async' ? 'Changing files needs a model that answers at once (on this computer, or an AI provider with your API key); a service that answers later cannot follow along step by step.' : 'Connect a model first: one on this computer (Ollama, LM Studio) or an AI provider with your API key (Claude, OpenAI, Gemini…).')}</p>
        ${!work.unavailable && html`<div class="card-actions"><button type="button" class="btn primary sm" onClick=${() => (onClose(), actions.showSettings())}>Set up in Settings</button></div>`}
      </div>
    </aside>`;
  }

  if (listOpen)
    return html`<aside class="assist-panel files-assist" role="dialog" aria-label="Files with the model">
      ${head}
      <div class="assist-body">
        <${ChatList} here=${target.key ? (actions.chatHere?.(target.key) ?? { key: target.key }) : (actions.chatHereFolder?.(target.folder) ?? {})} currentId=${chatId} onOpen=${openFromList} onDeleted=${(id) => id === chatRef.current.id && newChat({ keepList: true })} />
      </div>
    </aside>`;
  return html`<aside class="assist-panel files-assist" role="dialog" aria-label="Files with the model">
    ${head}
    <div class="assist-body">
      ${!turns.length &&
      html`<div class="gai-intro">
        <p class="small muted">${work.kind === 'notes' ? 'Ask about these notes, or say what to write or change. ' : `Ask about ${work.label}, or say what to make or change in it: files, folders, a whole project. `}The model looks at the files it needs; each change shows first and waits for your Apply, and can be undone.</p>
        <div class="gai-suggest">${SUGGESTIONS[kind].map((s) => html`<button type="button" class="chip" key=${s} onClick=${() => ask(s)}>${s}</button>`)}</div>
      </div>`}
      <div class="assist-thread" aria-live="polite">
        ${kept && turns.length > 0 && html`<${KeptNote} chat=${chatMeta} />`}
        ${turns.map(
          (t, ti) => html`<div class="assist-turn" key=${ti}>
            <p class="assist-question">${t.question}</p>
            <${SymbolsNote} symbols=${t.symbols} />
            ${t.parts.map((p, pi) =>
              p.steps
                ? html`<div class="gai-steps fai-steps" key=${pi}>${p.steps.map((s, si) => html`<${StepCard} key=${si} s=${s} waiting=${s.status === 'waiting'} many=${s.many ?? 0} onDecide=${(c) => decide.current?.(c)} onUndo=${undo} />`)}</div>`
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
      <div class="assist-mode" role="group" aria-label="What the model does">
        <button type="button" class=${`chip ${explainOnly ? '' : 'on'}`} aria-pressed=${!explainOnly} disabled=${Boolean(busy)} title="The model proposes the changes; each waits for your Apply" onClick=${() => setExplainOnly(false)}>Help me do it</button>
        <button type="button" class=${`chip ${explainOnly ? 'on' : ''}`} aria-pressed=${explainOnly} disabled=${Boolean(busy)} title="The model explains what to do; nothing is changed" onClick=${() => setExplainOnly(true)}>Only explain, I’ll do it</button>
      </div>
      <div class="assist-input">
        <textarea ref=${input} rows="2" value=${question} aria-label="What to do with the files" disabled=${Boolean(busy)}
          placeholder=${turns.length ? 'Ask a follow-up…' : work.kind === 'notes' ? 'Say what to write or change: “make a summary note”' : 'Say what to make or change: “add a README”, “make a small Express app here”'}
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
