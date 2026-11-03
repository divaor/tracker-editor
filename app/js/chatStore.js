// The chats with the model kept on this device (chats.js says what one is): the list of them in
// kv `chats` (rows, newest first), each chat in `chat:<id>`, written a moment after it changes
// (flush() writes at once: main.js calls it as the page goes away). `current` remembers the chat
// each panel showed last, per tab or target (kv `chats:current`), so a panel opened again takes it
// up; null there means New chat was asked for. Nothing here is ever synced.
import { chatRow, MAX_CHATS, pruneIndex, shrinkChat, withRow } from './chats.js';
import { kvDelete, kvGet, kvSet } from './kv.js';

const INDEX = 'chats';
const CURRENT = 'chats:current';
/** How many tabs and targets remember their chat (the ones used longest ago go). */
const MAX_CURRENT = 300;

/** A plain copy (no functions: Undo's, kept only while a panel is open), as IndexedDB keeps it. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** `get`/`set`/`del`: the storage (kv.js's in the app, a Map in the tests). */
export function createChatStore({ get, set, del, wait = 300, max = MAX_CHATS, now = () => new Date().toISOString() }) {
  let index = null;
  let current = null; // { [scope]: id | null }
  let loading = null;
  const records = new Map(); // id → chat: those read or kept while the app runs
  const dirty = new Set(); // chats to write
  let indexDirty = false;
  let currentDirty = false;
  let timer = null;
  const listeners = new Set();

  const ready = () =>
    (loading ??= Promise.all([get(INDEX), get(CURRENT)])
      .then(([rows, cur]) => {
        index = Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string') : [];
        current = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
      })
      .catch(() => {
        index = [];
        current = {};
      }));
  const emit = () => listeners.forEach((fn) => fn());
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => flush().catch(() => {}), wait);
  };

  // Every write starts at once (not one after another): as the page goes away, only what has
  // started gets written.
  async function flush() {
    clearTimeout(timer);
    timer = null;
    const writes = [...dirty].map((id) => records.get(id) && set(`chat:${id}`, records.get(id)));
    dirty.clear();
    if (indexDirty) writes.push(set(INDEX, index));
    if (currentDirty) writes.push(set(CURRENT, current));
    indexDirty = currentDirty = false;
    await Promise.all(writes);
  }

  /** Puts `chat` in memory, the list and the queue to write; `touch`: it changed (first in the list). */
  function keep(chat, { touch = true } = {}) {
    const at = now();
    const kept = shrinkChat(plain({ ...chat, createdAt: chat.createdAt ?? at, updatedAt: touch || !chat.updatedAt ? at : chat.updatedAt }));
    records.set(kept.id, kept);
    dirty.add(kept.id);
    const pruned = pruneIndex(withRow(index, chatRow(kept)), max);
    index = pruned.index;
    for (const id of pruned.dropped) {
      records.delete(id);
      dirty.delete(id);
      Promise.resolve(del(`chat:${id}`)).catch(() => {});
    }
    indexDirty = true;
    schedule();
    emit();
    return kept;
  }

  const store = {
    ready,
    /** The rows, newest first ([] until ready()). */
    list: () => index ?? [],
    row: (id) => index?.find((r) => r.id === id) ?? null,
    /** A whole chat, or null. */
    async load(id) {
      await ready();
      if (records.has(id)) return records.get(id);
      if (!index.some((r) => r.id === id)) return null;
      const chat = await get(`chat:${id}`).catch(() => null);
      if (chat?.id !== id) return null;
      records.set(id, chat);
      return chat;
    },
    /**
     * Keeps a chat made or changed (first in the list); resolves to it as kept. Kept at once once the
     * store is ready (main.js waits for it), so a panel closing as the page goes away loses nothing.
     */
    save(chat) {
      return index ? Promise.resolve(keep(chat)) : ready().then(() => keep(chat));
    },
    /** Keeps a chat as it was (Undo of a delete): its place in the list by when it last changed. */
    async restore(chat) {
      await ready();
      return keep(chat, { touch: false });
    },
    /** Saved (kept for good) or not; its place in the list stays. */
    async setSaved(id, saved) {
      const chat = await store.load(id);
      return chat ? keep({ ...chat, saved: Boolean(saved) }, { touch: false }) : null;
    },
    async rename(id, title) {
      const chat = await store.load(id);
      const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return chat && name ? keep({ ...chat, title: name, named: true }, { touch: false }) : null;
    },
    /** Deletes a chat; returns it (Undo keeps it again). */
    async remove(id) {
      const chat = await store.load(id);
      index = index.filter((r) => r.id !== id);
      records.delete(id);
      dirty.delete(id);
      for (const [scope, cur] of Object.entries(current)) if (cur === id) delete current[scope];
      indexDirty = currentDirty = true;
      await Promise.resolve(del(`chat:${id}`)).catch(() => {});
      await flush();
      emit();
      return chat;
    },
    /** Deletes every chat (the saved ones too, unless `keepSaved`); returns how many went. */
    async removeAll({ keepSaved = false } = {}) {
      await ready();
      const going = index.filter((r) => !(keepSaved && r.saved)).map((r) => r.id);
      for (const id of going) {
        records.delete(id);
        dirty.delete(id);
        await Promise.resolve(del(`chat:${id}`)).catch(() => {});
      }
      const gone = new Set(going);
      index = index.filter((r) => !gone.has(r.id));
      current = Object.fromEntries(Object.entries(current).filter(([, id]) => !gone.has(id)));
      indexDirty = currentDirty = true;
      await flush();
      emit();
      return going.length;
    },
    /** The chat a panel showed last for `scope` (undefined: none known; null: New chat asked for). */
    current: (scope) => (current && Object.hasOwn(current, scope) ? current[scope] : undefined),
    setCurrent(scope, id) {
      if (!current || !scope) return;
      if (current[scope] === id) return;
      delete current[scope];
      current[scope] = id ?? null;
      const scopes = Object.keys(current);
      for (const old of scopes.slice(0, Math.max(0, scopes.length - MAX_CURRENT))) delete current[old];
      currentDirty = true;
      schedule();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    flush,
  };
  return store;
}

/** The app's chats (kv: IndexedDB), written a moment after each change (chats change at an answer's end, not per key). */
export const chats = createChatStore({ get: kvGet, set: kvSet, del: kvDelete, wait: 60 });
