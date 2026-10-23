// HTML and XML in the editor: Emmet on Tab, and the other end of a tag renamed with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, LanguageDescription, ensureSyntaxTree, indentUnit, languages } from '../app/vendor/cm/codemirror.js';
import { emmetOnTab, linkedTags } from '../app/js/htmlTools.js';

async function stateFor(name, doc, cursor = doc.length, extra = []) {
  const desc = LanguageDescription.matchFilename(languages, name);
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [await desc.load(), indentUnit.of('  '), extra] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return { state, language: desc.name };
}
// A view as far as the commands need one.
const viewOf = (state) => ({
  state,
  dispatch(spec) {
    this.state = this.state.update(spec).state;
  },
});

test('Tab expands an abbreviation in HTML, indented like its line', async () => {
  const { state, language } = await stateFor('a.html', '<body>\n  ul>li*2\n</body>', 16);
  const view = viewOf(state);
  const tab = emmetOnTab(() => language, () => true);
  assert.equal(tab(view), true);
  assert.equal(view.state.doc.toString(), '<body>\n  <ul>\n    <li></li>\n    <li></li>\n  </ul>\n</body>');
  // The cursor in the first empty element.
  assert.equal(view.state.doc.sliceString(view.state.selection.main.head - 4, view.state.selection.main.head + 5), '<li></li>');
});

test('Tab is left alone: plain words, inside a tag, other languages, turned off', async () => {
  const tab = (language, on = true) => emmetOnTab(() => language, () => on);
  let s = await stateFor('a.html', '<p>hello</p>', 8);
  assert.equal(tab(s.language)(viewOf(s.state)), false, 'not a tag name');
  s = await stateFor('a.html', '<div class="x.y">', 15);
  assert.equal(tab(s.language)(viewOf(s.state)), false, 'in an attribute');
  s = await stateFor('a.js', 'const p = div', 13);
  assert.equal(tab(s.language)(viewOf(s.state)), false, 'plain JavaScript');
  s = await stateFor('a.html', 'div.x', 5);
  assert.equal(tab(s.language, false)(viewOf(s.state)), false, 'turned off');
  // JSX: className.
  s = await stateFor('a.jsx', 'const x = (\n  div.card\n);', 22);
  const view = viewOf(s.state);
  assert.equal(tab(s.language)(view), true);
  assert.ok(view.state.doc.toString().includes('<div className="card"></div>'), view.state.doc.toString());
});

test('renaming a tag renames its other end', async () => {
  const { state } = await stateFor('a.html', '<div><p>x</p></div>', 0, linkedTags(() => true));
  // Type "x" after "div" in the open tag: <divx> … </divx>.
  let next = state.update({ changes: { from: 4, insert: 'x' }, userEvent: 'input.type' }).state;
  assert.equal(next.doc.toString(), '<divx><p>x</p></divx>');
  // And from the close tag.
  ensureSyntaxTree(next, next.doc.length, 5000);
  next = next.update({ changes: { from: 12, to: 13, insert: 'span' }, userEvent: 'input.type' }).state;
  assert.equal(next.doc.toString(), '<divx><span>x</span></divx>');
  // Not when the ends did not match before, not for other changes, not when off.
  const off = await stateFor('a.html', '<a></b>', 0, linkedTags(() => true));
  assert.equal(off.state.update({ changes: { from: 2, insert: 'x' }, userEvent: 'input.type' }).state.doc.toString(), '<ax></b>');
  const prog = await stateFor('a.html', '<div></div>', 0, linkedTags(() => true));
  assert.equal(prog.state.update({ changes: { from: 4, insert: 'x' } }).state.doc.toString(), '<divx></div>', 'not typed');
  const offSetting = await stateFor('a.html', '<div></div>', 0, linkedTags(() => false));
  assert.equal(offSetting.state.update({ changes: { from: 4, insert: 'x' }, userEvent: 'input.type' }).state.doc.toString(), '<divx></div>');
  // XML too.
  const xml = await stateFor('a.xml', '<item><a/></item>', 0, linkedTags(() => true));
  assert.equal(xml.state.update({ changes: { from: 5, insert: 's' }, userEvent: 'input.type' }).state.doc.toString(), '<items><a/></items>');
});
