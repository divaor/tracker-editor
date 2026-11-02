// Lines changed since the last commit, for files on disk in a Git repository: a bar next
// to the line numbers (green added, blue changed) and a red mark where lines were removed.
// The text at the last commit comes from the main process (git:head); setGitBase gives it.
// A click on a mark calls the editor's `gitMarkClick` (stage, revert or show that change…).
// "Show the change" opens a peek under the change: the commit's lines against the ones now,
// with Revert, Stage, the previous and next change, and Close (Escape). Reverting puts a block
// back as it is at the last commit, as one edit (`revert.git`), so Ctrl+Z brings it back.
import { Decoration, EditorView, Facet, GutterMarker, Prec, RangeSetBuilder, StateEffect, StateField, WidgetType, gutter, keymap } from '../vendor/cm/codemirror.js';
import { changeIndexAt, changesOf, diffBlocks, markLineOf, revertBlock } from './gitStatus.js';

/** The file's text at the last commit (null: not in a repository, or new). */
export const setGitBase = StateEffect.define();
/**
 * The peek under the change whose mark is on `line` ({ line, index? }: `index` tells two changes
 * marked on one line apart, lines removed before and after the first), or none (null).
 */
export const peekChange = StateEffect.define();

const TITLES = {
  added: 'Added since the last commit (click: stage, revert or show it)',
  modified: 'Changed since the last commit (click: stage, revert or show it)',
  deleted: 'Lines removed here since the last commit (click: stage, revert or show it)',
  'deleted-top': 'Lines removed here since the last commit (click: stage, revert or show it)',
};

/** (view, line (1-based), { x, y }) for a click on a mark; the editor host provides it. */
export const gitMarkClick = Facet.define({ combine: (values) => values[0] ?? null });
/** (view, { action: 'revert' | 'stage', line }) from the peek's buttons; the editor host provides it. */
export const gitChangeAction = Facet.define({ combine: (values) => values[0] ?? null });
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

// One diff a change: the blocks (gitStatus.js diffBlocks) give the marks, the changes the
// minimap and the status bar read, and what reverting, staging and the peek take.
function compare(doc, base) {
  if (doc.length > MAX || base.length > MAX) return { marks: NONE, changes: null, blocks: null };
  const blocks = diffBlocks(base, doc.toString());
  if (!blocks) return { marks: NONE, changes: null, blocks: null };
  const changes = changesOf(blocks);
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
  return { marks: builder.finish(), changes, blocks };
}

const gitField = StateField.define({
  create: () => ({ base: null, marks: NONE, changes: null, blocks: null }),
  update(value, tr) {
    let { base } = value;
    for (const e of tr.effects) if (e.is(setGitBase)) base = e.value;
    if (base === value.base && !tr.docChanged) return value;
    if (base === null || base === undefined) return { base: null, marks: NONE, changes: null, blocks: null };
    return { base, ...compare(tr.state.doc, base) };
  },
});

// The peek: the line of the change it shows (it moves with the text) and its place among the
// changes, or null.
const peekField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(peekChange)) return e.value ? { line: e.value.line, index: e.value.index ?? -1 } : null;
    if (!value || !tr.docChanged) return value;
    const was = tr.startState.doc.line(Math.min(value.line, tr.startState.doc.lines));
    return { line: tr.newDoc.lineAt(tr.changes.mapPos(was.from, 1)).number, index: value.index };
  },
});
// The change the peek shows: its own when still marked on its line, else the one on its line.
const peekIndex = (blocks, peek) => (peek.index >= 0 && blocks[peek.index] && markLineOf(blocks[peek.index]) === peek.line ? peek.index : changeIndexAt(blocks, peek.line));

// The base's lines, split once per base (the peek reads them as you type).
let split = { base: null, lines: [] };
const baseLines = (base) => (split.base === base ? split.lines : (split = { base, lines: base.split('\n') }).lines);

const PEEK_LINES = 40; // lines shown a side; the rest is counted

// The width of the text one sees (the content may be wider, with long lines not wrapped): the
// peek keeps to it, so its buttons show without scrolling sideways.
function visibleTextWidth(view) {
  const mini = view.dom.querySelector('.cm-minimap')?.getBoundingClientRect();
  return Math.max(240, view.scrollDOM.clientWidth - view.contentDOM.offsetLeft - (mini?.width > 0 ? mini.width : 0) - 16);
}

class PeekWidget extends WidgetType {
  constructor(spec) {
    super();
    this.spec = spec;
  }
  eq(other) {
    const a = this.spec;
    const b = other.spec;
    return a.index === b.index && a.count === b.count && a.line === b.line && a.old.join('\n') === b.old.join('\n') && a.now.join('\n') === b.now.join('\n') && a.readOnly === b.readOnly;
  }
  toDOM(view) {
    const { old, now, index, count, line, readOnly } = this.spec;
    // The space around it is padding (a block widget's margins would put the gutter out of step).
    const el = document.createElement('div');
    el.className = 'cm-change-peek';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'The change against the last commit');
    const box = document.createElement('div');
    box.className = `cm-peek-box ${!old.length ? 'added' : !now.length ? 'deleted' : 'modified'}`;
    box.style.maxWidth = `${visibleTextWidth(view)}px`;
    el.append(box);
    const head = document.createElement('div');
    head.className = 'cm-peek-head';
    const title = document.createElement('span');
    title.className = 'cm-peek-title';
    const what = !old.length ? `${now.length} line${now.length === 1 ? '' : 's'} added` : !now.length ? `${old.length} line${old.length === 1 ? '' : 's'} removed` : `${now.length} line${now.length === 1 ? '' : 's'} changed`;
    title.textContent = `Change ${index + 1} of ${count} · ${what} since the last commit`;
    title.title = title.textContent;
    // The buttons keep together; the title gives way when the pane is narrow.
    const buttons = document.createElement('span');
    buttons.className = 'cm-peek-actions';
    head.append(title, buttons);
    const button = (label, text, run, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cm-peek-btn ${cls}`.trim();
      b.title = label;
      b.setAttribute('aria-label', label);
      b.textContent = text;
      // The text keeps the focus (and its cursor).
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        e.preventDefault();
        run();
      });
      return b;
    };
    const act = (action) => () => view.state.facet(gitChangeAction)?.(view, { action, line });
    if (!readOnly) buttons.append(button('Revert this change: back to the last commit’s lines (Ctrl+Z brings yours back)', 'Revert', act('revert'), 'revert'));
    buttons.append(button('Stage this change: only this block goes into the next commit', 'Stage', act('stage'), 'stage'));
    buttons.append(button('Previous change', '↑', () => gotoChange(view, -1), 'prev'), button('Next change', '↓', () => gotoChange(view, 1), 'next'));
    buttons.append(button('Close (Esc)', '×', () => view.dispatch({ effects: peekChange.of(null) }), 'close'));
    box.append(head);
    const body = document.createElement('div');
    body.className = 'cm-peek-body';
    const rows = (lines, kind, mark) => {
      for (const text of lines.slice(0, PEEK_LINES)) {
        const row = document.createElement('div');
        row.className = `cm-peek-line ${kind}`;
        const sign = document.createElement('span');
        sign.className = 'cm-peek-sign';
        sign.textContent = mark;
        const code = document.createElement('span');
        code.textContent = text || ' ';
        row.append(sign, code);
        body.append(row);
      }
      if (lines.length > PEEK_LINES) {
        const more = document.createElement('div');
        more.className = `cm-peek-line more ${kind}`;
        more.textContent = `… ${lines.length - PEEK_LINES} more line${lines.length - PEEK_LINES === 1 ? '' : 's'}`;
        body.append(more);
      }
    };
    rows(old, 'del', '−');
    rows(now, 'ins', '+');
    if (!old.length) {
      const note = document.createElement('div');
      note.className = 'cm-peek-note';
      note.textContent = 'Not in the last commit: Revert takes these lines out.';
      body.prepend(note);
    }
    box.append(body);
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function peekDecorations(state) {
  const peek = state.field(peekField, false);
  const git = state.field(gitField, false);
  if (!peek || !git?.blocks || git.base == null) return Decoration.none;
  const index = peekIndex(git.blocks, peek);
  if (index === -1) return Decoration.none;
  const block = git.blocks[index];
  const { doc } = state;
  const old = baseLines(git.base).slice(block.aFrom, block.aTo);
  const now = [];
  for (let n = block.bFrom; n < block.bTo && n < doc.lines; n++) now.push(doc.line(n + 1).text);
  const widget = new PeekWidget({ old, now, index, count: git.blocks.length, line: markLineOf(block), readOnly: state.readOnly });
  // Under the change's last line; a removal under the line before it, or over the first line.
  const after = block.bFrom === block.bTo ? block.bFrom : block.bTo;
  if (after === 0) return Decoration.set([Decoration.widget({ widget, block: true, side: -1 }).range(0)]);
  return Decoration.set([Decoration.widget({ widget, block: true, side: 1 }).range(doc.line(Math.min(after, doc.lines)).to)]);
}

/** The bar next to the line numbers (its width is the stylesheet's), for a tab given a base. */
export const gitGutter = [
  gitField,
  peekField,
  EditorView.decorations.compute([gitField, peekField], peekDecorations),
  // Escape closes the peek (before the editor's own Escape).
  Prec.highest(
    keymap.of([
      {
        key: 'Escape',
        run: (view) => {
          if (!view.state.field(peekField, false)) return false;
          view.dispatch({ effects: peekChange.of(null) });
          return true;
        },
      },
    ]),
  ),
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

/** { base, changes, blocks } for a state: the text at the last commit and how it differs (null when not known). */
export const gitInfo = (state) => {
  const f = state.field(gitField, false);
  return f && f.base !== null ? { base: f.base, changes: f.changes, blocks: f.blocks } : null;
};

/**
 * The change whose mark is on `line` of a state: { index, count, block, line (its mark's), kind,
 * removed (the commit's lines), added (the lines now) }, or null.
 */
export function changeAt(state, line) {
  const git = state.field(gitField, false);
  if (!git?.blocks || git.base == null) return null;
  const index = changeIndexAt(git.blocks, line);
  if (index === -1) return null;
  const block = git.blocks[index];
  const kind = block.aFrom === block.aTo ? 'added' : block.bFrom === block.bTo ? 'deleted' : 'modified';
  return { index, count: git.blocks.length, block, line: markLineOf(block), kind, removed: block.aTo - block.aFrom, added: block.bTo - block.bFrom };
}

/** The line the peek shows the change of, or 0. */
export const peekLineOf = (state) => state.field(peekField, false)?.line ?? 0;

/**
 * The change at `line` put back as it is at the last commit, in a view: one edit (`revert.git`,
 * its own step to undo), the cursor at its start, the peek closed. { line, kind } or null.
 */
export function revertChange(view, line) {
  const { state } = view;
  const git = state.field(gitField, false);
  if (!git?.blocks || git.base == null || state.readOnly) return null;
  const change = revertBlock(git.base, state.doc.toString(), line, git.blocks);
  if (!change) return null;
  const kind = change.block.aFrom === change.block.aTo ? 'added' : change.block.bFrom === change.block.bTo ? 'deleted' : 'modified';
  view.dispatch({
    changes: { from: change.from, to: change.to, insert: change.insert },
    // At the change's first line (lines put back at the end come after a line break).
    selection: { anchor: change.insert.startsWith('\n') ? change.from + 1 : change.from },
    effects: state.field(peekField, false) ? peekChange.of(null) : [],
    userEvent: 'revert.git',
    scrollIntoView: true,
  });
  return { line: view.state.doc.lineAt(view.state.selection.main.head).number, kind };
}

/** Opens the peek under the change at `line` of a view (false when no change is there). */
export function showChange(view, line) {
  const { state } = view;
  const change = changeAt(state, line);
  if (!change) return false;
  const from = state.doc.line(Math.min(change.line, state.doc.lines)).from;
  // The cursor goes to the change unless it is in it already.
  const here = state.doc.lineAt(state.selection.main.head).number;
  const inside = change.added ? here > change.block.bFrom && here <= change.block.bTo : here === change.line;
  view.dispatch({ effects: [peekChange.of({ line: change.line, index: change.index }), EditorView.scrollIntoView(inside ? state.selection.main.head : from, { y: 'center' })], ...(inside ? {} : { selection: { anchor: from } }) });
  return true;
}

/**
 * The next (1) or previous (-1) change in a view, from the peek's when it is open, else from the
 * cursor (wrapping round): the cursor goes to its first line and the peek, when open, follows.
 * { index, count } or null when nothing changed.
 */
export function gotoChange(view, dir) {
  const { state } = view;
  const git = state.field(gitField, false);
  const blocks = git?.blocks;
  if (!blocks?.length || git.base == null) return null;
  const lines = blocks.map(markLineOf);
  const peek = state.field(peekField, false);
  let index;
  const shown = peek ? peekIndex(blocks, peek) : -1;
  if (shown !== -1) index = (shown + (dir > 0 ? 1 : -1) + blocks.length) % blocks.length;
  else {
    const here = state.doc.lineAt(state.selection.main.head).number;
    if (dir > 0) {
      index = lines.findIndex((l) => l > here);
      if (index === -1) index = 0;
    } else {
      index = lines.findLastIndex((l) => l < here);
      if (index === -1) index = blocks.length - 1;
    }
  }
  const line = Math.min(lines[index], state.doc.lines);
  const from = state.doc.line(line).from;
  view.dispatch({ selection: { anchor: from }, effects: [EditorView.scrollIntoView(from, { y: 'center' }), ...(peek ? [peekChange.of({ line, index })] : [])], userEvent: 'select' });
  return { index, count: blocks.length };
}
