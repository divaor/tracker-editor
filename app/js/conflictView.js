// Git's conflict blocks in an open text (gitConflicts.js), for any text with markers: the current
// side, the base (diff3) and the incoming side tinted, the marker lines muted with what each side
// is, and a bar above each block: Accept current · Accept incoming · Accept both · Compare (the two
// sides side by side), and the merge view and the model's merge when the app offers them
// (setConflictInfo). Each accept is one edit (userEvent `resolve.conflict`: its own step, so
// Ctrl+Z brings the block back). editor.js keeps it in its `conflictsCfg` compartment, adds
// `conflictProblems` to the problems (warnings: F8, the minimap's ticks) and reports the count (the
// status bar). The words for each side come from the markers' labels and from the operation that
// stopped on them (git.cjs `in-progress`): during a rebase the current side is the branch being
// rebased onto and the incoming side is your commit, and the bar says so.
import { Decoration, EditorState, EditorView, Facet, StateEffect, StateField, ViewPlugin, WidgetType } from '../vendor/cm/codemirror.js';
import { conflictWords, findConflicts, hasConflictMarkers, resolutionText } from './gitConflicts.js';

/**
 * What the app knows of a tab's conflicts, merged into what it knew: { op: 'merge' | 'rebase' |
 * 'cherry-pick' | 'revert' | null, compare, mergeView, model } (the last three: the bar's buttons).
 */
export const setConflictInfo = StateEffect.define();
/** (view, { action: 'compare' | 'merge-view' | 'model', index }) from a bar's buttons; editor.js provides it. */
export const conflictAction = Facet.define({ combine: (values) => values[0] ?? null });

// Larger texts are not looked at (editor.js leaves the extension out of its lighter editor anyway).
const MAX_TEXT = 8 * 1024 * 1024;
const NONE = { conflicts: [], broken: [] };
const DEFAULT_INFO = { op: null, compare: true, mergeView: false, model: false };

function scan(doc) {
  if (doc.length > MAX_TEXT) return NONE;
  const text = doc.toString();
  return hasConflictMarkers(text) ? findConflicts(text) : NONE;
}

// After an edit to a text without conflicts: could it have made one? Only a start marker can, so
// the lines the edit touched are looked at (a large paste: the whole text again).
function madeStart(tr) {
  let found = false;
  const { doc } = tr.state;
  tr.changes.iterChangedRanges((_fromA, _toA, from, to) => {
    if (found) return;
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    if (last - first > 2000) {
      found = true;
      return;
    }
    for (let n = first; n <= last && !found; n++) if (doc.line(n).text.startsWith('<<<<<<<')) found = true;
  });
  return found;
}

const conflictField = StateField.define({
  create: (state) => ({ ...scan(state.doc), info: DEFAULT_INFO }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) if (e.is(setConflictInfo)) next = { ...next, info: { ...next.info, ...e.value } };
    if (tr.docChanged && (value.conflicts.length || value.broken.length || madeStart(tr))) next = { ...next, ...scan(tr.state.doc) };
    return next;
  },
});

/** The conflict blocks of a state (findConflicts' form, offsets in its text); [] without the extension. */
export const conflictsIn = (state) => state.field(conflictField, false)?.conflicts ?? [];
/** The blocks that cannot be resolved here ({ line, reason: 'nested' | 'unfinished' }). */
export const brokenConflictsIn = (state) => state.field(conflictField, false)?.broken ?? [];
/** Whether a state has conflict blocks, resolvable or not (the parser's errors are the markers' then). */
export const hasConflictBlocks = (state) => {
  const f = state.field(conflictField, false);
  return Boolean(f && (f.conflicts.length || f.broken.length));
};
/** What the app told of a state's conflicts (setConflictInfo). */
export const conflictInfoOf = (state) => state.field(conflictField, false)?.info ?? DEFAULT_INFO;

/** The block at `pos` (the cursor's by default), or null. */
export function conflictAt(state, pos = state.selection.main.head) {
  const end = state.doc.length;
  return conflictsIn(state).find((c) => pos >= c.start && (pos < c.end || (pos === end && c.end === end))) ?? null;
}

/**
 * A block's parts as text: { ours, base (null without diff3), theirs, block (markers and all),
 * before, after (the `around` lines on each side), line (its start marker's, 1-based) }.
 */
export function conflictTexts(state, c, around = 12) {
  const { doc } = state;
  const slice = (r) => (r ? state.sliceDoc(r.from, r.to) : null);
  const first = doc.lineAt(c.start).number;
  const last = doc.lineAt(Math.max(c.start, c.end - 1)).number;
  return {
    ours: slice(c.ours),
    base: slice(c.base),
    theirs: slice(c.theirs),
    block: state.sliceDoc(c.start, c.end),
    before: first > 1 && around > 0 ? state.sliceDoc(doc.line(Math.max(1, first - around)).from, c.start) : '',
    after: last < doc.lines && around > 0 ? state.sliceDoc(c.end, doc.line(Math.min(doc.lines, last + around)).to) : '',
    line: first,
  };
}

// Whether a block runs to the end of the text without a line break after its end marker: then
// what replaces it has none either.
const endsText = (state, c) => c.end === state.doc.length && state.sliceDoc(c.end - 1, c.end) !== '\n';

/**
 * The transaction (as for dispatch) resolving block `index` of a state as `how`
 * (gitConflicts.js RESOLUTIONS: 'ours', 'theirs', 'both', 'both-theirs-first', 'base', 'none'), or
 * null (no such block, or read-only). One edit, its own step to undo; the cursor at its start.
 */
export function conflictResolution(state, index, how) {
  const c = conflictsIn(state)[index];
  if (!c || state.readOnly) return null;
  const t = conflictTexts(state, c, 0);
  const insert = resolutionText({ ours: t.ours, base: t.base ?? '', theirs: t.theirs }, how, { finalNewline: !endsText(state, c) });
  return { changes: { from: c.start, to: c.end, insert }, selection: { anchor: c.start }, userEvent: 'resolve.conflict', scrollIntoView: true };
}

/** Resolves block `index` in a view as `how`: { index, left (the blocks still there) } or null. */
export function resolveConflictIn(view, index, how) {
  const spec = conflictResolution(view.state, index, how);
  if (!spec) return null;
  view.dispatch(spec);
  return { index, left: conflictsIn(view.state).length };
}

/** Resolves the block at `pos` in a view as `how` (the problems' tooltip): as resolveConflictIn. */
export function resolveConflictAt(view, pos, how) {
  const c = conflictAt(view.state, pos);
  return c ? resolveConflictIn(view, c.index, how) : null;
}

/**
 * The next (1) or previous (-1) block from the cursor, wrapping round: { index, count, spec } (spec:
 * the cursor at its start marker, scrolled to the middle), or null when there is none.
 */
export function conflictStep(state, step) {
  const list = conflictsIn(state);
  if (!list.length) return null;
  const pos = state.selection.main.head;
  let index = step > 0 ? list.findIndex((c) => c.start > pos) : list.findLastIndex((c) => c.start < pos);
  if (index === -1) index = step > 0 ? 0 : list.length - 1;
  const at = list[index].start;
  return { index, count: list.length, spec: { selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }), userEvent: 'select' } };
}

/** Goes to the next (1) or previous (-1) block in a view: { index, count } or null. */
export function gotoConflict(view, step) {
  const s = conflictStep(view.state, step);
  if (!s) return null;
  view.dispatch(s.spec);
  return { index: s.index, count: s.count };
}

/** The blocks as problems (warnings, source 'Git'): F8 goes to them, the minimap marks them. */
export function conflictProblems(state) {
  const f = state.field(conflictField, false);
  if (!f || (!f.conflicts.length && !f.broken.length)) return [];
  const { doc } = state;
  const count = f.conflicts.length;
  const out = f.conflicts.map((c, i) => ({
    from: c.start,
    to: doc.lineAt(c.start).to,
    severity: 'warning',
    source: 'Git',
    message: `Conflict ${i + 1} of ${count}: keep the current change (${c.labels.ours || 'current'}), the incoming one (${c.labels.theirs || 'incoming'}) or both, from the bar above it.`,
  }));
  for (const b of f.broken) {
    if (b.line > doc.lines) continue;
    const line = doc.line(b.line);
    out.push({
      from: line.from,
      to: line.to,
      severity: 'warning',
      source: 'Git',
      message: b.reason === 'nested' ? 'A conflict marker inside another conflict: put these lines right by hand.' : 'A conflict that never ends (no >>>>>>> line after it): put these lines right by hand.',
    });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** The problems tooltip's actions for a block at `pos` (undefined when none is there). */
export function conflictLintActions(state, pos) {
  if (!conflictAt(state, pos) || state.readOnly) return undefined;
  const take = (how) => (view, from) => resolveConflictAt(view, from, how);
  return [
    { name: 'Accept current', apply: take('ours') },
    { name: 'Accept incoming', apply: take('theirs') },
    { name: 'Accept both', apply: take('both') },
  ];
}

// ---- What it looks like ----

/** Words for a block: the bar's title and tip, the marker lines' notes, the buttons' hints. */
export function conflictLabels(op, labels = {}) {
  const words = conflictWords(op, labels);
  const ours = labels.ours || 'HEAD';
  const theirs = labels.theirs || 'incoming';
  const current = `Current change · ${ours}${words.current ? ` · ${words.current}` : ''}`;
  const incoming = `Incoming change · ${theirs}${words.incoming ? ` · ${words.incoming}` : ''}`;
  const swap = op === 'rebase' ? '\nDuring a rebase the sides swap: the current change is the branch you are rebasing onto, and the incoming one is your own commit being put on top.' : '';
  return {
    title: words.title,
    tip: `${current}\n${incoming}${swap}`,
    current,
    incoming,
    base: `Common ancestor · ${labels.base || 'base'} · what both changed from`,
    acceptCurrent: `Keep the current change (${ours}${words.current ? `: ${words.current}` : ''})`,
    acceptIncoming: `Keep the incoming change (${theirs}${words.incoming ? `: ${words.incoming}` : ''})`,
  };
}

const OURS = Decoration.line({ class: 'cm-conflict-ours' });
const BASE = Decoration.line({ class: 'cm-conflict-base' });
const THEIRS = Decoration.line({ class: 'cm-conflict-theirs' });
const SEP = Decoration.line({ class: 'cm-conflict-marker cm-conflict-sep' });
const marker = (kind, note) => Decoration.line({ class: `cm-conflict-marker cm-conflict-${kind}`, attributes: { 'data-note': note } });

class ConflictBar extends WidgetType {
  constructor(spec) {
    super();
    this.spec = spec;
  }
  eq(other) {
    const a = this.spec;
    const b = other.spec;
    return ['index', 'count', 'title', 'tip', 'acceptCurrent', 'acceptIncoming', 'readOnly', 'compare', 'mergeView', 'model'].every((k) => a[k] === b[k]);
  }
  toDOM(view) {
    const { index, count, title, tip, readOnly } = this.spec;
    // The space around it is padding (a block widget's margins would put the gutter out of step).
    const el = document.createElement('div');
    el.className = 'cm-conflict-bar';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', `Conflict ${index + 1} of ${count}`);
    const head = document.createElement('span');
    head.className = 'cm-conflict-title';
    head.textContent = `${title} · ${index + 1} of ${count}`;
    head.title = tip;
    el.append(head);
    const button = (hint, text, run, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cm-conflict-btn ${cls}`;
      b.title = hint;
      b.textContent = text;
      // The text keeps the focus (and its cursor).
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        run();
      });
      return b;
    };
    const take = (how) => () => resolveConflictIn(view, index, how);
    const act = (action) => () => view.state.facet(conflictAction)?.(view, { action, index });
    if (!readOnly) {
      el.append(
        button(`${this.spec.acceptCurrent}: one edit, Ctrl+Z brings the block back`, 'Accept current', take('ours'), 'cb-current'),
        button(`${this.spec.acceptIncoming}: one edit, Ctrl+Z brings the block back`, 'Accept incoming', take('theirs'), 'cb-incoming'),
        button('Keep both: the current lines, then the incoming ones', 'Accept both', take('both'), 'cb-both'),
      );
    }
    if (this.spec.compare) el.append(button('The current and the incoming change side by side', 'Compare', act('compare'), 'cb-compare'));
    if (this.spec.mergeView) el.append(button('The current side, the result and the incoming side in three columns (and what both changed from)', 'Merge view', act('merge-view'), 'cb-merge'));
    if (this.spec.model && !readOnly) el.append(button('Ask the model to merge the two changes: you see its proposal before anything changes', '✦ Merge', act('model'), 'cb-model'));
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function decorations(state) {
  const f = state.field(conflictField, false);
  if (!f?.conflicts.length) return Decoration.none;
  const { doc } = state;
  const ranges = [];
  const lineAt = (pos) => doc.lineAt(Math.min(pos, doc.length));
  const tint = (r, deco) => {
    if (!r) return;
    for (let pos = r.from; pos < r.to; ) {
      const line = doc.lineAt(pos);
      ranges.push(deco.range(line.from));
      pos = line.to + 1;
    }
  };
  const count = f.conflicts.length;
  const { compare, mergeView, model } = f.info;
  for (const c of f.conflicts) {
    const words = conflictLabels(f.info.op, c.labels);
    const start = lineAt(c.start);
    const widget = new ConflictBar({ index: c.index, count, title: words.title, tip: words.tip, acceptCurrent: words.acceptCurrent, acceptIncoming: words.acceptIncoming, readOnly: state.readOnly, compare: compare !== false, mergeView: Boolean(mergeView), model: Boolean(model) });
    ranges.push(Decoration.widget({ widget, block: true, side: -1 }).range(start.from));
    ranges.push(marker('start', words.current).range(start.from));
    tint(c.ours, OURS);
    if (c.base) {
      ranges.push(marker('basemark', words.base).range(lineAt(c.ours.to).from));
      tint(c.base, BASE);
    }
    ranges.push(SEP.range(lineAt((c.base ?? c.ours).to).from));
    tint(c.theirs, THEIRS);
    ranges.push(marker('end', words.incoming).range(lineAt(c.theirs.to).from));
  }
  return Decoration.set(ranges, true);
}

// The bars keep to the width one sees (the text may be wider: long lines not wrapped), so their
// buttons wrap there instead of running past the edge: --conflict-bar-width on the view.
const barWidth = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.width = 0;
      this.measure(view);
    }
    update(u) {
      if (u.geometryChanged || (u.docChanged && !this.width)) this.measure(u.view);
    }
    measure(view) {
      if (!conflictsIn(view.state).length) return;
      view.requestMeasure({
        read: () => {
          const mini = view.dom.querySelector('.cm-minimap')?.getBoundingClientRect();
          return Math.max(200, Math.round(view.scrollDOM.clientWidth - view.contentDOM.offsetLeft - (mini?.width > 0 ? mini.width : 0) - 12));
        },
        write: (w) => {
          if (w === this.width) return;
          this.width = w;
          view.dom.style.setProperty('--conflict-bar-width', `${w}px`);
        },
      });
    }
  },
);

/** The extension: the blocks found as the text changes, their tints, notes and bars. */
export const conflictView = [conflictField, EditorView.decorations.compute([conflictField, EditorState.readOnly], decorations), barWidth];
