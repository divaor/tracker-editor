// The page's side of files locked with a password (locked.js): which tabs are open here, their keys
// and the text between the editor (plain, in memory only) and the store (always the locked text,
// so IndexedDB, sync, the disk and everything that reads texts get ciphertext). The key derived
// from the password lives in this module's memory while its tab is open, and goes when the tab
// locks again or closes: never in IndexedDB, localStorage, the settings or the main process.
import { innerName, isLockedText, lockedHeader, lockText, openWithKey, relockDue, sealLocked, unlockText } from './locked.js';
import { parseKey, store } from './store.js';

/**
 * `host()`: the editor host (its `drop` lets go of a tab's text and undo history); `onChange()`
 * after a tab opens or locks; `onLost(key, why)` when one locked by itself (the file changed
 * elsewhere with another password, or is not locked any more).
 */
export function createLockedTabs({ host, onChange = () => {}, onLost = () => {}, now = () => Date.now() }) {
  // tab key → { tabKey, key (CryptoKey), header, base: { plain, text }, last: { plain, text }, seq, writing, usedAt }
  // (`tabKey` follows a file renamed or moved: a write on its way goes to where the tab is now).
  // `last`: what was written last; `base`: the text the store had when it was opened (or saved):
  // edits undone back to it write it again, so the file is unchanged (not "unsaved").
  const open = new Map();
  let rawReplace = null;

  /** A tab's locked text as stored (a synced file's, or a disk tab's), or null when it is not locked. */
  const storedText = (tabKey) => {
    const k = parseKey(tabKey);
    if (k?.kind === 'file') return store.lockedText(k.id);
    if (k?.kind === 'disk') {
      const text = store.diskTab(k.path)?.text;
      return isLockedText(text) ? text : null;
    }
    return null;
  };

  const storeWrite = (tabKey, text) => {
    const k = parseKey(tabKey);
    // At once: a locked text is written as soon as it is made (its debounce was the editor's).
    if (k?.kind === 'file') store.setText(k.id, text, { urgent: true });
    else if (k?.kind === 'disk') store.setDiskText(k.path, text, { urgent: true });
  };

  // The text for `plain`: a text already made for it when there is one, else sealed afresh.
  const encryptFor = async (s, plain) => {
    if (plain === s.last.plain) return s.last.text;
    if (plain === s.base.plain) return s.base.text;
    return (await sealLocked(s.key, s.header, plain)).text;
  };

  // A disk tab saved since (clean, holding what was written last): that is the base now.
  const settleBase = (tabKey, s) => {
    const k = parseKey(tabKey);
    const tab = k?.kind === 'disk' ? store.diskTab(k.path) : null;
    if (tab && !tab.dirty && tab.text === s.last.text) s.base = s.last;
  };

  // `latest`: the text the editor passed on last (written, or on its way).
  const session = (tabKey, { key, header, plain, text }) => ({ tabKey, key, header, base: { plain, text }, last: { plain, text }, latest: plain, seq: 0, writing: Promise.resolve(), usedAt: now() });

  const queue = (s, fn) => {
    s.writing = s.writing.then(fn).catch((err) => console.error('Locked file', err));
    return s.writing;
  };

  // Lets go of a tab's session and its editor state (`save`: edits waiting in the editor are written first).
  const close = async (tabKey, { save = true } = {}) => {
    const s = open.get(tabKey);
    if (!s) return;
    if (save) {
      // Edits still waiting in the editor are passed on (and written) first.
      host()?.drop(tabKey);
      await s.writing;
    }
    if (open.get(s.tabKey) === s) open.delete(s.tabKey);
    if (!save) host()?.drop(s.tabKey, { save: false });
    onChange();
  };

  const api = {
    storedText,
    /** True for a tab whose file is locked with a password (open here or not). */
    isLocked: (tabKey) => storedText(tabKey) != null || open.has(tabKey),
    /** True while a locked tab is open here (its password given). */
    isOpen: (tabKey) => open.has(tabKey),
    /** A locked tab not open here: its lock screen shows instead of the text. */
    isClosed: (tabKey) => !open.has(tabKey) && storedText(tabKey) != null,
    openKeys: () => [...open.keys()],
    /** The text of an open locked tab as the editor last passed it on (null when it is not open). */
    plainOf: (tabKey) => open.get(tabKey)?.latest ?? null,
    /** Its header (name, language, relock): the open one's, else the stored text's. */
    headerOf: (tabKey) => open.get(tabKey)?.header ?? lockedHeader(storedText(tabKey) ?? ''),

    /** Opens a locked tab with its password (throws LockedError: 'wrong-password', 'damaged'); returns its text. */
    async unlock(tabKey, password) {
      const text = storedText(tabKey);
      if (text == null) throw new Error('This file is not locked any more.');
      const { plain, key, header } = await unlockText(text, password);
      // The file may have changed while the key was being made.
      if (storedText(tabKey) !== text) return api.unlock(tabKey, password);
      open.set(tabKey, session(tabKey, { key, header, plain, text }));
      onChange();
      return plain;
    },

    /** A tab whose key the page already holds (a file just locked or made here) counts as open. */
    adopt(tabKey, { key, header, plain, text }) {
      open.set(tabKey, session(tabKey, { key, header, plain, text }));
      onChange();
    },

    /** A tab renamed or moved (its file did): its session goes with it. */
    rename(from, to) {
      const s = open.get(from);
      if (!s || from === to) return;
      open.delete(from);
      s.tabKey = to;
      open.set(to, s);
    },

    /** The editor's text of an open locked tab: sealed and written to the store (a fresh IV each time). */
    write(tabKey, plain) {
      const s = open.get(tabKey);
      if (!s) return Promise.resolve();
      s.usedAt = now();
      s.latest = plain;
      const seq = ++s.seq;
      return queue(s, async () => {
        // A newer text is on its way: it is the one written.
        if (seq !== s.seq) return;
        settleBase(s.tabKey, s);
        const text = await encryptFor(s, plain);
        s.last = { plain, text };
        storeWrite(s.tabKey, text);
      });
    },

    /** Everything typed into open locked tabs written (before a save, a sync, the app going away). */
    async settled(tabKey = null) {
      host()?.flushAll();
      await Promise.all([...open.entries()].filter(([k]) => !tabKey || k === tabKey).map(([, s]) => s.writing));
    },

    /** The tab was used (typed in, clicked, shown): its idle time starts again. */
    touch(tabKey) {
      const s = open.get(tabKey);
      if (s) s.usedAt = now();
    },

    /** Locks an open tab again: what was typed is written, then its key and text are let go of. */
    lock: (tabKey) => close(tabKey),
    async lockAll() {
      const keys = [...open.keys()];
      await Promise.all(keys.map((k) => close(k)));
      return keys.length;
    },
    /** A tab closed: its session goes (what was typed was written as the editor let go of it). */
    forget(tabKey) {
      if (open.delete(tabKey)) onChange();
    },

    /** The open tabs to lock now (relockDue's options: left, hidden, whenHidden, idleMinutes). */
    due(options) {
      return relockDue([...open.entries()].map(([key, s]) => ({ key, relock: s.header.relock, usedAt: s.usedAt })), { now: now(), ...options });
    },

    /**
     * Writes the open tab again with other options (`relock`, `name`, `language`) or, with
     * `password`, under a new password (a new salt and key). Returns the text written.
     */
    async rewrite(tabKey, { password = null, ...patch } = {}) {
      const s = open.get(tabKey);
      if (!s) throw new Error('Open the file with its password first.');
      await api.settled(tabKey);
      return queue(s, async () => {
        const plain = s.last.plain;
        if (password != null) {
          const made = await lockText(plain, password, { name: patch.name ?? s.header.name, language: patch.language ?? s.header.language, relock: patch.relock ?? s.header.relock });
          s.key = made.key;
          s.header = made.header;
          s.base = s.last = { plain, text: made.text };
        } else {
          const made = await sealLocked(s.key, s.header, plain, patch);
          s.header = made.header;
          s.base = s.last = { plain, text: made.text };
        }
        storeWrite(s.tabKey, s.last.text);
        onChange();
      }).then(() => s.last.text);
    },

    /** Checks a password against a locked tab's file (throws LockedError 'wrong-password'). */
    async check(tabKey, password) {
      await unlockText(storedText(tabKey) ?? '', password);
    },

    /** The text of an open tab, its lock taken off: the session goes, the editor keeps the text (the caller writes it plain). */
    async release(tabKey) {
      const s = open.get(tabKey);
      if (!s) throw new Error('Open the file with its password first.');
      await api.settled(tabKey);
      await s.writing;
      open.delete(tabKey);
      onChange();
      return s.last.plain;
    },

    /**
     * Keeps the editor's text and the store's apart: the host's `replaceText` and `appendText`
     * (a text from elsewhere: synced, reloaded, followed) go through here for locked tabs.
     */
    guard(h) {
      rawReplace = h.replaceText.bind(h);
      const append = h.appendText.bind(h);
      h.replaceText = (tabKey, text) => {
        if (open.has(tabKey)) return api.incoming(tabKey);
        // Locked elsewhere (synced, or the file replaced on disk): the plain text here goes.
        if (storedText(tabKey) != null || isLockedText(text)) return void (h.stateOf(tabKey) && h.drop(tabKey, { save: false }));
        return rawReplace(tabKey, text);
      };
      h.appendText = (tabKey, text, options) => (api.isLocked(tabKey) ? undefined : append(tabKey, text, options));
      return h;
    },

    /** The stored text of an open tab changed from elsewhere: opened with the key held, or the tab locks. */
    incoming(tabKey) {
      const s = open.get(tabKey);
      if (!s) return Promise.resolve();
      return queue(s, async () => {
        const at = s.tabKey;
        if (open.get(at) !== s) return;
        const text = storedText(at);
        if (text === s.last.text || text === s.base.text) return;
        if (text == null) {
          // Not locked any more (its lock was taken off on another device): the tab shows its text as it is now.
          open.delete(at);
          host()?.drop(at, { save: false });
          onLost(at, 'unlocked');
          return onChange();
        }
        try {
          const { plain, header } = await openWithKey(s.key, s.header, text);
          s.header = header;
          s.base = s.last = { plain, text };
          s.latest = plain;
          rawReplace?.(at, plain);
        } catch {
          open.delete(at);
          host()?.drop(at, { save: false });
          onLost(at, 'other');
          onChange();
        }
      });
    },
  };
  return api;
}

/** The name a locked tab's text has inside (for its language): "notes.md.locked" → "notes.md", else the header's. */
export function shownNameOf(name, header) {
  const inner = innerName(name ?? '');
  return /\.[^.]+$/.test(inner) || !header?.name ? inner : header.name;
}
