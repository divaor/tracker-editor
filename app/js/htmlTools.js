// HTML and XML in the editor: Emmet abbreviations expanded with Tab, and the matching tag
// renamed as you type a tag's name (both ends stay the same). Uses the syntax tree.
import { EditorSelection, EditorState, indentUnit, syntaxTree } from '../vendor/cm/codemirror.js';
import { abbreviationBefore, expandAbbreviation, isAbbreviation } from './emmet.js';

// Languages written with tags, and how Emmet writes them there.
// (Plain JavaScript and TypeScript are left alone, as in VS Code: .jsx and .tsx have tags.)
const MARKUP = { HTML: {}, Vue: {}, PHP: {}, 'Angular Template': {}, XML: { xml: true }, SVG: { xml: true }, JSX: { jsx: true }, TSX: { jsx: true } };

// Inside a tag, an attribute, a string, a comment or a script: no expansion. In JSX the
// abbreviation reads as code (div.card is a member expression), so only strings, comments
// and tags themselves stop it.
function inPlainText(state, pos, jsx = false) {
  const stop = jsx ? /String|Comment|^JSX(Attribute|StartTag|SelfClosingTag|EndTag|OpenTag|CloseTag)/ : /Tag$|Attribute|String|Comment|^Script|^StyleText|TemplateString|PropertyName|VariableName|^Property/;
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (stop.test(node.name) && !/Element$|Document|JSXText/.test(node.name)) return false;
  }
  return true;
}

/**
 * Tab in HTML, XML and JSX: the abbreviation before the cursor (ul>li*3, .card, !) becomes
 * tags, indented like its line, the cursor in the first empty place. `languageOf(state)`
 * gives the language's name; `enabled()` the setting. Otherwise Tab indents as usual.
 */
export const emmetOnTab = (languageOf, enabled) => (view) => {
  if (!enabled()) return false;
  const { state } = view;
  const how = MARKUP[languageOf(state)];
  const sel = state.selection.main;
  if (!how || !sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  const before = line.text.slice(0, sel.head - line.from);
  const abbr = abbreviationBefore(before);
  if (!abbr || !isAbbreviation(abbr, how)) return false;
  if (!inPlainText(state, sel.head - abbr.length, how.jsx)) return false;
  const lead = /^\s*/.exec(line.text)[0];
  // One level as the file indents (its tab or spaces).
  const expanded = expandAbbreviation(abbr, { ...how, indent: state.facet(indentUnit) || '  ' });
  if (!expanded) return false;
  const text = expanded.text.replace(/\n/g, `\n${lead}`);
  // The cursor's place moves by the indentation added before it.
  const linesBefore = expanded.text.slice(0, expanded.cursor).split('\n').length - 1;
  const cursor = expanded.cursor + linesBefore * lead.length;
  const from = sel.head - abbr.length;
  view.dispatch({ changes: { from, to: sel.head, insert: text }, selection: EditorSelection.cursor(from + cursor), userEvent: 'input.complete', scrollIntoView: true });
  return true;
};

/**
 * Renaming a tag renames its other end: typing in an open tag's name changes the close
 * tag's (and the other way round), when both had the same name before.
 */
export const linkedTags = (enabled) =>
  EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !enabled() || !(tr.isUserEvent('input') || tr.isUserEvent('delete'))) return tr;
    let one = null;
    let count = 0;
    tr.changes.iterChanges((fromA, toA) => {
      count++;
      one = { fromA, toA };
    });
    if (count !== 1) return tr;
    const tree = syntaxTree(tr.startState);
    // The tag name the change is in (or touches).
    let name = tree.resolveInner(one.fromA, 1);
    if (name.name !== 'TagName') name = tree.resolveInner(one.fromA, -1);
    if (name.name !== 'TagName' || one.toA > name.to || one.fromA < name.from) return tr;
    const tag = name.parent;
    const element = tag?.parent;
    if (!tag || !element || !/Element/.test(element.name)) return tr;
    const otherTag = tag.name === 'OpenTag' ? element.getChild('CloseTag') : tag.name === 'CloseTag' ? element.getChild('OpenTag') : null;
    const other = otherTag?.getChild('TagName');
    if (!other) return tr;
    const old = tr.startState.sliceDoc(name.from, name.to);
    if (tr.startState.sliceDoc(other.from, other.to) !== old) return tr;
    const now = tr.newDoc.sliceString(tr.changes.mapPos(name.from, -1), tr.changes.mapPos(name.to, 1));
    if (!/^[\w:.-]+$/.test(now) || now === old) return tr;
    return [tr, { changes: { from: tr.changes.mapPos(other.from, -1), to: tr.changes.mapPos(other.to, 1), insert: now }, sequential: true }];
  });
