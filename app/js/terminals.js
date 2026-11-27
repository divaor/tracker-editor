// Terminals (desktop): each one a shell over a server's SSH connection, or ('local') the
// person's own shell on this computer (main.cjs term:*), shown with xterm.js, which is
// loaded the first time one opens. The sessions live here, outside the panel, so hiding
// the panel keeps them; the panel attaches their screens (attach) and fits them to its size.
// "file:line" in the output is a link (fileRefs.js) that the app opens (setRefHandler), from
// the folder the shell says it is in (OSC 7 / 9;9 / 633, oscCwd: shells on this computer are
// started so they say it), else the one it was opened in.
// The tabs' order, the one in use and the panel split in two follow terminalTabs.js.
// Each terminal has a host: the panel (PANEL), or a Terminals tab (its id: terminalsTabs.js),
// each with its own tabs' state; a terminal moves between them keeping its shell (moveTerminalTo).
import { isKeyFor } from './keys.js';
import { outputTail } from './errorHelp.js';
import { findFileRefs } from './fileRefs.js';
import { getSettings, resolvedTheme } from './settings.js';
import { addTab, closeTab, commandEnded, commandLine, commandStarted, EMPTY_TABS, endMark, fromWsl, moveTab, oscCwd, shown, splitTab, unsplit, useTab } from './terminalTabs.js';

let lib = null; // { Terminal, FitAddon, SerializeAddon }
// { key, host, id, connId, cwd, cwdNow, label, name, title, term, fit, el, exited, code, starting, shell (its kind), shellId, profile, profileLabel, distro, runner, task,
//   nonce, running ({ command, at }: what its shell said it runs, until the command ends), offer (a login it ran before it came back: sshCommand.js), writes (output counter) }
const sessions = [];
const listeners = new Set();
/** The panel's host; a Terminals tab's is its id. */
export const PANEL = 'panel';
const hostTabs = new Map([[PANEL, EMPTY_TABS]]);
let wired = false;
let lastSize = { cols: 100, rows: 24 };
let onToggle = () => {};
let onKey = () => false;
let onRef = null;
let lastFocused = null;

const bridge = () => window.desktop?.terminal;
const changed = () => listeners.forEach((l) => l());
const byId = (id) => sessions.find((s) => s.id === id);
const byKey = (key) => sessions.find((s) => s.key === key) ?? null;
const tabsOf = (host) => hostTabs.get(host) ?? EMPTY_TABS;
// A host's tabs as they are now: its terminals in their order, the one in use, its split.
function setTabs(host, next) {
  hostTabs.set(host, next);
  changed();
}
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
/** A host's terminals (the panel's unless named), in their tabs' order. */
export const terminals = (host = PANEL) => tabsOf(host).order.map(byKey).filter(Boolean);
/** Every terminal open, in the panel and in Terminals tabs. */
export const allTerminals = () => [...sessions];
/** A host's terminal in use (the panel's unless named). */
export const activeTerminal = (host = PANEL) => byKey(tabsOf(host).active);
/** The two terminals side by side ({ left, right }) while a host is split, else null. */
export const splitTerminals = (host = PANEL) => {
  const { split } = tabsOf(host);
  return split ? { left: byKey(split.left), right: byKey(split.right) } : null;
};
/** A host's tabs' state (terminalTabs.js: { order, active, split }). */
export const terminalLayout = (host = PANEL) => tabsOf(host);
/** Whether a terminal's screen shows in its host (the one in use, or one of the two side by side). */
export const terminalShown = (s) => Boolean(s) && shown(tabsOf(s.host), s.key);
/** The terminal typed in last (still open), else the panel's in use. */
export const focusedTerminal = () => (lastFocused && sessions.includes(lastFocused) ? lastFocused : activeTerminal());
/** The folder a terminal is in now: the one its shell last said, else the one it was opened in. */
export const terminalFolder = (s) => s?.cwdNow || s?.cwd || '';
/** The shells on this computer ({ id, label, kind }), the default first; [] when they cannot be listed. */
export const localShells = () => bridge()?.shells?.().catch(() => []) ?? Promise.resolve([]);
export function onTerminals(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
/** What Ctrl+` does from inside a terminal (the app shows or hides the panel). */
export function setToggleHandler(fn) {
  onToggle = fn;
}
/**
 * The app's keys that pass the shell by: `fn(event, session)` runs the command and says true
 * (switching tabs, the Terminals tab's own key…); the rest are the shell's.
 */
export function setKeyHandler(fn) {
  onKey = fn;
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

/**
 * A terminal's output to keep (a Terminals tab's, for when it opens again): the last `lines` past
 * the screen, with their colors (xterm's serialize add-on; modes and a full-screen program's
 * screen left out), else as plain text; at most `chars`. { text, color, cols, rows } or null.
 */
export function terminalOutput(s, { lines = 1000, chars = 400_000 } = {}) {
  if (!s?.term) return null;
  const size = { cols: s.term.cols, rows: s.term.rows };
  for (let n = lines; n >= 50; n = Math.floor(n / 2)) {
    try {
      if (s.serialize) {
        const text = s.serialize.serialize({ scrollback: n, excludeModes: true, excludeAltBuffer: true });
        if (text.length <= chars) return text.trim() ? { text, color: true, ...size } : null;
        continue;
      }
    } catch {
      // the plain text instead
    }
    const buffer = s.term.buffer.normal;
    const out = [];
    for (let i = Math.max(0, buffer.length - n - s.term.rows); i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && out.length) out[out.length - 1] += text;
      else out.push(text);
    }
    while (out.length && !out.at(-1).trim()) out.pop();
    const text = out.join('\r\n');
    if (text.length <= chars) return text.trim() ? { text, color: false, ...size } : null;
  }
  return null;
}

function ended(s, code) {
  s.exited = true;
  s.code = code;
  // A run waiting for its command to end: the shell ended first.
  for (const w of s.waiters.splice(0)) w(null);
  // Kept on its server (tmux): only the connection went; what ran there goes on.
  if (s.tmux) s.term.write(`\r\n\x1b[2m[Disconnected. It keeps running on the server (tmux): press Enter to take it up again.]\x1b[0m\r\n`);
  else s.term.write(`\r\n\x1b[2m[The session ended${code ? ` (exit code ${code})` : ''}. Press Enter to start a new one.]\x1b[0m\r\n`);
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
    const { id, shell, profile, label, distro, integrated, nonce } = await bridge().open(s.connId, { cols, rows, cwd: s.cwd, ...(s.shellId ? { shell: s.shellId } : {}), ...(s.keep ? { keep: s.keep } : {}) });
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
    s.profile = profile ?? '';
    s.profileLabel = label ?? '';
    s.distro = distro ?? '';
    s.integrated = Boolean(integrated);
    s.nonce = typeof nonce === 'string' ? nonce : '';
    s.running = null;
    s.prompted = false;
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
/** A name for a terminal kept on a server (its tmux session there). */
export const keptName = () => `te-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 8)}`;

export async function openTerminal(connId, { cwd = '', label = 'Terminal', runner = false, shell = null, task = '', keep = '', host = PANEL, key = '', name = '', restore = null, offer = null } = {}) {
  if (!bridge()) throw new Error('Terminals work in the desktop app.');
  const { Terminal, FitAddon, SerializeAddon } = await load();
  wire();
  // Brought back (a Terminals tab): the size its output was kept at, so it lays out as it was.
  const at = restore?.text ? { cols: restore.cols || lastSize.cols, rows: restore.rows || lastSize.rows } : lastSize;
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    macOptionIsMeta: true,
    theme: themeNow(),
    minimumContrastRatio: contrastNow(),
    cols: at.cols,
    rows: at.rows,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const serialize = SerializeAddon ? new SerializeAddon() : null;
  if (serialize) term.loadAddon(serialize);
  // This computer's: the shell asked for, else the one chosen in Settings (else the default).
  const shellId = connId === 'local' ? (shell ?? getSettings().terminalShell ?? '') : '';
  // On a server, a terminal of your own is kept there (tmux, when the server has it: setting
  // terminalTmux): a reconnect or a reopen attaches to it again. Run and task terminals are not.
  const kept = connId !== 'local' && !runner && !task && getSettings().terminalTmux !== false ? keep || keptName() : '';
  if (!hostTabs.has(host)) hostTabs.set(host, EMPTY_TABS);
  const s = {
    key: /^t[a-z0-9]{1,32}$/.test(key) && !byKey(key) ? key : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    host, id: null, connId, cwd, cwdNow: '', label, name: String(name ?? '').trim().slice(0, 60), title: '', term, fit, serialize, el: null, exited: false, code: null, starting: false, typed: '', runner, task, shellId, integrated: false, waiters: [], keep: kept, tmux: false,
    nonce: '', running: null, offer: offer ?? null, writes: 0,
  };
  // Its output from before, then a line saying where the new shell starts.
  if (restore?.text) term.write(`${restore.text}\x1b[0m\r\n\x1b[2m${restore.note || '— Restored —'}\x1b[0m\r\n`);
  // The folder the shell says it is in after each command (OSC 7, 9;9, 633): links start there.
  const windows = connId === 'local' && window.desktop?.platform === 'win32';
  const onCwd = (ident) => (data) => {
    let p = oscCwd(ident, data, { windows: windows && s.shell !== 'wsl' });
    if (p && s.shell === 'wsl' && p.startsWith('/')) p = fromWsl(p, s.distro);
    if (p && p !== s.cwdNow) {
      s.cwdNow = p;
      changed();
    }
    return Boolean(p);
  };
  for (const ident of [7, 9]) term.parser.registerOscHandler(ident, onCwd(ident));
  // The server started it in tmux (remote.cjs prints OSC 7350 first): it is kept there.
  term.parser.registerOscHandler(7350, (data) => {
    if (data === 'tmux' && !s.tmux) {
      s.tmux = true;
      changed();
    }
    return true;
  });
  // 633: the folder (P;Cwd=), a command ended (D;code: what waits for it hears it), or the line
  // about to run (E;line;nonce, believed with its shell's nonce) and that it runs (C): what a
  // Terminals tab keeps, to offer a login again when it comes back.
  term.parser.registerOscHandler(633, (data) => {
    const end = commandEnded(data);
    if (end) {
      s.prompted = true;
      if (s.running) (s.running = null), changed();
      for (const w of s.waiters.splice(0)) w(end);
      return true;
    }
    const line = commandLine(data, s.nonce);
    if (line !== null || commandStarted(data)) {
      if (line !== null) s.running = { command: line, at: Date.now() };
      else s.running ??= { command: '', at: Date.now() };
      // Something runs now: the line it ran before it came back is not offered any more.
      s.offer = null;
      changed();
      return true;
    }
    return onCwd(633)(data);
  });
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
  // selected (else it interrupts), Ctrl+V pastes. Ctrl+` (or the terminal's key now) hides the panel.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (isKeyFor(e, 'terminal')) {
      e.preventDefault();
      onToggle();
      return false;
    }
    if (onKey(e, s)) {
      e.preventDefault();
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
  // Output written: what a Terminals tab keeps is saved again only after some.
  term.onWriteParsed(() => (s.writes += 1));
  sessions.push(s);
  setTabs(s.host, addTab(tabsOf(s.host), s.key));
  await start(s);
  return s;
}

/** Puts a session's screen in its host's container (`shown`: else hidden there), opened the first time it shows, and fits it. */
export function attach(s, container, { shown = true } = {}) {
  if (!s.el) {
    s.el = document.createElement('div');
    s.el.className = 'terminal-screen';
    s.el.dataset.key = s.key;
    // While a terminal has the focus, the window's menu shortcuts go to the shell.
    s.el.addEventListener('focusin', () => {
      bridge()?.ownKeys(true);
      lastFocused = s;
      // Clicked into one of the two side by side: that one is in use.
      if (activeTerminal(s.host) !== s && sessions.includes(s)) setTabs(s.host, useTab(tabsOf(s.host), s.key));
    });
    s.el.addEventListener('focusout', () => bridge()?.ownKeys(false));
    // Keys typed here are the shell's: the app's shortcuts (Ctrl+P, Escape…) do not see them.
    for (const type of ['keydown', 'keypress', 'keyup']) s.el.addEventListener(type, (e) => e.stopPropagation());
  }
  if (s.el.parentNode !== container) container.append(s.el);
  s.el.hidden = !shown;
  // Opened once it shows: xterm measures its characters then (a terminal opened hidden, as a
  // Terminals tab's coming back are, kept a width of nothing and spaced its letters out).
  if (shown && !s.opened) {
    s.opened = true;
    s.term.open(s.el);
  }
  if (shown) fitSoon(s);
}

/** Fits a session to its screen (after the layout settles). */
export function fitSoon(s) {
  requestAnimationFrame(() => {
    if (!s.el?.isConnected || !s.el.offsetWidth) return;
    try {
      s.fit.fit();
      // Its rows drawn again: rows drawn while it was being hidden (several terminals coming back
      // at once) measured their letters as nothing and spaced them out.
      s.term.refresh(0, s.term.rows - 1);
    } catch {
      // not measurable yet
    }
  });
}

export function focusTerminal(s = activeTerminal()) {
  s?.term.focus();
}

/** A terminal in use (shown; while split, in place of the one in use before when it was not showing). */
export function setActiveTerminal(s) {
  if (s) setTabs(s.host, useTab(tabsOf(s.host), s.key));
}

/** A terminal shown on one side of its host ('left', 'right'), split in two. */
export function showTerminalOn(s, side) {
  if (s) setTabs(s.host, splitTab(tabsOf(s.host), s.key, side));
}

/** One terminal in a host again: `keep` (by default the panel's in use), or `host`'s in use. */
export function unsplitTerminals(keep = null, host = keep?.host ?? PANEL) {
  const k = keep ?? activeTerminal(host);
  setTabs(host, unsplit(tabsOf(host), k?.key));
}

/** A terminal's tab moved to `index` among the others. */
export function moveTerminal(s, index) {
  if (s) setTabs(s.host, moveTab(tabsOf(s.host), s.key, index));
}

/** A host's tabs set as a whole (a Terminals tab brought back: its order, the one in use, its split). */
export function setTerminalLayout(host, layout) {
  const keys = terminals(host).map((s) => s.key);
  const listed = (layout?.order ?? []).filter((k) => keys.includes(k));
  const order = [...listed, ...keys.filter((k) => !listed.includes(k))];
  const active = keys.includes(layout?.active) ? layout.active : (order[0] ?? null);
  const split = layout?.split && keys.includes(layout.split.left) && keys.includes(layout.split.right) && layout.split.left !== layout.split.right ? { left: layout.split.left, right: layout.split.right } : null;
  setTabs(host, { order, active, split });
}

/**
 * A terminal moved to another host (the panel, a Terminals tab), its shell still running; at
 * `index` there (else at the end), in use. A terminal kept for running files or tasks becomes one
 * of your own (runs open their own again).
 */
export function moveTerminalTo(s, host, index = null) {
  if (!s || !sessions.includes(s) || s.host === host) return;
  setTabs(s.host, closeTab(tabsOf(s.host), s.key));
  s.host = host;
  s.runner = false;
  s.task = '';
  if (s.el) s.el.hidden = true; // its new host shows it
  let next = addTab(tabsOf(host), s.key);
  if (index !== null) next = moveTab(next, s.key, index);
  setTabs(host, next);
}

/** The login a terminal brought back offers to run again, or none (dismissed, run). */
export function setTerminalOffer(s, offer) {
  if (!s) return;
  s.offer = offer ?? null;
  changed();
}

/** Types `text` into a terminal's shell (as typed keys: queued while it starts). */
export function typeInTerminal(s, text) {
  if (!s || s.closed || !text) return;
  if (s.id && !s.starting && !s.exited) bridge().input(s.id, text);
  else s.typed += text;
}

/** Ends every terminal of a host (a Terminals tab closed) and forgets the host. */
export function closeHost(host) {
  if (host === PANEL) return;
  for (const s of terminals(host)) closeTerminal(s);
  hostTabs.delete(host);
  changed();
}

/** A terminal's tab named (an empty name: what it is and where, again). */
export function renameTerminal(s, name) {
  if (!s) return;
  s.name = String(name ?? '').trim().slice(0, 60);
  changed();
}

/** Ends a session's shell and removes it. */
export function closeTerminal(s) {
  const at = sessions.indexOf(s);
  if (at === -1) return;
  s.closed = true;
  for (const w of s.waiters.splice(0)) w(null);
  if (s.id && !s.exited) bridge().close(s.id);
  // Closed for good: a terminal kept on its server (tmux) ends there too.
  if (s.keep) bridge()?.endKept?.(s.connId, s.keep).catch(() => {});
  s.term.dispose();
  s.el?.remove();
  sessions.splice(at, 1);
  if (lastFocused === s) lastFocused = null;
  bridge()?.ownKeys(false);
  setTabs(s.host, closeTab(tabsOf(s.host), s.key));
}

/**
 * Types `line` and Enter into the terminal kept for running files on `connId` (one per
 * place; `task`: one per task), opened in `cwd` the first time. `line` may be a function of
 * the shell's kind ('powershell', 'cmd', 'posix', 'wsl'), known once the shell runs, for the
 * quoting. Resolves with the session.
 */
export async function runInTerminal(connId, { cwd = '', line, label = 'Run', enter = true, task = '' }) {
  let s = sessions.find((x) => x.host === PANEL && x.runner && x.connId === connId && (x.task ?? '') === task && !x.exited && !x.closed);
  if (!s) {
    s = await openTerminal(connId, { cwd, label, runner: true, task });
    if (s.exited) return s; // it said why in its screen
  }
  setActiveTerminal(s);
  const text = typeof line === 'function' ? line(s.shell ?? 'posix') : line;
  // Without `enter`, the line is typed for the person to run (Set up… for a language server).
  const typed = enter ? `${text}\r` : text;
  if (s.id && !s.starting) bridge().input(s.id, typed);
  else s.typed += typed;
  return s;
}

/** The next end of a command in `s` ({ code }), or null (the shell ended, or `ms` passed): a new shell's first prompt too. */
export function nextEnd(s, ms = 0) {
  return new Promise((resolve) => {
    let timer = null;
    const w = (end) => {
      clearTimeout(timer);
      resolve(end);
    };
    s.waiters.push(w);
    if (ms)
      timer = setTimeout(() => {
        s.waiters.splice(s.waiters.indexOf(w), 1);
        resolve(null);
      }, ms);
  });
}

/** The text of `s`'s screen from buffer line `from` on (wrapped lines joined). */
function textFrom(s, from) {
  const buffer = s.term.buffer.normal;
  const lines = [];
  for (let i = Math.max(0, from); i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines.join('\n');
}

/**
 * Like runInTerminal, then waits for the command to end: { session, done }, `done` resolving to
 * { code, output } (what it printed from its line on) or null (the shell ended, or it was
 * stopped). Shells with our integration say when a command ended at each prompt; the others
 * get the line's own mark (endMark). A shell just started is waited for until its first prompt.
 */
export async function runAndWait(connId, { cwd = '', line, label = 'Run', task = '' }) {
  let s = sessions.find((x) => x.host === PANEL && x.runner && x.connId === connId && (x.task ?? '') === task && !x.exited && !x.closed);
  if (!s) {
    s = await openTerminal(connId, { cwd, label, runner: true, task });
    if (s.exited) return { session: s, done: Promise.resolve(null) };
    if (s.integrated) await nextEnd(s, 8000);
  }
  setActiveTerminal(s);
  const kind = s.shell ?? 'posix';
  const text = `${typeof line === 'function' ? line(kind) : line}${s.integrated ? '' : endMark(kind)}`;
  const buffer = s.term.buffer.normal;
  const from = buffer.baseY + buffer.cursorY;
  const done = nextEnd(s).then((end) => end && { code: end.code, output: textFrom(s, from) });
  if (s.id && !s.starting) bridge().input(s.id, `${text}\r`);
  else s.typed += `${text}\r`;
  return { session: s, done };
}

/** What to ask the model about in a terminal: its selection, else the last output (wrapped lines joined). */
export function terminalText(s = focusedTerminal(), max = 80) {
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

export const clearTerminal = (s = activeTerminal()) => s?.term.clear();
export const copyFromTerminal = (s = activeTerminal()) => s && copySelection(s.term);
export const pasteIntoTerminal = (s = activeTerminal()) => s && pasteInto(s.term);
export const terminalHasSelection = (s = activeTerminal()) => Boolean(s?.term.hasSelection());

/** The colors follow the app's theme. */
export function retheme() {
  for (const s of sessions) {
    s.term.options.theme = themeNow();
    s.term.options.minimumContrastRatio = contrastNow();
  }
}
