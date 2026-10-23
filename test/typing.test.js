import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { formatDuration, prepareTyping, typingDelay, typingSeconds } from '../app/js/typing.js';

const require = createRequire(import.meta.url);
const { startTyping, windowsScript, macScript, encodeCommand, lineRuns, WINDOWS_TYPER } = require('../electron/typer.cjs');

test('text is prepared for typing', () => {
  assert.equal(prepareTyping('a\r\nb\rc\n'), 'a\nb\nc\n');
  assert.equal(prepareTyping('if x:\n    y\n\tz\n'), 'if x:\n    y\n\tz\n');
  // Indentation is kept: an editor that indents by itself has it cleared after each Enter instead.
  assert.equal(prepareTyping('a:\n  b:\n    c: 1\nd: 2'), 'a:\n  b:\n    c: 1\nd: 2');
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

test('an editor that indents by itself: after Enter its indentation is cleared, then the line is typed with its own', () => {
  // Windows: Shift+Home with Home as an extended key (else it is the keypad's 7), then space and Backspace.
  assert.ok(WINDOWS_TYPER.includes('EXTENDED = 0x1') && /ClearIndent/.test(WINDOWS_TYPER));
  assert.match(WINDOWS_TYPER, /Scan\(0x24\)/);
  assert.match(WINDOWS_TYPER, /if \(ch == '\\n' && lineStart\)/);
  assert.ok(windowsScript().includes("$env:TYPER_LINESTART -eq '1'"));
  // macOS: Cmd+Shift+Left after Return.
  assert.match(macScript(), /key code 123 using \{command down, shift down\}/);
  // Linux (xdotool, whose `type` takes every argument after it): one run per line, the
  // keys for the line break first; a blank line only presses the keys.
  const runs = lineRuns('a:\n  b: 1\n\nc: 2', { delay: 9 });
  const keys = ['key', '--delay', '9', 'Return', 'shift+Home', 'space', 'BackSpace'];
  assert.deepEqual(runs.map((r) => r.args), [
    ['type', '--delay', '9', '--', 'a:'],
    [...keys, 'type', '--delay', '9', '--', '  b: 1'],
    keys,
    [...keys, 'type', '--delay', '9', '--', 'c: 2'],
  ]);
  assert.equal(runs.reduce((n, r) => n + r.chars, 0), 'a:\n  b: 1\n\nc: 2'.length);
  assert.ok(runs.every((r) => r.args.indexOf('type') === -1 || r.args.indexOf('type') === r.args.length - 5));
  const wayland = lineRuns('x\n y', { tool: 'wtype', delay: 5 });
  assert.deepEqual(wayland[0].args, ['-d', '5', 'x', '-k', 'Return', '-M', 'shift', '-k', 'Home', '-m', 'shift', '-k', 'space', '-k', 'BackSpace', ' y']);
  // Long texts with wtype are split into several runs, in order, with every character counted.
  const long = Array.from({ length: 3000 }, (_, i) => `  line ${i}: ${'x'.repeat(30)}`).join('\n');
  const split = lineRuns(long, { tool: 'wtype' });
  assert.ok(split.length > 1);
  assert.equal(split.reduce((n, r) => n + r.chars, 0), long.length);
  assert.ok(split.every((r) => r.args.reduce((n, a) => n + a.length + 1, 0) < 70 * 1024));
});

test('Linux with an editor that indents by itself: the runs go one after another, with progress', async () => {
  const { spawn, calls } = fakeSpawn((child) => child.emit('close', 0));
  const progress = [];
  const long = Array.from({ length: 40 }, (_, i) => `  line ${i}: ${'x'.repeat(30)}`).join('\n');
  const job = startTyping(long, { delay: 1, at: Date.now() + 10, lineStart: true }, { platform: 'linux', spawn, env: { DISPLAY: ':1', LANG: 'en_US.UTF-8' }, onProgress: (n) => progress.push(n) });
  const result = await job.done;
  assert.ok(calls.length > 1 && calls.every((c) => c.command === 'xdotool'));
  assert.equal(calls[0].args[0], 'type');
  assert.deepEqual(result, { typed: long.length });
  assert.ok(progress.length === calls.length - 1 && progress.every((n, i) => i === 0 || n > progress[i - 1]));
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
