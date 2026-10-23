import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { renderMarkdown } from '../markdown.js';
import { ACTION_GROUPS, cleanReplacement, lastCodeBlock, SELECTION_ACTIONS, selectionMessages, withParam } from '../selectionAsk.js';
import { llmClient } from '../semantic.js';
import { getSettings } from '../settings.js';
import { toast } from './components.js';
import { Icon } from './icons.js';

const MODES = [
  { id: 'answer', label: 'Answer' },
  { id: 'replace', label: 'Change the text' },
];

/**
 * The model panel (the bubble at the bottom right, or Ctrl+K): help with the
 * selection, or the whole file when nothing is selected. `scope` says which.
 * Answers show here and can be followed up; new versions of the text open as
 * a comparison to accept (actions.proposeReplacement).
 */
/**
 * `start` ({ action, context }) opens it already asking: a problem to explain or fix, an error
 * from the terminal. Its context may have no `key` (the terminal's output): then there is no
 * text to replace, and `fixTarget` (a file the error points to) offers to fix that file.
 */
export function AssistPanel({ scope, actions, onClose, start = null }) {
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState('answer');
  const [pending, setPending] = useState(null); // { action, value }: an action waiting for its value
  const [conv, setConv] = useState(null); // { context, action, turns: [{ question, answer }], status, phase }
  const controller = useRef(null);
  const input = useRef(null);
  const valueInput = useRef(null);
  const end = useRef(null);
  const { llm } = getSettings();
  useLayoutEffect(() => input.current?.focus(), []);
  useLayoutEffect(() => valueInput.current?.focus(), [pending?.action.id]);
  // Escape closes it from anywhere (a value being picked first), unless something else used the key.
  const pendingRef = useRef(null);
  pendingRef.current = pending;
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (pendingRef.current) setPending(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => () => controller.current?.abort(), []);
  useLayoutEffect(() => {
    if (start && llm.enabled && llm.chatModel) ask(start.action, '', start.context);
  }, []);
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [conv?.turns.length, conv?.status]);

  // A follow-up continues the conversation about the same text.
  const ask = async (action, followUp = '', given = null) => {
    const context = followUp ? conv.context : (given ?? actions.assistContext());
    if (!context) return;
    const turns = followUp ? conv.turns : [];
    const history = turns.flatMap((t, i) => [...(i > 0 ? [{ role: 'user', content: t.question }] : []), { role: 'assistant', content: t.answer }]).concat(followUp ? [{ role: 'user', content: followUp }] : []);
    controller.current?.abort();
    const signal = (controller.current = new AbortController()).signal;
    const asking = [...turns, { question: followUp || action.label, answer: '' }];
    setConv({ context, action, turns: asking, status: 'asking', phase: '' });
    setPending(null);
    setQuestion('');
    let out = '';
    const show = (answer) => setConv((c) => c && { ...c, turns: [...asking.slice(0, -1), { ...asking.at(-1), answer }] });
    try {
      const reply = await llmClient().chat({
        model: llm.chatModel,
        purpose: action.kind === 'replace' && !followUp ? 'edit' : 'ask',
        messages: selectionMessages(followUp ? { ...action, kind: 'answer' } : action, context, history),
        signal,
        onToken: (t) => (action.kind === 'answer' || followUp) && show((out += t)),
        onState: (phase) => setConv((c) => c && { ...c, phase }),
      });
      if (action.kind === 'replace' && !followUp) {
        onClose();
        actions.proposeReplacement(context, cleanReplacement(reply, context.text), action);
        return;
      }
      show(reply || out);
      setConv((c) => c && { ...c, status: 'done' });
      setTimeout(() => input.current?.focus(), 0);
    } catch (err) {
      if (err?.name === 'AbortError') return setConv((c) => (c && c.turns.length > 1 ? { ...c, turns: c.turns.slice(0, -1), status: 'done' } : null));
      setConv((c) => c && { ...c, status: 'error', error: err.message });
    }
  };
  const submit = () => {
    const q = question.trim();
    if (!q) return;
    if (conv?.status === 'done') return ask(conv.action, q);
    ask({ id: 'custom', label: q, kind: mode, prompt: q });
  };
  const choose = (action) => (action.param ? setPending({ action, value: '' }) : ask(action));
  const runPending = (value = pending.value) => value.trim() && ask(withParam(pending.action, value));

  // The same question in the Claude app (your Claude subscription there; no key needed here).
  const inClaude = (action) => {
    const context = conv?.context ?? start?.context ?? actions.assistContext();
    if (context) actions.openInClaude({ action: action ?? conv?.action ?? start?.action ?? { prompt: question.trim() || 'Help me with this.' }, context });
  };
  const claudeButton = (action) =>
    html`<button type="button" class="btn sm" title="Opens Claude (the app on phones, claude.ai elsewhere) with this question; the question is also copied" onClick=${() => inClaude(action)}><${Icon} name="claude" size=${14} />Ask in the Claude app</button>`;
  const contextLabel = (c) => c.label ?? (c.whole ? `Whole file · ${c.name}` : 'The selection');
  const head = html`<div class="assist-head">
    <span class="assist-title"><${Icon} name="sparkle" size=${16} />Model</span>
    <span class="assist-scope" title="Select text in the file to ask about just that part">${conv ? contextLabel(conv.context) : start ? contextLabel(start.context) : scope}</span>
    <span class="spacer" />
    ${conv && html`<button type="button" class="btn ghost sm" title="Start over" onClick=${() => (controller.current?.abort(), setConv(null))}>New</button>`}
    <button type="button" class="icon-btn sm" aria-label="Close" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
  </div>`;

  if (!llm.enabled || !llm.chatModel) {
    return html`<aside class="assist-panel" role="dialog" aria-label="Ask the model">
      ${head}
      <div class="assist-body">
        <p>Connect a model first: one on this computer (Ollama, LM Studio), an AI provider with your API key (Claude, OpenAI, Gemini…), or a model service. Or ask in the Claude app, with your Claude subscription.</p>
        <div class="card-actions">
          <button type="button" class="btn primary sm" onClick=${() => (onClose(), actions.showSettings())}>Set up in Settings</button>
          ${claudeButton(start?.action)}
        </div>
      </div>
    </aside>`;
  }

  const last = conv?.turns.at(-1);
  const code = conv?.status === 'done' ? lastCodeBlock(last?.answer) : '';
  return html`<aside class="assist-panel" role="dialog" aria-label="Ask the model">
    ${head}
    <div class="assist-body">
      ${!conv &&
      html`<div class="assist-actions">
        ${ACTION_GROUPS.map(
          (g) => html`<div class="assist-group" key=${g.id}>
            <span class="assist-group-label">${g.label}</span>
            <div class="ask-actions">
              ${SELECTION_ACTIONS.filter((a) => a.group === g.id).map(
                (a) => html`<button type="button" key=${a.id} class="btn sm ${pending?.action.id === a.id ? 'on' : ''}" title=${a.kind === 'replace' ? 'Proposes a new version to compare and accept' : 'Answers here'}
                  onClick=${() => choose(a)}><${Icon} name=${a.icon} size=${14} />${a.label}</button>`,
              )}
            </div>
            ${pending?.action.group === g.id &&
            html`<form class="assist-param" onSubmit=${(e) => (e.preventDefault(), runPending())}>
              <label class="field"><span>${pending.action.param.label}</span>
                <input ref=${valueInput} value=${pending.value} list=${`assist-${pending.action.id}`} placeholder=${pending.action.param.placeholder ?? 'Pick or type'}
                  onInput=${(e) => setPending({ ...pending, value: e.currentTarget.value })} />
              </label>
              ${pending.action.param.options &&
              html`<datalist id=${`assist-${pending.action.id}`}>${pending.action.param.options.map((o) => html`<option key=${o} value=${o} />`)}</datalist>
                <div class="assist-options">${pending.action.param.options.map((o) => html`<button type="button" key=${o} class="chip" onClick=${() => runPending(o)}>${o}</button>`)}</div>`}
              <button type="submit" class="btn primary sm" disabled=${!pending.value.trim()}>Go</button>
            </form>`}
          </div>`,
        )}
        <div class="assist-claude">${claudeButton()}</div>
      </div>`}
      ${conv &&
      html`<div class="assist-thread" aria-live="polite">
        ${conv.turns.map(
          (t, i) => html`<div class="assist-turn" key=${i}>
            <p class="assist-question">${t.question}</p>
            ${t.answer
              ? html`<div class="answer markdown ask-answer" dangerouslySetInnerHTML=${{ __html: renderMarkdown(t.answer) }} />`
              : conv.status === 'asking' && i === conv.turns.length - 1 &&
                html`<p class="muted small assist-busy"><${Icon} name="sync" size=${14} /> ${conv.action.kind === 'replace' && conv.turns.length === 1 ? 'Writing the new version…' : 'Thinking…'} ${conv.phase && conv.phase !== 'done' ? `(${conv.phase})` : ''}</p>`}
          </div>`,
        )}
        ${conv.status === 'asking' && html`<button type="button" class="btn sm" onClick=${() => controller.current?.abort()}><${Icon} name="stop" size=${14} />Stop</button>`}
        ${conv.status === 'error' && html`<p class="notice error"><${Icon} name="alert" size=${15} />${conv.error}</p><div class="card-actions">${claudeButton()}</div>`}
        ${conv.status === 'done' &&
        html`<div class="card-actions assist-answer-actions">
          ${conv.context.fixTarget &&
          html`<button type="button" class="btn primary sm" title="Opens the file and proposes a fixed version to compare and accept" onClick=${() => (onClose(), actions.fixForError(conv.context.fixTarget, conv.context.errorText))}><${Icon} name="check" size=${14} />Fix ${conv.context.fixTarget.split(/[\\/]/).pop()}</button>`}
          ${code && conv.context.key && html`<button type="button" class="btn primary sm" title="Compare the code in the answer with your text, then accept it" onClick=${() => (onClose(), actions.proposeReplacement(conv.context, cleanReplacement(code, conv.context.text), { label: 'The code from the answer' }))}><${Icon} name="check" size=${14} />Use the code</button>`}
          <button type="button" class="btn sm" onClick=${() => navigator.clipboard.writeText(last.answer).then(() => toast('Copied'))}><${Icon} name="copy" size=${14} />Copy</button>
          ${conv.context.key && html`<button type="button" class="btn sm" title="Below the text it is about" onClick=${() => actions.insertAfter(conv.context, last.answer)}><${Icon} name="filePlus" size=${14} />Insert below</button>`}
          <button type="button" class="btn sm" onClick=${() => (onClose(), actions.answerAsNote(conv.context, conv.action.label, conv.turns.map((t, i) => (i ? `**${t.question}**\n\n${t.answer}` : t.answer)).join('\n\n')))}><${Icon} name="file" size=${14} />Save as note</button>
          ${claudeButton()}
        </div>`}
        <span ref=${end} />
      </div>`}
    </div>
    <form class="ask-custom assist-ask" onSubmit=${(e) => (e.preventDefault(), submit())}>
      ${!conv &&
      html`<div class="assist-mode" role="group" aria-label="What the model does">
        ${MODES.map((m) => html`<button type="button" key=${m.id} class="chip ${mode === m.id ? 'on' : ''}" aria-pressed=${mode === m.id} onClick=${() => setMode(m.id)}>${m.label}</button>`)}
      </div>`}
      <div class="assist-input">
        <textarea ref=${input} rows="2" value=${question} aria-label="Your question" disabled=${conv?.status === 'asking'}
          placeholder=${conv?.status === 'done' ? 'Ask a follow-up…' : mode === 'replace' ? 'What to do with the text: “make it a table”, “sort by date”…' : 'Ask anything about it: “what does this return?”…'}
          onInput=${(e) => setQuestion(e.currentTarget.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }} />
        <button type="submit" class="icon-btn primary" aria-label="Ask" title="Ask (Enter)" disabled=${!question.trim() || conv?.status === 'asking'}><${Icon} name="send" size=${16} /></button>
      </div>
    </form>
  </aside>`;
}

/** The round button at the bottom right that opens the panel. */
export function AssistBubble({ onOpen }) {
  return html`<button type="button" class="assist-bubble" aria-label="Ask the model about this file or the selection" title="Ask the model (Ctrl+K): about the selection, or the whole file" onClick=${onOpen}>
    <${Icon} name="sparkle" size=${22} />
  </button>`;
}
