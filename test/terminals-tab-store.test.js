// A Terminals tab's record in the store (a comparison tab of mode 'terminals'): kept when the app
// goes away with a change still waiting for its save (flush wrote no comparisons before 0.54).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The store saves through kv.js, which falls back to localStorage: a map stands in for it.
const memory = new Map();
globalThis.localStorage ??= { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };
const { flush, parseKey, store } = await import('../app/js/store.js');
const { compareKind, compareTitle, canSave } = await import('../app/js/compares.js');

test('a Terminals tab: opened, changed, flushed at once; its kind and tooltip', async () => {
  await store.load();
  const key = store.openCompare({ mode: 'terminals', name: 'Servers', terminals: [], layout: null, runAgain: false });
  const { id } = parseKey(key);
  await flush();
  store.updateCompare(id, { terminals: [{ id: 'ta1', connId: 'local', cwd: '/tmp', shell: 'bash', name: '181', running: 'ssh 181' }], runAgain: true }, { silent: true });
  // Going away now: the change waiting for its debounce is written by flush.
  await flush();
  const kept = JSON.parse(localStorage.getItem('editor.kv.compares'));
  const record = kept.find((c) => c.id === id);
  assert.equal(record.mode, 'terminals');
  assert.equal(record.runAgain, true);
  assert.equal(record.terminals[0].running, 'ssh 181');
  assert.equal(compareKind(record), 'Terminals');
  assert.match(compareTitle(record), /^Terminals: Servers\n181 · This computer · \/tmp/);
  assert.equal(canSave(record), false, 'not a comparison to save: a session is saved by name');
});
