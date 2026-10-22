import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { formatDuration, prepareTyping, typingDelay, typingSeconds } from '../app/js/typing.js';

const require = createRequire(import.meta.url);
const { startTyping, windowsScript, macScript, encodeCommand, WINDOWS_TYPER } = require('../electron/typer.cjs');

test('text is prepared for typing', () => {
  assert.equal(prepareTyping('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(prepareTyping('if x:\n    y\n\tz\n'), 'if x:\n    y\n\tz\n');
  assert.equal(prepareTyping('  if x:\n    y\n\tz\n', { autoIndent: true }), '  if x:\ny\nz\n');
  assert.equal(typingDelay('slow'), 40);
  assert.equal(typingDelay('unknown'), 15);
  assert.equal(typingSeconds(1000, 15), 18);
  assert.equal(formatDuration(45), '45 s');
  assert.equal(formatDuration(80), '1 min 20 s');
  assert.equal(formatDuration(120), '2 min');
});

test('the Windows helper uses scan codes, stops on a focus change or Escape, and never types into the editor', () => {
  const script = windowsScript();
  for (const part of ['SendInput', 'MapVirtualKeyW', 'GetForegroundWindow', 'GetAsyncKeyState(0x1B)', 'stopped self', 'TYPER_AT', 'Remove-Item']) {
    assert.ok(script.includes(part), part);
  }
  assert.ok(WINDOWS_TYPER.includes('SCANCODE = 0x8') && WINDOWS_TYPER.includes('UNICODE = 0x4'));
  // C# 5: no interpolated strings.
  assert.ok(!/\$"/.test(WINDOWS_TYPER));
  assert.equal(Buffer.from(encodeCommand('Write-Output é'), 'base64').toString('utf16le'), 'Write-Output é');
  assert.match(macScript(), /key code 36/);
});

function fakeSpawn(behave) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit('close', null));
    const call = { command, args, options, child, text: args.includes('--file') ? fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8') : null };
    calls.push(call);
    setImmediate(() => behave(child, call));
    return child;
  };
  return { spawn, calls };
}

test('Linux types with xdotool after the countdown, and removes the text file', async () => {
  const { spawn, calls } = fakeSpawn((child) => child.emit('close', 0));
  const job = startTyping('héllo\nworld', { delay: 12, at: Date.now() + 30 }, { platform: 'linux', spawn, env: { DISPLAY: ':1' } });
  assert.deepEqual(await job.done, { typed: 11 });
  assert.equal(calls[0].command, 'xdotool');
  assert.deepEqual(calls[0].args.slice(0, 3), ['type', '--delay', '12']);
  assert.equal(calls[0].text, 'héllo\nworld');
  assert.ok(!fs.existsSync(calls[0].args[4]));
});

test('nothing is typed while the editor itself has the focus, or after Cancel', async () => {
  const { spawn, calls } = fakeSpawn((child) => child.emit('close', 0));
  const self = startTyping('x', { at: Date.now() + 10 }, { platform: 'linux', spawn, env: { DISPLAY: ':1' }, isSelfFocused: () => true });
  assert.deepEqual(await self.done, { typed: 0, stopped: 'self' });
  const cancelled = startTyping('x', { at: Date.now() + 5000 }, { platform: 'linux', spawn, env: { DISPLAY: ':1' } });
  cancelled.cancel();
  assert.deepEqual(await cancelled.done, { typed: 0, stopped: 'cancelled' });
  assert.equal(calls.length, 0);
});

test('a missing tool and macOS permissions come back as plain advice', async () => {
  const missing = fakeSpawn((child) => child.emit('error', Object.assign(new Error('spawn xdotool ENOENT'), { code: 'ENOENT' })));
  await assert.rejects(startTyping('x', { at: Date.now() }, { platform: 'linux', spawn: missing.spawn, env: { DISPLAY: ':1' } }).done, /Install xdotool/);
  const denied = fakeSpawn((child) => {
    child.stderr.emit('data', Buffer.from('execution error: osascript is not allowed to send keystrokes. (1002)'));
    child.emit('close', 1);
  });
  await assert.rejects(startTyping('x', { at: Date.now() }, { platform: 'darwin', spawn: denied.spawn }).done, /Accessibility/);
  assert.equal(denied.calls[0].command, 'osascript');
});

test('Windows starts PowerShell at once, reports progress and why it stopped', async () => {
  const progress = [];
  const { spawn, calls } = fakeSpawn((child) => {
    child.stdout.emit('data', Buffer.from('progress 0\r\nprogress 25\r\nstop'));
    child.stdout.emit('data', Buffer.from('ped focus 30\r\n'));
    child.emit('close', 0);
  });
  const at = Date.now() + 5000;
  const job = startTyping('a'.repeat(100), { delay: 15, at, self: '1234' }, { platform: 'win32', spawn, env: {}, onProgress: (n) => progress.push(n) });
  assert.deepEqual(await job.done, { typed: 30, stopped: 'focus' });
  assert.deepEqual(progress, [0, 25]);
  const { command, args, options } = calls[0];
  assert.equal(command, 'powershell.exe');
  assert.ok(args.includes('-EncodedCommand') && args.includes('-NonInteractive'));
  assert.equal(options.env.TYPER_AT, String(at));
  assert.equal(options.env.TYPER_SELF, '1234');
  assert.equal(options.env.TYPER_UNICODE, '0');
  assert.match(windowsScript(), /\(\$env:TYPER_UNICODE -eq '1'\)/);
  assert.equal(options.windowsHide, true);
});
