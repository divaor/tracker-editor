// End-to-end encrypted files: the text of a file marked `encrypted` is stored in
// the data repo as AES-GCM ciphertext, under a key derived from a passphrase
// (PBKDF2-SHA256). The vault (editor/vault.json) holds the salt and a check
// value, never the key. Pure (WebCrypto only), so the Node tests can import it.

export const VAULT_PATH = 'editor/vault.json';
// First line of every encrypted text; the Claude connector looks for it too.
export const ENCRYPTED_MARK = 'TRACKER-EDITOR-ENCRYPTED v1';
const CHECK_TEXT = 'Tracker Editor vault check';
const ITERATIONS = 600000;

const subtle = () => globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** True for text stored encrypted (what the data repo holds for an encrypted file). */
export const isSealed = (text) => typeof text === 'string' && text.startsWith(ENCRYPTED_MARK);

async function deriveKey(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', utf8.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  // Not extractable: the key can be kept in IndexedDB, but never read back out.
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypts a text: the mark, then base64 of a fresh 12-byte IV and the ciphertext. */
export async function seal(key, text) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, utf8.encode(text)));
  const out = new Uint8Array(iv.length + data.length);
  out.set(iv);
  out.set(data, iv.length);
  return `${ENCRYPTED_MARK}\n${toBase64(out)}\n`;
}

/** Decrypts what seal() made. Throws when the key is wrong or the text was changed. */
export async function unseal(key, sealed) {
  if (!isSealed(sealed)) throw new Error('This text is not encrypted.');
  const bytes = fromBase64(sealed.slice(ENCRYPTED_MARK.length).trim());
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
    return fromUtf8.decode(plain);
  } catch {
    throw new Error('Could not decrypt: wrong passphrase, or the text was changed.');
  }
}

/** A new vault for `passphrase`: { vault, key }. `vault` goes to the data repo. */
export async function createVault(passphrase, { iterations = ITERATIONS, now = new Date().toISOString() } = {}) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, iterations);
  const vault = { app: 'tracker-editor', version: 1, kdf: 'PBKDF2-SHA256', iterations, salt: toBase64(salt), check: await seal(key, CHECK_TEXT), createdAt: now };
  return { vault, key };
}

/** The vault's key for `passphrase`. Throws "Wrong passphrase" when it does not open the vault. */
export async function unlockVault(vault, passphrase) {
  const key = await deriveKey(passphrase, fromBase64(vault.salt), vault.iterations);
  let check;
  try {
    check = await unseal(key, vault.check);
  } catch {
    check = null;
  }
  if (check !== CHECK_TEXT) throw new Error('Wrong passphrase.');
  return key;
}

/** vault.json's text parsed, or null when it is missing or not a vault. */
export function parseVault(text) {
  try {
    const v = JSON.parse(text);
    return v && v.version === 1 && typeof v.salt === 'string' && Number.isInteger(v.iterations) && isSealed(v.check) ? v : null;
  } catch {
    return null;
  }
}

export const serializeVault = (vault) => `${JSON.stringify(vault, null, 2)}\n`;

/** SHA-256 of a text, as hex: remembers which plaintext a ciphertext holds without keeping the text. */
export async function textHash(text) {
  const digest = new Uint8Array(await subtle().digest('SHA-256', utf8.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
