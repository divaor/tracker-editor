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
  MatchDecorator,
  MergeView,
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
  foldable,
  foldAll,
  foldCode,
  foldedRanges,
  foldEffect,
  foldService,
  unfoldAll,
  unfoldCode,
  unfoldEffect,
  ensureSyntaxTree,
  syntaxTree,
  getIndentUnit,
  linter,
  lintGutter,
  nextDiagnostic,
  previousDiagnostic,
  RangeSetBuilder,
  cursorMatchingBracket,
  Facet,
  StreamLanguage,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
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
  Transaction,
  undo,
  unifiedMergeView,
  runScopeHandlers,
  ViewPlugin,
  WidgetType,
} from '../vendor/cm/codemirror.js';
import { compileFilter, hiddenRuns, isBigText } from './logtools.js';
import { currentEntry, outline, parseLinks } from './outline.js';
import { isOwnDrop } from './dragOut.js';
import { createSearchPanel, openReplacePanel } from './searchPanel.js';
import { SYNTAX_LANGUAGES, problemsFor, treeErrors } from './problems.js';
import { convertIndent, detectIndent } from './indent.js';
import { gitGutter, gitInfo, setGitBase } from './gitGutter.js';

export { languages };

const remote = Annotation.define();
const imageIn = (data) => [...(data?.files ?? [])].find((f) => f.type.startsWith('image/')) ?? null;

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

// ---- Folding ----

// The language shown in a state (by name), for the outline and the status bar.
const languageName = Facet.define({ combine: (values) => values[0] ?? '' });

const indentOf = (text, tab) => {
  let n = 0;
  for (const ch of text) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += tab - (n % tab);
    else break;
  }
  return n;
};
/**
 * Folding by indentation, for languages without their own (plain text, older modes):
 * a line folds when the lines after it are indented further.
 */
const indentFolding = foldService.of((state, from) => {
  const line = state.doc.lineAt(from);
  if (!line.text.trim()) return null;
  const base = indentOf(line.text, state.tabSize);
  let end = null;
  for (let n = line.number + 1, seen = 0; n <= state.doc.lines && seen < 50000; n++, seen++) {
    const next = state.doc.line(n);
    if (!next.text.trim()) continue;
    if (indentOf(next.text, state.tabSize) <= base) break;
    end = next;
  }
  return end ? { from: line.to, to: end.to } : null;
});

// The foldable blocks with how deep each is (1: not inside another): [{ from, to, depth }].
function foldableBlocks(state) {
  ensureSyntaxTree(state, state.doc.length, 300);
  const out = [];
  const open = []; // ends of the blocks the line is inside
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    while (open.length && line.from > open[open.length - 1]) open.pop();
    const range = foldable(state, line.from, line.to);
    if (range && range.to > range.from) {
      out.push({ ...range, depth: open.length + 1 });
      open.push(range.to);
    }
  }
  return out;
}
// Folds every block (`level` 0), or only the blocks that deep, after unfolding the rest.
const foldLevel = (level) => (view) => {
  const { state } = view;
  const effects = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => void effects.push(unfoldEffect.of({ from, to })));
  for (const b of foldableBlocks(state)) if (!level || b.depth === level) effects.push(foldEffect.of({ from: b.from, to: b.to }));
  if (effects.length) view.dispatch({ effects });
  return true;
};

// The outline of a text, once per version of it (and its language: it loads after the text).
const outlines = new WeakMap();
const outlineOf = (state) => {
  const name = state.facet(languageName);
  let known = outlines.get(state.doc);
  if (known?.name !== name) {
    known = { name, entries: state.doc.length > 3_000_000 ? [] : outline(state.doc.toString(), name || '') };
    outlines.set(state.doc, known);
  }
  return known.entries;
};
/**
 * Where `pos` is: the names of the class, function or section around it, outermost
 * first ("Store › load"). Code uses the blocks the names start (their folds); text, the
 * last heading above.
 */
function scopeAt(state, pos) {
  const name = state.facet(languageName);
  const path = scopeEntries(state, pos);
  // Text: the last heading above (the status bar has little room).
  if (name === 'Markdown' || name === '') return path.length ? path[path.length - 1].title : '';
  return path.map((e) => e.title).join(' › ');
}
/** The outline entries around `pos`, outermost first ([{ title, line, level }]): headings in text. */
function scopeEntries(state, pos) {
  const entries = outlineOf(state);
  if (!entries.length) return [];
  const lineNo = state.doc.lineAt(pos).number;
  const name = state.facet(languageName);
  const path = [];
  let level = Infinity;
  for (let i = currentEntry(entries, lineNo), looked = 0; i >= 0 && looked < 400; i--, looked++) {
    const e = entries[i];
    if (e.level >= level) continue;
    if (name !== 'Markdown' && name !== '') {
      const line = state.doc.line(e.line);
      const block = line.number === lineNo ? { to: line.to } : foldable(state, line.from, line.to);
      if (!block || block.to < pos) continue;
    }
    path.unshift(e);
    level = e.level;
    if (level <= 1) break;
  }
  return path;
}

// ---- Problems as you type ----

// The file's name, for checks that depend on it (JSON with comments).
const fileName = Facet.define({ combine: (values) => values[0] ?? '' });

// The parser's syntax errors (problems.js treeErrors), and how far it read.
function parserErrors(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 400) ?? syntaxTree(state);
  return { errors: treeErrors(tree, (from, to) => state.sliceDoc(from, to)), parsed: tree.length };
}

/**
 * The linter for one tab: problemsFor (problems.js) with the parser's errors; `onProblems(key,
 * list, language)` hears each result ([{ from, to, line, column, severity, message }]).
 */
const problemsLinter = (key, onProblems) =>
  linter(
    (view) => {
      const { state } = view;
      const language = state.facet(languageName);
      let list = [];
      if (language === 'JSON' || SYNTAX_LANGUAGES.has(language)) {
        const { errors, parsed } = language === 'JSON' ? { errors: [], parsed: state.doc.length } : parserErrors(state);
        list = problemsFor(state.doc.toString(), { language, name: state.facet(fileName), errors }).filter((p) => p.from <= parsed);
      }
      const end = state.doc.length;
      const found = list.map((p) => {
        const from = Math.min(p.from, end);
        const line = state.doc.lineAt(from);
        return { from, to: Math.min(Math.max(p.to, from), end), severity: p.severity, message: p.message, line: line.number, column: from - line.from + 1 };
      });
      onProblems?.(key, found, language);
      return found.map(({ from, to, severity, message }) => ({ from, to, severity, message }));
    },
    // Again when the language has loaded (the first look was before).
    { delay: 600, needsRefresh: (update) => update.startState.facet(languageName) !== update.state.facet(languageName) },
  );

// ---- Indentation guides, bracket colors, the enclosing lines on top ----

// A guide at each indentation level of a line; empty lines take the smaller of their neighbors'.
const guideLine = (count, unit) => Decoration.line({ attributes: { class: 'cm-indent-guides', style: `--guides: ${count}; --unit: ${unit}` } });
function guideDecorations(view) {
  const { state } = view;
  const unit = Math.max(1, getIndentUnit(state));
  const builder = new RangeSetBuilder();
  const indentAt = (n) => {
    const text = state.doc.line(n).text;
    return text.trim() ? indentOf(text, state.tabSize) : null;
  };
  const near = (n, step) => {
    for (let k = n + step, seen = 0; k >= 1 && k <= state.doc.lines && seen < 200; k += step, seen++) {
      const i = indentAt(k);
      if (i !== null) return i;
    }
    return 0;
  };
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      let cols = indentAt(line.number);
      if (cols === null) cols = Math.min(near(line.number, -1), near(line.number, 1));
      const count = Math.ceil(cols / unit);
      if (count > 0) builder.add(line.from, line.from, guideLine(count, unit));
      pos = line.to + 1;
    }
  }
  return builder.finish();
}
const indentGuides = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = guideDecorations(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || getIndentUnit(u.startState) !== getIndentUnit(u.state) || u.startState.tabSize !== u.state.tabSize) this.decorations = guideDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// Brackets colored by how deep they are (three colors in turn), from the syntax tree, so
// those in strings and comments do not count; plain text counts characters.
const BRACKET_MARKS = [0, 1, 2].map((n) => Decoration.mark({ class: `cm-bracket-${n}` }));
const OPENERS = '([{';
const bracketDepths = new WeakMap(); // tree (or doc) → [[pos, depth]] in order
function bracketsOf(state) {
  const tree = syntaxTree(state);
  const plain = !state.facet(languageName) || tree.length === 0;
  const keyOf = plain ? state.doc : tree;
  if (bracketDepths.has(keyOf)) return bracketDepths.get(keyOf);
  const out = [];
  const stack = [];
  const visit = (pos, ch) => {
    if (OPENERS.includes(ch)) {
      out.push([pos, stack.length % 3]);
      stack.push(ch);
    } else if (stack.length) {
      stack.pop();
      out.push([pos, stack.length % 3]);
    }
  };
  if (state.doc.length <= 400_000) {
    if (plain) {
      const text = state.doc.toString();
      for (let i = 0; i < text.length; i++) if ('()[]{}'.includes(text[i])) visit(i, text[i]);
    } else {
      tree.iterate({
        enter(n) {
          if (n.to - n.from === 1 && '()[]{}'.includes(n.name)) visit(n.from, n.name);
        },
      });
    }
  }
  bracketDepths.set(keyOf, out);
  return out;
}
function bracketDecorations(view) {
  const list = bracketsOf(view.state);
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][0] < from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < list.length && list[i][0] < to; i++) builder.add(list[i][0], list[i][0] + 1, BRACKET_MARKS[list[i][1]]);
  }
  return builder.finish();
}
const bracketColors = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = bracketDecorations(view);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = bracketDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

// Sticky scroll: the lines that start the class, function or sections around the top of
// the view stay over it (up to three); click one to go there.
const STICKY_MAX = 3;
const stickyScroll = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.dom = document.createElement('div');
      this.dom.className = 'cm-sticky';
      this.dom.hidden = true;
      this.dom.addEventListener('mousedown', (e) => {
        const row = e.target.closest('[data-line]');
        if (!row) return;
        e.preventDefault();
        const line = view.state.doc.line(Number(row.dataset.line));
        view.dispatch({ selection: { anchor: line.from + (line.text.length - line.text.trimStart().length) }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 4 }) });
        view.focus();
      });
      view.dom.appendChild(this.dom);
      this.shown = '';
      this.onScroll = () => this.schedule();
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
      this.schedule();
    }
    update(u) {
      if (u.docChanged || u.geometryChanged || u.viewportChanged) this.schedule();
    }
    schedule() {
      this.view.requestMeasure({ key: this, read: () => this.read(), write: (m) => this.write(m) });
    }
    read() {
      const { view } = this;
      const scroller = view.scrollDOM.getBoundingClientRect();
      const box = view.dom.getBoundingClientRect();
      const lineHeight = view.defaultLineHeight;
      const top = scroller.top - view.documentTop;
      if (top <= 1) return { lines: [] };
      // The scopes at the line just under the sticky lines themselves.
      let lines = [];
      for (let rows = 0; rows <= STICKY_MAX; rows++) {
        const block = view.lineBlockAtHeight(top + rows * lineHeight + 1);
        const firstShown = view.state.doc.lineAt(block.from).number;
        const scopes = scopeEntries(view.state, block.from).filter((e) => e.line < firstShown).slice(-STICKY_MAX);
        lines = scopes;
        if (scopes.length <= rows) break;
      }
      const gutters = view.dom.querySelector('.cm-gutters');
      const content = view.contentDOM.getBoundingClientRect();
      return { lines, top: scroller.top - box.top, width: view.scrollDOM.clientWidth, gutter: gutters ? gutters.getBoundingClientRect().width : 0, textLeft: content.left - scroller.left, lineHeight };
    }
    write({ lines, top, width, gutter, textLeft, lineHeight }) {
      const key = lines.map((e) => e.line).join(',');
      if (!lines.length) {
        this.dom.hidden = true;
        this.shown = '';
        return;
      }
      this.dom.hidden = false;
      Object.assign(this.dom.style, { top: `${top}px`, width: `${width}px` });
      this.dom.style.setProperty('--sticky-gutter', `${gutter}px`);
      this.dom.style.setProperty('--sticky-text', `${textLeft}px`);
      this.dom.style.setProperty('--sticky-line', `${lineHeight}px`);
      const doc = this.view.state.doc;
      const signature = `${key}|${lines.map((e) => doc.line(e.line).text).join('\n')}`;
      if (signature === this.shown) return;
      this.shown = signature;
      this.dom.replaceChildren(
        ...lines.map((e) => {
          const row = document.createElement('div');
          row.className = 'cm-sticky-line';
          row.dataset.line = String(e.line);
          row.title = `Line ${e.line}: go there`;
          const num = document.createElement('span');
          num.className = 'cm-sticky-num';
          num.textContent = String(e.line);
          const text = document.createElement('span');
          text.className = 'cm-sticky-text';
          text.textContent = doc.line(e.line).text.slice(0, 300);
          row.append(num, text);
          return row;
        }),
      );
    }
    destroy() {
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
      this.dom.remove();
    }
  },
);

/** Editing commands beyond CodeMirror's keymaps (menus and the command list). */
export const COMMANDS = {
  undo,
  redo,
  find: openSearchPanel,
  replace: openReplacePanel,
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
  fold: foldCode,
  unfold: unfoldCode,
  foldAll: foldLevel(0),
  foldTop: foldLevel(1),
  foldLevel2: foldLevel(2),
  foldLevel3: foldLevel(3),
  unfoldAll,
  matchingBracket: cursorMatchingBracket,
  nextProblem: nextDiagnostic,
  previousProblem: previousDiagnostic,
  // (Format document is actions.formatDocument: formatter.js, which loads its parts when needed.)
};

// The smallest single change that turns `old` into `text` (keeps the cursor and undo history useful).
function minimalChange(old, text) {
  if (old === text) return null;
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) start++;
  let endOld = old.length;
  let endNew = text.length;
  while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { from: start, to: endOld, insert: text.slice(start, endNew) };
}

/**
 * A read-only comparison of two texts in `parent`: side by side, or (unified,
 * for phones) one text with the removed lines shown in place. Unchanged
 * stretches fold away. Returns { destroy, next, previous, changes }.
 */
export function createCompareView(parent, { left, right, name = '', language = '', dark = false, unified = false, wrap = false }) {
  const lang = new Compartment();
  const extensions = () => [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    baseTheme(dark),
    syntaxHighlighting(dark ? DARK_STYLE : LIGHT_STYLE, { fallback: true }),
    wrap ? EditorView.lineWrapping : [],
    lang.of([]),
  ];
  const collapseUnchanged = { margin: 3, minSize: 8 };
  let merge = null;
  let single = null;
  if (unified) {
    single = new EditorView({
      parent,
      state: EditorState.create({ doc: right, extensions: [...extensions(), unifiedMergeView({ original: left, mergeControls: false, highlightChanges: true, gutter: true, collapseUnchanged })] }),
    });
  } else {
    merge = new MergeView({ a: { doc: left, extensions: extensions() }, b: { doc: right, extensions: extensions() }, parent, highlightChanges: true, gutter: true, collapseUnchanged });
  }
  const views = merge ? [merge.a, merge.b] : [single];
  const desc = findLanguage(name, language);
  desc?.load().then((support) => views.forEach((v) => v.dispatch({ effects: lang.reconfigure(support) })), () => {});
  const target = () => (merge ? merge.b : single);
  return {
    destroy: () => (merge ?? single).destroy(),
    next: () => goToNextChunk(target()),
    previous: () => goToPreviousChunk(target()),
    changes: () => getChunks(target().state)?.chunks.length ?? 0,
  };
}

// Showing only the lines that match a filter (or hiding them), per tab. Hidden
// runs collapse into a small marker; line numbers stay those of the file.
const setLineFilter = StateEffect.define();
class HiddenLines extends WidgetType {
  constructor(count) {
    super();
    this.count = count;
  }
  eq(other) {
    return other.count === this.count;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-hidden-lines';
    el.textContent = `⋯ ${this.count.toLocaleString()} line${this.count === 1 ? '' : 's'} hidden`;
    return el;
  }
}
const NO_FILTER = { filter: null, test: null, deco: Decoration.none, shown: 0, total: 0 };
function applyFilter(doc, filter, test) {
  const { runs, shown } = hiddenRuns(doc.lines, (n) => doc.line(n).text, test, filter.mode);
  const deco = Decoration.set(runs.map(([a, b]) => Decoration.replace({ block: true, widget: new HiddenLines(b - a + 1) }).range(doc.line(a).from, doc.line(b).to)));
  return { filter, test, deco, shown, total: doc.lines };
}
const lineFilterField = StateField.define({
  create: () => NO_FILTER,
  update(value, tr) {
    let { filter, test } = value;
    for (const e of tr.effects) {
      if (!e.is(setLineFilter)) continue;
      filter = e.value;
      test = filter ? compileFilter(filter) : null;
    }
    if (!filter) return NO_FILTER;
    if (filter === value.filter && !tr.docChanged) return value;
    return applyFilter(tr.state.doc, filter, test);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// [[Links]] between notes: underlined; Ctrl/Cmd+click opens them (host option onOpenLink).
const wikiLinkMatcher = new MatchDecorator({ regexp: /\[\[[^[\]\n]+?\]\]/g, decoration: Decoration.mark({ class: 'cm-wikilink', attributes: { title: 'Ctrl+click to open' } }) });
const wikiLinks = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = wikiLinkMatcher.createDeco(view);
    }
    update(update) {
      this.decorations = wikiLinkMatcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** The [[link]] at a position, if any. */
function linkAt(state, pos) {
  const line = state.doc.lineAt(pos);
  return parseLinks(line.text).find((l) => pos - line.from >= l.from && pos - line.from <= l.to) ?? null;
}

/**
 * Creates the editor in `parent`. `onChange(key, text, { urgent })` gets the text of the
 * tab after you type (debounced); `onCursor(info)` the cursor position.
 * `onOpenLink(target)` opens a [[link]]; `linkTargets()` lists names to complete after [[.
 * `openSide(key, el, …)` shows a second tab next to it (the split view); a tab's
 * state, with its undo history, moves between the panes.
 */
export function createEditorHost(parent, { onChange, onCursor, onShortcut, onOpenLink, onImage, onProblems, linkTargets, settings }) {
  const states = new Map(); // key → EditorState
  const scroll = new Map(); // key → scroll position
  const pending = new Map(); // key → timer for onChange
  const lang = new Compartment();
  const theme = new Compartment();
  const wrap = new Compartment();
  const whitespace = new Compartment();
  const tabs = new Compartment();
  const gutter = new Compartment();
  const readOnly = new Compartment();
  const checks = new Compartment(); // problems as you type
  const aids = new Compartment(); // indentation guides, bracket colors, sticky scroll
  const gitBar = new Compartment(); // lines changed since the last commit (files in a Git repository)
  const indents = new Map(); // key → { tabs, size, source: 'detected' | 'editorconfig' | 'chosen' }
  let options = settings;
  let active = null;
  let side = null; // { key, view } of the split view's second pane
  const bigKeys = new Set(); // tabs in the lighter editor for very large files
  // Macro being recorded: keys the keymaps handle, and typed or pasted text, in order.
  let recording = null;
  const MACRO_KEYS = (e) => (e.ctrlKey || e.metaKey) && e.shiftKey && /^[rp]$/i.test(e.key);
  const recorder = [
    EditorView.domEventHandlers({
      keydown(e) {
        if (!recording || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key) || MACRO_KEYS(e)) return false;
        // Plain characters arrive as text (below); keep named keys and shortcuts.
        if (e.key.length > 1 || e.ctrlKey || e.metaKey || e.altKey) {
          recording.push({ type: 'key', key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });
        }
        return false;
      },
      paste(e) {
        const text = e.clipboardData?.getData('text/plain');
        if (recording && text) recording.push({ type: 'text', text });
        return false;
      },
    }),
    EditorView.inputHandler.of((_view, _from, _to, text) => {
      if (recording) recording.push({ type: 'text', text });
      return false;
    }),
  ];

  // Replays one recorded step in a view, the way the keymaps and input handlers would.
  function replay(v, step) {
    if (step.type === 'key') return runScopeHandlers(v, new KeyboardEvent('keydown', step), 'editor');
    const { from, to } = v.state.selection.main;
    const handlers = v.state.facet(EditorView.inputHandler);
    const fallback = () => v.state.replaceSelection(step.text);
    if (!handlers.some((h) => h(v, from, to, step.text, fallback))) v.dispatch(v.state.replaceSelection(step.text), { userEvent: 'input.type', scrollIntoView: true });
    return true;
  }
  let focused = 'main'; // the pane typed in last: commands and reading aloud use it
  // The view showing a tab, if one does.
  const viewOf = (key) => (key && key === active ? view : key && key === side?.key ? side.view : null);
  const current = () => (focused === 'side' && side ? side : { key: active, view });

  // A tab's indentation: its own (detected, from .editorconfig, or picked), else the default.
  const indentFor = (key, o = options) => {
    const own = indents.get(key);
    return { tabs: own?.tabs ?? false, size: own?.size || o.tabSize, source: own?.source ?? 'default' };
  };
  const configFor = (o, key) => {
    const indent = indentFor(key, o);
    const big = bigKeys.has(key);
    return {
      theme: [baseTheme(o.dark), syntaxHighlighting(o.dark ? DARK_STYLE : LIGHT_STYLE, { fallback: true })],
      wrap: o.wordWrap && !big ? EditorView.lineWrapping : [],
      whitespace: o.showWhitespace ? [highlightWhitespace(), highlightTrailingWhitespace()] : [],
      tabs: [EditorState.tabSize.of(indent.size), indentUnit.of(indent.tabs ? '\t' : ' '.repeat(indent.size))],
      gutter: [o.lineNumbers ? lineNumbers() : [], foldGutter()],
      checks: o.problems !== false && !big ? [problemsLinter(key, onProblems), lintGutter()] : [],
      aids: big ? [] : [o.indentGuides !== false ? indentGuides : [], o.bracketColors !== false ? bracketColors : [], o.stickyScroll !== false ? stickyScroll : []],
    };
  };
  // A new tab's indentation: the one picked for it, else what its text uses (`fresh`: not the pick).
  const settleIndent = (key, text, { fresh = false } = {}) => {
    const chosen = !fresh && options.indentChosen?.[key];
    if (chosen) return void indents.set(key, { tabs: Boolean(chosen.tabs), size: chosen.size, source: 'chosen' });
    if (indents.has(key) || options.detectIndent === false) return;
    const found = detectIndent(text);
    if (found) indents.set(key, { tabs: found.tabs, size: found.size ?? options.tabSize, source: 'detected' });
  };

  const flush = (key, urgent = false) => {
    if (!pending.has(key)) return;
    clearTimeout(pending.get(key));
    pending.delete(key);
    const state = viewOf(key)?.state ?? states.get(key);
    if (state) onChange(key, state.doc.toString(), { urgent });
  };

  // After [[: the names of your files.
  const linkCompletion = (ctx) => {
    const m = ctx.matchBefore(/\[\[[^\]\n]*/);
    if (!m || !linkTargets) return null;
    return {
      from: m.from + 2,
      validFor: /^[^\]\n]*$/,
      options: linkTargets().map((name) => ({
        label: name,
        type: 'text',
        apply: (view, _completion, from, to) => {
          const closed = view.state.sliceDoc(to, to + 2) === ']]';
          view.dispatch({ changes: { from, to, insert: closed ? name : `${name}]]` }, selection: { anchor: from + name.length + 2 } });
        },
      })),
    };
  };

  const report = (state, key) => {
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    onCursor?.({ key, line: line.number, column: sel.head - line.from + 1, selected: state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0), lines: state.doc.lines, cursors: state.selection.ranges.length, scope: scopeAt(state, sel.head), indent: indentFor(key) });
  };

  function extensions(key, text) {
    // A very large file gets a lighter editor: no wrapping, matching, completion or highlighting.
    const big = isBigText(text);
    if (big) bigKeys.add(key);
    settleIndent(key, text);
    const config = configFor(options, key);
    return [
      readOnly.of([]),
      recorder,
      lineFilterField,
      gutter.of(config.gutter),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      big ? [] : [bracketMatching(), closeBrackets(), autocompletion({ activateOnTyping: true })],
      EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }, { autocomplete: linkCompletion }]),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      // The selection's other occurrences, and the name under the cursor's.
      big ? [] : highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 2 }),
      readingField,
      search({ top: true, createPanel: createSearchPanel }),
      placeholder('Type or paste here. Everything is saved on this device as you type and synced to GitHub.'),
      keymap.of([
        { key: 'Mod-g', run: gotoLine, preventDefault: true },
        { key: 'Mod-h', mac: 'Mod-Alt-f', run: openReplacePanel, preventDefault: true },
        { key: 'Alt-z', run: () => onShortcut?.('toggleWrap') ?? true },
        { key: 'Shift-Alt-f', run: () => onShortcut?.('format') ?? true, preventDefault: true },
        { key: 'Mod-s', run: () => onShortcut?.('sync') ?? true, preventDefault: true },
        // Code: definitions, usages, renaming in the file; folding by level (as in Notepad++).
        { key: 'F12', run: () => onShortcut?.('definition') ?? true, preventDefault: true },
        { key: 'Shift-F12', run: () => onShortcut?.('usages') ?? true, preventDefault: true },
        { key: 'F2', run: () => onShortcut?.('renameSymbol') ?? true, preventDefault: true },
        { key: 'Alt-0', run: COMMANDS.foldAll, preventDefault: true },
        { key: 'Alt-Shift-0', run: unfoldAll, preventDefault: true },
        { key: 'Alt-1', run: COMMANDS.foldTop, preventDefault: true },
        { key: 'Alt-2', run: COMMANDS.foldLevel2, preventDefault: true },
        { key: 'Alt-3', run: COMMANDS.foldLevel3, preventDefault: true },
        // Problems: the next and the one before (as in VS Code; the list is the window's Ctrl+Shift+M).
        { key: 'F8', run: nextDiagnostic, preventDefault: true },
        { key: 'Shift-F8', run: previousDiagnostic, preventDefault: true },
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
      checks.of(config.checks),
      aids.of(config.aids),
      gitBar.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((tr) => tr.annotation(remote))) {
          clearTimeout(pending.get(key));
          // Pasted or dropped text is saved at once; typing a moment after the last key.
          if (update.transactions.some((tr) => tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop'))) {
            pending.set(key, null);
            flush(key, true);
          } else pending.set(key, setTimeout(() => flush(key), 250));
        }
        if (update.docChanged || update.selectionSet) report(update.state, key);
      }),
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.domEventHandlers({
        scroll: (_e, v) => scroll.set(key, v.scrollDOM.scrollTop),
        // An image (and no text) pasted or dropped: `onImage` reads its text instead of inserting bytes.
        paste(e) {
          const image = imageIn(e.clipboardData);
          if (!image || !onImage || e.clipboardData.getData('text/plain')) return false;
          e.preventDefault();
          onImage(image);
          return true;
        },
        drop(e, v) {
          // A tab dropped on the text (dragged out and back, or within the page) is not inserted.
          if (isOwnDrop(e.dataTransfer)) {
            e.preventDefault();
            return true;
          }
          const image = imageIn(e.dataTransfer);
          // Other files are added as files (the window's drop handler), not inserted into this one.
          if (!image || !onImage) return Boolean(e.dataTransfer?.files?.length);
          e.preventDefault();
          e.stopPropagation();
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos !== null) v.dispatch({ selection: { anchor: pos } });
          onImage(image);
          return true;
        },
        mousedown(e, v) {
          if (!(e.ctrlKey || e.metaKey) || !onOpenLink) return false;
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
          const link = pos === null ? null : linkAt(v.state, pos);
          if (!link) return false;
          e.preventDefault();
          onOpenLink(link.target);
          return true;
        },
      }),
      wikiLinks,
      // The text itself is in the state's doc.
      [],
    ];
  }

  const view = new EditorView({ parent, state: EditorState.create({ doc: '' }) });
  view.dom.addEventListener('focusin', () => (focused = 'main'));
  // CodeMirror's own style sets `display: flex !important`, which beats the
  // hidden attribute, so hiding needs an inline !important rule.
  const setVisible = (on) => (on ? view.dom.style.removeProperty('display') : view.dom.style.setProperty('display', 'none', 'important'));
  setVisible(false);

  async function loadLanguage(key, name, chosen) {
    if (bigKeys.has(key)) return PLAIN_TEXT;
    const desc = findLanguage(name, chosen);
    const support = desc ? (desc.support ?? (await desc.load().catch(() => null))) : null;
    // Older modes (and plain text) fold by indentation.
    const ownFolding = support && !(support.language instanceof StreamLanguage);
    const effects = lang.reconfigure([support ?? [], languageName.of(desc?.name ?? ''), fileName.of(name ?? ''), ownFolding ? [] : indentFolding]);
    if (viewOf(key)) viewOf(key).dispatch({ effects });
    else if (states.has(key)) states.set(key, states.get(key).update({ effects }).state);
    return desc?.name ?? PLAIN_TEXT;
  }

  return {
    view,

    /** Shows a tab (creating its editor state the first time). */
    show(key, { text, name, language }) {
      // From the second pane to the main one.
      if (side?.key === key) this.closeSide();
      focused = 'main';
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
      report(view.state, key);
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
      const v = viewOf(key);
      const state = v ? v.state : states.get(key);
      const changes = state && minimalChange(state.doc.toString(), text);
      if (!changes) return;
      const tr = state.update({ changes, annotations: remote.of(true) });
      if (v) v.dispatch(tr);
      else states.set(key, tr.state);
    },

    /** Replaces a shown tab's text as an edit of yours: saved at once, and Ctrl+Z takes it back. */
    setTextAsEdit(key, text) {
      const v = viewOf(key);
      if (!v) return false;
      const changes = minimalChange(v.state.doc.toString(), text);
      if (changes) v.dispatch({ changes, userEvent: 'input.paste' });
      return true;
    },

    /** The selection of the pane typed in last: { key, from, to, text } (from === to when nothing is selected). */
    selectionInfo() {
      const { key, view: v } = current();
      if (!key) return null;
      const { from, to } = v.state.selection.main;
      return { key, from, to, text: v.state.sliceDoc(from, to), docLength: v.state.doc.length, doc: () => v.state.doc.toString() };
    },

    /** Replaces from–to in a shown tab when it still holds `expected`, as an edit you can undo. False when it changed. */
    replaceRange(key, from, to, expected, text) {
      const v = viewOf(key);
      if (!v || to > v.state.doc.length || v.state.sliceDoc(from, to) !== expected) return false;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length }, userEvent: 'input.paste', scrollIntoView: true });
      v.focus();
      return true;
    },

    /**
     * Shows only the lines of a tab that match `filter` ({ pattern, regex,
     * caseSensitive, mode: 'show' | 'hide' }), or all of them (null).
     * Returns { shown, total }; throws when the pattern is invalid.
     */
    setLineFilter(key, filter) {
      if (filter) compileFilter(filter);
      const v = viewOf(key);
      const effects = setLineFilter.of(filter);
      if (v) v.dispatch({ effects });
      else if (states.has(key)) states.set(key, states.get(key).update({ effects }).state);
      return this.lineFilter(key);
    },
    /** The tab's filter and counts: { filter, shown, total }. */
    lineFilter(key) {
      const state = viewOf(key)?.state ?? states.get(key);
      const f = state?.field(lineFilterField, false);
      return f?.filter ? { filter: f.filter, shown: f.shown, total: f.total } : { filter: null, shown: state?.doc.lines ?? 0, total: state?.doc.lines ?? 0 };
    },
    /** The lines the filter shows, as text. */
    shownLines(key) {
      const state = viewOf(key)?.state ?? states.get(key);
      const f = state?.field(lineFilterField, false);
      if (!state) return '';
      if (!f?.filter) return state.doc.toString();
      const out = [];
      for (let n = 1; n <= state.doc.lines; n++) {
        const text = state.doc.line(n).text;
        if (f.test.test(text) === (f.filter.mode === 'show')) out.push(text);
      }
      return out.join('\n');
    },
    // ---- Macros ----
    startRecording() {
      recording = [];
      current().view.focus();
    },
    /** Stops recording; returns the steps (an empty list when nothing was done). */
    stopRecording() {
      const steps = recording ?? [];
      recording = null;
      return steps;
    },
    get recording() {
      return Boolean(recording);
    },
    /**
     * Plays a macro in the pane typed in last: `times` times, or with 'end'
     * until the cursor reaches the end of the file or stops moving. Returns how many times it ran.
     */
    playMacro(steps, times = 1) {
      const { key, view: v } = current();
      if (!key || !steps?.length || recording) return 0;
      const limit = times === 'end' ? 10000 : Math.max(1, Math.min(10000, times));
      let runs = 0;
      for (; runs < limit; runs++) {
        const before = v.state.selection.main.head;
        const lengthBefore = v.state.doc.length;
        for (const step of steps) replay(v, step);
        if (times !== 'end') continue;
        // Until the end: it has to move forward (or shorten the file) each time.
        const head = v.state.selection.main.head;
        const progressed = head > before || v.state.doc.length < lengthBefore;
        if (head >= v.state.doc.length || !progressed) {
          runs++;
          break;
        }
      }
      v.focus();
      return runs;
    },

    /** Makes a tab read-only (a followed log, the tail of a huge file) or editable again. */
    setReadOnly(key, on) {
      const v = viewOf(key);
      const effects = readOnly.reconfigure(on ? [EditorState.readOnly.of(true), EditorView.editable.of(true)] : []);
      if (v) v.dispatch({ effects });
      else if (states.has(key)) states.set(key, states.get(key).update({ effects }).state);
    },

    /** Adds text at the end of a tab (new lines of a followed file); `follow` keeps the end in view (with '' it only goes there). */
    appendText(key, text, { follow = true } = {}) {
      const v = viewOf(key);
      const state = v ? v.state : states.get(key);
      if (!state || (!text && !follow)) return;
      const end = state.doc.length;
      // Not in the undo history: a followed log would fill it.
      const spec = text ? { changes: { from: end, insert: text }, annotations: [remote.of(true), Transaction.addToHistory.of(false)] } : {};
      if (follow) Object.assign(spec, { selection: { anchor: end + text.length }, scrollIntoView: true });
      if (v) v.dispatch(spec);
      else states.set(key, state.update(spec).state);
    },

    /** Whether a tab is in the lighter editor for very large files. */
    isBig: (key) => bigKeys.has(key),

    /** Inserts text in place of the selection of the pane typed in last, the cursor `cursorOffset` into it. */
    insertAtCursor(text, cursorOffset = text.length, { focus = true } = {}) {
      const { key, view: v } = current();
      if (!key) return false;
      const { from, to } = v.state.selection.main;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + cursorOffset }, userEvent: 'input.paste', scrollIntoView: true });
      if (focus) v.focus();
      return true;
    },

    /** Adds `text` as its own paragraph below the line where `pos` is (or the line before, at a line start), as an edit you can undo. */
    insertBelow(key, pos, text) {
      const v = viewOf(key);
      if (!v || pos > v.state.doc.length) return false;
      let line = v.state.doc.lineAt(pos);
      if (pos === line.from && pos > 0) line = v.state.doc.lineAt(pos - 1);
      const insert = `\n\n${text.trim()}`;
      v.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length }, userEvent: 'input.paste', scrollIntoView: true });
      return true;
    },

    /** The last `n` characters before the cursor of the pane typed in last ('' when none is open). */
    textBeforeCursor(n) {
      const { key, view: v } = current();
      if (!key) return '';
      const at = v.state.selection.main.from;
      return v.state.sliceDoc(Math.max(0, at - n), at);
    },

    /** Shows `key` in the second pane, inside `el` (never the main pane's tab). */
    openSide(key, el, { text, name, language }) {
      if (key === active) return Promise.resolve(null);
      if (side?.key === key && el.contains(side.view.dom)) return Promise.resolve(null);
      this.closeSide();
      let created = false;
      if (!states.has(key)) {
        states.set(key, EditorState.create({ doc: text, extensions: extensions(key, text) }));
        created = true;
      }
      const sideView = new EditorView({ parent: el, state: states.get(key) });
      sideView.dom.addEventListener('focusin', () => (focused = 'side'));
      side = { key, view: sideView };
      const top = scroll.get(key);
      if (top) requestAnimationFrame(() => sideView.scrollDOM.scrollTo({ top }));
      return created ? loadLanguage(key, name, language) : Promise.resolve(null);
    },

    closeSide() {
      if (!side) return;
      const { key, view: sideView } = side;
      flush(key);
      states.set(key, sideView.state);
      scroll.set(key, sideView.scrollDOM.scrollTop);
      side = null;
      focused = 'main';
      sideView.destroy();
    },

    focusSide() {
      side?.view.focus();
      return Boolean(side);
    },
    get side() {
      return side?.key ?? null;
    },

    setLanguage: loadLanguage,

    applySettings(next) {
      const before = options;
      options = next;
      // Indentation picked elsewhere (another window) or no longer detected.
      for (const [key, state] of states) {
        const chosen = next.indentChosen?.[key];
        const was = indents.get(key)?.source;
        if (chosen) indents.set(key, { tabs: Boolean(chosen.tabs), size: chosen.size, source: 'chosen' });
        else if (was === 'chosen' || (was === 'detected' && next.detectIndent === false)) indents.delete(key);
        if (!indents.has(key)) settleIndent(key, (viewOf(key)?.state ?? state).doc.toString());
      }
      // Only what changed is set again (a new linter would check every tab again).
      const same = (k) => before?.[k] === next[k];
      const effectsFor = (key) => {
        const config = configFor(next, key);
        const effects = [theme.reconfigure(config.theme), wrap.reconfigure(config.wrap), whitespace.reconfigure(config.whitespace), tabs.reconfigure(config.tabs), gutter.reconfigure(config.gutter)];
        if (!same('problems')) effects.push(checks.reconfigure(config.checks));
        if (!same('indentGuides') || !same('bracketColors') || !same('stickyScroll')) effects.push(aids.reconfigure(config.aids));
        return effects;
      };
      for (const [key, state] of states) if (!viewOf(key)) states.set(key, state.update({ effects: effectsFor(key) }).state);
      if (active) view.dispatch({ effects: effectsFor(active) });
      if (side) side.view.dispatch({ effects: effectsFor(side.key) });
      if (active) report(view.state, active);
    },

    /**
     * The text a tab's file had at the last commit (files in a Git repository): its changed
     * lines get a bar next to the line numbers. null takes the bar away.
     */
    setGitBase(key, text) {
      const apply = (spec) => {
        const v = viewOf(key);
        if (v) v.dispatch(spec);
        else if (states.has(key)) states.set(key, states.get(key).update(spec).state);
      };
      const state = viewOf(key)?.state ?? states.get(key);
      if (!state || bigKeys.has(key)) return;
      const has = Boolean(gitInfo(state)) || state.field(gitGutter[0], false) !== undefined;
      if (text === null) {
        if (has) apply({ effects: gitBar.reconfigure([]) });
        return;
      }
      if (!has) apply({ effects: gitBar.reconfigure(gitGutter) });
      apply({ effects: setGitBase.of(text) });
    },
    /** { base, changes } of a tab's file against the last commit, or null. */
    gitChanges(key) {
      const state = viewOf(key)?.state ?? states.get(key);
      return state ? gitInfo(state) : null;
    },

    /** A tab's indentation: { tabs, size, source } (source: 'detected', 'editorconfig', 'chosen' or 'default'). */
    indentation: (key) => indentFor(key),

    /** Sets a tab's indentation ({ tabs, size, source }), or (null) goes back to what its text uses. */
    setIndentation(key, indent) {
      if (indent) indents.set(key, { tabs: Boolean(indent.tabs), size: indent.size || options.tabSize, source: indent.source ?? 'chosen' });
      else {
        indents.delete(key);
        const state = viewOf(key)?.state ?? states.get(key);
        if (state) settleIndent(key, state.doc.toString(), { fresh: true });
      }
      const effects = tabs.reconfigure(configFor(options, key).tabs);
      const v = viewOf(key);
      if (v) v.dispatch({ effects });
      else if (states.has(key)) states.set(key, states.get(key).update({ effects }).state);
      if (key === active) report(view.state, key);
      return indentFor(key);
    },

    /** Changes a shown tab's line indentation to tabs or spaces (the tab's size), as an edit you can undo. */
    convertIndentation(key, toTabs) {
      const v = viewOf(key);
      if (!v) return false;
      const { size } = indentFor(key);
      const changes = [];
      for (let n = 1; n <= v.state.doc.lines; n++) {
        const line = v.state.doc.line(n);
        const lead = /^[ \t]*/.exec(line.text)[0];
        if (!lead) continue;
        const next = convertIndent(lead, { toTabs, size });
        if (next !== lead) changes.push({ from: line.from, to: line.from + lead.length, insert: next });
      }
      if (changes.length) v.dispatch({ changes, userEvent: 'input' });
      this.setIndentation(key, { tabs: toTabs, size, source: indents.get(key)?.source === 'editorconfig' ? 'editorconfig' : 'chosen' });
      return changes.length;
    },

    drop(key) {
      flush(key);
      bigKeys.delete(key);
      indents.delete(key);
      // hide() keeps the active tab's state, so hide first, then forget it.
      if (key === active) this.hide();
      if (key === side?.key) this.closeSide();
      states.delete(key);
      scroll.delete(key);
    },

    /** Marks the passage being read aloud in a tab ({ from, to }, or null to clear) and scrolls to it. */
    highlightReading(key, range) {
      const shown = viewOf(key);
      const isActive = Boolean(shown);
      const state = shown ? shown.state : states.get(key);
      if (!state) return;
      const len = state.doc.length;
      const r = range && { from: Math.min(range.from, len), to: Math.min(range.to, len) };
      const effects = [setReading.of(r && r.to > r.from ? r : null)];
      if (isActive && r && r.to > r.from) effects.push(EditorView.scrollIntoView(r.from, { y: 'center' }));
      if (isActive) shown.dispatch({ effects });
      else states.set(key, state.update({ effects }).state);
    },

    /** The text and selection of the pane typed in last: { key, text, from, to } (for reading aloud). */
    snapshot() {
      const { key, view: v } = current();
      if (!key) return null;
      const { main } = v.state.selection;
      return { key, text: v.state.doc.toString(), from: main.from, to: main.to };
    },

    flushAll() {
      for (const key of [...pending.keys()]) flush(key);
    },

    run(name) {
      const command = COMMANDS[name];
      const { key, view: v } = current();
      if (!command || !key) return false;
      v.focus();
      return command(v);
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
      const { state } = current().view;
      return state.selection.ranges.map((r) => state.sliceDoc(r.from, r.to)).join('\n');
    },

    /** The pane typed in last (or the one showing `of`), for code navigation: { key, text, pos, language, symbols }. */
    codeContext(of = null) {
      const { key, view: v } = of ? { key: of, view: viewOf(of) } : current();
      if (!key || !v) return null;
      const { state } = v;
      return { key, text: state.doc.toString(), pos: state.selection.main.head, selection: state.sliceDoc(state.selection.main.from, state.selection.main.to), language: state.facet(languageName), symbols: outlineOf(state) };
    },

    /** Selects `ranges` ([{ from, to }]) in the pane typed in last (or the one showing `of`), the one at `main` as the main one. */
    selectRanges(ranges, main = 0, of = null) {
      const { key, view: v } = of ? { key: of, view: viewOf(of) } : current();
      if (!key || !v || !ranges.length) return;
      v.dispatch({ selection: EditorSelection.create(ranges.map((r) => EditorSelection.range(r.from, r.to)), main), effects: EditorView.scrollIntoView(ranges[main].from, { y: 'center' }), userEvent: 'select' });
      v.focus();
    },

    focus: () => view.focus(),
    get active() {
      return active;
    },
  };
}
