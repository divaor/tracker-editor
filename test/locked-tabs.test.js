// lockedTabs.js against the real store (kept in memory here: no IndexedDB in Node) and a stand-in
// editor host: the store only ever gets locked text, the editor the plain one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The store saves through kv.js, which falls back to localStorage: a map stands in for it.
const memory = new Map();
globalThis.localStorage ??= { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };

const { diskKey, fileKey, store } = await import('../app/js/store.js');
const { createLockedTabs, shownNameOf } = await import('../app/js/lockedTabs.js');
const { isLockedText, lockText, MIN_ITERATIONS, unlockText } = await import('../app/js/locked.js');
const { isLockedName, peekKind, searchesText } = await import('../app/js/folders.js');
const locked = await import('../app/js/locked.js');
const { fileTypeOf } = await import('../app/js/fileTypes.js');
const { isSecretName } = await import('../app/js/fileSteps.js');

const FAST = { iterations: MIN_ITERATIONS };
// A sync round as syncManager.js runs it: this device's text uploaded, then (`remote`) another's.
const raw = (id) => store.lockedText(id) ?? store.text(id);
const uploaded = (id) => store.applySynced({ files: [{ ...store.get(id), dirty: false }], texts: new Map() }, { texts: new Map([[id, raw(id)]]), repo: [], ops: [], ids: new Set([id]) });
const remote = (id, text) => store.applySynced({ files: [{ ...store.get(id), dirty: false }], texts: new Map([[id, text]]) }, { texts: new Map(), repo: [], ops: [], ids: new Set([id]) });
const PW = 'a good password';
const settle = () => new Promise((r) => setTimeout(r, 5));

// The editor: a text per tab key; `typed` waits to be passed on (as the editor's debounce would).
function fakeHost(locks) {
  const texts = new Map();
  const typed = new Map();
  const host = {
    texts,
    dropped: [],
    type(key, text) {
      texts.set(key, text);
      typed.set(key, text);
    },
    flushAll() {
      for (const [key, text] of typed) locks.write(key, text);
      typed.clear();
    },
    drop(key, { save = true } = {}) {
      if (save && typed.has(key)) locks.write(key, typed.get(key));
      typed.delete(key);
      texts.delete(key);
      host.dropped.push(key);
    },
    stateOf: (key) => (texts.has(key) ? { doc: { toString: () => texts.get(key) } } : null),
    replaceText(key, text) {
      if (texts.has(key)) texts.set(key, text);
    },
    appendText(key, text) {
      if (texts.has(key)) texts.set(key, texts.get(key) + text);
    },
  };
  return host;
}

function setUp() {
  const lost = [];
  let host = null;
  const locks = createLockedTabs({ host: () => host, onLost: (key, why) => lost.push([key, why]) });
  host = fakeHost(locks);
  locks.guard(host);
  return { locks, host, lost };
}

test('a locked note: the store keeps only its locked text; typing writes a new one', async () => {
  const { locks, host } = setUp();
  const made = await lockText('first words', PW, FAST);
  const id = store.create({ name: 'diary.md', text: made.text, open: false });
  const key = fileKey(id);
  assert.ok(store.isLocked(id));
  assert.equal(store.text(id), '', 'what reads texts (search, the model) gets nothing');
  assert.ok(locks.isLocked(key) && locks.isClosed(key) && !locks.isOpen(key));
  await assert.rejects(locks.unlock(key, 'wrong one'), /Wrong password/);
  assert.equal(await locks.unlock(key, PW), 'first words');
  assert.ok(locks.isOpen(key));
  host.texts.set(key, 'first words');
  host.type(key, 'first words, and more');
  await locks.settled(key);
  const stored = store.lockedText(id);
  assert.ok(isLockedText(stored) && !stored.includes('more'));
  assert.notEqual(stored, made.text, 'a fresh IV');
  assert.equal((await unlockText(stored, PW)).plain, 'first words, and more');
  assert.equal(locks.plainOf(key), 'first words, and more');
  // Locking again: what was typed is written, then the editor's text and the key go.
  host.type(key, 'last words');
  await locks.lock(key);
  assert.ok(host.dropped.includes(key));
  assert.ok(!locks.isOpen(key) && locks.isClosed(key));
  assert.equal(locks.plainOf(key), null);
  assert.equal((await unlockText(store.lockedText(id), PW)).plain, 'last words');
});

test('a locked disk tab: edits undone back to what the file holds leave it saved', async () => {
  const { locks, host } = setUp();
  const made = await lockText('on disk', PW, FAST);
  const path = '/w/notes.md.locked';
  store.openDiskFile({ path, name: 'notes.md.locked', text: made.text, eol: 'lf', bom: false, encoding: 'utf8', mtimeMs: 1, size: made.text.length });
  const key = diskKey(path);
  assert.ok(locks.isClosed(key));
  await locks.unlock(key, PW);
  host.texts.set(key, 'on disk');
  host.type(key, 'on disk!');
  await locks.settled(key);
  assert.equal(store.diskTab(path).dirty, true);
  assert.ok(isLockedText(store.diskTab(path).text));
  host.type(key, 'on disk');
  await locks.settled(key);
  assert.equal(store.diskTab(path).text, made.text, 'the text the file holds, not one sealed again');
  assert.equal(store.diskTab(path).dirty, false);
  // Saved (as diskTabs.js does): the next undo comes back to what was saved.
  host.type(key, 'saved version');
  await locks.settled(key);
  const written = store.diskTab(path).text;
  store.diskSaved(path, { text: written, mtimeMs: 2, size: written.length });
  host.type(key, 'saved version, edited');
  await locks.settled(key);
  assert.equal(store.diskTab(path).dirty, true);
  host.type(key, 'saved version');
  await locks.settled(key);
  assert.equal(store.diskTab(path).text, written);
  assert.equal(store.diskTab(path).dirty, false);
  // Renamed in Folders: the tab's key moves, and so does what is open.
  store.renameDiskTab(path, '/w/renamed.md.locked');
  locks.rename(key, diskKey('/w/renamed.md.locked'));
  assert.ok(locks.isOpen(diskKey('/w/renamed.md.locked')) && !locks.isOpen(key));
  await locks.lock(diskKey('/w/renamed.md.locked'));
});

test('a text from elsewhere: opened with the key held, else the tab locks', async () => {
  const { locks, host, lost } = setUp();
  const made = await lockText('v1', PW, FAST);
  const id = store.create({ name: 'synced.txt', text: made.text, open: false });
  const key = fileKey(id);
  await locks.unlock(key, PW);
  host.texts.set(key, 'v1');
  // Another device saved v2 with the same password (the same salt): the editor gets it.
  const { key: cryptoKey, header } = await unlockText(made.text, PW);
  const v2 = (await locked.sealLocked(cryptoKey, header, 'v2 from the phone')).text;
  uploaded(id);
  remote(id, v2);
  host.replaceText(key, store.text(id));
  await settle();
  await locks.settled(key);
  assert.equal(host.texts.get(key), 'v2 from the phone');
  assert.ok(locks.isOpen(key));
  // Then locked again elsewhere with another password: the tab locks here, its text goes.
  const other = await lockText('v3', 'another password', FAST);
  remote(id, other.text);
  host.replaceText(key, store.text(id));
  await settle();
  await locks.settled();
  assert.ok(!locks.isOpen(key));
  assert.ok(!host.texts.has(key));
  assert.deepEqual(lost, [[key, 'other']]);
  // The lock taken off elsewhere: plain text now, the tab shows it as a plain one.
  await locks.unlock(key, 'another password');
  host.texts.set(key, 'v3');
  remote(id, 'plain again');
  host.replaceText(key, store.text(id));
  await settle();
  await locks.settled();
  assert.ok(!locks.isLocked(key));
  assert.equal(lost.at(-1)[1], 'unlocked');
});

test('a plain tab whose file became locked elsewhere lets go of its plain text', async () => {
  const { locks, host } = setUp();
  const id = store.create({ name: 'was-plain.txt', text: 'plain', open: false });
  const key = fileKey(id);
  host.texts.set(key, 'plain');
  const made = await lockText('plain', PW, FAST);
  uploaded(id);
  remote(id, made.text);
  host.replaceText(key, store.text(id));
  assert.ok(!host.texts.has(key), 'its editor state is dropped (not replaced by nothing)');
  assert.ok(locks.isClosed(key));
  // An editor's leftover for it is never written over the locked text.
  host.appendText(key, 'more');
  assert.equal(store.lockedText(id), made.text);
});

test('options and passwords: written in the file, the text kept', async () => {
  const { locks, host } = setUp();
  const made = await lockText('keep me', PW, FAST);
  const id = store.create({ name: 'opts.md', text: made.text, open: false });
  const key = fileKey(id);
  await locks.unlock(key, PW);
  host.texts.set(key, 'keep me');
  await locks.rewrite(key, { relock: true });
  assert.equal(locks.headerOf(key).relock, true);
  assert.equal((await unlockText(store.lockedText(id), PW)).header.relock, true);
  await locks.rewrite(key, { password: 'the new password' });
  await assert.rejects(locks.check(key, PW), /Wrong password/);
  await locks.check(key, 'the new password');
  assert.equal((await unlockText(store.lockedText(id), 'the new password')).plain, 'keep me');
  assert.equal((await unlockText(store.lockedText(id), 'the new password')).header.relock, true);
  // Which tabs lock now.
  assert.deepEqual(locks.due({ left: key }), [key]);
  assert.deepEqual(locks.due({ hidden: true }), [key]);
  assert.deepEqual(locks.due({ hidden: true, whenHidden: false }), []);
  assert.equal(await locks.release(key), 'keep me');
  assert.ok(!locks.isOpen(key));
});

test('names, icons and what is searched: one rule for ".locked"', () => {
  for (const name of ['a.md.locked', 'b.LOCKED', 'dir/c.txt.locked', 'x.lock', '.locked', 'notes.md']) {
    assert.equal(isLockedName(name), locked.isLockedName(name.split('/').pop()), name);
  }
  assert.equal(peekKind('notes.md.locked'), 'locked');
  assert.equal(searchesText('notes.md.locked'), false);
  assert.equal(searchesText('notes.md'), true);
  assert.equal(fileTypeOf('notes.md.locked').glyph, 'lock');
  assert.equal(isSecretName('src/notes.md.locked'), true, 'the model never reads or changes one');
  assert.equal(shownNameOf('notes.md.locked', { name: 'x.txt' }), 'notes.md');
  assert.equal(shownNameOf('secret.locked', { name: 'secret.py' }), 'secret.py');
});
