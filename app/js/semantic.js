// The local model for your files: an embeddings index for "find by meaning"
// and for picking the passages a question is answered from. Each file is
// split into chunks with line ranges, embedded with the local model and kept
// in IndexedDB; only files whose text changed are embedded again. Without an
// embedding model, questions fall back to keyword search.
import { chunkText, rankBySimilarity } from './ai.js';
import { kvGet, kvSet } from './kv.js';
import { createLlmClient } from './llm.js';
import { gitBlobSha } from './model.js';
import { findInFiles } from './search.js';
import { getSettings } from './settings.js';
import { store } from './store.js';

/** fetch() through the desktop app's main process: no CORS setup needed in Ollama or LM Studio. */
function desktopFetch(url, init = {}) {
  const bridge = window.desktop.llm;
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let controller;
  const stream = new ReadableStream({
    start: (c) => (controller = c),
    cancel: () => bridge.abort(id),
  });
  const off = bridge.onChunk(id, (chunk, done, error) => {
    if (chunk) controller.enqueue(chunk);
    if (error) controller.error(new Error(error));
    else if (done) controller.close();
    if (done || error) off();
  });
  init.signal?.addEventListener('abort', () => bridge.abort(id));
  return bridge.request(id, url, { method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null }).then(
    (meta) => new Response(stream, { status: meta.status, statusText: meta.statusText, headers: meta.headers }),
    (err) => {
      off();
      throw new TypeError(err?.message ?? 'Request failed');
    },
  );
}

export function llmClient(settings = getSettings()) {
  return createLlmClient({ baseUrl: settings.llm.baseUrl, apiKey: settings.llm.apiKey, fetchImpl: window.desktop?.llm ? desktopFetch : undefined });
}

let index = null; // file id → { id, hash, model, chunks: [{ from, to, text, vector }] }
async function load() {
  index ??= new Map(((await kvGet('vectors')) ?? []).map((e) => [e.id, e]));
  return index;
}
const save = () => kvSet('vectors', [...index.values()]);

/** How many files the index has and how many need (re-)embedding. */
export async function indexStatus() {
  await load();
  const model = getSettings().llm.embedModel;
  let stale = 0;
  for (const f of store.live()) {
    const entry = index.get(f.id);
    if (!entry || entry.model !== model || entry.hash !== (await gitBlobSha(store.text(f.id)))) stale++;
  }
  return { indexed: [...index.keys()].filter((id) => store.get(id)).length, stale, total: store.live().length };
}

let running = null;

/** Embeds new and changed files. `onProgress({ done, total, name })`. Only one run at a time. */
export function updateIndex({ onProgress, signal } = {}) {
  running ??= (async () => {
    const model = getSettings().llm.embedModel;
    if (!model) throw new Error('Choose an embedding model in Settings → Local model.');
    await load();
    const client = llmClient();
    for (const id of [...index.keys()]) if (!store.get(id)) index.delete(id);
    const todo = [];
    for (const f of store.live()) {
      const text = store.text(f.id);
      const hash = await gitBlobSha(text);
      const entry = index.get(f.id);
      if (!entry || entry.hash !== hash || entry.model !== model) todo.push({ f, text, hash });
    }
    let done = 0;
    onProgress?.({ done, total: todo.length });
    for (const { f, text, hash } of todo) {
      if (signal?.aborted) break;
      const chunks = chunkText(text);
      const vectors = [];
      for (let i = 0; i < chunks.length; i += 16) {
        const input = chunks.slice(i, i + 16).map((c) => `${f.name}${f.project ? ` (${f.project})` : ''}\n${c.text}`);
        vectors.push(...(await client.embed({ model, input, signal })));
      }
      index.set(f.id, { id: f.id, hash, model, chunks: chunks.map((c, i) => ({ from: c.from, to: c.to, text: c.text, vector: Float32Array.from(vectors[i]) })) });
      done++;
      onProgress?.({ done, total: todo.length, name: f.name });
      if (done % 10 === 0) await save();
    }
    await save();
    return { indexed: index.size, updated: done };
  })().finally(() => (running = null));
  return running;
}

/** Passages most similar in meaning to `query`, best first: [{ id, name, from, to, text, score }]. */
export async function semanticSearch(query, { k = 10, fileIds = null, signal } = {}) {
  await load();
  const model = getSettings().llm.embedModel;
  const [vector] = await llmClient().embed({ model, input: [query], signal });
  const entries = [];
  for (const e of index.values()) {
    const file = store.get(e.id);
    if (!file || (fileIds && !fileIds.has(e.id))) continue;
    for (const c of e.chunks) entries.push({ id: e.id, name: file.name, from: c.from, to: c.to, text: c.text, vector: c.vector });
  }
  return rankBySimilarity(vector, entries, k).map(({ vector: _, ...rest }) => rest);
}

const STOP = new Set('about above after again also because been before being between both could does doing down during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very what when where which while whom will with would your yours where what about'.split(' '));

/** Without embeddings: passages around keyword matches, files with the most hits first. */
export function keywordPassages(question, files, { k = 8, around = 8 } = {}) {
  const words = [...new Set((question.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []).filter((w) => !STOP.has(w)))];
  if (!words.length) return [];
  const docs = files.map((f) => ({ id: f.id, name: f.name, text: store.text(f.id) }));
  const scores = new Map();
  for (const word of words) {
    for (const hit of findInFiles(docs, word, { maxPerFile: 20 }).files) {
      const s = scores.get(hit.id) ?? { id: hit.id, name: hit.name, score: 0, lines: [] };
      s.score += hit.count;
      s.lines.push(...hit.matches.map((m) => m.line));
      scores.set(hit.id, s);
    }
  }
  const passages = [];
  for (const s of [...scores.values()].sort((a, b) => b.score - a.score).slice(0, k)) {
    const lines = store.text(s.id).split('\n');
    const center = s.lines.sort((a, b) => a - b)[0];
    const from = Math.max(1, center - around);
    const to = Math.min(lines.length, center + around);
    passages.push({ id: s.id, name: s.name, from, to, text: lines.slice(from - 1, to).join('\n'), score: s.score });
  }
  return passages;
}
