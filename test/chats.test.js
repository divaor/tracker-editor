import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatPreview,
  chatRow,
  chatTitle,
  chatToResume,
  filterChats,
  filterCounts,
  fitMessages,
  fitTurns,
  historyBudget,
  inGroup,
  keptAction,
  keptContext,
  leftOutNote,
  linkLabel,
  MAX_CHAT_CHARS,
  newChatId,
  pruneIndex,
  settledSteps,
  shrinkChat,
  withRow,
} from '../app/js/chats.js';
import { createChatStore } from '../app/js/chatStore.js';

const at = (n) => new Date(Date.UTC(2026, 10, 1, 9, n)).toISOString();
const row = (id, extra = {}) => ({ id, kind: 'ask', title: id, createdAt: at(0), updatedAt: at(0), saved: false, link: null, turns: 1, preview: '', ...extra });

test('titles and previews: the question, or an action with its file; the last answer on one line', () => {
  assert.equal(chatTitle('  How do I   compare two files?\n'), 'How do I compare two files?');
  assert.equal(chatTitle('Explain', { name: 'app.js', action: true }), 'Explain · app.js');
  assert.equal(chatTitle('', { name: 'notes.md' }), 'About notes.md');
  assert.equal(chatTitle(''), 'New chat');
  const long = chatTitle('word '.repeat(40));
  assert.ok(long.length <= 80 && long.endsWith('…'), long);
  assert.equal(chatPreview('## The fix\n\nUse `map`:\n```js\nconst a = 1;\n```\nDone.'), 'The fix Use map : [code] Done.');
  assert.ok(chatPreview('x'.repeat(500)).length <= 140);
  assert.match(newChatId(), /^[a-z0-9]{10,}$/);
  assert.notEqual(newChatId(), newChatId());
});

test('the index: a row per chat (no state), newest first; pruning keeps saved ones and the newest', () => {
  const chat = { id: 'a', kind: 'files', title: 'Add a README', createdAt: at(1), updatedAt: at(2), saved: true, link: { folder: '/p' }, turns: 2, preview: 'Done', state: { big: 'x'.repeat(1000) } };
  assert.deepEqual(chatRow(chat), { id: 'a', kind: 'files', title: 'Add a README', named: false, createdAt: at(1), updatedAt: at(2), saved: true, link: { folder: '/p' }, turns: 2, preview: 'Done' });
  let index = [row('old', { updatedAt: at(1) }), row('mid', { updatedAt: at(5) })];
  index = withRow(index, row('new', { updatedAt: at(9) }));
  index = withRow(index, row('old', { updatedAt: at(10), title: 'again' }));
  assert.deepEqual(index.map((r) => r.id), ['old', 'new', 'mid']);
  assert.equal(index[0].title, 'again');
  const many = Array.from({ length: 8 }, (_, i) => row(`c${i}`, { updatedAt: at(i), saved: i === 0 || i === 1 }));
  const { index: kept, dropped } = pruneIndex(many, 5);
  assert.deepEqual(kept.map((r) => r.id), ['c7', 'c6', 'c5', 'c1', 'c0']);
  assert.deepEqual(dropped.sort(), ['c2', 'c3', 'c4']);
  // More saved than the room: every saved one stays, no other.
  const saved = Array.from({ length: 4 }, (_, i) => row(`s${i}`, { saved: true, updatedAt: at(i) }));
  assert.deepEqual(pruneIndex([...saved, row('x', { updatedAt: at(20) })], 3).dropped, ['x']);
});

test('filters: this file, this project (its group, a folder inside it, its project), all, saved; words', () => {
  const index = [
    row('a', { title: 'Explain · app.js', link: { key: 'd:/w/shop/app.js', name: 'app.js', folder: '/w/shop', group: { id: 'f:/w/shop', name: 'shop' } }, updatedAt: at(3) }),
    row('b', { kind: 'files', title: 'Add tests', link: { folder: '/w/shop/src', group: { id: 'f:/w/shop/src', name: 'src' } }, updatedAt: at(2), saved: true }),
    row('c', { title: 'Summarize', link: { key: 'f:n1', name: 'plan.md', project: 'Shop', group: { id: 'p:shop', name: 'Shop' } }, preview: 'The launch is in May', updatedAt: at(1) }),
    row('d', { title: 'How do I split?', link: { help: true }, updatedAt: at(0) }),
  ];
  const shop = { id: 'f:/w/shop', folder: '/w/shop' };
  assert.deepEqual(filterChats(index, { show: 'file', key: 'd:/w/shop/app.js' }).map((r) => r.id), ['a']);
  assert.deepEqual(filterChats(index, { show: 'file', key: null }), []);
  assert.deepEqual(filterChats(index, { show: 'project', group: shop }).map((r) => r.id), ['a', 'b'], 'a folder inside the group’s folder counts');
  assert.deepEqual(filterChats(index, { show: 'project', group: { id: 'p:shop', project: 'shop' } }).map((r) => r.id), ['c'], 'the project by its name, any case');
  assert.deepEqual(filterChats(index, { show: 'saved' }).map((r) => r.id), ['b']);
  assert.deepEqual(filterChats(index, { show: 'all', query: 'launch may' }).map((r) => r.id), ['c'], 'words in the last answer');
  assert.deepEqual(filterChats(index, { show: 'all', query: 'shop' }).map((r) => r.id), ['a', 'b', 'c'], 'the file’s project, group or folder');
  assert.deepEqual(filterChats(index, { show: 'all', kind: 'files' }).map((r) => r.id), ['b']);
  assert.deepEqual(filterCounts(index, { key: 'd:/w/shop/app.js', group: shop }), { file: 1, project: 2, all: 4, saved: 1 });
  assert.deepEqual(filterChats(index, { show: 'project', group: { id: 'p:other', folders: ['/w/shop/src'] } }).map((r) => r.id), ['b'], 'a folder linked to the project');
  assert.equal(inGroup(null, shop), false);
  assert.equal(inGroup({ folder: '/w/shopping' }, shop), false, 'a folder named alike is not inside');
});

test('the chat a panel takes up: the one shown last, else the newest about it; none after New chat', () => {
  const index = [row('new', { updatedAt: at(5), link: { key: 'd:/a.js' } }), row('old', { updatedAt: at(1), link: { key: 'd:/a.js' } }), row('f', { kind: 'files', updatedAt: at(3), link: { folder: '/w' } })];
  assert.equal(chatToResume(index, { kind: 'ask', key: 'd:/a.js' }), 'new');
  assert.equal(chatToResume(index, { kind: 'ask', key: 'd:/a.js', current: 'old' }), 'old');
  assert.equal(chatToResume(index, { kind: 'ask', key: 'd:/a.js', current: null }), null, 'New chat');
  assert.equal(chatToResume(index, { kind: 'ask', key: 'd:/a.js', current: 'gone' }), 'new', 'a deleted one: the newest');
  assert.equal(chatToResume(index, { kind: 'ask', key: 'd:/b.js' }), null);
  assert.equal(chatToResume(index, { kind: 'files', folder: '/w' }), 'f');
  assert.equal(chatToResume(index, { kind: 'files', key: 'd:/a.js' }), null, 'kinds apart');
});

test('labels: the file and its group, a folder, the editor', () => {
  assert.equal(linkLabel({ key: 'd:/w/a.js', name: 'a.js', group: { name: 'shop' } }), 'a.js · shop');
  assert.equal(linkLabel({ folder: '/w/shop/', group: { name: 'shop' } }), 'shop');
  assert.equal(linkLabel({ folder: 'C:\\w\\site' }), 'site');
  assert.equal(linkLabel({ help: true }), 'the editor');
  assert.equal(linkLabel({ help: true, key: 'd:/w/a.js', name: 'a.js' }), 'the editor', 'asked from a file, about the editor');
  assert.equal(linkLabel(null), '');
});

test('long chats: the first turn and the newest that fit go again; old messages shortened, the last kept', () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ question: `q${i}`, answer: 'a'.repeat(1000) }));
  assert.equal(fitTurns(turns.slice(0, 2), 10).turns.length, 2, 'two turns always go');
  assert.deepEqual(fitTurns(turns, 1e6), { turns, left: 0 });
  const fitted = fitTurns(turns, 4100);
  assert.deepEqual(fitted.turns.map((t) => t.question), ['q0', 'q7', 'q8', 'q9']);
  assert.equal(fitted.left, 6);
  assert.equal(fitTurns([turns[0], { question: 'huge', answer: 'x'.repeat(9000) }, turns[2]], 500).turns.length, 2, 'the newest goes whatever its size');
  assert.match(leftOutNote(6), /6 earlier exchanges/);
  assert.match(leftOutNote(1), /1 earlier exchange of/);

  const messages = [
    { role: 'user', content: 'u'.repeat(20000) },
    { role: 'assistant', content: 'a'.repeat(20000) },
    { role: 'user', content: 'short' },
    { role: 'assistant', content: 'b'.repeat(20000) },
    { role: 'user', content: 'c'.repeat(20000) },
    { role: 'assistant', content: 'd'.repeat(20000) },
  ];
  const fit = fitMessages(messages, 50000, { keepLast: 2 });
  assert.ok(fit.reduce((n, m) => n + m.content.length, 0) <= 50000);
  assert.match(fit[0].content, /^u{1500}\n\[… 18500 characters of an earlier part of this chat left out\]$/);
  assert.equal(fit[2].content, 'short');
  assert.equal(fit.at(-1).content, messages.at(-1).content, 'the newest whole');
  assert.equal(messages[0].content.length, 20000, 'the original untouched');
  assert.ok(historyBudget('local') < historyBudget('api'));
});

test('kept as small as needed: model messages first, then the text; steps settled; context and action trimmed', () => {
  const chat = { id: 'x', state: { history: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'z'.repeat(200_000) })) } };
  const small = shrinkChat(chat, 1_000_000);
  assert.ok(JSON.stringify(small).length <= 1_000_000, JSON.stringify(small).length);
  assert.equal(small.state.history.at(-1).content.length, 200_000);
  const tiny = { id: 'y', state: {} };
  assert.equal(shrinkChat(tiny), tiny, 'a small chat as it is');
  const ask = { id: 'q', state: { conv: { context: { text: 'w'.repeat(MAX_CHAT_CHARS + 10) } } } };
  assert.ok(JSON.stringify(shrinkChat(ask)).length < 30_000);

  const parts = [{ text: 'Plan' }, { steps: [{ text: 'a', status: 'ok', undo: () => {} }, { text: 'b', status: 'waiting', many: 2 }, { text: 'c', status: 'running' }, { text: 'd', status: 'skipped' }] }];
  assert.deepEqual(settledSteps(parts), [{ text: 'Plan' }, { steps: [{ text: 'a', status: 'ok', undo: null, many: 0 }, { text: 'b', status: 'stopped', undo: null, many: 0 }, { text: 'c', status: 'stopped', undo: null, many: 0 }, { text: 'd', status: 'skipped', undo: null, many: 0 }] }]);

  const ctx = keptContext({ key: 'd:/a.js', from: 3, to: 9, text: 't'.repeat(30_000), whole: false, name: 'a.js', language: 'JavaScript', symbols: { count: 1, rows: [], text: 's' }, extra: 'dropped', help: false });
  assert.equal(ctx.text.length, 20_000 + '\n[… cut when kept]'.length);
  assert.deepEqual(Object.keys(ctx).sort(), ['from', 'key', 'language', 'name', 'symbols', 'text', 'to', 'whole']);
  assert.equal(keptContext(null), null);
  assert.deepEqual(keptAction({ id: 'tone', label: 'Change the tone More formal', kind: 'replace', prompt: 'p', value: 'More formal', param: { options: [] }, run: () => {} }), { id: 'tone', label: 'Change the tone More formal', kind: 'replace', prompt: 'p', value: 'More formal' });
});

/** A store over a Map, as kv.js keeps things (a structured copy: no functions). */
function memoryStore(opts = {}) {
  const map = new Map();
  let n = 0;
  const store = createChatStore({
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)) : undefined),
    set: async (k, v) => void map.set(k, structuredClone(v)),
    del: async (k) => void map.delete(k),
    wait: 5,
    now: () => at(n++),
    ...opts,
  });
  return { map, store };
}

test('the store: kept, listed, loaded again after a restart; saved, renamed, deleted; Undo keeps it again', async () => {
  const { map, store } = memoryStore();
  await store.ready();
  assert.deepEqual(store.list(), []);
  const kept = await store.save({ id: 'c1', kind: 'ask', title: 'Explain · a.js', link: { key: 'd:/a.js' }, turns: 1, preview: 'It adds', state: { conv: { turns: [{ question: 'Explain', answer: 'It adds' }] }, undo: () => 'functions never kept' } });
  assert.equal(kept.state.undo, undefined, 'no functions');
  await store.save({ id: 'c2', kind: 'files', title: 'Add a README', link: { folder: '/w' }, turns: 1, state: {} });
  assert.deepEqual(store.list().map((r) => r.id), ['c2', 'c1']);
  await store.flush();
  assert.deepEqual(map.get('chats').map((r) => r.id), ['c2', 'c1']);
  assert.equal(map.get('chat:c1').state.conv.turns[0].answer, 'It adds');

  // Another run of the app reads them back.
  const again = createChatStore({ get: async (k) => structuredClone(map.get(k)), set: async (k, v) => void map.set(k, structuredClone(v)), del: async (k) => void map.delete(k), wait: 5 });
  await again.ready();
  assert.deepEqual(again.list().map((r) => r.id), ['c2', 'c1']);
  assert.equal((await again.load('c1')).title, 'Explain · a.js');
  assert.equal(await again.load('nope'), null);

  // Saved and renamed keep their place in the list.
  await again.setSaved('c1', true);
  await again.rename('c1', '  The adder  ');
  assert.deepEqual(again.list().map((r) => [r.id, r.saved, r.title, r.named]), [['c2', false, 'Add a README', false], ['c1', true, 'The adder', true]]);
  assert.equal(await again.rename('c1', '   '), null, 'no empty names');

  // Deleted: gone from the list and the storage; saving it again (Undo) brings it back.
  let told = 0;
  const off = again.subscribe(() => told++);
  again.setCurrent('ask:d:/a.js', 'c1');
  const gone = await again.remove('c1');
  assert.equal(gone.title, 'The adder');
  assert.equal(map.has('chat:c1'), false);
  assert.deepEqual(again.list().map((r) => r.id), ['c2']);
  assert.equal(again.current('ask:d:/a.js'), undefined, 'not current any more');
  await again.restore(gone);
  assert.deepEqual(again.list().map((r) => r.id), ['c2', 'c1'], 'back in its place');
  assert.equal(again.row('c1').updatedAt, gone.updatedAt);
  off();
  assert.ok(told >= 2);
});

test('the store: what each panel showed last (null after New chat), the oldest forgotten; pruning deletes records; delete all', async () => {
  const { map, store } = memoryStore({ max: 3 });
  await store.ready();
  assert.equal(store.current('ask:d:/a.js'), undefined);
  store.setCurrent('ask:d:/a.js', 'c1');
  store.setCurrent('ask:d:/b.js', null);
  assert.equal(store.current('ask:d:/a.js'), 'c1');
  assert.equal(store.current('ask:d:/b.js'), null);
  await store.flush();
  assert.deepEqual(map.get('chats:current'), { 'ask:d:/a.js': 'c1', 'ask:d:/b.js': null });
  for (let i = 0; i < 302; i++) store.setCurrent(`ask:d:/f${i}.js`, `x${i}`);
  await store.flush();
  const scopes = Object.keys(map.get('chats:current'));
  assert.equal(scopes.length, 300);
  assert.ok(!scopes.includes('ask:d:/a.js') && scopes.includes('ask:d:/f301.js'), 'the oldest forgotten');

  await store.save({ id: 'keep', kind: 'ask', title: 'k', saved: true, state: {} });
  for (const id of ['o1', 'o2', 'o3', 'o4']) await store.save({ id, kind: 'ask', title: id, state: {} });
  await store.flush();
  assert.deepEqual(store.list().map((r) => r.id), ['o4', 'o3', 'keep']);
  assert.ok(!map.has('chat:o1') && !map.has('chat:o2'), 'the records of the chats pruned are deleted');
  assert.equal(await store.removeAll({ keepSaved: true }), 2);
  assert.deepEqual(store.list().map((r) => r.id), ['keep']);
  assert.equal(await store.removeAll(), 1);
  assert.deepEqual(map.get('chats'), []);
  assert.ok(![...map.keys()].some((k) => k.startsWith('chat:')));
});

test('the store: unreadable storage starts empty; a bad index entry is left out', async () => {
  const broken = createChatStore({ get: async () => { throw new Error('no db'); }, set: async () => {}, del: async () => {} });
  await broken.ready();
  assert.deepEqual(broken.list(), []);
  const odd = createChatStore({ get: async (k) => (k === 'chats' ? [null, { id: 3 }, { id: 'ok', title: 'fine' }] : 'not an object'), set: async () => {}, del: async () => {} });
  await odd.ready();
  assert.deepEqual(odd.list().map((r) => r.id), ['ok']);
  assert.equal(odd.current('anything'), undefined);
});

test('the store: a chat is kept at once once ready, and a flush starts every write together (the page may be going away)', async () => {
  const started = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const store = createChatStore({
    get: async () => undefined,
    set: (k) => (started.push(k), gate),
    del: async () => {},
    wait: 10_000,
  });
  await store.ready();
  store.save({ id: 'a', kind: 'ask', title: 'a', state: {} });
  store.save({ id: 'b', kind: 'files', title: 'b', state: {} });
  assert.deepEqual(store.list().map((r) => r.id), ['b', 'a'], 'in the list at once, no await');
  store.setCurrent('ask:', 'a');
  const done = store.flush();
  assert.deepEqual(started.sort(), ['chat:a', 'chat:b', 'chats', 'chats:current'], 'all four writes started before any finished');
  release();
  await done;
});
