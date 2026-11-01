// Breakpoints in a file (Debugging): a gutter before the line numbers. A click toggles a
// breakpoint on the line (F9 at the cursor does too), a right-click opens its menu (condition,
// log message, hit count, off, remove); the marks follow edits, and the app hears where they
// moved to (it keeps them per file in the settings). While a run is paused in the file, an
// arrow and a band mark the line it is paused on.
import { Decoration, EditorView, Facet, GutterMarker, RangeSetBuilder, StateEffect, StateField, gutter } from '../vendor/cm/codemirror.js';

/** [{ line, enabled?, condition?, logMessage?, hitCondition?, verified? }]: the file's breakpoints. */
export const setBreakpointMarks = StateEffect.define();
/** The line a run is paused on (0: none). */
export const setPausedLine = StateEffect.define();
/** (view, { line, x, y, menu }) for a click in the gutter; the editor host provides it. */
export const breakpointClick = Facet.define({ combine: (values) => values[0] ?? null });
/** (view, list) when edits moved the breakpoints; the editor host provides it. */
export const breakpointsMoved = Facet.define({ combine: (values) => values[0] ?? null });

class BreakpointMark extends GutterMarker {
  constructor(bp) {
    super();
    this.bp = bp;
  }
  eq(other) {
    const a = this.bp;
    const b = other.bp;
    return a.enabled === b.enabled && a.condition === b.condition && a.logMessage === b.logMessage && a.hitCondition === b.hitCondition && a.verified === b.verified;
  }
  toDOM() {
    const el = document.createElement('div');
    const b = this.bp;
    const kind = b.logMessage ? 'log' : b.condition || b.hitCondition ? 'conditional' : 'plain';
    el.className = `cm-breakpoint ${kind}${b.enabled === false ? ' off' : ''}${b.verified === false ? ' unverified' : ''}`;
    const what = b.logMessage ? `Log point: ${b.logMessage}` : b.condition ? `Breakpoint when ${b.condition}` : b.hitCondition ? `Breakpoint on hit ${b.hitCondition}` : 'Breakpoint';
    el.title = `${what}${b.enabled === false ? ' (off)' : ''}${b.verified === false ? ' — not bound yet (the code there has not loaded, or no code is on the line)' : ''}\nClick: remove · Right-click: change`;
    return el;
  }
}
// The mark keeps to its line's text: Enter at the line's start takes it down with the text.
BreakpointMark.prototype.startSide = 1;
BreakpointMark.prototype.endSide = 1;
BreakpointMark.prototype.mapMode = 1; // MapMode.TrackDel: a deleted line's mark goes with it

class PausedMark extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-debug-arrow';
    el.title = 'Paused here';
    el.textContent = '➜';
    return el;
  }
  eq() {
    return true;
  }
}
PausedMark.prototype.startSide = 1;
PausedMark.prototype.endSide = 1;

// The gutter's width when no line has a mark.
class SpaceMark extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-breakpoint-space';
    return el;
  }
}

const EMPTY = new RangeSetBuilder().finish();
const pausedLine = Decoration.line({ class: 'cm-debug-paused' });

function build(doc, list) {
  const builder = new RangeSetBuilder();
  const byLine = new Map();
  for (const bp of list ?? []) if (bp.line >= 1 && bp.line <= doc.lines && !byLine.has(bp.line)) byLine.set(bp.line, bp);
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const from = doc.line(line).from;
    const { line: _l, ...rest } = byLine.get(line);
    builder.add(from, from, new BreakpointMark(rest));
  }
  return builder.finish();
}

const breakpointField = StateField.define({
  create: () => EMPTY,
  update(set, tr) {
    for (const e of tr.effects) if (e.is(setBreakpointMarks)) return build(tr.state.doc, e.value);
    return tr.docChanged ? set.map(tr.changes) : set;
  },
});

const pausedField = StateField.define({
  create: () => ({ marks: EMPTY, decos: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setPausedLine)) continue;
      const line = e.value;
      if (!line || line > tr.state.doc.lines) return { marks: EMPTY, decos: Decoration.none };
      const from = tr.state.doc.line(line).from;
      const marks = new RangeSetBuilder();
      marks.add(from, from, new PausedMark());
      return { marks: marks.finish(), decos: Decoration.set([pausedLine.range(from)]) };
    }
    return tr.docChanged ? { marks: value.marks.map(tr.changes), decos: value.decos.map(tr.changes) } : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/** A state's breakpoints as they are now (moved by edits): [{ line, … }], one a line. */
export function breakpointsIn(state) {
  const set = state.field(breakpointField, false);
  if (!set) return [];
  const out = [];
  const seen = new Set();
  for (let it = set.iter(); it.value; it.next()) {
    const line = state.doc.lineAt(it.from).number;
    if (seen.has(line)) continue;
    seen.add(line);
    const { verified: _v, ...bp } = it.value.bp;
    out.push({ line, ...bp });
  }
  return out;
}
/** Does a state have the breakpoint gutter? */
export const hasDebugGutter = (state) => state.field(breakpointField, false) !== undefined;
/** The line a state shows as paused (0: none). */
export function pausedLineOf(state) {
  const v = state.field(pausedField, false);
  if (!v) return 0;
  const it = v.marks.iter();
  return it.value ? state.doc.lineAt(it.from).number : 0;
}

const sameLines = (a, b) => a.length === b.length && a.every((x, i) => x.line === b[i].line);

/** The gutter and its fields, for a tab whose file can be debugged. */
export const debugGutter = [
  breakpointField,
  pausedField,
  gutter({
    class: 'cm-breakpoint-gutter',
    markers: (view) => [view.state.field(breakpointField), view.state.field(pausedField).marks],
    initialSpacer: () => new SpaceMark(),
    // Every line has its element, so hovering one shows where a click puts a breakpoint.
    renderEmptyElements: true,
    domEventHandlers: {
      mousedown(view, block, event) {
        const onClick = view.state.facet(breakpointClick);
        if (!onClick || (event.button !== 0 && event.button !== 2)) return false;
        event.preventDefault();
        onClick(view, { line: view.state.doc.lineAt(block.from).number, x: event.clientX, y: event.clientY, menu: event.button === 2 || (event.button === 0 && event.ctrlKey && /Mac/.test(navigator.platform)) });
        return true;
      },
      contextmenu(_view, _block, event) {
        event.preventDefault();
        return true;
      },
    },
  }),
  // Edits move the marks: the app hears the new lines (it keeps them in the settings).
  EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const before = update.startState.field(breakpointField, false);
    const after = update.state.field(breakpointField, false);
    if (!after || (before === EMPTY && after === EMPTY)) return;
    const onMoved = update.state.facet(breakpointsMoved);
    if (!onMoved) return;
    const was = breakpointsIn(update.startState);
    const now = breakpointsIn(update.state);
    if (!sameLines(was, now)) onMoved(update.view, now);
  }),
];
