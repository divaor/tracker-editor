// Types text into the window that has the keyboard focus, as real key presses:
// for remote desktops and consoles that do not take pasted text.
// - Windows: SendInput with scan codes (what remote desktop clients pass on),
//   from PowerShell. It stops when another window gets the focus, or on Escape.
// - macOS: System Events (needs Accessibility permission).
// - Linux: xdotool (X11) or wtype (Wayland).
// With `lineStart` (the other editor indents new lines by itself), after each Enter
// whatever indentation it added is cleared (Shift+Home selects it, a space replaces
// it, Backspace removes the space), so each line gets exactly its own indentation.
const { spawn: nodeSpawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// C# 5 (Windows PowerShell 5.1 compiles it with .NET Framework).
const WINDOWS_TYPER = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class TrackerEditorTyper {
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScanW(char ch);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern short GetKeyState(int key);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);

  const uint KEYBOARD = 1, EXTENDED = 0x1, KEYUP = 0x2, UNICODE = 0x4, SCANCODE = 0x8;

  static INPUT Key(ushort scan, uint flags) {
    INPUT input = new INPUT();
    input.type = KEYBOARD;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = flags;
    return input;
  }

  static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

  static ushort Scan(int vk) { return (ushort)MapVirtualKeyW((uint)vk, 0); }

  static void Tap(int vk) {
    ushort sc = Scan(vk);
    Send(Key(sc, SCANCODE), Key(sc, SCANCODE | KEYUP));
  }

  static void Unicode(char ch) { Send(Key(ch, UNICODE), Key(ch, UNICODE | KEYUP)); }

  // After Enter: select what the other editor indented the new line with, replace it
  // with a space and remove that, so the line starts at the left. Home is an extended
  // key (without the flag it is the keypad's 7).
  static void ClearIndent(int delay) {
    ushort shiftSc = Scan(0x10), homeSc = Scan(0x24);
    Send(Key(shiftSc, SCANCODE), Key(homeSc, SCANCODE | EXTENDED), Key(homeSc, SCANCODE | EXTENDED | KEYUP), Key(shiftSc, SCANCODE | KEYUP));
    Thread.Sleep(delay);
    Tap(0x20);
    Thread.Sleep(delay);
    Tap(0x08);
  }

  static void Press(char ch) {
    if (ch == '\n') { Tap(0x0D); return; }
    if (ch == '\t') { Tap(0x09); return; }
    short r = VkKeyScanW(ch);
    int mods = (r >> 8) & 0xff;
    ushort sc = r == -1 ? (ushort)0 : Scan(r & 0xff);
    // Not on this keyboard, or behind Ctrl/Alt (AltGr): send the character itself.
    if (r == -1 || sc == 0 || (mods & 6) != 0) { Unicode(ch); return; }
    bool shift = (mods & 1) != 0;
    // Caps Lock flips the case of letters.
    if (char.IsLetter(ch) && (GetKeyState(0x14) & 1) != 0) shift = !shift;
    if (shift) {
      ushort shiftSc = Scan(0x10);
      Send(Key(shiftSc, SCANCODE), Key(sc, SCANCODE), Key(sc, SCANCODE | KEYUP), Key(shiftSc, SCANCODE | KEYUP));
    } else Send(Key(sc, SCANCODE), Key(sc, SCANCODE | KEYUP));
  }

  public static void Type(string text, int delay, long self, bool unicode, bool lineStart) {
    IntPtr target = GetForegroundWindow();
    if (self != 0 && target.ToInt64() == self) { Console.WriteLine("stopped self 0"); return; }
    for (int i = 0; i < text.Length; i++) {
      if (GetForegroundWindow() != target) { Console.WriteLine("stopped focus " + i); return; }
      if ((GetAsyncKeyState(0x1B) & 0x8000) != 0) { Console.WriteLine("stopped escape " + i); return; }
      char ch = text[i];
      if (char.IsHighSurrogate(ch) && i + 1 < text.Length) { Unicode(ch); Unicode(text[i + 1]); i++; }
      else if (unicode && ch != '\n' && ch != '\t') Unicode(ch);
      else Press(ch);
      if (ch == '\n' && lineStart) { Thread.Sleep(delay); ClearIndent(delay); }
      if (i % 25 == 0) Console.WriteLine("progress " + i);
      Thread.Sleep(delay);
    }
    Console.WriteLine("progress " + text.Length);
  }
}
`;

/** The PowerShell script for Windows; it reads its parameters from TYPER_* environment variables. */
function windowsScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -TypeDefinition @'\n${WINDOWS_TYPER}\n'@`,
    '$text = [IO.File]::ReadAllText($env:TYPER_FILE, [Text.Encoding]::UTF8)',
    'Remove-Item -LiteralPath $env:TYPER_FILE',
    // Starts at the end of the countdown, however long PowerShell took to get here.
    '$wait = [int64]$env:TYPER_AT - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()',
    'if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }',
    "[TrackerEditorTyper]::Type($text, [int]$env:TYPER_DELAY, [int64]$env:TYPER_SELF, ($env:TYPER_UNICODE -eq '1'), ($env:TYPER_LINESTART -eq '1'))",
  ].join('\n');
}

/** For powershell.exe -EncodedCommand: base64 of the UTF-16LE script. */
const encodeCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** AppleScript: argv is the text file, the delay between keys in seconds, and "1" to clear the indentation after Enter. */
function macScript() {
  return `on run argv
  set theText to read (POSIX file (item 1 of argv)) as «class utf8»
  set pause to (item 2 of argv) as real
  set lineStart to (item 3 of argv) is "1"
  tell application "System Events"
    set frontApp to name of first application process whose frontmost is true
    if frontApp is "Tracker Editor" or frontApp is "Electron" then error "stopped self"
    repeat with c in (characters of theText)
      set ch to contents of c
      if ch is linefeed or ch is return then
        key code 36
        if lineStart then
          delay pause
          key code 123 using {command down, shift down}
          keystroke " "
          key code 51
        end if
      else if ch is tab then
        key code 48
      else
        keystroke ch
      end if
      delay pause
    end repeat
  end tell
end run
`;
}

const STOPPED = { self: 'self', focus: 'focus', escape: 'escape' };

// Keys that clear the indentation the other editor put on a new line (see the top).
const CLEAR_INDENT = { xdotool: ['shift+Home', 'space', 'BackSpace'], wtype: ['-M', 'shift', '-k', 'Home', '-m', 'shift', '-k', 'space', '-k', 'BackSpace'] };
const MAX_ARGS = 60 * 1024;

/**
 * Linux, clearing the indentation after each Enter: the argument lists of the runs
 * that type `text` line by line ([{ args, chars }], chars: how many characters a run
 * types). xdotool's `type` takes every argument after it, so each xdotool run is one
 * line: the keys for the line break before it, then `type` last. wtype takes text and
 * keys in any order, so its runs only split to keep the arguments short.
 */
function lineRuns(text, { tool = 'xdotool', delay = 15 } = {}) {
  const lines = text.split('\n');
  if (tool !== 'wtype') {
    return lines
      .map((line, i) => ({
        args: [...(i ? ['key', '--delay', String(delay), 'Return', ...CLEAR_INDENT.xdotool] : []), ...(line ? ['type', '--delay', String(delay), '--', line] : [])],
        chars: line.length + (i ? 1 : 0),
      }))
      .filter((run) => run.args.length);
  }
  const runs = [];
  let args = [];
  let size = 0;
  let chars = 0;
  const flush = () => {
    if (args.length) runs.push({ args: ['-d', String(delay), ...args], chars });
    args = [];
    size = 0;
    chars = 0;
  };
  lines.forEach((line, i) => {
    const step = [...(i ? ['-k', 'Return', ...CLEAR_INDENT.wtype] : []), ...(line ? [line] : [])];
    const stepSize = step.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);
    if (size && size + stepSize > MAX_ARGS) flush();
    args.push(...step);
    size += stepSize;
    chars += line.length + (i ? 1 : 0);
  });
  flush();
  return runs;
}

function startTyping(text, { delay = 15, at = Date.now() + 5000, self = '0', unicode = false, lineStart = false } = {}, deps = {}) {
  const { platform = process.platform, spawn = nodeSpawn, tmpdir = os.tmpdir(), env = process.env, onProgress = () => {}, isSelfFocused = () => false, setTimer = setTimeout, clearTimer = clearTimeout } = deps;
  const dir = fs.mkdtempSync(path.join(tmpdir, 'tracker-editor-typing-'));
  const file = path.join(dir, 'text.txt');
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  let child = null;
  let timer = null;
  let cancelled = false;
  let stopped = null;
  let typed = 0;
  let settle = null;

  const done = new Promise((resolve, reject) => {
    settle = resolve;
    // One run, or several in a row: `more` lists the next ones ({ args, chars }); `chars`
    // is how many characters this one types (for the progress between runs).
    const run = (command, args, options = {}, more = [], chars = 0) => {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...options });
      let errText = '';
      let buffered = '';
      child.stdout.on('data', (chunk) => {
        buffered += chunk.toString();
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop();
        for (const line of lines) {
          const [word, kind, n] = line.trim().split(' ');
          if (word === 'progress') {
            typed = Number(kind) || typed;
            onProgress(typed);
          } else if (word === 'stopped') {
            stopped = STOPPED[kind] ?? kind;
            typed = Number(n) || 0;
          }
        }
      });
      child.stderr.on('data', (chunk) => (errText += chunk.toString()));
      child.on('error', (err) => {
        cleanup();
        reject(new Error(err.code === 'ENOENT' ? missingTool(platform, env) : err.message));
      });
      child.on('close', (code) => {
        if (!cancelled && code === 0 && more.length) {
          typed += chars;
          onProgress(typed);
          return run(command, more[0].args, options, more.slice(1), more[0].chars);
        }
        cleanup();
        if (cancelled) return resolve({ typed, stopped: 'cancelled' });
        if (/stopped self/.test(errText)) return resolve({ typed: 0, stopped: 'self' });
        if (code !== 0 && !stopped) return reject(new Error(explain(platform, errText) || `Typing failed (exit code ${code}).`));
        resolve(stopped ? { typed, stopped } : { typed: platform === 'win32' ? typed : text.length });
      });
    };

    if (platform === 'win32') {
      // Started now: PowerShell takes a moment, and waits for the end of the countdown itself.
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(windowsScript())], {
        env: { ...env, TYPER_FILE: file, TYPER_AT: String(at), TYPER_DELAY: String(delay), TYPER_SELF: String(self || 0), TYPER_UNICODE: unicode ? '1' : '0', TYPER_LINESTART: lineStart ? '1' : '0' },
      });
      return;
    }
    timer = setTimer(() => {
      timer = null;
      if (cancelled) return;
      if (isSelfFocused()) {
        cleanup();
        resolve({ typed: 0, stopped: 'self' });
        return;
      }
      if (platform === 'darwin') {
        const script = path.join(dir, 'type.applescript');
        fs.writeFileSync(script, macScript(), 'utf8');
        run('osascript', [script, file, String(delay / 1000), lineStart ? '1' : '0']);
      } else if (lineStart) {
        // Line by line, with the keys that clear the other editor's indentation between them.
        const tool = !env.DISPLAY && env.WAYLAND_DISPLAY ? 'wtype' : 'xdotool';
        const utf8 = /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
        const [first, ...rest] = lineRuns(text, { tool, delay });
        if (!first) return resolve({ typed: 0 });
        run(tool, first.args, { env: utf8 || tool === 'wtype' ? env : { ...env, LC_ALL: 'C.UTF-8' } }, rest, first.chars);
      } else if (!env.DISPLAY && env.WAYLAND_DISPLAY) {
        run('wtype', ['-d', String(delay), '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin?.end(text);
      } else {
        // xdotool reads the file in the locale's encoding: make it UTF-8, or accents stop it.
        const utf8 = /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
        run('xdotool', ['type', '--delay', String(delay), '--file', file], { env: utf8 ? env : { ...env, LC_ALL: 'C.UTF-8' } });
      }
    }, Math.max(0, at - Date.now()));
  });

  return {
    done,
    cancel() {
      cancelled = true;
      if (child) return child.kill();
      // Still counting down: nothing runs yet.
      if (timer) clearTimer(timer);
      timer = null;
      cleanup();
      settle({ typed: 0, stopped: 'cancelled' });
    },
  };
}

function missingTool(platform, env) {
  if (platform === 'win32') return 'PowerShell is not available on this computer.';
  if (platform === 'darwin') return 'osascript is not available on this Mac.';
  return !env.DISPLAY && env.WAYLAND_DISPLAY ? 'Install wtype to type into other windows (sudo apt install wtype).' : 'Install xdotool to type into other windows (sudo apt install xdotool).';
}

function explain(platform, errText) {
  const text = errText.trim();
  if (platform === 'darwin' && /not allowed|1002|1743|25211|assistive/i.test(text)) {
    return 'Allow Tracker Editor to control the keyboard: System Settings, Privacy & Security, Accessibility.';
  }
  if (platform === 'win32' && /Add-Type|language mode|ConstrainedLanguage/i.test(text)) {
    return 'Windows blocked the typing helper (PowerShell is restricted on this computer).';
  }
  return text.split('\n').filter(Boolean).slice(-3).join(' ');
}

module.exports = { startTyping, windowsScript, macScript, encodeCommand, lineRuns, WINDOWS_TYPER };
