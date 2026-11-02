// Keys your way: every command's keys as this device has them. A key combination has one form,
// "Mod+Shift+P": Mod is Ctrl (Cmd on a Mac), then Ctrl (a Mac's Control key), Meta (the Windows
// key), Alt and Shift, then the key ("P", "5", "/", "F12", "ArrowUp", "Space", "Plus"). It is read
// from commands.js's strings and from key events, layout-safe as CodeMirror's keymaps are: a letter
// as the layout has it (by its place when that is not a Latin letter: a Russian keyboard, a Mac's
// Option), a digit or a mark as typed and then by its place. A command's keys are its own
// (commands.js), then a preset's (VS Code, Notepad++), then the person's changes (settings
// `keyBindings`: id → [combos], [] for none; `keyPreset`); a key a later layer gives one command is
// taken from the others. Pure (no DOM), so the Node tests import it; keys.js keeps the keys in effect
// for the page, editor.js builds CodeMirror's keymap from them and the desktop menu shows them.

export const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Hyper', 'Super', 'Fn', 'FnLock', 'NumLock', 'ScrollLock', 'Process']);

// The character a key's place has on a US keyboard (KeyboardEvent.code).
const BASE = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', IntlBackslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' };
for (let i = 0; i < 26; i++) BASE[`Key${String.fromCharCode(65 + i)}`] = String.fromCharCode(65 + i);
for (let i = 0; i < 10; i++) BASE[`Digit${i}`] = String(i);

const NAMED = ['Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Plus', 'ContextMenu', 'Pause', 'PrintScreen'];
const ALIASES = {
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  Esc: 'Escape',
  Del: 'Delete',
  Return: 'Enter',
  Ins: 'Insert',
  PgUp: 'PageUp',
  PgDn: 'PageDown',
  Spacebar: 'Space',
  ' ': 'Space',
  '+': 'Plus',
};
const isFKey = (k) => /^F([1-9]|1\d|2[0-4])$/.test(k);

/** A key's name in a combination ("P", "5", "/", "F12", "ArrowUp", "Plus"), or null when it is none. */
export function keyName(token) {
  if (typeof token !== 'string' || !token) return null;
  if (ALIASES[token]) return ALIASES[token];
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[\x21-\x7e]$/.test(token)) return token;
  if (isFKey(token.toUpperCase())) return token.toUpperCase();
  return NAMED.find((n) => n.toLowerCase() === token.toLowerCase()) ?? null;
}

const MOD_WORDS = { mod: 'Mod', cmdorctrl: 'Mod', commandorcontrol: 'Mod', ctrl: 'Ctrl', control: 'Ctrl', cmd: 'Cmd', command: 'Cmd', meta: 'Meta', win: 'Meta', super: 'Meta', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift' };

/**
 * A combination in its one form, from text such as commands.js has ("Mod+Shift+P", "Ctrl+`",
 * "Alt+↑", "Shift+F12") or a person wrote ("Cmd+K", "ctrl + shift + p"); null when it is not one.
 * `mac`: Cmd is Mod and Ctrl the Control key; elsewhere Ctrl is Mod and Cmd or Win the Meta key.
 */
export function parseCombo(text, { mac = false } = {}) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  if (!t || t.length > 48) return null;
  let key = null;
  // "Ctrl++": the last + is the key.
  if (t.endsWith('++')) {
    key = 'Plus';
    t = t.slice(0, -2);
  }
  const parts = t ? t.split('+').map((p) => p.trim()) : [];
  if (key === null) key = keyName(parts.pop());
  if (!key) return null;
  const mods = new Set();
  for (const p of parts) {
    const word = MOD_WORDS[p.toLowerCase()];
    if (!word) return null;
    if (word === 'Cmd') mods.add(mac ? 'Mod' : 'Meta');
    else if (word === 'Ctrl') mods.add(mac ? 'Ctrl' : 'Mod');
    else if (word === 'Meta') mods.add(mac ? 'Mod' : 'Meta');
    else mods.add(word);
  }
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+');
}

/**
 * The combinations in a commands.js string ("Mod+Y · Mod+Shift+Z"): { combos, descriptive };
 * `descriptive` when they are words rather than keys ("Mod+P, then @", "Double-click").
 */
export function parseKeys(text, opts = {}) {
  if (!text) return { combos: [], descriptive: false };
  const combos = String(text)
    .split(' · ')
    .map((t) => parseCombo(t, opts));
  return combos.every(Boolean) ? { combos: [...new Set(combos)], descriptive: false } : { combos: [], descriptive: true };
}

/**
 * The combinations a key press can stand for, in the order to look them up (as CodeMirror's
 * keymaps do): a letter as the layout has it, or by its place when the layout's character is not
 * a Latin one; a digit or a mark as typed (Shift is in the character: "/" is Shift+7 on a German
 * keyboard), then by its place with Shift ("Mod+Shift+/" for Ctrl+? on a US one); other keys by
 * name, a dead key by its place. [] for a modifier alone. `windows`: Ctrl+Alt is AltGr there, which
 * types characters, so those are not looked up by place.
 */
export function combosOf(e, { mac = false, windows = false } = {}) {
  const key = e?.key;
  if (typeof key !== 'string' || !key || MODIFIER_KEYS.has(key)) return [];
  const mods = (shift) => {
    const out = [];
    if (mac ? e.metaKey : e.ctrlKey) out.push('Mod');
    if (mac && e.ctrlKey) out.push('Ctrl');
    if (!mac && e.metaKey) out.push('Meta');
    if (e.altKey) out.push('Alt');
    if (shift && e.shiftKey) out.push('Shift');
    return out;
  };
  const join = (m, k) => [...m, k].join('+');
  const base = BASE[e.code] ?? null;
  if ([...key].length !== 1 || key === ' ') {
    if (key === 'Dead' || key === 'Unidentified') return base ? [join(mods(true), base)] : [];
    const name = keyName(key === ' ' ? 'Space' : key);
    return name ? [join(mods(true), name)] : [];
  }
  if (/^[a-z]$/i.test(key)) return [join(mods(true), key.toUpperCase())];
  if (!/^[\x21-\x7e]$/.test(key)) return base ? [join(mods(true), base)] : [];
  const name = keyName(key);
  const out = [join(mods(false), name)];
  if (base && base !== key && (e.ctrlKey || e.altKey || e.metaKey) && !(windows && e.ctrlKey && e.altKey)) out.push(join(mods(true), base));
  if (e.shiftKey) out.push(join(mods(true), name));
  return [...new Set(out)];
}

/**
 * The combination to keep for a key pressed in Settings → Keys: as typed, except a digit or a
 * mark with Shift and Ctrl, Alt or Cmd, kept by its place ("Alt+Shift+0" rather than "Alt+)", as
 * commands.js writes them); '' for a modifier alone.
 */
export function recordedCombo(e, opts = {}) {
  const all = combosOf(e, opts);
  if (!all.length) return '';
  if (e.shiftKey && (e.ctrlKey || e.altKey || e.metaKey) && all.length > 1 && all[1].includes('Shift+')) return all[1];
  return all[0];
}

/** Whether a combination types text where text is typed (no Ctrl, Alt or Cmd, and not F1–F24). */
export function typesText(combo) {
  const parts = String(combo).split('+');
  const key = parts.pop();
  return !parts.some((m) => m === 'Mod' || m === 'Ctrl' || m === 'Meta' || m === 'Alt') && !isFKey(key);
}

// ---- Commands' keys ----

/** Commands CodeMirror runs (editor.js builds their keymap from these keys): only while a text has the focus. */
export const EDITOR_COMMANDS = new Set([
  'find',
  'replace',
  'goto-line',
  'selectNext',
  'format',
  'toggleComment',
  'duplicateLine',
  'deleteLine',
  'selectLine',
  'undo',
  'redo',
  'upperCase',
  'lowerCase',
  'sortLines',
  'removeDuplicateLines',
  'trimTrailing',
  'addCursorAbove',
  'addCursorBelow',
  'goto-definition',
  'find-usages',
  'rename-symbol',
  'quick-fix',
  'organize-imports',
  'matchingBracket',
  'fold',
  'unfold',
  'foldAll',
  'unfoldAll',
  'foldTop',
  'foldLevel2',
  'foldLevel3',
  'nextProblem',
  'previousProblem',
]);

/**
 * A command's own keys here: { combos, text }. The desktop app has its `desktop` keys first and its
 * `keys` too (Ctrl+W and Alt+W close a tab there); a Mac its `mac` keys instead of `keys`. `text`:
 * commands.js's words when they are not keys ("Mod+P, then @").
 */
export function ownKeys(command, { mac = false, desktop = false } = {}) {
  const main = mac && command.mac ? command.mac : command.keys;
  const parsed = parseKeys(main, { mac });
  const desk = desktop && command.desktop ? parseKeys(command.desktop, { mac }) : { combos: [], descriptive: false };
  return { combos: [...new Set([...desk.combos, ...parsed.combos])], text: parsed.descriptive ? main : desk.descriptive ? command.desktop : '' };
}

// Keys a browser keeps for itself (a new window or tab, closing one, switching): not in the web app.
export const BROWSER_KEYS = ['Mod+N', 'Mod+Shift+N', 'Mod+T', 'Mod+Shift+T', 'Mod+W', 'Mod+Shift+W', 'Mod+Q', 'Mod+Tab', 'Mod+Shift+Tab', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Mod+PageUp', 'Mod+PageDown', 'Mod+F4', 'Alt+F4'];

/**
 * Presets: the keys VS Code and Notepad++ give the commands this editor has (on Windows and Linux;
 * `mac` for a Mac's own, null to leave one as it is there). Chords (VS Code's Ctrl+K Ctrl+0) are
 * left out, and so are keys this editor keeps for its column selection (VS Code's Shift+Alt+↓
 * copies the line) and for keys that work in place (Notepad++'s Ctrl+Shift+L deletes the line here
 * it selects every occurrence).
 */
export const PRESETS = {
  vscode: {
    label: 'VS Code',
    keys: {
      // F1 is VS Code's command palette (Help stays in the menu and the palette).
      'command-palette': ['Mod+Shift+P', 'F1'],
      help: [],
      'quick-open': { keys: ['Mod+P', 'Mod+E'], mac: ['Mod+P'] },
      // Go to Symbol in Editor; the outline has no key there.
      'goto-symbol': ['Mod+Shift+O'],
      outline: [],
      // Search: Replace in Files too.
      'find-in-files': ['Mod+Shift+F', 'Mod+Shift+H'],
      // Go to Line is Ctrl+G on a Mac too (Cmd+G finds the next match there).
      'goto-line': { keys: ['Mod+G'], mac: ['Ctrl+G'] },
      // Markdown: Open Preview.
      preview: ['Mod+Shift+V'],
      'clipboard-history': [],
      // Source control; Go to Next / Previous Change (Alt+F5, free here once F5 debugs) and Show Next / Previous Change.
      'git-panel': { keys: ['Mod+Shift+G'], mac: ['Ctrl+Shift+G'] },
      'git-next-change': ['Alt+F5', 'Alt+F3'],
      'git-prev-change': ['Shift+Alt+F5', 'Shift+Alt+F3'],
      // F5 debugs, Ctrl+F5 runs without debugging; while debugging F6 pauses, Ctrl+Shift+F5 restarts.
      'debug-file': ['F5'],
      'run-file': { keys: ['Mod+F5'], mac: ['Ctrl+F5'] },
      'test-at-cursor': [],
      'test-file': [],
      'debug-pause': ['F6'],
      'debug-restart': ['Mod+Shift+F5'],
      'close-tab': { keys: ['Mod+W', 'Mod+F4'], mac: ['Mod+W'] },
      'next-tab': { keys: ['Ctrl+Tab', 'Mod+PageDown'], mac: ['Ctrl+Tab', 'Mod+Alt+ArrowRight'] },
      'prev-tab': { keys: ['Ctrl+Shift+Tab', 'Mod+PageUp'], mac: ['Ctrl+Shift+Tab', 'Mod+Alt+ArrowLeft'] },
    },
  },
  notepadpp: {
    label: 'Notepad++',
    keys: {
      // Edit: Duplicate Current Line, Select and Find Next, Toggle Single Line Comment (Cmd+Q quits on a Mac), case.
      duplicateLine: ['Mod+D'],
      selectNext: ['Mod+F3'],
      toggleComment: { keys: ['Mod+Q'], mac: null },
      upperCase: ['Mod+Shift+U'],
      lowerCase: ['Mod+U'],
      // Search: Go to Matching Brace (the file list keeps its menu item).
      matchingBracket: ['Mod+B'],
      'toggle-sidebar': [],
      // Macro: Start/Stop Recording is Ctrl+Shift+R as here; Playback is Ctrl+Shift+P (Ctrl+P, then > still runs commands).
      'macro-play': ['Mod+Shift+P'],
      'command-palette': [],
      // File: Save As, close, the next and previous tab.
      'save-copy': ['Mod+Alt+S'],
      'close-tab': { keys: ['Mod+W', 'Mod+F4'], mac: ['Mod+W'] },
      'next-tab': ['Ctrl+Tab', 'Mod+PageDown'],
      'prev-tab': ['Ctrl+Shift+Tab', 'Mod+PageUp'],
      // View: Fold and Unfold the current level (left as they are on a Mac, where Cmd+Option+F replaces).
      fold: { keys: ['Mod+Alt+F'], mac: null },
      unfold: { keys: ['Mod+Alt+Shift+F'], mac: null },
    },
  },
};
export const PRESET_IDS = ['', ...Object.keys(PRESETS)];

// A layer's keys for a command: an array, or { keys, mac } (mac null: as it is); null for no change.
function layerCombos(value, { mac }) {
  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? (mac && 'mac' in value ? value.mac : value.keys) : null;
  if (!Array.isArray(list)) return null;
  return [...new Set(list.map((c) => parseCombo(String(c), { mac })).filter(Boolean))];
}

/**
 * The keys of every command here: Map id → [combos]. Commands whose keys work only in place
 * (`run: false`) have none; desktop-only ones exist only in the desktop app. Layers: the commands'
 * own keys, `preset`, then `overrides`; a key a layer gives one command is taken from the others it
 * clashes with (the same `when`: debugging's F5 lives beside Run's). In the browser the keys it keeps
 * (Ctrl+W, Ctrl+T…) are left out, and a command left with none gets its own back.
 */
export function effectiveKeys(commands, { preset = '', overrides = {}, mac = false, desktop = false } = {}) {
  const list = commands.filter((c) => c.run !== false && (desktop || c.only !== 'desktop'));
  const byId = new Map(list.map((c) => [c.id, c]));
  const own = new Map(list.map((c) => [c.id, ownKeys(c, { mac, desktop }).combos]));
  const keys = new Map(own);
  const whenOf = (id) => byId.get(id)?.when ?? '';
  const take = (id, combos) => {
    for (const [other, have] of keys) {
      if (other === id || whenOf(other) !== whenOf(id)) continue;
      const left = have.filter((c) => !combos.includes(c));
      if (left.length !== have.length) keys.set(other, left);
    }
  };
  const apply = (layer) => {
    for (const [id, value] of Object.entries(layer ?? {})) {
      if (!byId.has(id)) continue;
      const combos = layerCombos(value, { mac });
      if (combos === null) continue;
      keys.set(id, combos);
      take(id, combos);
    }
  };
  apply(PRESETS[preset]?.keys);
  apply(overrides && typeof overrides === 'object' ? overrides : {});
  if (!desktop) {
    for (const [id, have] of keys) {
      const kept = have.filter((c) => !BROWSER_KEYS.includes(c));
      if (kept.length === have.length) continue;
      const taken = (c) => [...keys].some(([other, h]) => other !== id && whenOf(other) === whenOf(id) && h.includes(c));
      keys.set(id, kept.length ? kept : own.get(id).filter((c) => !BROWSER_KEYS.includes(c) && !taken(c)));
    }
  }
  return keys;
}

// Ctrl+= also as Ctrl++ (Shift, or the number pad's +), Ctrl+- as Ctrl+_ (as textSize.js read them).
export const KEY_ALIASES = { 'Mod+=': ['Mod+Plus', 'Mod+Shift+=', 'Mod+Shift+Plus'], 'Mod+-': ['Mod+_', 'Mod+Shift+-'] };

/**
 * Everything to look keys up with: { keys (effectiveKeys), owners: Map combo → [ids], whenOf,
 * own: Map id → own combos, fixed: Map combo → [ids] of keys that work in place }.
 */
export function keyTable(commands, opts = {}) {
  const keys = effectiveKeys(commands, opts);
  const owners = new Map();
  const add = (combo, id) => {
    const list = owners.get(combo) ?? [];
    if (!list.includes(id)) list.push(id);
    owners.set(combo, list);
  };
  for (const [id, combos] of keys) for (const c of combos) add(c, id);
  for (const [id, combos] of keys) for (const c of combos) for (const a of KEY_ALIASES[c] ?? []) if (!owners.has(a)) add(a, id);
  const ctx = { mac: Boolean(opts.mac), desktop: Boolean(opts.desktop) };
  const own = new Map(commands.filter((c) => keys.has(c.id)).map((c) => [c.id, ownKeys(c, ctx).combos]));
  const fixed = new Map();
  for (const c of commands.filter((x) => x.run === false && (ctx.desktop || x.only !== 'desktop'))) {
    for (const t of String((ctx.mac && c.mac) || c.keys || '').split(/ · | \/ /)) {
      const combo = parseCombo(t, ctx);
      if (combo) fixed.set(combo, [...(fixed.get(combo) ?? []), c.id]);
    }
  }
  return { keys, owners, whenOf: new Map(commands.map((c) => [c.id, c.when ?? ''])), own, fixed, ctx };
}

/**
 * The command the first of `combos` that has one runs: one with a `when` matching `when` (while
 * debugging, F5 continues) before a plain one; `accept(id)` leaves others out. null when none.
 */
export function commandFor(table, combos, { when = '', accept = () => true } = {}) {
  for (const combo of combos) {
    const ids = (table.owners.get(combo) ?? []).filter(accept);
    const hit = ids.find((id) => table.whenOf.get(id) && table.whenOf.get(id) === when) ?? ids.find((id) => !table.whenOf.get(id));
    if (hit) return hit;
  }
  return null;
}

/** Whether a command's keys differ from its own (a preset or the person changed them). */
export function keysChanged(table, id) {
  const now = table.keys.get(id) ?? [];
  const own = table.own.get(id) ?? [];
  return now.length !== own.length || now.some((c) => !own.includes(c));
}

/** The commands that would lose `combo` if `id` took it (the same `when`). */
export function keyHolders(table, id, combo) {
  const when = table.whenOf.get(id) ?? '';
  return (table.owners.get(combo) ?? []).filter((other) => other !== id && (table.whenOf.get(other) ?? '') === when && (table.keys.get(other) ?? []).includes(combo));
}

/**
 * The person's changes after giving `id` the keys `combos`: the others that had one of them keep
 * the rest of theirs (written as their own change), so the key moves.
 */
export function assignKeys(table, overrides, id, combos) {
  const next = { ...(overrides ?? {}), [id]: [...new Set(combos)] };
  for (const combo of combos) {
    for (const other of keyHolders(table, id, combo)) next[other] = (next[other] ?? table.keys.get(other) ?? []).filter((c) => c !== combo);
  }
  return next;
}

/** The person's changes without theirs for `id` (its keys come back from the preset or its own). */
export function resetKeys(overrides, id) {
  const { [id]: _gone, ...rest } = overrides ?? {};
  return rest;
}

// Keys this device or the app keeps for itself: never given to a command.
const SYSTEM = {
  all: { 'Mod+C': 'copies', 'Mod+X': 'cuts', 'Mod+V': 'pastes', 'Mod+A': 'selects everything' },
  mac: { 'Mod+Q': 'quits the app', 'Mod+H': 'hides the app', 'Mod+M': 'minimizes the window', 'Mod+Tab': 'switches apps', 'Mod+Space': 'is Spotlight', 'Mod+Alt+I': 'opens the developer tools' },
  other: { 'Alt+F4': 'closes the window', 'Alt+Tab': 'switches windows', 'Mod+Alt+Delete': 'is the system’s', 'Mod+Shift+Escape': 'opens the Task Manager', 'Mod+Shift+I': 'opens the developer tools' },
  desktop: { 'Mod+R': 'reloads the window', F11: 'is full screen' },
};

/** Why `combo` cannot be a command's key here ('' when it can). */
export function comboProblem(combo, { mac = false, desktop = false } = {}) {
  if (!combo) return 'That is not a key.';
  if (typesText(combo)) return 'A key without Ctrl, Alt or Cmd types text: hold one of them too, or use F1–F12.';
  const label = formatCombo(combo, { mac });
  const why = SYSTEM.all[combo] ?? (mac ? SYSTEM.mac[combo] : SYSTEM.other[combo]) ?? (desktop ? SYSTEM.desktop[combo] : null);
  if (why) return `${label} ${why}: pick another one.`;
  if (!desktop && BROWSER_KEYS.includes(combo)) return `The browser keeps ${label} for itself: it works in the desktop app only.`;
  return '';
}

// ---- Showing keys ----

const SHOWN = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Delete: 'Del' };

/** A combination as this device shows it: "Ctrl+Shift+P", "Cmd+Option+↑". */
export function formatCombo(combo, { mac = false } = {}) {
  const parts = String(combo).split('+');
  const key = parts.pop();
  const names = parts.map((m) => (m === 'Mod' ? (mac ? 'Cmd' : 'Ctrl') : m === 'Alt' ? (mac ? 'Option' : 'Alt') : m === 'Meta' ? (mac ? 'Cmd' : 'Win') : m));
  return [...names, SHOWN[key] ?? key].join('+');
}
export const formatKeys = (combos, opts) => combos.map((c) => formatCombo(c, opts)).join(' · ');

const ELECTRON_KEYS = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Escape: 'Esc' };

/** A combination as an Electron accelerator: "CmdOrCtrl+Shift+P", "Ctrl+`", "Alt+Up". */
export function electronAccelerator(combo, { mac = false } = {}) {
  const parts = String(combo).split('+');
  const key = parts.pop();
  const mods = parts.map((m) => (m === 'Mod' ? 'CmdOrCtrl' : m === 'Meta' ? (mac ? 'Cmd' : 'Super') : m));
  return [...mods, ELECTRON_KEYS[key] ?? key].join('+');
}

/** The desktop menu's keys: id → its first key as an accelerator ('' for none), for every command with keys here. */
export function menuAccelerators(table) {
  const out = {};
  for (const [id, combos] of table.keys) out[id] = combos[0] ? electronAccelerator(combos[0], table.ctx) : '';
  return out;
}

/** A combination as a CodeMirror key: "Mod-Shift-p", "Alt-ArrowUp", "Ctrl-Shift-[", "Mod-+". */
export function cmKey(combo) {
  const parts = String(combo).split('+');
  const key = parts.pop();
  const name = key === 'Plus' ? '+' : /^[A-Z]$/.test(key) ? key.toLowerCase() : key;
  return [...parts, name].join('-');
}

/**
 * The person's changes from a file or settings, cleaned: known command ids (`ids`), each a list of
 * combinations that parse and can be keys here; anything else is left out.
 */
export function cleanBindings(value, ids, opts = {}) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, list] of Object.entries(value)) {
    if (!ids.has(id) || !Array.isArray(list) || list.length > 8) continue;
    out[id] = [...new Set(list.map((c) => parseCombo(String(c), opts)).filter((c) => c && !comboProblem(c, { ...opts, desktop: true })))];
  }
  return out;
}
