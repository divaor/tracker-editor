// The text's right-click menu, and what Ctrl+click does, by the kind of file. A program gets
// what IDEs offer, in their order: go to the definition, the references, rename, the file's
// symbols, quick fixes and organizing imports (with a language server), formatting, cut, copy,
// paste, a comment, a breakpoint, running, debugging, the test at the cursor, and the model.
// Data and markup files (JSON, YAML, XML…) get formatting and the edit items; prose (plain text,
// Markdown) the shortest menu. Pure, so the Node tests import it: app.js turns the items into a
// Menu with their actions and the keys in effect.

/** Prose and plain text: no names to go to (Ctrl+click keeps opening links there). */
const PROSE = new Set(['', 'Plain text', 'Markdown', 'CSV', 'TSV', 'Diff', 'reStructuredText', 'AsciiDoc', 'Textile', 'Org', 'LaTeX', 'sTeX']);
/** Data and configuration: formatted and commented, but not programs. */
const DATA = new Set(['JSON', 'JSON5', 'YAML', 'TOML', 'XML', 'Properties files', 'INI']);
/** Languages without comments to toggle. */
const NO_COMMENTS = new Set(['JSON']);

/** A file's kind by its CodeMirror language name: 'code', 'data' or 'prose'. */
export function fileKind(language = '') {
  if (PROSE.has(language)) return 'prose';
  if (DATA.has(language)) return 'data';
  return 'code';
}

/** Whether Ctrl+click on a name goes to its definition in this language (programs only). */
export const definesNames = (language) => fileKind(language) === 'code';

/** The edit items' keys (no command of their own: the system's and the editor's). */
export const EDIT_KEYS = { cut: 'Mod+X', copy: 'Mod+C', paste: 'Mod+V', 'select-all': 'Mod+A' };

/**
 * The items of the text's right-click menu, in the order IDEs have them: { id, label, command,
 * disabled? } (command: the commands.js id for its keys, or one of EDIT_KEYS) and { separator:
 * true } between groups, none at the ends or twice. `at`:
 * - language: the CodeMirror language name (its kind decides most of it);
 * - onName: the pointer was on a name (definition, references, rename need one);
 * - hasSelection: Format selection instead of Format document, Ask about the selection;
 * - readOnly: nothing that changes the text;
 * - server: { attached, organizeImports } (what the file's language server does);
 * - runs, debugs, tests: what the Run group offers for this file (breakpoints with debugs);
 * - model: the model panel (Ctrl+K: it answers without a model too, from the guide and the
 *   Claude app); files: the model can change files here.
 */
export function codeMenuItems({ language = '', onName = false, hasSelection = false, readOnly = false, server = {}, runs = false, debugs = false, tests = false, model = true, files = false } = {}) {
  const kind = fileKind(language);
  const items = [];
  const add = (id, label, command, extra = {}) => items.push({ id, label, command, ...extra });
  const sep = () => items.push({ separator: true });
  if (kind === 'code') {
    add('definition', 'Go to definition', 'goto-definition', { disabled: !onName });
    add('references', 'Find all references', 'find-usages', { disabled: !onName });
    if (!readOnly) add('rename', 'Rename symbol', 'rename-symbol', { disabled: !onName });
    add('symbol', 'Go to symbol in file…', 'goto-symbol');
    sep();
    if (!readOnly && server.attached) add('quick-fix', 'Quick fix…', 'quick-fix');
    if (!readOnly && server.organizeImports) add('organize', 'Organize imports', 'organize-imports');
  }
  if (!readOnly && kind !== 'prose') add('format', hasSelection ? 'Format selection' : 'Format document', 'format');
  sep();
  if (!readOnly) add('cut', 'Cut', 'cut');
  add('copy', 'Copy', 'copy');
  if (!readOnly) add('paste', 'Paste', 'paste');
  add('select-all', 'Select all', 'select-all');
  sep();
  if (kind === 'prose') add('find', 'Find in this file…', 'find');
  if (!readOnly && kind !== 'prose' && !NO_COMMENTS.has(language)) add('comment', 'Toggle line comment', 'toggleComment');
  if (kind === 'code' && debugs) add('breakpoint', 'Toggle breakpoint', 'breakpoint-toggle');
  sep();
  if (kind === 'code') {
    if (runs) add('run-file', 'Run this file', 'run-file');
    if (debugs) add('debug-file', 'Debug this file', 'debug-file');
    if (tests) add('test-at-cursor', 'Run the test at the cursor', 'test-at-cursor');
    if (tests && debugs) add('debug-test', 'Debug the test at the cursor', 'debug-test');
    sep();
  }
  if (model) add('ask', hasSelection ? 'Ask the model about the selection…' : 'Ask the model about this…', 'ask-selection');
  if (files) add('files', 'Change files with the model…', 'assist-files');
  return tidy(items);
}

// No separator at the ends or next to another.
function tidy(items) {
  const out = [];
  for (const item of items) {
    if (item.separator && (!out.length || out.at(-1).separator)) continue;
    out.push(item);
  }
  if (out.at(-1)?.separator) out.pop();
  return out;
}
