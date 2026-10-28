// Terminals (desktop): each one a shell over a server's SSH connection, or ('local') the
// person's own shell on this computer (main.cjs term:*), shown with xterm.js, which is
// loaded the first time one opens. The sessions live here, outside the panel, so hiding
// the panel keeps them; the panel attaches their screens (attach) and fits them to its size.
// "file:line" in the output is a link (fileRefs.js) that the app opens (setRefHandler).
import { outputTail } from './errorHelp.js';
import { findFileRefs } from './fileRefs.js';
import { getSettings, resolvedTheme } from './settings.js';

let lib = null; // { Terminal, FitAddon }
const sessions = []; // { key, id, connId, cwd, label, title, term, fit, el, exited, code, starting, shell, runner }
const listeners = new Set();
let active = null;
let wired = false;
let lastSize = { cols: 100, rows: 24 };
let onToggle = () => {};
let onRef = null;

const bridge = () => window.desktop?.terminal;
const changed = () => listeners.forEach((l) => l());
const byId = (id) => sessions.find((s) => s.id === id);
// Output and ends that come before their session knows its id: in the Android app the answer
// to open and the shell's first output (its prompt) travel separately, and either may come
// first. Kept a while for start() to take; others are dropped (a session closed meanwhile).
const early = new Map(); // id → { data, ended, code, timer }
function keepEarly(id) {
  let e = early.get(id);
  if (!e) {
    e = { data: '', ended: false, code: null, timer: setTimeout(() => early.delete(id), 30_000) };
    early.set(id, e);
  }
  return e;
}
function takeEarly(id) {
  const e = early.get(id);
  if (e) {
    clearTimeout(e.timer);
    early.delete(id);
  }
  return e;
}
const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

export const terminalsAvailable = () => Boolean(bridge());
export const terminals = () => sessions;
export const activeTerminal = () => active;
export function onTerminals(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
/** What Ctrl+` does from inside a terminal (the app shows or hides the panel). */
export function setToggleHandler(fn) {
  onToggle = fn;
}
/** What a click on "file:line" in a terminal does: `fn(ref, session)` (ref from findFileRefs). */
export function setRefHandler(fn) {
  onRef = fn;
}

// Light: xterm's own colors are made for a dark screen (bright green and yellow nearly vanish on
// white, and prompts are bold, which draws them bright), so each has a darker shade here, all at
// least 4.5:1 on white; `minimumContrastRatio` does the same for 256 colors and true color.
const THEMES = {
  light: {
    background: '#ffffff', foreground: '#1d1c19', cursor: '#4f46e5', cursorAccent: '#ffffff', selectionBackground: '#c7c4f7',
    black: '#1d1c19', red: '#c4231c', green: '#1a7f37', yellow: '#8f6200', blue: '#0b5cbd', magenta: '#9a2b9e', cyan: '#0b7285', white: '#6b6860',
    brightBlack: '#5c5a55', brightRed: '#d1242f', brightGreen: '#1f883d', brightYellow: '#9a6700', brightBlue: '#1f6feb', brightMagenta: '#a23aa6', brightCyan: '#0d7d91', brightWhite: '#8a8780',
  },
  dark: { background: '#1b1a18', foreground: '#ece9e2', cursor: '#8b85f5', cursorAccent: '#1b1a18', selectionBackground: '#4a4680' },
};
const darkNow = () => resolvedTheme(getSettings().theme) === 'dark';
const themeNow = () => THEMES[darkNow() ? 'dark' : 'light'];
const contrastNow = () => (darkNow() ? 1 : 4.5);

async function load() {
  if (lib) return lib;
  if (!document.querySelector('link[data-xterm]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'vendor/xterm/xterm.css';
    link.dataset.xterm = '1';
    document.head.append(link);
  }
  lib = await import('../vendor/xterm/xterm.js');
  return lib;
}

function ended(s, code) {
  s.exited = true;
  s.code = code;
  s.term.write(`\r\n\x1b[2m[The session ended${code ? ` (exit code ${code})` : ''}. Press Enter to start a new one.]\x1b[0m\r\n`);
  changed();
}

function wire() {
  if (wired) return;
  wired = true;
  bridge().onData(({ id, data }) => {
    const s = byId(id);
    if (s) s.term.write(data);
    else {
      const e = keepEarly(id);
      if (e.data.length < 262144) e.data += data;
    }
  });
  bridge().onExit(({ id, code }) => {
    const s = byId(id);
    if (s) return ended(s, code);
    Object.assign(keepEarly(id), { ended: true, code });
  });
}

async function start(s) {
  s.starting = true;
  changed();
  // A shell that takes a moment (connecting to a server, the phone starting its file access)
  // says so; the line goes once it answers.
  let waiting = false;
  const slow = setTimeout(() => {
    if (s.closed) return;
    waiting = true;
    s.term.write(`\x1b[2m${s.connId === 'local' ? 'Starting the shell…' : 'Connecting…'}\x1b[0m`);
  }, 700);
  try {
    const cols = s.term.cols || lastSize.cols;
    const rows = s.term.rows || lastSize.rows;
    const { id, shell } = await bridge().open(s.connId, { cols, rows, cwd: s.cwd });
    clearTimeout(slow);
    const before = takeEarly(id);
    // Closed while it was starting: the shell ends right away.
    if (s.closed) {
      bridge().close(id);
      return false;
    }
    if (waiting) s.term.write('\r\x1b[2K');
    s.id = id;
    s.shell = shell ?? 'posix';
    s.exited = false;
    s.code = null;
    if (before?.data) s.term.write(before.data);
    if (before?.ended) {
      ended(s, before.code);
      return false;
    }
    // Fitted meanwhile, and typed meanwhile: both go to the shell now.
    if (s.term.cols !== cols || s.term.rows !== rows) bridge().resize(id, s.term.cols, s.term.rows);
    if (s.typed) bridge().input(id, s.typed);
    s.typed = '';
    return true;
  } catch (err) {
    clearTimeout(slow);
    s.exited = true;
    s.term.write(`\r\n\x1b[31m${message(err)}\x1b[0m\r\n\x1b[2m[Press Enter to try again.]\x1b[0m\r\n`);
    return false;
  } finally {
    s.starting = false;
    changed();
  }
}

const copySelection = (term) => {
  const text = term.getSelection();
  if (text) navigator.clipboard.writeText(text).catch(() => {});
  return Boolean(text);
};
const pasteInto = (term) => navigator.clipboard.readText().then((text) => text && term.paste(text), () => {});

/**
 * Opens a terminal on a server (an SFTP connection's id) or on this computer ('local'),
 * in `cwd` when given. Resolves with the session once its shell runs (or shows why it did not).
 */
export async function openTerminal(connId, { cwd = '', label = 'Terminal', runner = false } = {}) {
  if (!bridge()) throw new Error('Terminals work in the desktop app.');
  const { Terminal, FitAddon } = await load();
  wire();
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: themeNow(),
    minimumContrastRatio: contrastNow(),
    cols: lastSize.cols,
    rows: lastSize.rows,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const s = { key: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, id: null, connId, cwd, label, title: '', term, fit, el: null, exited: false, code: null, starting: false, typed: '', runner };
  term.onData((data) => {
    if (s.exited) {
      if (data === '\r' && !s.starting) {
        term.write('\r\n');
        start(s);
      }
      return;
    }
    if (s.id && !s.starting) bridge().input(s.id, data);
    else s.typed += data;
  });
  term.onResize(({ cols, rows }) => {
    lastSize = { cols, rows };
    if (s.id && !s.exited) bridge().resize(s.id, cols, rows);
  });
  term.onTitleChange((title) => {
    s.title = title;
    changed();
  });
  // "file:line" (compilers, stack traces) opens the file there; Ctrl+click, or a click.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
      const refs = onRef ? findFileRefs(line) : [];
      callback(
        refs.length
          ? refs.map((ref) => ({
              range: { start: { x: ref.from + 1, y }, end: { x: ref.to, y } },
              text: line.slice(ref.from, ref.to),
              decorations: { underline: true, pointerCursor: true },
              activate: () => onRef?.(ref, s),
            }))
          : undefined,
      );
    },
  });
  // Copy and paste as in terminals: Ctrl+Shift+C / V; Ctrl+C copies when text is
  // selected (else it interrupts), Ctrl+V pastes. Ctrl+` hides the panel.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      onToggle();
      return false;
    }
    if (mod && e.shiftKey && key === 'c') return copySelection(term), false;
    if (mod && e.shiftKey && key === 'v') return e.preventDefault(), pasteInto(term), false;
    if (mod && !e.shiftKey && !e.altKey && key === 'c' && term.hasSelection()) {
      copySelection(term);
      term.clearSelection();
      return false;
    }
    if (mod && !e.shiftKey && !e.altKey && key === 'v') return e.preventDefault(), pasteInto(term), false;
    return true;
  });
  sessions.push(s);
  active = s;
  changed();
  await start(s);
  return s;
}

/** Puts a session's screen in the panel's container (opened there the first time) and fits it. */
export function attach(s, container) {
  if (!s.el) {
    s.el = document.createElement('div');
    s.el.className = 'terminal-screen';
    s.el.dataset.key = s.key;
    // While a terminal has the focus, the window's menu shortcuts go to the shell.
    s.el.addEventListener('focusin', () => bridge()?.ownKeys(true));
    s.el.addEventListener('focusout', () => bridge()?.ownKeys(false));
    // Keys typed here are the shell's: the app's shortcuts (Ctrl+P, Escape…) do not see them.
    for (const type of ['keydown', 'keypress', 'keyup']) s.el.addEventListener(type, (e) => e.stopPropagation());
    container.append(s.el);
    s.term.open(s.el);
  } else if (s.el.parentNode !== container) container.append(s.el);
  fitSoon(s);
}

/** Fits a session to its screen (after the layout settles). */
export function fitSoon(s) {
  requestAnimationFrame(() => {
    if (!s.el?.isConnected || !s.el.offsetWidth) return;
    try {
      s.fit.fit();
    } catch {
      // not measurable yet
    }
  });
}

export function focusTerminal(s = active) {
  s?.term.focus();
}

export function setActiveTerminal(s) {
  active = s;
  changed();
}

/** Ends a session's shell and removes it. */
export function closeTerminal(s) {
  const at = sessions.indexOf(s);
  if (at === -1) return;
  s.closed = true;
  if (s.id && !s.exited) bridge().close(s.id);
  s.term.dispose();
  s.el?.remove();
  sessions.splice(at, 1);
  if (active === s) active = sessions[Math.min(at, sessions.length - 1)] ?? null;
  bridge()?.ownKeys(false);
  changed();
}

/**
 * Types `line` and Enter into the terminal kept for running files on `connId` (one per
 * place), opened in `cwd` the first time. Resolves with the session.
 */
export async function runInTerminal(connId, { cwd = '', line, label = 'Run', enter = true }) {
  let s = sessions.find((x) => x.runner && x.connId === connId && !x.exited && !x.closed);
  if (!s) {
    s = await openTerminal(connId, { cwd, label, runner: true });
    if (s.exited) return s; // it said why in its screen
  }
  setActiveTerminal(s);
  // Without `enter`, the line is typed for the person to run (Set up… for a language server).
  const typed = enter ? `${line}\r` : line;
  if (s.id && !s.starting) bridge().input(s.id, typed);
  else s.typed += typed;
  return s;
}

/** What to ask the model about in a terminal: its selection, else the last output (wrapped lines joined). */
export function terminalText(s = active, max = 80) {
  if (!s) return '';
  if (s.term.hasSelection()) return s.term.getSelection().trim();
  const buffer = s.term.buffer.active;
  const lines = [];
  for (let i = Math.max(0, buffer.length - 600); i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return outputTail(lines, max);
}

export const clearTerminal = (s = active) => s?.term.clear();
export const copyFromTerminal = (s = active) => s && copySelection(s.term);
export const pasteIntoTerminal = (s = active) => s && pasteInto(s.term);
export const terminalHasSelection = (s = active) => Boolean(s?.term.hasSelection());

/** The colors follow the app's theme. */
export function retheme() {
  for (const s of sessions) {
    s.term.options.theme = themeNow();
    s.term.options.minimumContrastRatio = contrastNow();
  }
}
