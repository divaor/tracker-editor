import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { askMessages, summaryMessages } from '../ai.js';
import { renderMarkdown } from '../markdown.js';
import { indexStatus, keywordPassages, llmClient, semanticSearch, updateIndex } from '../semantic.js';
import { store } from '../store.js';
import { Segmented } from './components.js';
import { Icon } from './icons.js';

const MODES = [
  { id: 'ask', label: 'Ask' },
  { id: 'find', label: 'Find by meaning' },
  { id: 'summary', label: 'Summarize' },
];
const SCOPES = [
  { id: 'file', label: 'This file' },
  { id: 'filtered', label: 'Filtered' },
  { id: 'all', label: 'All files' },
];

function Answer({ text, busy }) {
  return html`<div class="answer markdown">${text ? html`<div dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }} />` : busy ? html`<p class="muted">Thinking…</p>` : null}</div>`;
}

function Sources({ passages, actions }) {
  if (!passages?.length) return null;
  return html`<div class="sources">
    <div class="muted small">Sources</div>
    ${passages.map(
      (p, i) => html`<button type="button" key=${i} class="source" onClick=${() => actions.openFile(p.id, { line: p.from })}>
        <${Icon} name="file" size=${13} /><span>${p.name}</span><span class="muted">:${p.from}${p.to > p.from ? `–${p.to}` : ''}</span>
      </button>`,
    )}
  </div>`;
}

/** The local model (Ollama, LM Studio, …): ask about your files, find by meaning, summarize. */
export function AssistantPanel({ files, activeFile, activeRepo, settings, actions, onClose }) {
  const { llm } = settings;
  const [mode, setMode] = useState('ask');
  const [scope, setScope] = useState(activeFile ? 'file' : 'all');
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState([]); // [{ q, a, passages }]
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [found, setFound] = useState(null);
  const [summary, setSummary] = useState('');
  const [status, setStatus] = useState(null);
  const [progress, setProgress] = useState(null);
  const abort = useRef(null);
  const bottom = useRef(null);

  const refreshStatus = () => llm.embedModel && indexStatus().then(setStatus).catch(() => {});
  const index = async () => {
    if (!llm.embedModel) return;
    try {
      await updateIndex({ onProgress: setProgress });
    } catch (err) {
      setError(err.message);
    }
    setProgress(null);
    refreshStatus();
  };
  // Keep the index current while the panel is open.
  useEffect(() => {
    refreshStatus();
    index();
  }, [llm.embedModel]);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [chat, summary]);

  const run = async (fn) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    try {
      await fn(controller.signal);
    } catch (err) {
      if (err?.name !== 'AbortError') setError(err.message);
    } finally {
      setBusy(false);
      if (abort.current === controller) abort.current = null;
    }
  };

  const summarize = (selectionOnly = false) =>
    run(async (signal) => {
      setMode('summary');
      const name = activeFile?.name ?? activeRepo?.name;
      const full = activeFile ? store.text(activeFile.id) : (activeRepo?.text ?? '');
      const selected = actions.selectionText();
      const text = selectionOnly && selected ? selected : full;
      if (!text.trim()) throw new Error('Open a file with some text first.');
      setSummary('');
      let out = '';
      await llmClient().chat({ model: llm.chatModel, messages: summaryMessages(name, text, { selection: selectionOnly && Boolean(selected) }), signal, onToken: (t) => setSummary((out += t)) });
    });

  // "Summarize" in the file bar opens the panel and asks for this.
  useEffect(() => {
    const on = (e) => e.detail?.action === 'summarize' && summarize(false);
    window.addEventListener('assistant', on);
    return () => window.removeEventListener('assistant', on);
  }, [activeFile?.id, activeRepo?.path]);

  const pool = () => (scope === 'file' && activeFile ? [activeFile] : scope === 'filtered' ? files : store.live());

  const ask = (e) => {
    e?.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setQuestion('');
    run(async (signal) => {
      const candidates = pool();
      const ids = new Set(candidates.map((f) => f.id));
      let passages;
      if (scope === 'file' && activeFile && store.text(activeFile.id).length < 20000) {
        const text = store.text(activeFile.id);
        passages = [{ id: activeFile.id, name: activeFile.name, from: 1, to: text.split('\n').length, text }];
      } else if (llm.embedModel) {
        await updateIndex({ onProgress: setProgress, signal }).catch(() => {});
        setProgress(null);
        passages = await semanticSearch(q, { k: 8, fileIds: ids, signal });
      } else {
        passages = keywordPassages(q, candidates);
      }
      const history = chat.flatMap((t) => [{ role: 'user', content: t.q }, { role: 'assistant', content: t.a }]).slice(-6);
      const turn = { q, a: '', passages };
      setChat((c) => [...c, turn]);
      let out = '';
      await llmClient().chat({
        model: llm.chatModel,
        messages: askMessages(q, passages, { history }),
        signal,
        onToken: (t) => {
          out += t;
          setChat((c) => c.map((x) => (x === turn ? Object.assign(turn, { a: out }) : x)).slice());
        },
      });
    });
  };

  const find = (e) => {
    e?.preventDefault();
    const q = question.trim();
    if (!q) return;
    run(async (signal) => {
      if (!llm.embedModel) throw new Error('Finding by meaning needs an embedding model (Settings → Local model), e.g. nomic-embed-text.');
      await updateIndex({ onProgress: setProgress, signal });
      setProgress(null);
      setFound(await semanticSearch(q, { k: 15, fileIds: new Set(pool().map((f) => f.id)), signal }));
      refreshStatus();
    });
  };

  if (!llm.enabled || !llm.chatModel) {
    return html`<aside class="panel assistant-panel" aria-label="Local model">
      <div class="panel-head"><h2><${Icon} name="sparkle" size=${16} />Local model</h2><span class="spacer" />
        <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button></div>
      <div class="panel-body"><p class="muted">Connect a model running on this computer (Ollama or LM Studio) to summarize files, ask about them and find things by meaning.</p>
        <button type="button" class="btn primary" onClick=${() => (onClose(), actions.showSettings())}>Set up in Settings</button></div>
    </aside>`;
  }

  return html`<aside class="panel assistant-panel" aria-label="Local model">
    <div class="panel-head">
      <h2><${Icon} name="sparkle" size=${16} />Local model</h2>
      <span class="muted small model-name" title=${llm.baseUrl}>${llm.chatModel}</span>
      <span class="spacer" />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    <div class="panel-body">
      <${Segmented} small options=${MODES} value=${mode} onChange=${setMode} label="Mode" />
      ${mode !== 'summary' && html`<${Segmented} small options=${activeFile ? SCOPES : SCOPES.slice(1)} value=${scope} onChange=${setScope} label="Look in" />`}

      ${mode === 'summary' &&
      html`<div class="assistant-actions">
        <button type="button" class="btn sm" disabled=${busy || (!activeFile && !activeRepo)} onClick=${() => summarize(false)}><${Icon} name="file" size=${14} />Summarize this file</button>
        <button type="button" class="btn sm" disabled=${busy || (!activeFile && !activeRepo)} onClick=${() => summarize(true)}>Summarize selection</button>
      </div>
      <${Answer} text=${summary} busy=${busy} />`}

      ${mode === 'ask' &&
      html`<div class="chat">
        ${chat.map(
          (t, i) => html`<div class="turn" key=${i}>
            <p class="question">${t.q}</p>
            <${Answer} text=${t.a} busy=${busy && i === chat.length - 1} />
            <${Sources} passages=${t.passages} actions=${actions} />
          </div>`,
        )}
        ${!chat.length && html`<p class="muted small">Ask about your files, e.g. “where did I write the deploy steps?” or “what is still undecided in this plan?”. Answers cite the files and lines they used.</p>`}
      </div>`}

      ${mode === 'find' &&
      html`<div class="found">
        ${found?.map(
          (p, i) => html`<button type="button" key=${i} class="found-row" onClick=${() => actions.openFile(p.id, { line: p.from })}>
            <span class="found-head"><${Icon} name="file" size=${13} /><strong>${p.name}</strong><span class="muted">lines ${p.from}–${p.to}</span><span class="spacer" /><span class="muted small">${Math.round(p.score * 100)}%</span></span>
            <span class="found-text">${p.text.slice(0, 220)}</span>
          </button>`,
        )}
        ${found && !found.length && html`<p class="muted small">Nothing similar found.</p>`}
        ${!found && html`<p class="muted small">Describe what you are looking for in your own words, e.g. “the email to the landlord about the heating”.</p>`}
      </div>`}

      ${error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${error}</p>`}
      <div ref=${bottom} />
    </div>
    ${mode !== 'summary' &&
    html`<form class="panel-foot ask-form" onSubmit=${mode === 'ask' ? ask : find}>
      <textarea rows="2" value=${question} placeholder=${mode === 'ask' ? 'Ask about your files…' : 'Describe what you are looking for…'} aria-label="Question"
        onInput=${(e) => setQuestion(e.currentTarget.value)}
        onKeyDown=${(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), mode === 'ask' ? ask() : find())} />
      ${busy
        ? html`<button type="button" class="btn sm" onClick=${() => abort.current?.abort()}><${Icon} name="stop" size=${14} />Stop</button>`
        : html`<button type="submit" class="btn primary sm" disabled=${!question.trim()}>${mode === 'ask' ? 'Ask' : 'Find'}</button>`}
      ${mode === 'ask' && chat.length > 0 && !busy && html`<button type="button" class="btn ghost sm" onClick=${() => setChat([])}>New chat</button>`}
    </form>`}
    <div class="index-status muted small">
      ${progress
        ? html`Indexing ${progress.done}/${progress.total}${progress.name ? ` · ${progress.name}` : ''}<progress max=${progress.total || 1} value=${progress.done} />`
        : llm.embedModel
          ? status && html`Index: ${status.indexed} of ${status.total} files${status.stale ? html` · ${status.stale} to update <button type="button" class="btn link" onClick=${index}>Update</button>` : ' · up to date'}`
          : html`No embedding model: questions use keyword search. <button type="button" class="btn link" onClick=${() => (onClose(), actions.showSettings())}>Add one</button>`}
    </div>
  </aside>`;
}
