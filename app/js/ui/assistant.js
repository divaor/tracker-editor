import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { askMessages, summaryMessages } from '../ai.js';
import { renderMarkdown } from '../markdown.js';
import { allSources, docSources, fileSources, indexStatus, keywordPassages, llmClient, semanticSearch, updateIndex } from '../semantic.js';
import { store } from '../store.js';
import { Segmented } from './components.js';
import { Icon } from './icons.js';
import { chatPreview, chatTitle, chatToResume, newChatId } from '../chats.js';
import { chats } from '../chatStore.js';
import { ChatButtons, ChatList, KeptNote, useChats } from './chats.js';

const CHAT_SCOPE = 'library:';
// A passage as a kept chat has it: where it is (its Sources button), not its text.
const keptPassage = ({ id, name, from, to }) => ({ id, name, from, to });

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
// Find by asking's Ask about these: just the files and items it found.
const FOUND_SCOPE = { id: 'found', label: 'Found' };

function Answer({ text, busy }) {
  return html`<div class="answer markdown">${text ? html`<div dangerouslySetInnerHTML=${{ __html: renderMarkdown(text) }} />` : busy ? html`<p class="muted">Thinking…</p>` : null}</div>`;
}

// A passage's file: the editor's files and tracker documents, or (found by asking) a file on disk or a tracker item.
const openPassage = (p, actions) => (/^[fdi]:/.test(p.id) ? actions.openFound({ id: p.id, kind: p.id.startsWith('i:') ? 'item' : '', itemId: p.id.slice(2) }, p.from) : actions.openFile(p.id, { line: p.from }));

function Sources({ passages, actions }) {
  if (!passages?.length) return null;
  return html`<div class="sources">
    <div class="muted small">Sources</div>
    ${passages.map(
      (p, i) => html`<button type="button" key=${i} class="source" onClick=${() => openPassage(p, actions)}>
        <${Icon} name="file" size=${13} /><span>${p.name}</span><span class="muted">:${p.from}${p.to > p.from ? `–${p.to}` : ''}</span>
      </button>`,
    )}
  </div>`;
}

/**
 * The model (on this computer, an AI provider, or a service): ask about your files, find by meaning, summarize.
 * Its questions and answers are kept as a chat (chatStore.js), taken up again when it opens until New chat;
 * `resume` opens a kept one.
 */
export function AssistantPanel({ files, docs, activeFile, activeRepo, asked = null, resume = null, settings, actions, onClose }) {
  const { llm } = settings;
  // The open tab: one of the editor's files or a tracker document.
  // An encrypted file is never one of them: its text and name never go to the model.
  const current = activeFile && !activeFile.encrypted
    ? { id: activeFile.id, name: activeFile.name, project: activeFile.project, text: store.text(activeFile.id) }
    : activeRepo ? { id: `r:${activeRepo.path}`, name: activeRepo.name, project: '', text: activeRepo.text } : null;
  const [mode, setMode] = useState('ask');
  const [scope, setScope] = useState(asked ? 'found' : current ? 'file' : 'all');
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
  const [chatId, setChatId] = useState(null);
  const [chatMeta, setChatMeta] = useState(null);
  const [kept, setKept] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const chatRef = useRef({ id: null, meta: null });
  const turnsRef = useRef([]);
  turnsRef.current = chat;
  const rows = useChats();
  const currentKey = current ? (current.id.startsWith('r:') ? current.id : `f:${current.id}`) : null;
  // Found by asking's Ask about these is a chat of its own; else the one it had last comes back.
  useEffect(() => {
    if (asked) return;
    let live = true;
    chats.ready().then(() => {
      if (!live) return;
      const id = resume ?? chatToResume(chats.list(), { kind: 'library', current: chats.current(CHAT_SCOPE) });
      if (id) openChat(id);
    });
    return () => (live = false);
  }, []);
  const openChat = async (id) => {
    const kept = await chats.load(id);
    if (!kept || kept.kind !== 'library' || !kept.state?.turns?.length) return false;
    chatRef.current = { id: kept.id, meta: kept };
    setChatId(kept.id);
    setChatMeta(kept);
    setKept(true);
    setChat(kept.state.turns);
    setMode('ask');
    if (kept.state.scope && kept.state.scope !== 'found' && (kept.state.scope !== 'file' || current)) setScope(kept.state.scope);
    chats.setCurrent(CHAT_SCOPE, kept.id);
    setListOpen(false);
    return true;
  };
  const newChat = ({ keepList = false } = {}) => {
    abort.current?.abort();
    chatRef.current = { id: null, meta: null };
    setChat([]);
    setChatId(null);
    setChatMeta(null);
    setKept(false);
    if (!keepList) setListOpen(false);
    chats.setCurrent(CHAT_SCOPE, null);
  };
  /** Keeps the questions and answers as they are now (a new chat at the first answer). */
  const persist = () => {
    const turns = turnsRef.current.filter((t) => t.a);
    if (!turns.length) return;
    const { id: known, meta } = chatRef.current;
    const id = known ?? newChatId();
    const link = meta?.link ?? (scope === 'file' && currentKey ? actions.chatLink?.({ key: currentKey }, currentKey) : { key: null, name: scope === 'found' && asked ? `Found: ${asked.label}` : 'My files' }) ?? null;
    chatRef.current = { id, meta: { ...(meta ?? {}), link } };
    chats.setCurrent(CHAT_SCOPE, id);
    const row = chats.row(id);
    const named = Boolean(row?.named);
    chats
      .save({
        id,
        kind: 'library',
        title: named ? row.title : chatTitle(turns[0].q),
        named,
        createdAt: meta?.createdAt,
        saved: Boolean(row?.saved),
        link,
        turns: turns.length,
        preview: chatPreview(turns.at(-1).a),
        state: { scope, turns: turns.map((t) => ({ q: t.q, a: t.a, passages: (t.passages ?? []).map(keptPassage) })) },
      })
      .then((c) => {
        if (chatRef.current.id === id) chatRef.current.meta = c;
      });
    setChatId(id);
  };
  const openFromList = async (row) => {
    if (row.kind === 'library' && (await openChat(row.id))) return;
    onClose();
    actions.openChat(row);
  };

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
      if (activeFile?.encrypted) throw new Error('Encrypted files are not sent to the model.');
      const name = current?.name;
      const full = current?.text ?? '';
      const selected = actions.selectionText();
      const text = selectionOnly && selected ? selected : full;
      if (!text.trim()) throw new Error('Open a file with some text first.');
      setSummary('');
      let out = '';
      await llmClient().chat({ model: llm.chatModel, purpose: 'summarize', messages: summaryMessages(name, text, { selection: selectionOnly && Boolean(selected) }), signal, onToken: (t) => setSummary((out += t)) });
    });

  // "Summarize" in the file bar opens the panel and asks for this.
  useEffect(() => {
    const on = (e) => e.detail?.action === 'summarize' && summarize(false);
    window.addEventListener('assistant', on);
    return () => window.removeEventListener('assistant', on);
  }, [activeFile?.id, activeRepo?.path]);

  const pool = () => (scope === 'found' && asked ? asked.sources : scope === 'file' && current ? [current] : scope === 'filtered' ? [...fileSources(files), ...docSources(docs)] : allSources());

  const ask = (e) => {
    e?.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setQuestion('');
    run(async (signal) => {
      const candidates = pool();
      const ids = new Set(candidates.map((f) => f.id));
      let passages;
      if (scope === 'found' && asked) {
        // What Find by asking found: whole when it is short, else the passages about the question.
        const total = asked.sources.reduce((n, f) => n + f.text.length, 0);
        passages = total < 24000 ? asked.sources.map((f) => ({ id: f.id, name: f.name, from: 1, to: f.text.split('\n').length, text: f.text })) : keywordPassages(q, asked.sources);
      } else if (scope === 'file' && current && current.text.length < 20000) {
        const { text } = current;
        passages = [{ id: current.id, name: current.name, from: 1, to: text.split('\n').length, text }];
      } else if (llm.embedModel) {
        await updateIndex({ onProgress: setProgress, signal }).catch(() => {});
        setProgress(null);
        passages = await semanticSearch(q, { k: 8, fileIds: ids, signal });
      } else {
        passages = keywordPassages(q, candidates);
      }
      const history = chat.filter((t) => t.a).flatMap((t) => [{ role: 'user', content: t.q }, { role: 'assistant', content: t.a }]).slice(-6);
      const turn = { q, a: '', passages };
      setChat((c) => [...c, turn]);
      let out = '';
      await llmClient().chat({
        purpose: 'ask',
        model: llm.chatModel,
        messages: askMessages(q, passages, { history }),
        signal,
        onToken: (t) => {
          out += t;
          setChat((c) => c.map((x) => (x === turn ? Object.assign(turn, { a: out }) : x)).slice());
        },
      });
      setTimeout(persist, 0);
    });
  };

  const find = (e) => {
    e?.preventDefault();
    const q = question.trim();
    if (!q) return;
    run(async (signal) => {
      if (!llm.embedModel) throw new Error('Finding by meaning needs an embedding model (Settings → Model, an OpenAI-compatible server), e.g. nomic-embed-text.');
      await updateIndex({ onProgress: setProgress, signal });
      setProgress(null);
      setFound(await semanticSearch(q, { k: 15, fileIds: new Set(pool().map((f) => f.id)), signal }));
      refreshStatus();
    });
  };

  if (!llm.enabled || !llm.chatModel) {
    return html`<aside class="panel assistant-panel" aria-label="The model">
      <div class="panel-head"><h2><${Icon} name="sparkle" size=${16} />The model</h2><span class="spacer" />
        <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button></div>
      <div class="panel-body"><p class="muted">Connect a model running on this computer (Ollama or LM Studio) to summarize files, ask about them and find things by meaning.</p>
        <button type="button" class="btn primary" onClick=${() => (onClose(), actions.showSettings())}>Set up in Settings</button></div>
    </aside>`;
  }

  const title = 'The model';
  return html`<aside class="panel assistant-panel" aria-label=${title}>
    <div class="panel-head">
      <h2><${Icon} name="sparkle" size=${16} />${title}</h2>
      <span class="muted small model-name" title=${llm.provider === 'async' ? 'A model service that answers later' : llm.baseUrl}>${llm.chatModel}</span>
      <span class="spacer" />
      <${ChatButtons} chatId=${chatId} saved=${Boolean(rows.find((r) => r.id === chatId)?.saved)} listOpen=${listOpen} busy=${busy} onToggleList=${() => setListOpen(!listOpen)} onNew=${() => newChat()} />
      <button type="button" class="icon-btn sm" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${16} /></button>
    </div>
    ${listOpen &&
    html`<div class="panel-body">
      <${ChatList} here=${actions.chatHere?.(currentKey) ?? { key: currentKey }} currentId=${chatId} onOpen=${openFromList} onDeleted=${(id) => id === chatRef.current.id && newChat({ keepList: true })} />
    </div>`}
    <div class="panel-body" hidden=${listOpen}>
      <${Segmented} small options=${MODES} value=${mode} onChange=${setMode} label="Mode" />
      ${mode !== 'summary' && html`<${Segmented} small options=${[...(asked ? [FOUND_SCOPE] : []), ...(current ? SCOPES : SCOPES.slice(1))]} value=${scope} onChange=${setScope} label="Look in" />`}
      ${scope === 'found' && asked && html`<p class="muted small">Asking about the ${asked.sources.length} result${asked.sources.length === 1 ? '' : 's'} found for “${asked.label}”.</p>`}

      ${mode === 'summary' &&
      html`<div class="assistant-actions">
        <button type="button" class="btn sm" disabled=${busy || (!activeFile && !activeRepo)} onClick=${() => summarize(false)}><${Icon} name="file" size=${14} />Summarize this file</button>
        <button type="button" class="btn sm" disabled=${busy || (!activeFile && !activeRepo)} onClick=${() => summarize(true)}>Summarize selection</button>
      </div>
      <${Answer} text=${summary} busy=${busy} />`}

      ${mode === 'ask' &&
      html`<div class="chat">
        ${kept && chat.length > 0 && html`<${KeptNote} chat=${chatMeta} />`}
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
    !listOpen &&
    html`<form class="panel-foot ask-form" onSubmit=${mode === 'ask' ? ask : find}>
      <textarea rows="2" value=${question} placeholder=${mode === 'ask' ? 'Ask about your files…' : 'Describe what you are looking for…'} aria-label="Question"
        onInput=${(e) => setQuestion(e.currentTarget.value)}
        onKeyDown=${(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), mode === 'ask' ? ask() : find())} />
      ${busy
        ? html`<button type="button" class="btn sm" onClick=${() => abort.current?.abort()}><${Icon} name="stop" size=${14} />Stop</button>`
        : html`<button type="submit" class="btn primary sm" disabled=${!question.trim()}>${mode === 'ask' ? 'Ask' : 'Find'}</button>`}
      ${mode === 'ask' && chat.length > 0 && !busy && !chatId && html`<button type="button" class="btn ghost sm" onClick=${newChat}>New chat</button>`}
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
