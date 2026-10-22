// CodeMirror: one EditorView and one EditorState per open tab, so every tab
// keeps its own undo history, selection and scroll position. Languages load
// on demand (by file name, or as chosen); theme, wrapping, whitespace, font
// size and tab size apply live to all tabs.
import {
  Annotation,
  Compartment,
  Decoration,
  EditorSelection,
  EditorState,
  EditorView,
  HighlightStyle,
  LanguageDescription,
  StateEffect,
  StateField,
  autocompletion,
  bracketMatching,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
  copyLineDown,
  crosshairCursor,
  defaultHighlightStyle,
  defaultKeymap,
  deleteLine,
  drawSelection,
  dropCursor,
  foldGutter,
  foldKeymap,
  gotoLine,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSelectionMatches,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  history,
  historyKeymap,
  indentOnInput,
  indentUnit,
  indentWithTab,
  keymap,
  languages,
  lineNumbers,
  oneDarkHighlightStyle,
  openSearchPanel,
  placeholder,
  rectangularSelection,
  redo,
  search,
  searchKeymap,
  selectNextOccurrence,
  syntaxHighlighting,
  tags,
  toggleComment,
  undo,
} from '../vendor/cm/codemirror.js';

export { languages };

const remote = Annotation.define();

// Markdown headings in bold and the accent color (the default style underlines them, spaces included).
const withHeadings = (style) => HighlightStyle.define([...style.specs.filter((s) => s.tag !== tags.heading), { tag: tags.heading, fontWeight: 'bold', color: 'var(--accent)' }]);
const LIGHT_STYLE = withHeadings(defaultHighlightStyle);
const DARK_STYLE = withHeadings(oneDarkHighlightStyle);

// The passage being read aloud.
const setReading = StateEffect.define();
const readingMark = Decoration.mark({ class: 'cm-reading' });
const readingField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects) if (e.is(setReading)) marks = e.value ? Decoration.set([readingMark.range(e.value.from, e.value.to)]) : Decoration.none;
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const PLAIN_TEXT = 'Plain text';
export const languageNames = () => [PLAIN_TEXT, ...languages.map((l) => l.name).sort((a, b) => a.localeCompare(b))];

/** The language for a file: the one chosen for it, else by its name (extension). */
export function findLanguage(name, chosen = '') {
  if (chosen === PLAIN_TEXT) return null;
  if (chosen) return LanguageDescription.matchLanguageName(languages, chosen, false);
  return LanguageDescription.matchFilename(languages, name) ?? null;
}

/** A guess for untitled tabs from what was pasted. */
export function guessLanguage(text) {
  const t = text.trimStart();
  if (!t) return '';
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(text);
      return 'JSON';
    } catch {
      // not JSON
    }
  }
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return 'HTML';
  if (/^<\?xml/.test(t)) return 'XML';
  if (/^#!.*\b(bash|sh|zsh)\b/.test(t)) return 'Shell';
  if (/^#!.*\bpython/.test(t) || /^(def|class|import|from) \w+.*:?\s*$/m.test(t.slice(0, 400)) && /:\s*$/m.test(t.slice(0, 400))) return 'Python';
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\b/i.test(t)) return 'SQL';
  if (/^#{1,6} \S|^\s*[-*] \[[ x]\]/m.test(t.slice(0, 600))) return 'Markdown';
  return '';
}

function baseTheme(dark) {
  return EditorView.theme(
    {
      '&': { height: '100%', backgroundColor: 'var(--surface)', color: 'var(--text)', fontSize: 'var(--editor-font-size, 14px)' },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
      '.cm-content': { caretColor: 'var(--accent)', padding: '6px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: dark ? 'rgba(139,133,245,.32) !important' : 'rgba(79,70,229,.2) !important' },
      '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-3)', borderRight: '1px solid var(--border)' },
      '.cm-activeLine': { backgroundColor: dark ? 'rgba(255,255,255,.035)' : 'rgba(25,23,18,.035)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
      '.cm-selectionMatch': { backgroundColor: dark ? 'rgba(224,169,74,.22)' : 'rgba(183,121,31,.18)' },
      '.cm-searchMatch': { backgroundColor: dark ? 'rgba(224,169,74,.3)' : 'rgba(183,121,31,.25)', outline: '1px solid var(--warn)' },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: dark ? 'rgba(139,133,245,.45)' : 'rgba(79,70,229,.3)' },
      '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--border)' },
      '.cm-panel input, .cm-panel button': { fontFamily: 'var(--font)', fontSize: '13px' },
      '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px' },
      '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-2)' },
      '.cm-highlightSpace': { backgroundImage: `radial-gradient(circle at 50% 55%, ${dark ? '#6d6a63' : '#b8b4aa'} 11%, transparent 5%)` },
      '.cm-trailingSpace': { backgroundColor: dark ? 'rgba(239,107,107,.18)' : 'rgba(194,59,59,.12)' },
      '.cm-reading': { backgroundColor: dark ? 'rgba(52,211,153,.2)' : 'rgba(16,185,129,.18)', borderRadius: '2px' },
    },
    { dark },
  );
}

const transform = (fn) => (view) => {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    if (range.empty) return { range };
    const text = fn(state.sliceDoc(range.from, range.to));
    return { changes: { from: range.from, to: range.to, insert: text }, range: EditorSelection.range(range.from, range.from + text.length) };
  });
  view.dispatch(state.update(changes, { userEvent: 'input' }));
  return true;
};

const withLines = (fn) => (view) => {
  const { state } = view;
  const sel = state.selection.main;
  const fromLine = state.doc.lineAt(sel.empty ? 0 : sel.from);
  const toLine = state.doc.lineAt(sel.empty ? state.doc.length : sel.to);
  const text = state.sliceDoc(fromLine.from, toLine.to);
  const next = fn(text.split('\n')).join('\n');
  if (next !== text) view.dispatch({ changes: { from: fromLine.from, to: toLine.to, insert: next }, userEvent: 'input' });
  return true;
};

/** Editing commands beyond CodeMirror's keymaps (menus and the command list). */
export const COMMANDS = {
  undo,
  redo,
  find: openSearchPanel,
  replace: (view) => {
    openSearchPanel(view);
    setTimeout(() => view.dom.querySelector('.cm-search [name=replace]')?.focus(), 0);
    return true;
  },
  gotoLine,
  selectNext: selectNextOccurrence,
  toggleComment,
  duplicateLine: copyLineDown,
  deleteLine,
  upperCase: transform((s) => s.toUpperCase()),
  lowerCase: transform((s) => s.toLowerCase()),
  sortLines: withLines((lines) => [...lines].sort((a, b) => a.localeCompare(b))),
  removeDuplicateLines: withLines((lines) => [...new Set(lines)]),
  trimTrailing: withLines((lines) => lines.map((l) => l.replace(/[ \t]+$/, ''))),
  formatJson: (view) => {
    const text = view.state.doc.toString();
    const formatted = `${JSON.stringify(JSON.parse(text), null, view.state.tabSize)}\n`;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: formatted }, userEvent: 'input' });
    return true;
  },
};

/**
 * Creates the editor in `parent`. `onChange(key, text, { urgent })` gets the text of the
 * tab after you type (debounced); `onCursor(info)` the cursor position.
 */
export function createEditorHost(parent, { onChange, onCursor, onShortcut, settings }) {
  const states = new Map(); // key → EditorState
  const scroll = new Map(); // key → scroll position
  const pending = new Map(); // key → timer for onChange
  const lang = new Compartment();
  const theme = new Compartment();
  const wrap = new Compartment();
  const whitespace = new Compartment();
  const tabs = new Compartment();
  const gutter = new Compartment();
  let options = settings;
  let active = null;

  const configFor = (o) => ({
    theme: [baseTheme(o.dark), syntaxHighlighting(o.dark ? DARK_STYLE : LIGHT_STYLE, { fallback: true })],
    wrap: o.wordWrap ? EditorView.lineWrapping : [],
    whitespace: o.showWhitespace ? [highlightWhitespace(), highlightTrailingWhitespace()] : [],
    tabs: [EditorState.tabSize.of(o.tabSize), indentUnit.of(' '.repeat(o.tabSize))],
    gutter: o.lineNumbers ? [lineNumbers(), foldGutter()] : [],
  });

  const flush = (key, urgent = false) => {
    if (!pending.has(key)) return;
    clearTimeout(pending.get(key));
    pending.delete(key);
    const state = key === active ? view.state : states.get(key);
    if (state) onChange(key, state.doc.toString(), { urgent });
  };

  const report = (state) => {
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    onCursor?.({ line: line.number, column: sel.head - line.from + 1, selected: state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0), lines: state.doc.lines, cursors: state.selection.ranges.length });
  };

  function extensions(key, text) {
    const config = configFor(options);
    return [
      gutter.of(config.gutter),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true }),
      EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      readingField,
      search({ top: true }),
      placeholder('Type or paste here. Everything is saved on this device as you type and synced to GitHub.'),
      keymap.of([
        { key: 'Mod-g', run: gotoLine, preventDefault: true },
        { key: 'Alt-z', run: () => onShortcut?.('toggleWrap') ?? true },
        { key: 'Mod-s', run: () => onShortcut?.('sync') ?? true, preventDefault: true },
        { key: 'Mod-Shift-d', run: copyLineDown },
        { key: 'Mod-Shift-k', run: deleteLine },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      lang.of([]),
      theme.of(config.theme),
      wrap.of(config.wrap),
      whitespace.of(config.whitespace),
      tabs.of(config.tabs),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((tr) => tr.annotation(remote))) {
          clearTimeout(pending.get(key));
          // Pasted or dropped text is saved at once; typing a moment after the last key.
          if (update.transactions.some((tr) => tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop'))) {
            pending.set(key, null);
            flush(key, true);
          } else pending.set(key, setTimeout(() => flush(key), 250));
        }
        if (update.docChanged || update.selectionSet) report(update.state);
      }),
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.domEventHandlers({ scroll: (_e, v) => scroll.set(key, v.scrollDOM.scrollTop) }),
      // The text itself is in the state's doc.
      [],
    ];
  }

  const view = new EditorView({ parent, state: EditorState.create({ doc: '' }) });
  // CodeMirror's own style sets `display: flex !important`, which beats the
  // hidden attribute, so hiding needs an inline !important rule.
  const setVisible = (on) => (on ? view.dom.style.removeProperty('display') : view.dom.style.setProperty('display', 'none', 'important'));
  setVisible(false);

  async function loadLanguage(key, name, chosen) {
    const desc = findLanguage(name, chosen);
    const support = desc ? (desc.support ?? (await desc.load().catch(() => null))) : null;
    const effects = lang.reconfigure(support ?? []);
    if (key === active) view.dispatch({ effects });
    else if (states.has(key)) states.set(key, states.get(key).update({ effects }).state);
    return desc?.name ?? PLAIN_TEXT;
  }

  return {
    view,

    /** Shows a tab (creating its editor state the first time). */
    show(key, { text, name, language }) {
      if (active && active !== key) {
        flush(active);
        states.set(active, view.state);
        scroll.set(active, view.scrollDOM.scrollTop);
      }
      let created = false;
      if (!states.has(key)) {
        states.set(key, EditorState.create({ doc: text, extensions: extensions(key, text) }));
        created = true;
      }
      active = key;
      setVisible(true);
      view.setState(states.get(key));
      requestAnimationFrame(() => view.scrollDOM.scrollTo({ top: scroll.get(key) ?? 0 }));
      report(view.state);
      if (created) return loadLanguage(key, name, language);
      return Promise.resolve(null);
    },

    hide() {
      if (active) {
        flush(active);
        states.set(active, view.state);
      }
      active = null;
      setVisible(false);
    },

    /** Replaces a tab's text with a version from elsewhere, touching only what differs. */
    replaceText(key, text) {
      const state = key === active ? view.state : states.get(key);
      if (!state) return;
      const old = state.doc.toString();
      if (old === text) return;
      let start = 0;
      while (start < old.length && start < text.length && old[start] === text[start]) start++;
      let endOld = old.length;
      let endNew = text.length;
      while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) {
        endOld--;
        endNew--;
      }
      const tr = state.update({ changes: { from: start, to: endOld, insert: text.slice(start, endNew) }, annotations: remote.of(true) });
      if (key === active) view.dispatch(tr);
      else states.set(key, tr.state);
    },

    setLanguage: loadLanguage,

    applySettings(next) {
      options = next;
      const config = configFor(next);
      const effects = [theme.reconfigure(config.theme), wrap.reconfigure(config.wrap), whitespace.reconfigure(config.whitespace), tabs.reconfigure(config.tabs), gutter.reconfigure(config.gutter)];
      for (const [key, state] of states) if (key !== active) states.set(key, state.update({ effects }).state);
      if (active) view.dispatch({ effects });
    },

    drop(key) {
      flush(key);
      // hide() keeps the active tab's state, so hide first, then forget it.
      if (key === active) this.hide();
      states.delete(key);
      scroll.delete(key);
    },

    /** Marks the passage being read aloud in a tab ({ from, to }, or null to clear) and scrolls to it. */
    highlightReading(key, range) {
      const isActive = key === active;
      const state = isActive ? view.state : states.get(key);
      if (!state) return;
      const len = state.doc.length;
      const r = range && { from: Math.min(range.from, len), to: Math.min(range.to, len) };
      const effects = [setReading.of(r && r.to > r.from ? r : null)];
      if (isActive && r && r.to > r.from) effects.push(EditorView.scrollIntoView(r.from, { y: 'center' }));
      if (isActive) view.dispatch({ effects });
      else states.set(key, state.update({ effects }).state);
    },

    /** The text and selection of the active tab: { key, text, from, to } (for reading aloud). */
    snapshot() {
      if (!active) return null;
      const { main } = view.state.selection;
      return { key: active, text: view.state.doc.toString(), from: main.from, to: main.to };
    },

    flushAll() {
      for (const key of [...pending.keys()]) flush(key);
    },

    run(name) {
      const command = COMMANDS[name];
      if (!command || !active) return false;
      view.focus();
      return command(view);
    },

    /** Moves the cursor to a line (1-based) and column, centering it. */
    reveal(line, column = 1, length = 0) {
      const doc = view.state.doc;
      const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
      const from = Math.min(l.from + column - 1, l.to);
      view.dispatch({ selection: EditorSelection.single(from, Math.min(from + length, l.to)), effects: EditorView.scrollIntoView(from, { y: 'center' }) });
      view.focus();
    },

    selectionText() {
      const { state } = view;
      return state.selection.ranges.map((r) => state.sliceDoc(r.from, r.to)).join('\n');
    },

    focus: () => view.focus(),
    get active() {
      return active;
    },
  };
}
