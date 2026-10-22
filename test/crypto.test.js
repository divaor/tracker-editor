import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVault, ENCRYPTED_MARK, isSealed, parseVault, seal, serializeVault, textHash, unlockVault, unseal } from '../app/js/crypto.js';

// Few PBKDF2 rounds: the tests check the format, not the cost.
const FAST = { iterations: 1000 };

test('a vault opens with its passphrase and refuses others', async () => {
  const { vault, key } = await createVault('correct horse battery', FAST);
  assert.equal(vault.kdf, 'PBKDF2-SHA256');
  assert.ok(!JSON.stringify(vault).includes('correct horse'));
  const again = parseVault(serializeVault(vault));
  assert.deepEqual(again, vault);
  const key2 = await unlockVault(again, 'correct horse battery');
  // Either key opens what the other sealed.
  assert.equal(await unseal(key2, await seal(key, 'hola ✓')), 'hola ✓');
  await assert.rejects(unlockVault(vault, 'wrong horse battery'), /Wrong passphrase/);
});

test('sealed text has the mark, a fresh IV each time, and detects changes', async () => {
  const { key } = await createVault('pass phrase', FAST);
  const text = '# Secret\n\nlínea dos\n'.repeat(3000);
  const a = await seal(key, text);
  const b = await seal(key, text);
  assert.ok(a.startsWith(`${ENCRYPTED_MARK}\n`) && isSealed(a));
  assert.notEqual(a, b);
  assert.equal(await unseal(key, a), text);
  const body = a.split('\n')[1];
  const tampered = `${ENCRYPTED_MARK}\n${body.slice(0, 40)}${body[40] === 'A' ? 'B' : 'A'}${body.slice(41)}\n`;
  await assert.rejects(unseal(key, tampered), /Could not decrypt/);
  await assert.rejects(unseal(key, 'plain text'), /not encrypted/);
  assert.equal(isSealed('plain'), false);
});

test('parseVault rejects what is not a vault', () => {
  assert.equal(parseVault('not json'), null);
  assert.equal(parseVault('{"version": 1}'), null);
  assert.equal(parseVault(''), null);
});

test('textHash is SHA-256 hex', async () => {
  assert.equal(await textHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
