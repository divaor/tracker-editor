import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatcher, findInFiles, fuzzyScore, quickOpen } from '../app/js/search.js';
import { askMessages, chunkText, cosine, rankBySimilarity, summaryMessages } from '../app/js/ai.js';
import { createLlmClient } from '../app/js/llm.js';
import { embedText, startFakeLlm } from './helpers/fake-llm.js';

const files = [
  { id: 'a', name: 'notes.md', text: 'first line\nTODO: call Ana\nnothing here\ntodo again, todo twice\n' },
  { id: 'b', name: 'server.py', text: 'def handler(req):\n    return todos\n' },
  { id: 'c', name: 'empty.txt', text: '' },
];

test('find in files: lines, columns, counts and previews', () => {
  const r = findInFiles(files, 'todo');
  assert.equal(r.total, 4);
  assert.deepEqual(r.files.map((f) => [f.id, f.count]), [['a', 3], ['b', 1]]);
  const [first, second] = r.files[0].matches;
  assert.deepEqual([first.line, first.column, first.preview], [2, 1, 'TODO: call Ana']);
  assert.equal(second.line, 4, 'one result per line, with the first match');
  assert.equal(r.files[1].matches[0].preview, 'return todos');
  assert.equal(r.files[1].matches[0].at, 7);
});

test('find in files: match case, whole word and regular expressions', () => {
  assert.equal(findInFiles(files, 'TODO', { caseSensitive: true }).total, 1);
  assert.equal(findInFiles(files, 'todo', { wholeWord: true }).total, 3, '"todos" is not a whole-word match');
  assert.equal(findInFiles(files, '^def \\w+', { regex: true }).files[0].matches[0].preview, 'def handler(req):');
  assert.throws(() => buildMatcher('(unclosed', { regex: true }), /Invalid regular expression/);
  assert.equal(findInFiles(files, '', {}).total, 0);
  const long = { id: 'l', name: 'log.txt', text: `${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}` };
  const hit = findInFiles([long], 'needle').files[0].matches[0];
  assert.ok(hit.preview.length <= 160 && hit.preview.slice(hit.at, hit.at + 6) === 'NEEDLE');
});

test('find in files stops at the limits and says so', () => {
  const many = { id: 'm', name: 'many.txt', text: 'hit\n'.repeat(50) };
  const r = findInFiles([many], 'hit', { maxPerFile: 10 });
  assert.equal(r.files[0].matches.length, 10);
  assert.equal(r.files[0].count, 50);
  assert.equal(r.truncated, true);
});

test('quick open ranks fuzzy matches on names', () => {
  assert.ok(fuzzyScore('server.py', 'srv') > 0);
  assert.equal(fuzzyScore('server.py', 'xyz'), -1);
  assert.ok(fuzzyScore('notes.md', 'notes') > fuzzyScore('my-notes-old.md', 'notes'));
  const list = [
    { name: 'meeting notes.md', project: 'Work' },
    { name: 'notes.md', project: '' },
    { name: 'server.py', project: 'Platform' },
    { name: 'proposal.md', project: '', item: 'Caching proposal' },
  ];
  assert.deepEqual(quickOpen(list, 'notes').map((f) => f.name), ['notes.md', 'meeting notes.md']);
  assert.deepEqual(quickOpen(list, 'plat').map((f) => f.name), ['server.py'], 'matches on the project too');
  assert.deepEqual(quickOpen(list, 'caching').map((f) => f.name), ['proposal.md'], 'and on a tracker document’s item');
});

test('chunks keep line ranges and stay near the size limit', () => {
  const text = Array.from({ length: 120 }, (_, i) => `line ${i + 1} ${'word '.repeat(10)}`).join('\n');
  const chunks = chunkText(text, { maxChars: 600 });
  assert.ok(chunks.length > 5);
  assert.equal(chunks[0].from, 1);
  assert.equal(chunks.at(-1).to, 120);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].from, chunks[i - 1].to + 1, 'no gaps or overlaps');
  for (const c of chunks) assert.ok(c.text.length <= 700);
  const long = chunkText(`short\n${'z'.repeat(2500)}\nend`, { maxChars: 1000 });
  assert.deepEqual(long.map((c) => [c.from, c.to, c.text.length]), [[1, 1, 5], [2, 2, 1000], [2, 2, 1000], [2, 2, 500], [3, 3, 3]]);
});

test('similarity ranking and prompts', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  const entries = ['the deploy checklist for servers', 'grocery list: apples and bread', 'servers deploy tomorrow'].map((text, i) => ({ i, vector: embedText(text) }));
  const ranked = rankBySimilarity(embedText('when do we deploy the servers'), entries, 2);
  assert.deepEqual(ranked.map((r) => r.i).sort(), [0, 2]);
  const summary = summaryMessages('plan.md', 'x'.repeat(30), { maxChars: 10 });
  assert.match(summary[1].content, /“plan\.md”[\s\S]*\[… cut, 20 more characters\]/);
  const ask = askMessages('Where is the deploy?', [{ name: 'ops.md', from: 3, to: 9, text: 'deploy steps' }]);
  assert.match(ask[0].content, /### ops\.md \(lines 3–9\)\ndeploy steps/);
  assert.equal(ask.at(-1).content, 'Where is the deploy?');
});

test('model client: models, streamed chat, embeddings and clear errors', async () => {
  const llm = await startFakeLlm();
  try {
    const client = createLlmClient({ baseUrl: `${llm.url}/` });
    assert.deepEqual(await client.listModels(), ['llama3.2', 'nomic-embed-text']);
    const pieces = [];
    const text = await client.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'Summarize “notes.md” ✓' }], onToken: (t) => pieces.push(t) });
    assert.equal(text, 'Answer about: Summarize “notes.md” ✓');
    assert.ok(pieces.length > 3, 'streamed in pieces');
    assert.equal(llm.calls.at(-1).body.stream, true);
    const vectors = await client.embed({ model: 'nomic-embed-text', input: ['alpha beta', 'gamma'] });
    assert.equal(vectors.length, 2);
    await assert.rejects(client.chat({ model: 'missing', messages: [{ role: 'user', content: 'hi' }] }), /404: model "missing" not found.*ollama pull/);
  } finally {
    await llm.close();
  }
  await assert.rejects(createLlmClient({ baseUrl: 'http://127.0.0.1:9/v1' }).listModels(), /Could not reach the model server.*Is Ollama or LM Studio running\?/);
});

test('lists the tracker’s attached files with their item', async () => {
  const { trackerDocs } = await import('../app/js/model.js');
  const items = [
    { id: 'a', title: 'Caching proposal', project: 'Platform', tags: ['GlobalAPI'], updatedAt: '2026-10-20T10:00:00.000Z', files: [{ path: 'files/p1/proposal.md', name: 'proposal.md', sha: 's1', size: 10 }, { path: 'files/p1/diagram.svg', name: 'diagram.svg', sha: 's2', size: 5 }] },
    { id: 'b', title: 'Gone', deleted: true, files: [{ path: 'files/x/old.md', name: 'old.md', sha: 's3' }] },
    { id: 'c', title: 'Plain task', files: [] },
    { id: 'd', title: 'Caching proposal v2', project: 'Platform', tags: [], updatedAt: '2026-10-21T10:00:00.000Z', files: [{ path: 'files/p1/proposal.md', sha: 's4', size: 12 }] },
  ];
  const docs = trackerDocs(items);
  assert.deepEqual(docs.map((d) => [d.path, d.name, d.sha, d.item.title]), [
    ['files/p1/proposal.md', 'proposal.md', 's4', 'Caching proposal v2'],
    ['files/p1/diagram.svg', 'diagram.svg', 's2', 'Caching proposal'],
  ]);
  assert.deepEqual(docs[1], { path: 'files/p1/diagram.svg', name: 'diagram.svg', sha: 's2', size: 5, project: 'Platform', tags: ['GlobalAPI'], modifiedAt: '2026-10-20T10:00:00.000Z', item: { id: 'a', title: 'Caching proposal' } });
  assert.deepEqual(trackerDocs(undefined), []);
});
