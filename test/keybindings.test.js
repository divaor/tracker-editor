import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_LIST } from '../app/js/commands.js';
import {
  BROWSER_KEYS,
  EDITOR_COMMANDS,
  PRESETS,
  assignKeys,
  cleanBindings,
  cmKey,
  comboProblem,
  combosOf,
  commandFor,
  effectiveKeys,
  electronAccelerator,
  formatCombo,
  keyHolders,
  keyTable,
  keysChanged,
  menuAccelerators,
  ownKeys,
  parseCombo,
  parseKeys,
  recordedCombo,
  resetKeys,
  typesText,
} from '../app/js/keybindings.js';

const byId = (id) => COMMAND_LIST.find((c) => c.id === id);
const WIN = { mac: false, desktop: true };
const MAC = { mac: true, desktop: true };
const WEB = { mac: false, desktop: false };

test('one form for a combination, from commands.js or typed', () => {
  assert.equal(parseCombo('Mod+Shift+P'), 'Mod+Shift+P');
  assert.equal(parseCombo('Shift+Alt+F'), 'Alt+Shift+F', 'modifiers in one order');
  assert.equal(parseCombo('ctrl + shift + p'), 'Mod+Shift+P', 'Ctrl is Mod off a Mac');
  assert.equal(parseCombo('Ctrl+`'), 'Mod+`');
  assert.equal(parseCombo('Ctrl+`', { mac: true }), 'Ctrl+`', 'a Mac’s Control key');
  assert.equal(parseCombo('Cmd+K', { mac: true }), 'Mod+K');
  assert.equal(parseCombo('Win+E'), 'Meta+E');
  assert.equal(parseCombo('Alt+↑'), 'Alt+ArrowUp');
  assert.equal(parseCombo('Mod+Shift+\\'), 'Mod+Shift+\\');
  assert.equal(parseCombo('Ctrl++'), 'Mod+Plus');
  assert.equal(parseCombo('Mod+-'), 'Mod+-');
  assert.equal(parseCombo('Shift+F12'), 'Shift+F12');
  assert.equal(parseCombo('Mod+Shift+Space'), 'Mod+Shift+Space');
  for (const words of ['Mod+P, then @', 'Double-click', 'Middle-click', 'Mod+click', 'Shift+Alt+↑ ↓ ← →', 'Hyper+X', '']) assert.equal(parseCombo(words), null, words);
  assert.deepEqual(parseKeys('Mod+Y · Mod+Shift+Z'), { combos: ['Mod+Y', 'Mod+Shift+Z'], descriptive: false });
  assert.deepEqual(parseKeys('Mod+P, then @'), { combos: [], descriptive: true });
});

test('a key press, layout-safe as CodeMirror reads it', () => {
  const k = (key, code, mods = {}) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.deepEqual(combosOf(k('P', 'KeyP', { ctrlKey: true, shiftKey: true })), ['Mod+Shift+P']);
  assert.deepEqual(combosOf(k('p', 'KeyP', { ctrlKey: true })), ['Mod+P']);
  // Ctrl+? on a US keyboard is Ctrl+Shift+/ by place.
  assert.deepEqual(combosOf(k('?', 'Slash', { ctrlKey: true, shiftKey: true })), ['Mod+?', 'Mod+Shift+/', 'Mod+Shift+?']);
  // "/" is Shift+7 on a German keyboard: Ctrl+/ as typed comes first.
  assert.equal(combosOf(k('/', 'Digit7', { ctrlKey: true, shiftKey: true }))[0], 'Mod+/');
  // A Mac's Option types characters; a Russian layout its letters: by place.
  assert.deepEqual(combosOf(k('π', 'KeyP', { altKey: true }), { mac: true }), ['Alt+P']);
  assert.deepEqual(combosOf(k('∏', 'KeyP', { altKey: true, shiftKey: true }), { mac: true }), ['Alt+Shift+P']);
  assert.deepEqual(combosOf(k('з', 'KeyP', { ctrlKey: true })), ['Mod+P']);
  assert.deepEqual(combosOf(k('p', 'KeyP', { metaKey: true }), { mac: true }), ['Mod+P'], 'Cmd is Mod on a Mac');
  assert.deepEqual(combosOf(k('`', 'Backquote', { ctrlKey: true }), { mac: true }), ['Ctrl+`']);
  // Alt+Shift+0 on a US keyboard types ")".
  assert.ok(combosOf(k(')', 'Digit0', { altKey: true, shiftKey: true })).includes('Alt+Shift+0'));
  assert.deepEqual(combosOf(k('F5', 'F5', { shiftKey: true })), ['Shift+F5']);
  assert.deepEqual(combosOf(k(' ', 'Space', { ctrlKey: true, shiftKey: true })), ['Mod+Shift+Space']);
  assert.deepEqual(combosOf(k('Dead', 'Backquote', { ctrlKey: true })), ['Mod+`']);
  assert.deepEqual(combosOf(k('+', 'NumpadAdd', { ctrlKey: true })), ['Mod+Plus']);
  assert.deepEqual(combosOf(k('Control', 'ControlLeft', { ctrlKey: true })), []);
  // AltGr (Ctrl+Alt on Windows) types characters: not looked up by place.
  assert.deepEqual(combosOf(k('@', 'KeyQ', { ctrlKey: true, altKey: true }), { windows: true }), ['Mod+Alt+@']);
  assert.equal(recordedCombo(k(')', 'Digit0', { altKey: true, shiftKey: true })), 'Alt+Shift+0');
  assert.equal(recordedCombo(k('k', 'KeyK', { ctrlKey: true })), 'Mod+K');
  assert.equal(typesText('Shift+A'), true);
  assert.equal(typesText('Escape'), true);
  assert.equal(typesText('Shift+F5'), false);
  assert.equal(typesText('Alt+N'), false);
});

test('a command’s own keys here: the desktop app’s and the browser’s, a Mac’s', () => {
  assert.deepEqual(ownKeys(byId('close-tab'), WIN).combos, ['Mod+W', 'Alt+W'], 'both close a tab in the desktop app');
  assert.deepEqual(ownKeys(byId('close-tab'), WEB).combos, ['Alt+W']);
  assert.deepEqual(ownKeys(byId('replace'), MAC).combos, ['Mod+Alt+F']);
  assert.deepEqual(ownKeys(byId('goto-symbol-all'), WIN).combos, ['Mod+T']);
  assert.deepEqual(ownKeys(byId('goto-symbol-all'), WEB), { combos: [], text: 'Mod+P, then #' });
});

test('every runnable command’s keys parse, and no two commands share one', () => {
  for (const ctx of [WIN, MAC, WEB]) {
    const seen = new Map();
    for (const c of COMMAND_LIST.filter((x) => x.run !== false && (ctx.desktop || x.only !== 'desktop'))) {
      const own = ownKeys(c, ctx);
      assert.ok(own.combos.length || !own.text || /then/.test(own.text), `${c.id}: ${own.text}`);
      for (const combo of own.combos) {
        const slot = `${c.when ?? ''}|${combo}`;
        assert.ok(!seen.has(slot), `${combo} is both ${seen.get(slot)}’s and ${c.id}’s (${ctx.mac ? 'mac' : ctx.desktop ? 'desktop' : 'web'})`);
        seen.set(slot, c.id);
      }
    }
  }
});

test('presets name real commands, with keys that parse and do not clash', () => {
  const ids = new Set(COMMAND_LIST.filter((c) => c.run !== false).map((c) => c.id));
  for (const [name, preset] of Object.entries(PRESETS)) {
    for (const [id, value] of Object.entries(preset.keys)) {
      assert.ok(ids.has(id), `${name}: ${id}`);
      const lists = Array.isArray(value) ? [value] : [value.keys, value.mac].filter(Array.isArray);
      for (const list of lists) for (const combo of list) assert.ok(parseCombo(combo), `${name}: ${id} ${combo}`);
    }
    for (const ctx of [WIN, MAC]) {
      const seen = new Map();
      for (const [id, combos] of effectiveKeys(COMMAND_LIST, { preset: name, ...ctx })) {
        for (const combo of combos) {
          const slot = `${byId(id).when ?? ''}|${combo}`;
          assert.ok(!seen.has(slot), `${name}: ${combo} for ${seen.get(slot)} and ${id}`);
          seen.set(slot, id);
        }
      }
    }
  }
});

test('the keys in effect: a preset, then your changes, each taking the key from the others', () => {
  const plain = effectiveKeys(COMMAND_LIST, WIN);
  assert.deepEqual(plain.get('command-palette'), ['Mod+Shift+P']);
  assert.deepEqual(plain.get('help'), ['F1']);
  assert.ok(!plain.has('tab-middle'), 'keys that work in place are not bindings');

  const vscode = effectiveKeys(COMMAND_LIST, { preset: 'vscode', ...WIN });
  assert.deepEqual(vscode.get('command-palette'), ['Mod+Shift+P', 'F1']);
  assert.deepEqual(vscode.get('help'), []);
  assert.deepEqual(vscode.get('goto-symbol'), ['Mod+Shift+O']);
  assert.deepEqual(vscode.get('outline'), []);
  assert.deepEqual(vscode.get('debug-file'), ['F5']);
  assert.deepEqual(vscode.get('run-file'), ['Mod+F5']);
  assert.deepEqual(vscode.get('debug-continue'), ['F5'], 'while debugging F5 still continues');
  assert.deepEqual(effectiveKeys(COMMAND_LIST, { preset: 'vscode', ...MAC }).get('goto-line'), ['Ctrl+G']);

  const npp = effectiveKeys(COMMAND_LIST, { preset: 'notepadpp', ...WIN });
  assert.deepEqual(npp.get('duplicateLine'), ['Mod+D']);
  assert.deepEqual(npp.get('selectNext'), ['Mod+F3']);
  assert.deepEqual(npp.get('toggleComment'), ['Mod+Q']);
  assert.deepEqual(npp.get('macro-play'), ['Mod+Shift+P']);
  assert.deepEqual(npp.get('command-palette'), []);
  assert.deepEqual(effectiveKeys(COMMAND_LIST, { preset: 'notepadpp', ...MAC }).get('toggleComment'), ['Mod+/'], 'Cmd+Q quits on a Mac');

  // Your change on top of a preset: the key moves to it.
  const mine = effectiveKeys(COMMAND_LIST, { preset: 'vscode', overrides: { 'quick-open': ['Mod+Shift+P'] }, ...WIN });
  assert.deepEqual(mine.get('quick-open'), ['Mod+Shift+P']);
  assert.deepEqual(mine.get('command-palette'), ['F1']);
  // F5 for something else: Run loses it, debugging keeps its own F5.
  const f5 = effectiveKeys(COMMAND_LIST, { overrides: { 'test-file': ['F5'] }, ...WIN });
  assert.deepEqual(f5.get('run-file'), []);
  assert.deepEqual(f5.get('debug-continue'), ['F5']);
  // Unknown ids and keys that do not parse are left out.
  const odd = effectiveKeys(COMMAND_LIST, { overrides: { nothing: ['Mod+J'], help: ['not a key', 'F4'] }, ...WIN });
  assert.deepEqual(odd.get('help'), ['F4']);
});

test('in the browser, the keys it keeps for itself are left out', () => {
  const web = effectiveKeys(COMMAND_LIST, { preset: 'vscode', ...WEB });
  assert.deepEqual(web.get('close-tab'), ['Alt+W'], 'Ctrl+W and Ctrl+F4 close the browser’s tab: its own key comes back');
  assert.ok(!web.has('run-file'), 'desktop-only commands are not there');
  assert.ok([...web.values()].every((combos) => combos.every((c) => !BROWSER_KEYS.includes(c))));
});

test('looking a key up: aliases, debugging keys, the editor’s commands', () => {
  const table = keyTable(COMMAND_LIST, WIN);
  assert.equal(commandFor(table, ['Mod+Shift+P']), 'command-palette');
  assert.equal(commandFor(table, ['Mod+Plus']), 'text-larger', 'Ctrl++ and the number pad’s + as Ctrl+=');
  assert.equal(commandFor(table, ['Mod+Shift+=']), 'text-larger');
  assert.equal(commandFor(table, ['F5']), 'run-file');
  assert.equal(commandFor(table, ['F5'], { when: 'debugging' }), 'debug-continue');
  assert.equal(commandFor(table, ['F10']), null, 'F10 steps only while debugging');
  assert.equal(commandFor(table, ['Mod+?', 'Mod+Shift+/']), null);
  assert.equal(commandFor(table, ['Mod+/'], { accept: (id) => !EDITOR_COMMANDS.has(id) }), null, 'the editor’s own are CodeMirror’s');
  assert.equal(commandFor(table, ['Mod+/']), 'toggleComment');
  assert.equal(keysChanged(table, 'help'), false);
  assert.equal(keysChanged(keyTable(COMMAND_LIST, { preset: 'vscode', ...WIN }), 'help'), true);
  assert.ok(table.fixed.get('F2')?.includes('fv-rename'), 'keys that work in place are known, to warn about');
});

test('giving a command a key: the others keep the rest of theirs; reset brings its own back', () => {
  const table = keyTable(COMMAND_LIST, WIN);
  assert.deepEqual(keyHolders(table, 'command-palette', 'Mod+B'), ['toggle-sidebar']);
  assert.deepEqual(keyHolders(table, 'debug-continue', 'F5'), [], 'a debugging key lives beside Run’s');
  const next = assignKeys(table, {}, 'command-palette', ['Mod+B']);
  assert.deepEqual(next, { 'command-palette': ['Mod+B'], 'toggle-sidebar': [] });
  const after = effectiveKeys(COMMAND_LIST, { overrides: next, ...WIN });
  assert.deepEqual(after.get('command-palette'), ['Mod+B']);
  assert.deepEqual(after.get('toggle-sidebar'), []);
  // Two keys, one taken from a command with two.
  const redo = assignKeys(table, {}, 'command-palette', ['Mod+Shift+P', 'Mod+Y']);
  assert.deepEqual(redo.redo, ['Mod+Shift+Z']);
  assert.deepEqual(resetKeys(next, 'command-palette'), { 'toggle-sidebar': [] });
});

test('keys a device keeps, and keys that type, are refused', () => {
  assert.match(comboProblem('Shift+A', WIN), /types text/);
  assert.match(comboProblem('Mod+C', WIN), /copies/);
  assert.match(comboProblem('Mod+Q', MAC), /Cmd\+Q quits/);
  assert.equal(comboProblem('Mod+Q', WIN), '');
  assert.match(comboProblem('Mod+W', WEB), /browser keeps Ctrl\+W/);
  assert.equal(comboProblem('Mod+W', WIN), '');
  assert.match(comboProblem('F11', WIN), /full screen/);
  assert.equal(comboProblem('F11', WEB), '');
  assert.equal(comboProblem('Mod+Alt+K', WIN), '');
});

test('keys as shown, as the menu’s accelerators and as CodeMirror’s keys', () => {
  assert.equal(formatCombo('Mod+Alt+ArrowUp'), 'Ctrl+Alt+↑');
  assert.equal(formatCombo('Mod+Alt+ArrowUp', { mac: true }), 'Cmd+Option+↑');
  assert.equal(formatCombo('Alt+Shift+F', { mac: true }), 'Option+Shift+F');
  assert.equal(electronAccelerator('Mod+Shift+P'), 'CmdOrCtrl+Shift+P');
  assert.equal(electronAccelerator('Mod+`'), 'CmdOrCtrl+`');
  assert.equal(electronAccelerator('Ctrl+`', { mac: true }), 'Ctrl+`');
  assert.equal(electronAccelerator('Alt+ArrowUp'), 'Alt+Up');
  assert.equal(electronAccelerator('Mod+Plus'), 'CmdOrCtrl+Plus');
  assert.equal(cmKey('Mod+Shift+P'), 'Mod-Shift-p');
  assert.equal(cmKey('Mod+Shift+['), 'Mod-Shift-[');
  assert.equal(cmKey('Alt+ArrowUp'), 'Alt-ArrowUp');
  assert.equal(cmKey('Mod+Plus'), 'Mod-+');
  assert.equal(cmKey('Mod+-'), 'Mod--');
  const menu = menuAccelerators(keyTable(COMMAND_LIST, { overrides: { 'toggle-sidebar': [] }, ...WIN }));
  assert.equal(menu['command-palette'], 'CmdOrCtrl+Shift+P');
  assert.equal(menu['close-tab'], 'CmdOrCtrl+W', 'the desktop key first');
  assert.equal(menu['toggle-sidebar'], '', 'no key: the menu shows none');
  assert.equal(menu.trash, '');
});

test('keys from a file or the settings are cleaned', () => {
  const ids = new Set(['help', 'command-palette']);
  assert.deepEqual(cleanBindings({ help: ['F4', 'nonsense', 'Shift+A'], 'command-palette': [], gone: ['F6'], bad: 'x' }, ids, WIN), { help: ['F4'], 'command-palette': [] });
  assert.deepEqual(cleanBindings(null, ids), {});
  assert.deepEqual(cleanBindings(['F4'], ids), {});
});

test('0.48: the next and previous change since the last commit: Alt+F3, and VS Code’s Alt+F5 too', () => {
  const plain = effectiveKeys(COMMAND_LIST, WIN);
  assert.deepEqual(plain.get('git-next-change'), ['Alt+F3']);
  assert.deepEqual(plain.get('git-prev-change'), ['Alt+Shift+F3']);
  assert.deepEqual(plain.get('debug-file'), ['Alt+F5'], 'Alt+F5 stays Debug');
  assert.deepEqual(plain.get('git-revert-change'), [], 'reverting has no key of its own');
  const vs = effectiveKeys(COMMAND_LIST, { ...WIN, preset: 'vscode' });
  assert.deepEqual(vs.get('git-next-change'), ['Alt+F5', 'Alt+F3']);
  assert.deepEqual(vs.get('git-prev-change'), ['Alt+Shift+F5', 'Alt+Shift+F3']);
  assert.deepEqual(vs.get('debug-file'), ['F5']);
  assert.equal(effectiveKeys(COMMAND_LIST, WEB).has('git-next-change'), false, 'the desktop app’s');
});
