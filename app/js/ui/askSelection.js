import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { renderMarkdown } from '../markdown.js';
import { cleanReplacement, SELECTION_ACTIONS, selectionMessages } from '../selectionAsk.js';
import { llmClient } from '../semantic.js';
import { getSettings } from '../settings.js';
import { Modal, toast } from './components.js';
import { Icon } from './icons.js';

/**
 * Ctrl+K: ask the model about the selection (or the file). `context` is
 * { key, from, to, text, whole, name, language }. Answers show here; proposed
 * replacements open as a comparison to accept (actions.proposeReplacement).
 */
export function AskSelectionDialog({ context, actions, onClose }) {
  const [custom, setCustom] = useState('');
  const [replace, setReplace] = useState(false);
  const [state, setState] = useState(null); // { action, status: 'asking' | 'done' | 'error', text, phase }
  const controller = useRef(null);
  const input = useRef(null);
  const { llm } = getSettings();
  useLayoutEffect(() => input.current?.focus(), []);
  useEffect(() => () => controller.current?.abort(), []);

  const ask = async (action) => {
    controller.current?.abort();
    controller.current = new AbortController();
    setState({ action, status: 'asking', text: '', phase: '' });
    let out = '';
    try {
      const reply = await llmClient().chat({
        model: llm.chatModel,
        purpose: action.kind === 'replace' ? 'edit' : 'ask',
        messages: selectionMessages(action, context),
        signal: controller.current.signal,
        onToken: (t) => action.kind === 'answer' && setState((s) => ({ ...s, text: (out += t) })),
        onState: (phase) => setState((s) => ({ ...s, phase })),
      });
      if (action.kind === 'replace') {
        onClose();
        actions.proposeReplacement(context, cleanReplacement(reply, context.text), action.label);
        return;
      }
      setState({ action, status: 'done', text: reply || out });
    } catch (err) {
      if (err?.name === 'AbortError') return setState(null);
      setState({ action, status: 'error', text: err.message });
    }
  };
  const askCustom = () => custom.trim() && ask({ id: 'custom', label: custom.trim(), kind: replace ? 'replace' : 'answer', prompt: custom.trim() });

  if (!llm.enabled || !llm.chatModel) {
    return html`<${Modal} title="Ask the model" onClose=${onClose}>
      <p>Connect a model first: a local one (Ollama, LM Studio) or a model service.</p>
      <div class="card-actions"><button type="button" class="btn primary" onClick=${() => (onClose(), actions.showSettings())}>Set up in Settings</button></div>
    </${Modal}>`;
  }
  const excerpt = context.text.length > 400 ? `${context.text.slice(0, 400)}…` : context.text;
  return html`<${Modal} title=${context.whole ? `Ask about ${context.name}` : 'Ask about the selection'} onClose=${onClose} className="ask-dialog" wide>
    <pre class="ask-excerpt" aria-label="The text">${excerpt}</pre>
    ${!state &&
    html`<div class="ask-actions">
        ${SELECTION_ACTIONS.map((a) => html`<button type="button" key=${a.id} class="btn sm" onClick=${() => ask(a)}><${Icon} name=${a.icon} size=${14} />${a.label}</button>`)}
      </div>
      <form class="ask-custom" onSubmit=${(e) => (e.preventDefault(), askCustom())}>
        <input ref=${input} value=${custom} onInput=${(e) => setCustom(e.currentTarget.value)} placeholder="Or ask anything: “turn this into a table”, “what could fail here?”…" aria-label="Your question" />
        <label class="check-inline"><input type="checkbox" checked=${replace} onChange=${(e) => setReplace(e.currentTarget.checked)} />Replace the text</label>
        <button type="submit" class="btn primary sm" disabled=${!custom.trim()}><${Icon} name="send" size=${14} />Ask</button>
      </form>`}
    ${state?.status === 'asking' &&
    html`<div class="ask-busy">
      <p class="muted"><${Icon} name="sync" size=${15} /> ${state.action.label}… ${state.phase && state.phase !== 'done' ? `(${state.phase})` : ''}</p>
      ${state.text && html`<div class="answer markdown" dangerouslySetInnerHTML=${{ __html: renderMarkdown(state.text) }} />`}
      <button type="button" class="btn sm" onClick=${() => controller.current?.abort()}><${Icon} name="stop" size=${14} />Stop</button>
    </div>`}
    ${state?.status === 'error' && html`<p class="notice error"><${Icon} name="alert" size=${15} />${state.text}</p><div class="card-actions"><button type="button" class="btn sm" onClick=${() => setState(null)}>Back</button></div>`}
    ${state?.status === 'done' &&
    html`<div class="answer markdown ask-answer" dangerouslySetInnerHTML=${{ __html: renderMarkdown(state.text) }} />
      <div class="card-actions">
        <button type="button" class="btn sm" onClick=${() => navigator.clipboard.writeText(state.text).then(() => toast('Copied'))}><${Icon} name="copy" size=${14} />Copy</button>
        <button type="button" class="btn sm" onClick=${() => (onClose(), actions.answerAsNote(context, state.action.label, state.text))}><${Icon} name="filePlus" size=${14} />Save as note</button>
        <button type="button" class="btn ghost sm" onClick=${() => setState(null)}>Ask something else</button>
      </div>`}
  </${Modal}>`;
}
