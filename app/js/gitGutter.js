// Lines changed since the last commit, for files on disk in a Git repository: a bar next
// to the line numbers (green added, blue changed) and a red mark where lines were removed.
// The text at the last commit comes from the main process (git:head); setGitBase gives it.
// A click on a mark calls the editor's `gitMarkClick` (stage that change, compare…).
import { Facet, GutterMarker, RangeSetBuilder, StateEffect, StateField, gutter } from '../vendor/cm/codemirror.js';
import { lineChanges } from './gitStatus.js';

/** The file's text at the last commit (null: not in a repository, or new). */
export const setGitBase = StateEffect.define();

const TITLES = { added: 'Added since the last commit (click to stage it)', modified: 'Changed since the last commit (click to stage it)', deleted: 'Lines removed here since the last commit (click to stage it)', 'deleted-top': 'Lines removed here since the last commit (click to stage it)' };

/** (view, line (1-based), { x, y }) for a click on a mark; the editor host provides it. */
export const gitMarkClick = Facet.define({ combine: (values) => values[0] ?? null });
class Mark extends GutterMarker {
  constructor(kind) {
    super();
    this.kind = kind;
  }
  eq(other) {
    return other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = `cm-git-mark ${this.kind}`;
    el.title = TITLES[this.kind];
    return el;
  }
}
const MARKS = Object.fromEntries(Object.keys(TITLES).map((k) => [k, new Mark(k)]));
const NONE = new RangeSetBuilder().finish();
const MAX = 2_000_000; // longer texts are not compared as you type

function compare(doc, base) {
  if (doc.length > MAX || base.length > MAX) return { marks: NONE, changes: null };
  const changes = lineChanges(base, doc.toString());
  if (!changes) return { marks: NONE, changes: null };
  const builder = new RangeSetBuilder();
  const byLine = new Map();
  for (const c of changes) {
    if (c.kind === 'deleted') byLine.set(Math.max(1, c.at), byLine.get(Math.max(1, c.at)) ?? (c.at === 0 ? 'deleted-top' : 'deleted'));
    else for (let n = c.from; n <= Math.min(c.to, doc.lines); n++) byLine.set(n, c.kind);
  }
  for (const n of [...byLine.keys()].sort((a, b) => a - b)) {
    const line = doc.line(Math.min(n, doc.lines));
    builder.add(line.from, line.from, MARKS[byLine.get(n)]);
  }
  return { marks: builder.finish(), changes };
}

const gitField = StateField.define({
  create: () => ({ base: null, marks: NONE, changes: null }),
  update(value, tr) {
    let { base } = value;
    for (const e of tr.effects) if (e.is(setGitBase)) base = e.value;
    if (base === value.base && !tr.docChanged) return value;
    if (base === null || base === undefined) return { base: null, marks: NONE, changes: null };
    return { base, ...compare(tr.state.doc, base) };
  },
});

/** The bar next to the line numbers (its width is the stylesheet's), for a tab given a base. */
export const gitGutter = [
  gitField,
  gutter({
    class: 'cm-git-gutter',
    markers: (view) => view.state.field(gitField).marks,
    domEventHandlers: {
      mousedown(view, line, event) {
        const onClick = view.state.facet(gitMarkClick);
        if (!onClick || event.button !== 0) return false;
        let marked = false;
        view.state.field(gitField).marks.between(line.from, line.from, () => {
          marked = true;
        });
        if (!marked) return false;
        event.preventDefault();
        onClick(view, view.state.doc.lineAt(line.from).number, { x: event.clientX, y: event.clientY });
        return true;
      },
    },
  }),
];

/** { base, changes } for a state: the text at the last commit and how it differs (null when not known). */
export const gitInfo = (state) => {
  const f = state.field(gitField, false);
  return f && f.base !== null ? { base: f.base, changes: f.changes } : null;
};
