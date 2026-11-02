// The merge view's texts (ui/mergeView.js): the current side (Git's :2:), the result (the file,
// editable, with the editor's own conflict bars: conflictView.js) and the incoming side (:3:), and
// the common ancestor (:1:) when it is asked for. The sides are read-only: the lines each changed
// from the ancestor are marked, and the section of the conflict in hand is outlined and scrolled to
// as the result's cursor goes from block to block (gitConflicts.js sidePlace finds it there).
import { Compartment, Decoration, EditorState, EditorView, StateEffect, StateField, bracketMatching, defaultKeymap, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, history, historyKeymap, indentWithTab, keymap, lineNumbers, searchKeymap } from '../vendor/cm/codemirror.js';
import { findLanguage, textLook } from './editor.js';
import { conflictAction, conflictAt, conflictsIn, conflictTexts, conflictView, gotoConflict, setConflictInfo } from './conflictView.js';
import { resolutionText, sidePlace } from './gitConflicts.js';
import { diffBlocks } from './gitStatus.js';

// The section of the block in hand, in a side: its lines outlined (an empty one: a line where it would be).
const setFocus = StateEffect.define();
const FOCUS = Decoration.line({ class: 'cm-merge-focus' });
const PLACE = Decoration.line({ class: 'cm-merge-place' });
function focusMarks(state, place) {
  if (!place) return Decoration.none;
  const { doc } = state;
  if (place.from >= place.to) return Decoration.set([PLACE.range(doc.lineAt(Math.min(place.from, doc.length)).from)]);
  const ranges = [];
  for (let pos = place.from; pos < place.to && pos <= doc.length; ) {
    const line = doc.lineAt(pos);
    ranges.push(FOCUS.range(line.from));
    pos = line.to + 1;
  }
  return Decoration.set(ranges);
}
const focusField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) return focusMarks(tr.state, e.value);
    return marks.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
// The lines a side changed from the common ancestor (none known: nothing marked).
const CHANGED = Decoration.line({ class: 'cm-merge-changed' });
const changedField = (base) =>
  StateField.define({
    create(state) {
      if (base == null) return Decoration.none;
      const ranges = [];
      for (const b of diffBlocks(base, state.doc.toString()) ?? []) for (let n = b.bFrom; n < b.bTo && n < state.doc.lines; n++) ranges.push(CHANGED.range(state.doc.line(n + 1).from));
      return Decoration.set(ranges);
    },
    update: (marks) => marks,
    provide: (f) => EditorView.decorations.from(f),
  });

/**
 * The views in `parents` ({ ours, theirs, result, base (null: not shown) }), for the texts `ours`,
 * `theirs`, `base` (null when Git has none) and `result`. `info`: { op, model } (conflictView.js
 * setConflictInfo: the words, the bar's ✦ Merge); `onChange(text)` after each edit of the result,
 * `onCursor({ index, count })` when the block at its cursor or the number of blocks changes,
 * `onAction({ action, index })` for a bar's ✦ Merge.
 */
export function createThreeWay(parents, { ours = '', theirs = '', base = null, result = '', name = '', dark = false, wrap = false, readOnly = false, info = {}, onChange = () => {}, onCursor = () => {}, onAction = () => {} }) {
  const lang = new Compartment();
  const look = () => [textLook(dark), wrap ? EditorView.lineWrapping : [], lang.of([])];
  const side = (parent, text, from) =>
    parent
      ? new EditorView({
          parent,
          state: EditorState.create({ doc: text ?? '', extensions: [lineNumbers(), highlightSpecialChars(), drawSelection(), EditorState.readOnly.of(true), keymap.of([...defaultKeymap, ...searchKeymap]), focusField, changedField(from), ...look()] }),
        })
      : null;
  const views = { ours: side(parents.ours, ours, base), theirs: side(parents.theirs, theirs, base), base: side(parents.base, base, null), result: null };
  let reported = '';
  const report = () => {
    const v = views.result;
    if (!v) return;
    const c = conflictAt(v.state);
    const now = { index: c ? c.index : -1, count: conflictsIn(v.state).length };
    const key = `${now.index}:${now.count}:${c?.start ?? ''}`;
    if (key === reported) return;
    reported = key;
    onCursor(now);
    if (c) showSides(c);
  };
  // Each side shows the section of block `c` (the result's), outlined.
  const showSides = (c) => {
    const st = views.result.state;
    const t = conflictTexts(st, c);
    const near = st.doc.length ? c.start / st.doc.length : 0;
    for (const [v, section] of [[views.ours, t.ours], [views.theirs, t.theirs], [views.base, t.base]]) {
      if (!v) continue;
      const place = sidePlace(v.state.doc.toString(), section ?? '', { before: t.before, near });
      v.dispatch({ effects: [setFocus.of(place), ...(place ? [EditorView.scrollIntoView(place.from, { y: 'center' })] : [])] });
    }
  };
  views.result = new EditorView({
    parent: parents.result,
    state: EditorState.create({
      doc: result,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        readOnly ? EditorState.readOnly.of(true) : [],
        ...look(),
        conflictView,
        conflictAction.of((_v, a) => onAction(a)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) queueMicrotask(report);
        }),
      ],
    }),
  });
  // No Compare or merge view from the bars here: the sides are beside them.
  views.result.dispatch({ effects: setConflictInfo.of({ op: info.op ?? null, compare: false, mergeView: false, model: Boolean(info.model) }) });
  const all = () => Object.values(views).filter(Boolean);
  const desc = findLanguage(name);
  desc?.load().then((support) => all().forEach((v) => v.dispatch({ effects: lang.reconfigure(support) })), () => {});
  const r = () => views.result;
  return {
    views,
    /** The result's text now. */
    text: () => r().state.doc.toString(),
    /** The cursor to block `index` of the result (false when there is none), the sides with it. */
    focusConflict(index) {
      const c = conflictsIn(r().state)[index];
      if (!c) return false;
      r().dispatch({ selection: { anchor: c.start }, effects: EditorView.scrollIntoView(c.start, { y: 'center' }) });
      reported = '';
      report();
      return true;
    },
    /** The next (1) or previous (-1) block: { index, count } or null. */
    goto(step) {
      const moved = gotoConflict(r(), step);
      r().focus();
      return moved;
    },
    /** Block `index`'s texts (conflictView.js conflictTexts), or null. */
    conflict(index) {
      const st = r().state;
      const c = conflictsIn(st)[index];
      return c ? { index: c.index, count: conflictsIn(st).length, labels: c.labels, ...conflictTexts(st, c) } : null;
    },
    /** Every block resolved as `how` in one edit (Ctrl+Z brings them back): false when there is none. */
    resolveAll(how) {
      const st = r().state;
      const list = conflictsIn(st);
      if (st.readOnly || !list.length) return false;
      const changes = list.map((c) => {
        const t = conflictTexts(st, c, 0);
        const last = c.end === st.doc.length && st.sliceDoc(c.end - 1, c.end) !== '\n';
        return { from: c.start, to: c.end, insert: resolutionText({ ours: t.ours, base: t.base ?? '', theirs: t.theirs }, how, { finalNewline: !last }) };
      });
      r().dispatch({ changes, userEvent: 'resolve.conflict', scrollIntoView: true });
      return true;
    },
    /** Block `index` replaced by `text` when it still reads `block` (the model's merge): false when it changed. */
    replaceConflict(index, block, text) {
      const st = r().state;
      const c = conflictsIn(st)[index];
      if (!c || st.readOnly || st.sliceDoc(c.start, c.end) !== block) return false;
      r().dispatch({ changes: { from: c.start, to: c.end, insert: text }, selection: { anchor: c.start }, userEvent: 'resolve.conflict', scrollIntoView: true });
      return true;
    },
    /** What the result's bars know: { op, model }. */
    setInfo: (next) => r().dispatch({ effects: setConflictInfo.of(next) }),
    /** The views measure again (a column just shown). */
    measure: () => all().forEach((v) => v.requestMeasure()),
    focus: () => r().focus(),
    destroy: () => all().forEach((v) => v.destroy()),
  };
}
