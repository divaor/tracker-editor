// Tests in a file (Running tests): a mark next to the line numbers at each test and suite the
// file declares: ▶ to run it, then ✓ passed, ✗ failed or – skipped after a run. Failures go to
// the editor's problems at their lines (the assertion, from the stack). The page gives what
// testRun.js found (setTestInfo); the marks and failures follow edits until the next run.
import { Facet, GutterMarker, RangeSetBuilder, StateEffect, StateField, gutter } from '../vendor/cm/codemirror.js';

/** { tests: [{ line, kind, title, name }], states: Map(line → state) | null, failures: [{ line, column, message, source }] } */
export const setTestInfo = StateEffect.define();
/** (view, test, { x, y, debug }) for a click on a mark (a right-click debugs); the editor host provides it. */
export const testMarkClick = Facet.define({ combine: (values) => values[0] ?? null });

const TITLES = {
  idle: (t) => `Run ${t.kind === 'suite' ? 'these tests' : 'this test'} (Ctrl+F5) · right-click: debug ${t.kind === 'suite' ? 'them' : 'it'} (Ctrl+Alt+F5)`,
  running: () => 'Running…',
  passed: (t) => `Passed: ${t.title} (click to run again)`,
  failed: (t) => `Failed: ${t.title} (click to run again)`,
  skipped: (t) => `Skipped: ${t.title}`,
};
class Mark extends GutterMarker {
  constructor(test, state) {
    super();
    this.test = test;
    this.state = state;
  }
  eq(other) {
    return other.state === this.state && other.test.title === this.test.title && other.test.kind === this.test.kind;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = `cm-test-mark ${this.state} ${this.test.kind}`;
    el.title = TITLES[this.state](this.test);
    el.textContent = { idle: '▶', running: '…', passed: '✓', failed: '✗', skipped: '–' }[this.state];
    return el;
  }
}

const EMPTY = new RangeSetBuilder().finish();

function build(doc, info) {
  const builder = new RangeSetBuilder();
  // One mark a line (a suite and its first test on one line: the test's), in order.
  const byLine = new Map();
  for (const t of info.tests ?? []) if (t.line >= 1 && t.line <= doc.lines && (!byLine.has(t.line) || t.kind === 'test')) byLine.set(t.line, t);
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const t = byLine.get(line);
    const from = doc.line(line).from;
    builder.add(from, from, new Mark(t, info.states?.get(line) ?? 'idle'));
  }
  const failures = [];
  for (const f of info.failures ?? []) {
    if (!f.line || f.line > doc.lines) continue;
    const line = doc.line(f.line);
    const from = Math.min(line.from + Math.max(0, (f.column ?? 1) - 1), line.to);
    failures.push({ from: from === line.to ? line.from : from, to: line.to, message: f.message, source: f.source ?? '' });
  }
  return { marks: builder.finish(), failures };
}

const testField = StateField.define({
  create: () => ({ marks: EMPTY, failures: [] }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTestInfo)) return e.value ? build(tr.state.doc, e.value) : { marks: EMPTY, failures: [] };
    if (!tr.docChanged) return value;
    // The marks and failures move with the text until the next run.
    return { marks: value.marks.map(tr.changes), failures: value.failures.map((f) => ({ ...f, from: tr.changes.mapPos(f.from), to: tr.changes.mapPos(f.to, 1) })).filter((f) => f.to >= f.from) };
  },
});

/** The marks' gutter and its field, for a tab whose file declares tests. */
export const testGutter = [
  testField,
  gutter({
    class: 'cm-test-gutter',
    markers: (view) => view.state.field(testField).marks,
    domEventHandlers: {
      mousedown(view, line, event) {
        const onClick = view.state.facet(testMarkClick);
        if (!onClick || (event.button !== 0 && event.button !== 2)) return false;
        let test = null;
        view.state.field(testField).marks.between(line.from, line.from, (_from, _to, mark) => {
          test = mark.test;
        });
        if (!test) return false;
        event.preventDefault();
        onClick(view, test, { x: event.clientX, y: event.clientY, debug: event.button === 2 });
        return true;
      },
      contextmenu(view, line, event) {
        let on = false;
        view.state.field(testField).marks.between(line.from, line.from, () => {
          on = true;
        });
        if (on) event.preventDefault();
        return on;
      },
    },
  }),
];

/** A state's test failures as problems ([{ from, to, severity, message, source }]), or []. */
export const testProblems = (state) => (state.field(testField, false)?.failures ?? []).map((f) => ({ from: f.from, to: f.to, severity: 'error', message: f.message, source: f.source }));
/** Does a state have the test marks? */
export const hasTestGutter = (state) => state.field(testField, false) !== undefined;
