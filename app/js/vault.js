// This device's side of encryption (crypto.js): the vault from the data repo,
// the key once unlocked (kept in IndexedDB, not extractable), and the encode /
// decode hooks sync uses. An unchanged text keeps its ciphertext, so its blob
// sha stays the same and it is not uploaded again.
import { createVault, isSealed, parseVault, seal, serializeVault, textHash, unlockVault, unseal, VAULT_PATH } from './crypto.js';
import { kvDelete, kvGet, kvSet } from './kv.js';

let vault = null; // vault.json, parsed
let key = null; // CryptoKey while unlocked
let cache = new Map(); // file id → { hash, sealed }: the ciphertext of a known text
const listeners = new Set();

const emit = () => {
  for (const fn of listeners) fn(vaultState());
};
const saveCache = () => kvSet('encCache', [...cache]);

export async function loadVault() {
  vault = (await kvGet('vault')) ?? null;
  key = (await kvGet('vaultKey')) ?? null;
  cache = new Map((await kvGet('encCache')) ?? []);
  emit();
}

/** { exists, unlocked }: whether a passphrase is set (in the data repo) and this device knows it. */
export const vaultState = () => ({ exists: Boolean(vault), unlocked: Boolean(key && vault) });

export function onVault(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reads vault.json from the data repo (null when there is none yet). */
export async function fetchVault(client, branch) {
  const file = await client.getFile(VAULT_PATH, branch || undefined);
  const next = file ? parseVault(file.text) : null;
  if (file && !next) throw new Error(`${VAULT_PATH} in your data repo is not readable.`);
  if (JSON.stringify(next) !== JSON.stringify(vault)) {
    vault = next;
    await kvSet('vault', vault);
    // Another passphrase now: the key kept here no longer fits.
    if (!vault && key) await forgetKey();
    emit();
  }
  return vault;
}

/** Sets the passphrase: writes a new vault to the data repo and unlocks this device. */
export async function setUpVault(client, branch, passphrase, device) {
  if (await fetchVault(client, branch)) throw new Error('A passphrase is already set on another device: unlock with it instead.');
  const created = await createVault(passphrase);
  await client.putFile(VAULT_PATH, { text: serializeVault(created.vault), branch: branch || undefined, message: `Editor: set up encryption (from ${device})` });
  vault = created.vault;
  key = created.key;
  await Promise.all([kvSet('vault', vault), kvSet('vaultKey', key)]);
  emit();
}

/** Unlocks this device with the passphrase (throws "Wrong passphrase."). */
export async function unlock(passphrase) {
  if (!vault) throw new Error('No passphrase is set yet.');
  key = await unlockVault(vault, passphrase);
  await kvSet('vaultKey', key);
  emit();
}

async function forgetKey() {
  key = null;
  cache = new Map();
  await Promise.all([kvDelete('vaultKey'), kvDelete('encCache')]);
}

/** Forgets the key on this device. */
export async function lock() {
  await forgetKey();
  emit();
}

/** What to store in the repo for a file's text: its ciphertext when it is encrypted. */
export async function encodeFor(file, text) {
  if (!file?.encrypted || isSealed(text)) return text;
  if (!key) throw new Error('Unlock encryption in Settings to sync your encrypted files.');
  const hash = await textHash(text);
  const known = cache.get(file.id);
  if (known?.hash === hash) return known.sealed;
  const sealed = await seal(key, text);
  cache.set(file.id, { hash, sealed });
  saveCache();
  return sealed;
}

/** A text from the repo, decrypted when this device can; otherwise it stays sealed. */
export async function decodeFor(file, text) {
  if (!isSealed(text) || !key) return text;
  const plain = await unseal(key, text);
  if (file?.id) {
    cache.set(file.id, { hash: await textHash(plain), sealed: text });
    saveCache();
  }
  return plain;
}

/** Decrypts a sealed text (an old version, a deleted file); plain text comes back as it is. */
export async function openText(text) {
  if (!isSealed(text)) return text;
  if (!key) throw new Error('This text is encrypted: unlock with your passphrase in Settings first.');
  return unseal(key, text);
}
