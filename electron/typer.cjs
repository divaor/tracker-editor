// Types text into the window that has the keyboard focus, as real key presses:
// for remote desktops and consoles that do not take pasted text.
// - Windows: SendInput with scan codes (what remote desktop clients pass on),
//   from PowerShell. It stops when another window gets the focus, or on Escape.
// - macOS: System Events (needs Accessibility permission).
// - Linux: xdotool (X11) or wtype (Wayland).
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

  const uint KEYBOARD = 1, KEYUP = 0x2, UNICODE = 0x4, SCANCODE = 0x8;

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

  public static void Type(string text, int delay, long self, bool unicode) {
    IntPtr target = GetForegroundWindow();
    if (self != 0 && target.ToInt64() == self) { Console.WriteLine("stopped self 0"); return; }
    for (int i = 0; i < text.Length; i++) {
      if (GetForegroundWindow() != target) { Console.WriteLine("stopped focus " + i); return; }
      if ((GetAsyncKeyState(0x1B) & 0x8000) != 0) { Console.WriteLine("stopped escape " + i); return; }
      char ch = text[i];
      if (char.IsHighSurrogate(ch) && i + 1 < text.Length) { Unicode(ch); Unicode(text[i + 1]); i++; }
      else if (unicode && ch != '\n' && ch != '\t') Unicode(ch);
      else Press(ch);
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
    "[TrackerEditorTyper]::Type($text, [int]$env:TYPER_DELAY, [int64]$env:TYPER_SELF, ($env:TYPER_UNICODE -eq '1'))",
  ].join('\n');
}

/** For powershell.exe -EncodedCommand: base64 of the UTF-16LE script. */
const encodeCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** AppleScript: argv is the text file and the delay between keys in seconds. */
function macScript() {
  return `on run argv
  set theText to read (POSIX file (item 1 of argv)) as «class utf8»
  set pause to (item 2 of argv) as real
  tell application "System Events"
    set frontApp to name of first application process whose frontmost is true
    if frontApp is "Tracker Editor" or frontApp is "Electron" then error "stopped self"
    repeat with c in (characters of theText)
      set ch to contents of c
      if ch is linefeed or ch is return then
        key code 36
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

/**
 * Starts typing `text` at time `at` (ms since the epoch), `delay` ms between keys.
 * Returns { done, cancel }: done resolves to { typed, stopped? } where stopped is
 * 'self' (this app still had the focus), 'focus' (another window took it),
 * 'escape' or 'cancelled'; it rejects with a message to show.
 */
function startTyping(text, { delay = 15, at = Date.now() + 5000, self = '0', unicode = false } = {}, deps = {}) {
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
    const run = (command, args, options = {}) => {
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
        env: { ...env, TYPER_FILE: file, TYPER_AT: String(at), TYPER_DELAY: String(delay), TYPER_SELF: String(self || 0), TYPER_UNICODE: unicode ? '1' : '0' },
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
        run('osascript', [script, file, String(delay / 1000)]);
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

module.exports = { startTyping, windowsScript, macScript, encodeCommand, WINDOWS_TYPER };
