import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENCRYPTED_MARK, isSealed } from '../app/js/crypto.js';
import {
  createLock,
  idleMinutesOf,
  innerName,
  isLockedName,
  isLockedText,
  ITERATIONS,
  LOCKED_MARK,
  LockedError,
  lockedHeader,
  lockedName,
  lockText,
  MIN_ITERATIONS,
  openWithKey,
  parseLocked,
  passwordStrength,
  relockDue,
  sealLocked,
  unlockText,
} from '../app/js/locked.js';

// The lowest count a header may ask for: the tests check the format, not the cost.
const FAST = { iterations: MIN_ITERATIONS };

const code = (c) => (err) => err instanceof LockedError && err.code === c;

test('a locked text opens with its password and keeps the text exactly', async () => {
  const plain = '# Diario\n\nlínea dos ✓\r\nwith CRLF kept\n\ttab\n';
  const { text, header } = await lockText(plain, 'correct horse battery', { ...FAST, name: 'notes.md', language: 'Markdown' });
  assert.ok(isLockedText(text));
  assert.ok(text.startsWith(`${LOCKED_MARK}\n{`));
  assert.ok(!text.includes('Diario') && !text.includes('correct horse'));
  assert.equal(header.name, 'notes.md');
  assert.equal(header.relock, false);
  const opened = await unlockText(text, 'correct horse battery');
  assert.equal(opened.plain, plain);
  assert.equal(opened.header.language, 'Markdown');
  // Lines of base64 no longer than 76 characters, after the mark and the header.
  const lines = text.trimEnd().split('\n');
  assert.ok(lines.slice(2).every((l) => l.length <= 76 && /^[A-Za-z0-9+/=]+$/.test(l)));
});

test('the default count is at least the vault’s, and a header asking for too few is refused', async () => {
  assert.ok(ITERATIONS >= 600000);
  const { text } = await lockText('x', 'a password!', FAST);
  const weak = text.replace(/"iter":\d+/, '"iter":1000');
  assert.equal(parseLocked(weak), null);
  await assert.rejects(unlockText(weak, 'a password!'), code('damaged'));
  await assert.rejects(createLock('pw', { iterations: 10 }), RangeError);
});

test('a wrong password says so; a changed header or ciphertext is damaged', async () => {
  const { text } = await lockText('secret text', 'the right one', FAST);
  await assert.rejects(unlockText(text, 'the wrong one'), code('wrong-password'));
  await assert.rejects(unlockText(text, 'the wrong one'), /Wrong password/);
  // The header is bound: turning "ask again" off by hand breaks the file.
  const flipped = text.replace('"relock":false', '"relock":true');
  assert.notEqual(flipped, text);
  await assert.rejects(unlockText(flipped, 'the right one'), code('damaged'));
  // So is the name inside.
  await assert.rejects(unlockText(text.replace('"name":""', '"name":"x.md"'), 'the right one'), code('damaged'));
  // One character of the ciphertext.
  const lines = text.split('\n');
  const c = lines[2][10];
  lines[2] = `${lines[2].slice(0, 10)}${c === 'A' ? 'B' : 'A'}${lines[2].slice(11)}`;
  await assert.rejects(unlockText(lines.join('\n'), 'the right one'), code('damaged'));
  // Cut short.
  await assert.rejects(unlockText(text.split('\n').slice(0, 2).join('\n'), 'the right one'), code('damaged'));
  // Not locked at all.
  await assert.rejects(unlockText('plain text', 'x'), code('not-locked'));
});

test('a fresh IV on every save; the same key keeps opening them', async () => {
  const lock = await createLock('pass word 1', FAST);
  const a = await sealLocked(lock.key, lock.header, 'same text');
  const b = await sealLocked(lock.key, lock.header, 'same text');
  assert.notEqual(a.text, b.text);
  assert.notEqual(a.header.iv, b.header.iv);
  assert.equal(a.header.salt, b.header.salt);
  assert.equal((await openWithKey(lock.key, a.header, b.text)).plain, 'same text');
  assert.equal((await unlockText(b.text, 'pass word 1')).plain, 'same text');
  // Options change with a save, and are bound too.
  const c = await sealLocked(lock.key, a.header, 'same text', { relock: true, name: 'x.txt' });
  assert.equal(lockedHeader(c.text).relock, true);
  assert.equal(lockedHeader(c.text).name, 'x.txt');
  assert.equal((await unlockText(c.text, 'pass word 1')).header.relock, true);
});

test('a key held for one password does not open the file locked again with another', async () => {
  const first = await lockText('one', 'first password', FAST);
  const second = await lockText('two', 'second password', FAST);
  await assert.rejects(openWithKey(first.key, first.header, second.text), code('other-password'));
  await assert.rejects(openWithKey(first.key, first.header, 'plain'), code('not-locked'));
});

test('large texts and every kind of character', async () => {
  const big = `${'línea con ü, 中文, emoji 🔒 y \u0000 nul\n'.repeat(60000)}end`;
  const { text, key, header } = await lockText(big, 'big file password', FAST);
  assert.ok(text.length > big.length);
  assert.equal((await openWithKey(key, header, text)).plain, big);
});

test('passwords are compared as NFC: the same word typed either way opens it', async () => {
  const composed = 'contraseña segura';
  const decomposed = 'contrasen\u0303a segura';
  assert.notEqual(composed, decomposed);
  const { text } = await lockText('hola', composed, FAST);
  assert.equal((await unlockText(text, decomposed)).plain, 'hola');
  const emoji = await lockText('x', '🔑 clé 密码 ключ', FAST);
  assert.equal((await unlockText(emoji.text, '🔑 clé 密码 ключ')).plain, 'x');
});

test('CRLF line endings (a locked file saved by Windows) still open', async () => {
  const { text } = await lockText('crlf\nkept', 'windows pw!', FAST);
  assert.equal((await unlockText(text.replace(/\n/g, '\r\n'), 'windows pw!')).plain, 'crlf\nkept');
});

test('locked and vault-encrypted texts are told apart', async () => {
  const { text } = await lockText('x', 'some password', FAST);
  assert.ok(!isSealed(text));
  assert.ok(!isLockedText(`${ENCRYPTED_MARK}\nabc`));
  assert.ok(!isLockedText(`${LOCKED_MARK}X\n`));
  assert.ok(!isLockedText(` ${LOCKED_MARK}\n`));
  assert.ok(isLockedText(`${LOCKED_MARK}\r\n{}`));
  assert.equal(parseLocked(`${LOCKED_MARK}\n{"v":2}\nAAAA`), null);
  assert.equal(lockedHeader('not locked'), null);
});

test('names on disk: <name>.locked', () => {
  assert.equal(lockedName('notes.md'), 'notes.md.locked');
  assert.equal(lockedName('notes.md.locked'), 'notes.md.locked');
  assert.equal(innerName('notes.md.locked'), 'notes.md');
  assert.equal(innerName('Notes.MD.LOCKED'), 'Notes.MD');
  assert.equal(innerName('notes.md'), 'notes.md');
  assert.ok(isLockedName('/home/me/a.txt.locked'));
  assert.ok(!isLockedName('.locked'));
  assert.ok(!isLockedName('a.lock'));
});

test('password strength: length counts most', () => {
  assert.equal(passwordStrength('').label, '');
  assert.equal(passwordStrength('short').score, 0);
  assert.match(passwordStrength('short').hint, /at least 8/);
  assert.equal(passwordStrength('password').score, 0);
  assert.equal(passwordStrength('aaaaaaaaaaaa').score, 0);
  assert.ok(passwordStrength('Tr0ub4dor&3').score >= 2);
  assert.equal(passwordStrength('correct horse battery staple').score, 4);
  assert.ok(passwordStrength('abcdefghij').score < passwordStrength('a much longer passphrase').score);
});

test('which open locked tabs lock now', () => {
  const now = 1_000_000_000;
  const open = [
    { key: 'f:a', relock: true, usedAt: now },
    { key: 'd:/b.md.locked', relock: false, usedAt: now - 11 * 60000 },
    { key: 'f:c', relock: false, usedAt: now - 2 * 60000 },
  ];
  // Leaving a tab that asks again when come back to.
  assert.deepEqual(relockDue(open, { now, left: 'f:a' }), ['f:a']);
  assert.deepEqual(relockDue(open, { now, left: 'f:c' }), []);
  // Idle for 10 minutes.
  assert.deepEqual(relockDue(open, { now, idleMinutes: 10 }), ['d:/b.md.locked']);
  assert.deepEqual(relockDue(open, { now, idleMinutes: 0 }), []);
  // The app hidden: all of them, unless that setting is off.
  assert.deepEqual(relockDue(open, { now, hidden: true }), ['f:a', 'd:/b.md.locked', 'f:c']);
  assert.deepEqual(relockDue(open, { now, hidden: true, whenHidden: false }), []);
  assert.deepEqual(relockDue([], { now, hidden: true }), []);
});

test('the idle setting', () => {
  assert.equal(idleMinutesOf(undefined), 10);
  assert.equal(idleMinutesOf(null), 10);
  assert.equal(idleMinutesOf(0), 0);
  assert.equal(idleMinutesOf(5), 5);
  assert.equal(idleMinutesOf(-3), 10);
  assert.equal(idleMinutesOf(99999), 1440);
});
