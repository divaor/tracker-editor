// The keys in effect on this device (keys.js): the Android app is the app too, so the commands
// it has (the terminal, Folders…) keep their keys there; a browser leaves them out.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage ??= { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

test('the Android app keeps the app’s keys (Ctrl+` for the terminal); a browser does not', async () => {
  const { keyContext, currentKeys } = await import('../app/js/keys.js');
  const terminalKeys = () => currentKeys({ keyBindings: { [`probe-${Math.random()}`]: [] } }).keys.get('terminal') ?? [];
  globalThis.window = { desktop: { platform: 'android' } };
  assert.equal(keyContext().desktop, true);
  assert.deepEqual(terminalKeys(), ['Mod+`']);
  globalThis.window = { desktop: { platform: 'linux' } };
  assert.equal(keyContext().desktop, true);
  globalThis.window = {};
  assert.equal(keyContext().desktop, false);
  assert.deepEqual(terminalKeys(), []);
  delete globalThis.window;
});
