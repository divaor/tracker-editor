// Files locked with a password of their own (not the vault of crypto.js / vault.js, one passphrase
// for the encrypted synced files). A locked file is text, so it syncs, copies and diffs like any
// file:
//
//   TINTA-LOCKED v1
//   {"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":"…","cipher":"AES-256-GCM","iv":"…","check":"…","name":"notes.md","language":"","relock":false}
//   <the ciphertext in base64, 76 characters a line>
//
// The key comes from the password (NFC) by PBKDF2-SHA256 with the header's salt; the text is
// AES-256-GCM with a fresh IV on every save, and the mark and the header line are its additional
// data, so neither can be changed without the file failing to open. `check` (a known text sealed
// with the same key) tells a wrong password from a damaged file. On disk a locked file is named
// "<name>.locked" ("notes.md.locked"), so the name inside gives its language. Pure (WebCrypto only):
// the Node tests import it, and it works in Electron, browsers and the Android WebView.

import { fromBase64, toBase64 } from './crypto.js';

export const LOCKED_MARK = 'TINTA-LOCKED v1';
export const LOCKED_EXT = '.locked';
export const ITERATIONS = 600000;
// A header asking for fewer would make a password quick to guess; more than this would hang the page.
export const MIN_ITERATIONS = 100000;
export const MAX_ITERATIONS = 10000000;
export const MIN_PASSWORD = 8;
const CHECK_TEXT = 'locked file check';
const LINE = 76;

const subtle = () => globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Why a locked file did not open: `code` is 'wrong-password', 'other-password', 'damaged' or 'not-locked'. */
export class LockedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LockedError';
    this.code = code;
  }
}

const MESSAGES = {
  'wrong-password': 'Wrong password.',
  'other-password': 'This file is locked with another password now.',
  damaged: 'This locked file was changed or is damaged: it cannot be opened.',
  'not-locked': 'This file is not locked.',
};
const fail = (code) => new LockedError(code, MESSAGES[code]);

/** True for a locked file's text (it starts with the mark line). */
export const isLockedText = (text) => typeof text === 'string' && text.startsWith(LOCKED_MARK) && /^\r?\n/.test(text.slice(LOCKED_MARK.length));

// ---- Names ----

/** True for a name (or path) that ends in ".locked". */
export const isLockedName = (name) => typeof name === 'string' && name.length > LOCKED_EXT.length && name.toLowerCase().endsWith(LOCKED_EXT);
/** "notes.md.locked" → "notes.md"; other names stay as they are. */
export const innerName = (name) => (isLockedName(name) ? name.slice(0, -LOCKED_EXT.length) : name);
/** "notes.md" → "notes.md.locked" (a name that already ends so stays). */
export const lockedName = (name) => (isLockedName(name) ? name : `${name}${LOCKED_EXT}`);

// ---- The format ----

const b64ok = (s, bytes) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  try {
    return fromBase64(s).length === bytes;
  } catch {
    return false;
  }
};

/** The header from a locked file's header line, checked; null when it is not one this version opens. */
function readHeader(line) {
  let h;
  try {
    h = JSON.parse(line);
  } catch {
    return null;
  }
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  if (h.v !== 1 || h.kdf !== 'PBKDF2-SHA256' || h.cipher !== 'AES-256-GCM') return null;
  if (!Number.isInteger(h.iter) || h.iter < MIN_ITERATIONS || h.iter > MAX_ITERATIONS) return null;
  if (!b64ok(h.salt, 16) || !b64ok(h.iv, 12) || !b64ok(h.check, 12 + CHECK_TEXT.length + 16)) return null;
  if (h.name != null && (typeof h.name !== 'string' || h.name.length > 255)) return null;
  if (h.language != null && (typeof h.language !== 'string' || h.language.length > 60)) return null;
  if (h.relock != null && typeof h.relock !== 'boolean') return null;
  return { v: 1, kdf: h.kdf, iter: h.iter, salt: h.salt, cipher: h.cipher, iv: h.iv, check: h.check, name: h.name ?? '', language: h.language ?? '', relock: Boolean(h.relock) };
}

/**
 * A locked file's parts: { header, headerLine, data } (`data`: the ciphertext's bytes), or null
 * when the text is not a locked file this version can open (another version, a broken header).
 */
export function parseLocked(text) {
  if (!isLockedText(text)) return null;
  const lines = text.split(/\r?\n/);
  const header = readHeader(lines[1] ?? '');
  if (!header) return null;
  const body = lines.slice(2).join('').replace(/\s+/g, '');
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return null;
  let data;
  try {
    data = fromBase64(body);
  } catch {
    return null;
  }
  if (data.length < 16) return null;
  return { header, headerLine: lines[1], data };
}

/** The header of a locked text (its options: name, language, relock), or null. */
export const lockedHeader = (text) => parseLocked(text)?.header ?? null;

const headerLine = (h) => JSON.stringify({ v: 1, kdf: h.kdf, iter: h.iter, salt: h.salt, cipher: h.cipher, iv: h.iv, check: h.check, name: h.name ?? '', language: h.language ?? '', relock: Boolean(h.relock) });
// The mark and the header are the ciphertext's additional data: changing either breaks the file.
const additional = (line) => utf8.encode(`${LOCKED_MARK}\n${line}`);
const wrap = (b64) => (b64.match(new RegExp(`.{1,${LINE}}`, 'g')) ?? []).join('\n');

// ---- Keys ----

async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', utf8.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  // Not extractable: the page can use it while the file is open, never read it out.
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encrypt(key, bytes, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, ...(aad ? { additionalData: aad } : {}) }, key, bytes));
  return { iv, data };
}

async function decrypt(key, iv, data, aad) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, ...(aad ? { additionalData: aad } : {}) }, key, data));
}

// Whether `key` is the password's: its check opens (else it is another password).
async function keyFits(key, check) {
  const bytes = fromBase64(check);
  try {
    return fromUtf8.decode(await decrypt(key, bytes.subarray(0, 12), bytes.subarray(12))) === CHECK_TEXT;
  } catch {
    return false;
  }
}

/**
 * A new lock for `password`: { key, header } (a fresh salt; `header` without an IV yet). The
 * options go in the header: `name` and `language` (what the text is, for its highlighting) and
 * `relock` (ask for the password again each time its tab is come back to).
 */
export async function createLock(password, { iterations = ITERATIONS, name = '', language = '', relock = false } = {}) {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new RangeError(`iterations: ${MIN_ITERATIONS} to ${MAX_ITERATIONS}`);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt, iterations);
  const check = await encrypt(key, utf8.encode(CHECK_TEXT));
  const header = { v: 1, kdf: 'PBKDF2-SHA256', iter: iterations, salt: toBase64(salt), cipher: 'AES-256-GCM', iv: '', check: toBase64(concat(check.iv, check.data)), name, language, relock: Boolean(relock) };
  return { key, header };
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * The locked text of `plain` with a key the page holds (`header`: the one it opened with or
 * createLock's; `patch` changes its options: name, language, relock). A fresh IV every time.
 */
export async function sealLocked(key, header, plain, patch = {}) {
  const next = { ...header, ...pick(patch), iv: '' };
  // The IV is in the header, which is the additional data: pick it first.
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  next.iv = toBase64(iv);
  const line = headerLine(next);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: additional(line) }, key, utf8.encode(String(plain))));
  return { text: `${LOCKED_MARK}\n${line}\n${wrap(toBase64(data))}\n`, header: readHeader(line) };
}

const pick = (patch) => Object.fromEntries(Object.entries(patch ?? {}).filter(([k, v]) => ['name', 'language', 'relock'].includes(k) && v !== undefined));

/** `plain` locked with a new password: { text, key, header }. */
export async function lockText(plain, password, options = {}) {
  const lock = await createLock(password, options);
  const sealed = await sealLocked(lock.key, lock.header, plain);
  return { text: sealed.text, key: lock.key, header: sealed.header };
}

// Opens the parts with a key; throws 'damaged' when the text was changed.
async function openParts(key, parts) {
  try {
    const plain = await decrypt(key, fromBase64(parts.header.iv), parts.data, additional(parts.headerLine));
    return fromUtf8.decode(plain);
  } catch {
    throw fail('damaged');
  }
}

/**
 * Opens a locked text with its password: { plain, key, header }. Throws a LockedError:
 * 'wrong-password', 'damaged' (changed or cut short), 'not-locked'.
 */
export async function unlockText(text, password) {
  const parts = parseLocked(text);
  if (!parts) throw fail(isLockedText(text) ? 'damaged' : 'not-locked');
  const key = await deriveKey(password, fromBase64(parts.header.salt), parts.header.iter);
  if (!(await keyFits(key, parts.header.check))) throw fail('wrong-password');
  return { plain: await openParts(key, parts), key, header: parts.header };
}

/**
 * Opens a locked text with a key the page already holds (the file came back changed: synced,
 * reloaded): { plain, header }. 'other-password' when it was locked again with another salt.
 */
export async function openWithKey(key, header, text) {
  const parts = parseLocked(text);
  if (!parts) throw fail(isLockedText(text) ? 'damaged' : 'not-locked');
  if (parts.header.salt !== header.salt || parts.header.iter !== header.iter || parts.header.check !== header.check) throw fail('other-password');
  return { plain: await openParts(key, parts), header: parts.header };
}

// ---- Passwords ----

const COMMON = new Set(['password', 'passw0rd', 'password1', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123', 'iloveyou', 'letmein1', 'admin123', 'welcome1', 'abc12345', 'contraseña', 'senha123']);

/**
 * How hard a password is to guess, roughly: { score 0–4, label, hint }. Length counts most; a
 * few words beat a short mix of symbols. Not a promise: it cannot know what others know of you.
 */
export function passwordStrength(password) {
  const p = String(password ?? '');
  if (!p) return { score: 0, label: '', hint: '' };
  if (p.length < MIN_PASSWORD) return { score: 0, label: 'Too short', hint: `Use at least ${MIN_PASSWORD} characters: a few words you will remember work well.` };
  const lower = p.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(p) || /^(?:0123456789|123456789|abcdefgh|qwertyuiop|asdfghjkl)/.test(lower)) return { score: 0, label: 'Too easy to guess', hint: 'This one is among the first anyone tries.' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  const words = p.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3).length;
  let score = p.length >= 20 ? 4 : p.length >= 14 ? 3 : p.length >= 10 ? 2 : 1;
  if (classes >= 3 && score < 4) score++;
  if (words >= 4 && score < 4) score++;
  if (new Set(p).size <= 3 && score > 1) score = 1;
  const label = ['Too easy to guess', 'Weak', 'Fair', 'Good', 'Strong'][score];
  const hint = score >= 3 ? '' : 'Longer is better: four or five words you will remember.';
  return { score, label, hint };
}

// ---- Locking again ----

/**
 * The open locked tabs to lock now. `open`: [{ key, relock, usedAt }] (unlocked here; `usedAt`:
 * when it was last used, in ms); `left`: the tab just left for another one (a tab whose relock
 * option is on asks again when come back to: it locks as it is left); `hidden`: the app was
 * hidden (minimized, another app) with `whenHidden` on; `idleMinutes`: lock after that long
 * without use (0: never).
 */
export function relockDue(open, { now = Date.now(), left = null, hidden = false, whenHidden = true, idleMinutes = 0 } = {}) {
  return open
    .filter((t) => (hidden && whenHidden) || (left && t.key === left && t.relock) || (idleMinutes > 0 && now - (t.usedAt ?? 0) >= idleMinutes * 60000))
    .map((t) => t.key);
}

/** The idle time setting as minutes: a number of minutes ≥ 1, 0 for never; anything else the default (10). */
export const idleMinutesOf = (setting) => (setting === 0 ? 0 : Number.isFinite(setting) && setting >= 1 ? Math.min(Math.round(setting), 24 * 60) : 10);
