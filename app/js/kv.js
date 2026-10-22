// Tiny async key-value store on IndexedDB, falling back to localStorage when
// IndexedDB is unavailable (some private browsing modes).

const DB_NAME = 'tracker-editor';
const STORE = 'kv';
const LS_PREFIX = 'editor.kv.';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        // Writes wait until they are on disk ("strict"), so a crash or power cut keeps them.
        const tx = mode === 'readwrite' ? db.transaction(STORE, mode, { durability: 'strict' }) : db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        // Commit now rather than when the browser gets to it, so a save
        // started as the page closes is not lost with it.
        if (mode === 'readwrite') tx.commit?.();
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export async function kvGet(key) {
  try {
    return await run('readonly', (s) => s.get(key));
  } catch {
    try {
      const raw = localStorage.getItem(LS_PREFIX + key);
      return raw == null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
}

export async function kvSet(key, value) {
  try {
    await run('readwrite', (s) => s.put(value, key));
  } catch {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  }
}

export async function kvDelete(key) {
  try {
    await run('readwrite', (s) => s.delete(key));
  } catch {
    localStorage.removeItem(LS_PREFIX + key);
  }
}

// Ask the browser not to evict our data under storage pressure (mobile).
export function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}
