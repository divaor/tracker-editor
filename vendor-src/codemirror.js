// Entry for the CodeMirror bundle in app/vendor/cm/ (built by scripts/vendor.js).
// Languages load on demand: each one is its own chunk next to the bundle.
export {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightWhitespace,
  highlightTrailingWhitespace,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  placeholder,
  Decoration,
} from '@codemirror/view';
export { EditorState, EditorSelection, Compartment, Prec, Annotation, Transaction, StateField, StateEffect } from '@codemirror/state';
export {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
  undo,
  redo,
  selectAll,
  copyLineDown,
  deleteLine,
  moveLineUp,
  moveLineDown,
  indentMore,
  indentLess,
} from '@codemirror/commands';
export {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  closeSearchPanel,
  gotoLine,
  selectNextOccurrence,
  SearchQuery,
  setSearchQuery,
  findNext,
  replaceAll,
} from '@codemirror/search';
export { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, completeAnyWord } from '@codemirror/autocomplete';
export {
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  bracketMatching,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
  LanguageDescription,
} from '@codemirror/language';
export { tags } from '@lezer/highlight';
export { languages } from '@codemirror/language-data';
export { oneDark, oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
