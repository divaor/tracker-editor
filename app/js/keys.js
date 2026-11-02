// The keys in effect on this device (keybindings.js's table for the settings now): looked up from
// key events by the window's key handler (app.js), the terminal and the macro recorder; shown in
// the palette, Help and Settings → Keys; built into CodeMirror's keymaps (editor.js); and sent to
// the desktop menu, which shows them and takes the ones it registers.
import { COMMAND_LIST, keysFor } from './commands.js';
import { combosOf, commandFor, formatKeys, keyTable, keysChanged, menuAccelerators, ownKeys } from './keybindings.js';
import { isAndroidApp, isDesktopApp } from './platform.js';
import { getSettings, onSettings } from './settings.js';

const platform = () => globalThis.window?.desktop?.platform ?? '';
const inApp = () => isDesktopApp() || isAndroidApp();
const navPlatform = () => globalThis.navigator?.platform ?? '';
/** A Mac's keys (Cmd for Mod, Option for Alt). */
export const isMacKeys = () => platform() === 'darwin' || (!platform() && /Mac|iPhone|iPad/.test(navPlatform()));
/**
 * This device's keys: { mac, desktop, windows }. `desktop` is the app (the desktop app, or the
 * Android app, whose WebView keeps no keys for itself and has the terminal, Folders and the
 * rest of `only: 'desktop'`); features missing there are left to app.js's `usable`.
 */
export const keyContext = () => ({ mac: isMacKeys(), desktop: inApp(), windows: platform() === 'win32' || (!platform() && /Win/.test(navPlatform())) });

let memo = null;
/** The table (keybindings.js keyTable) for `settings`; the same settings give the same table. */
export function currentKeys(settings = getSettings()) {
  const ctx = keyContext();
  if (memo && memo.bindings === settings.keyBindings && memo.preset === settings.keyPreset && memo.mac === ctx.mac && memo.desktop === ctx.desktop) return memo.table;
  const table = keyTable(COMMAND_LIST, { preset: settings.keyPreset ?? '', overrides: settings.keyBindings ?? {}, mac: ctx.mac, desktop: ctx.desktop });
  memo = { bindings: settings.keyBindings, preset: settings.keyPreset, mac: ctx.mac, desktop: ctx.desktop, table };
  return table;
}

/** The command a key press runs (`debugging`: F5 continues; `accept(id)` leaves others out), or null. */
export function commandOfEvent(e, { debugging = false, accept } = {}) {
  return commandFor(currentKeys(), combosOf(e, keyContext()), { when: debugging ? 'debugging' : '', accept });
}

/** Whether a key press is one of `id`'s keys. */
export function isKeyFor(e, id) {
  const owners = currentKeys().owners;
  return combosOf(e, keyContext()).some((c) => (owners.get(c) ?? []).includes(id));
}

/**
 * A command's keys as this device shows them: as commands.js writes them while they are its own
 * ("Ctrl+H", "Mod+P, then @"), else the keys a preset or the person gave it ('' for none). Keys
 * that work only in place are commands.js's.
 */
export function shownKeys(command, settings = getSettings()) {
  const ctx = keyContext();
  if (command.run === false) return keysFor(command, ctx);
  const table = currentKeys(settings);
  if (!table.keys.has(command.id) || !keysChanged(table, command.id)) return keysFor(command, ctx);
  const now = table.keys.get(command.id);
  return now.length ? formatKeys(now, ctx) : '';
}

/** A command's own keys here (commands.js's), as combinations. */
export const ownCombos = (command) => ownKeys(command, keyContext()).combos;

// The desktop menu shows the keys in effect and registers the ones it registers today.
let sent = '';
export function sendMenuKeys(settings = getSettings()) {
  const setMenuKeys = globalThis.window?.desktop?.setMenuKeys;
  if (typeof setMenuKeys !== 'function') return;
  const map = menuAccelerators(currentKeys(settings));
  const json = JSON.stringify(map);
  if (json === sent) return;
  sent = json;
  setMenuKeys(map);
}

const listeners = new Set();
/** Calls `fn` when the keys in effect change (a preset, a change in Settings → Keys, another window). */
export function onKeysChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Started once (app.js): the menu gets the keys now and whenever they change. */
export function startKeys() {
  let was = currentKeys();
  sendMenuKeys();
  return onSettings((s) => {
    const now = currentKeys(s);
    if (now === was) return;
    was = now;
    sendMenuKeys(s);
    for (const fn of listeners) fn(now);
  });
}
