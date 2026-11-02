// Blame in the editor (Git, desktop): who changed each line and when, from `git blame
// --porcelain` of the editor's own text (git:blame, so lines not saved yet are "not committed
// yet"). The app gives a tab its blame (setBlame); edits move it (an edited line is not committed
// until the app asks again, once typing stops). Two ways to see it:
// - inline: at the end of the cursor's line, muted ("You, 3 days ago · Fix the parser"), only
//   while the cursor rests in a pane with the focus, and only where it fits beside the code;
// - the column (blameColumn, in a compartment of its own per tab): a gutter before the line
//   numbers with each block's date and author, tinted by how new its commit is.
// Hovering either (a mouse), or a click or tap, calls `onEvent` with the line and where it is on
// screen: the app shows the commit's card (ui/blame.js).
import { Decoration, GutterMarker, StateEffect, StateField, ViewPlugin, WidgetType, gutter } from '../vendor/cm/codemirror.js';
import { NOT_COMMITTED, blameAges, blameLineText, blameWho, remapLines } from './gitStatus.js';

/** A tab's blame (git:blame's answer: { commits, lines, me, … }, or { status: 'big', size, max }), or null for none. */
export const setBlame = StateEffect.define();
/** The settings changed: the inline blame looks again (shows, or goes). */
export const refreshBlame = StateEffect.define();
// The inline blame a view shows: { pos, line, hash, text, max, note } or null (the plugin's own).
const showInline = StateEffect.define();

const REST_MS = 500; // the cursor rests this long before the inline blame shows
const TOLD_MS = 1200; // a note on screen this long has been said (a file too large: once)
const NOT_YET = { hash: NOT_COMMITTED, author: '', mail: '', time: 0, tz: '', summary: '', previous: null, boundary: false, filename: '', uncommitted: true };

// Lines git counts in a text: a last line break ends a line rather than starting one.
const blamedLines = (doc) => (doc.length === 0 ? 0 : doc.line(doc.lines).length === 0 ? doc.lines - 1 : doc.lines);

function prepare(raw, doc) {
  if (raw.tooBig || raw.status === 'big') return { status: 'big', size: raw.size ?? 0, max: raw.max ?? 0, told: false, source: raw };
  const commits = new Map(Object.entries(raw.commits ?? {}));
  if (!commits.has(NOT_COMMITTED)) commits.set(NOT_COMMITTED, NOT_YET);
  // Not in the last commit (a new file, or a repository without one): every line is not committed yet.
  const lines = raw.untracked ? new Array(blamedLines(doc)).fill(NOT_COMMITTED) : [...(raw.lines ?? [])];
  return { status: 'ready', commits, lines, ages: blameAges(raw.commits), me: raw.me ?? null, head: raw.head ?? '', root: raw.root ?? '', rel: raw.rel ?? '', untracked: Boolean(raw.untracked), source: raw, mapped: false };
}

/**
 * The lines an edit touched, as blocks of lines before and after (gitStatus.js remapLines): a
 * line the change only starts at the end of, or only ends at the start of, keeps its text and its
 * blame (Enter at a line's end, a whole line deleted).
 */
function changeBlocks(tr) {
  const a = tr.startState.doc;
  const b = tr.newDoc;
  const blocks = [];
  tr.changes.iterChanges((fromA, toA, fromB, toB) => {
    const la1 = a.lineAt(fromA);
    const la2 = a.lineAt(toA);
    const lb1 = b.lineAt(fromB);
    const lb2 = b.lineAt(toB);
    let aFrom = la1.number - 1;
    let aTo = la2.number;
    let bFrom = lb1.number - 1;
    let bTo = lb2.number;
    if (toA === la2.from && toB === lb2.from && (aTo - 1 > aFrom || bTo - 1 > bFrom)) {
      aTo--;
      bTo--;
    }
    if (fromA === la1.to && fromB === lb1.to && (aTo > aFrom + 1 || bTo > bFrom + 1)) {
      aFrom++;
      bFrom++;
    }
    blocks.push({ aFrom, aTo: Math.max(aFrom, aTo), bFrom, bTo: Math.max(bFrom, bTo) });
  });
  return blocks;
}

/** A tab's blame: { status: 'ready', commits (Map), lines, ages, me, … } or { status: 'big', … }, or null. */
const blameField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value ? prepare(e.value, tr.state.doc) : null;
    if (!value || !tr.docChanged || value.status !== 'ready') return value;
    return { ...value, lines: remapLines(value.lines, changeBlocks(tr), NOT_COMMITTED), mapped: true };
  },
});

/** A state's blame (see blameField), or null. */
export const blameOf = (state) => state.field(blameField, false) ?? null;

/**
 * What blame says of a line (1-based) of a state: { status: 'ready', line, hash, commit, me, age,
 * column } | { status: 'big', size, max } | null.
 */
export function blameAt(state, line) {
  const data = blameOf(state);
  if (!data) return null;
  if (data.status === 'big') return { status: 'big', size: data.size, max: data.max };
  const hash = data.lines[line - 1];
  const commit = hash ? data.commits.get(hash) : null;
  if (!commit) return null;
  return { status: 'ready', line, hash, commit, me: data.me, age: data.ages.get(hash) ?? 1, root: data.root, rel: data.rel };
}

/** The extension: the field, in every tab (the app fills it for files in a repository). */
export const blameState = blameField;

// ---- Inline: at the end of the cursor's line ----

class InlineBlame extends WidgetType {
  constructor(spec, onEvent) {
    super();
    this.spec = spec;
    this.onEvent = onEvent;
  }
  eq(other) {
    const a = this.spec;
    const b = other.spec;
    return a.text === b.text && a.max === b.max && a.line === b.line && a.hash === b.hash && a.note === b.note;
  }
  toDOM(view) {
    const { text, max, line, hash, note, uncommitted } = this.spec;
    const el = document.createElement('span');
    el.className = `cm-inline-blame${uncommitted ? ' uncommitted' : ''}${note ? ' note' : ''}`;
    el.textContent = text;
    // As much room as there is beside the code, and not more than a sentence.
    el.style.maxWidth = `min(60ch, ${max}px)`;
    el.dataset.line = String(line);
    if (hash) el.dataset.hash = hash;
    const tell = (kind, e) => this.onEvent?.(view, { kind, line, from: 'inline', rect: el.getBoundingClientRect(), touch: e?.pointerType !== 'mouse' });
    // A mouse hovers (a click there is a click at the line's end, as without it); a finger or a pen taps.
    el.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && tell('enter', e));
    el.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && tell('leave', e));
    el.addEventListener('pointerdown', (e) => {
      el.dataset.pointer = e.pointerType;
      if (e.pointerType !== 'mouse') e.preventDefault();
    });
    el.addEventListener('click', (e) => {
      if (el.dataset.pointer === 'mouse') return;
      e.preventDefault();
      tell('click', e);
    });
    return el;
  }
  // The editor takes a mouse's press (the cursor goes to the line's end); a tap is the card's.
  ignoreEvent(event) {
    return !(event.type === 'mousedown' && event.target?.closest?.('.cm-inline-blame')?.dataset.pointer === 'mouse');
  }
}

/**
 * The inline blame, for every view: `enabled()` (the setting), `onEvent(view, { kind: 'enter' |
 * 'leave' | 'click', line, rect, from: 'inline', touch })`.
 */
export function inlineBlame({ enabled = () => true, onEvent = null } = {}) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.decorations = Decoration.none;
        this.shown = null;
        this.timer = null;
        this.quietSince = 0;
        this.noteSince = 0;
        this.onResize = () => {
          this.hideNow();
          this.wait();
        };
        window.addEventListener('resize', this.onResize);
        this.wait();
      }
      update(u) {
        for (const tr of u.transactions) {
          for (const e of tr.effects) {
            if (!e.is(showInline)) continue;
            if (e.value?.note && !this.shown?.note) this.noteSince = Date.now();
            this.shown = e.value;
            this.decorations = e.value ? Decoration.set([Decoration.widget({ widget: new InlineBlame(e.value, onEvent), side: 1 }).range(e.value.pos)]) : Decoration.none;
          }
        }
        const lineOf = (s) => s.doc.lineAt(s.selection.main.head).number;
        const moved = u.selectionSet && (u.docChanged || lineOf(u.startState) !== lineOf(u.state));
        const refreshed = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshBlame)));
        const data = blameOf(u.state);
        const dataChanged = data !== blameOf(u.startState);
        // Typing, moving to another line, the focus going: away at once.
        if (u.docChanged || moved || refreshed || (u.focusChanged && !u.view.hasFocus)) this.hide();
        if (u.docChanged || u.selectionSet) this.quietSince = Date.now();
        // The editor's size changed (a pane beside it, the file list): measured again, so it still fits.
        if (u.docChanged || moved || refreshed || u.focusChanged || dataChanged || (u.geometryChanged && this.shown)) this.wait();
      }
      // Within an update: the decoration goes with it.
      hide() {
        if (this.shown?.note && Date.now() - this.noteSince >= TOLD_MS) {
          const data = blameOf(this.view.state);
          if (data?.status === 'big') data.told = true;
        }
        this.shown = null;
        this.decorations = Decoration.none;
      }
      // Outside an update (a timer, a resize).
      hideNow() {
        if (this.shown) this.view.dispatch({ effects: showInline.of(null) });
      }
      wait() {
        clearTimeout(this.timer);
        const rest = REST_MS - (Date.now() - this.quietSince);
        this.timer = setTimeout(() => this.show(), Math.max(30, rest));
      }
      target() {
        const v = this.view;
        if (!enabled() || !v.hasFocus) return null;
        const data = blameOf(v.state);
        const { selection, doc } = v.state;
        if (!data || selection.ranges.length > 1) return null;
        const line = doc.lineAt(selection.main.head);
        if (data.status === 'big') {
          if (data.told) return null;
          const mb = (n) => (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1).replace(/\.0$/, '');
          return { pos: line.to, line: line.number, hash: '', text: `No blame: the file is over ${mb(data.max)} MB`, note: 'big' };
        }
        const hash = data.lines[line.number - 1];
        const commit = hash && data.commits.get(hash);
        if (!commit) return null;
        return { pos: line.to, line: line.number, hash, text: blameLineText(commit, data.me, Date.now()), uncommitted: commit.uncommitted, note: '' };
      }
      // Room from the line's end to the visible edge of the text (the minimap's and the padding's
      // left out): the inline blame never covers code, nor makes the line wrap or scroll.
      room(pos) {
        const v = this.view;
        const end = v.coordsAtPos(pos, -1) ?? v.coordsAtPos(pos, 1);
        if (!end) return 0;
        const scroller = v.scrollDOM.getBoundingClientRect();
        let right = scroller.left + v.scrollDOM.clientWidth;
        // The minimap where it shows (it is there but hidden in narrow windows and on phones).
        const mini = v.dom.querySelector('.cm-minimap')?.getBoundingClientRect();
        if (mini && mini.width > 0) right = Math.min(right, mini.left);
        const content = v.contentDOM.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(v.contentDOM).paddingRight) || 0;
        right = Math.min(right, content.right - pad);
        return Math.floor(right - end.right - v.defaultCharacterWidth * 3 - 6);
      }
      show() {
        this.timer = null;
        const v = this.view;
        if (!v.dom.isConnected) return;
        const target = this.target();
        if (!target) return this.hideNow();
        const max = this.room(target.pos);
        if (max < v.defaultCharacterWidth * 10) return this.hideNow();
        // Showing it changes no room beside the code, so the same answer twice stops here.
        const s = this.shown;
        if (s && s.line === target.line && s.text === target.text && s.hash === target.hash && Math.abs(s.max - max) <= 2) return;
        v.dispatch({ effects: showInline.of({ ...target, max }) });
      }
      destroy() {
        clearTimeout(this.timer);
        window.removeEventListener('resize', this.onResize);
      }
    },
    { decorations: (p) => p.decorations },
  );
}

// ---- The column: every line's commit, before the line numbers ----

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' });

class BlameCell extends GutterMarker {
  constructor(label, age, first, uncommitted, spacer = false) {
    super();
    this.label = label;
    this.age = age;
    this.first = first;
    this.uncommitted = uncommitted;
    this.spacer = spacer;
  }
  eq(other) {
    return other.label === this.label && other.age === this.age && other.first === this.first && other.uncommitted === this.uncommitted && other.spacer === this.spacer;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = `cm-blame-cell${this.spacer ? ' spacer' : this.first ? ' first' : ''}${this.uncommitted ? ' uncommitted' : ''}`;
    el.style.setProperty('--age', this.age.toFixed(3));
    // A block's first line says whose it is; the gutter's (hidden) spacer gives it its width.
    if (this.first || this.spacer) el.textContent = this.label;
    return el;
  }
}

const labelOf = (commit, me) => (commit.uncommitted ? 'Not committed yet' : `${commit.time ? dateFormat.format(new Date(commit.time * 1000)) : ''} ${blameWho(commit, me)}`);

// The cells of a blame, made as lines show and kept with it.
const cells = new WeakMap();
function cellFor(data, hash, first) {
  let made = cells.get(data.source);
  if (!made) cells.set(data.source, (made = new Map()));
  const key = `${hash}:${first ? 1 : 0}`;
  if (!made.has(key)) {
    const commit = data.commits.get(hash);
    made.set(key, new BlameCell(labelOf(commit, data.me), commit.uncommitted ? 0 : (data.ages.get(hash) ?? 1), first, commit.uncommitted));
  }
  return made.get(key);
}

// The column is as wide as its longest label (the stylesheet caps it).
const spacers = new WeakMap();
function spacerFor(data) {
  if (data?.status !== 'ready') return new BlameCell('00/00/0000 Somebody', 0, false, false, true);
  if (!spacers.has(data.source)) {
    const used = new Set(data.lines);
    let longest = 'Not committed yet';
    for (const hash of used) {
      const commit = hash && data.commits.get(hash);
      const label = commit ? labelOf(commit, data.me) : '';
      if (label.length > longest.length) longest = label;
    }
    spacers.set(data.source, new BlameCell(longest, 0, false, false, true));
  }
  return spacers.get(data.source);
}

/** The blame column, `onEvent` as for the inline blame (from: 'column'). */
export function blameColumn({ onEvent = null } = {}) {
  let hovered = 0; // the line hovered last, so moving within it says nothing
  const lineOf = (view, block) => view.state.doc.lineAt(block.from).number;
  const rectOf = (event) => (event.target.closest?.('.cm-gutterElement') ?? event.target).getBoundingClientRect();
  return gutter({
    class: 'cm-blame-gutter',
    lineMarker(view, block) {
      const data = blameOf(view.state);
      if (data?.status !== 'ready') return null;
      const n = lineOf(view, block);
      const hash = data.lines[n - 1];
      if (!hash || !data.commits.has(hash)) return null;
      return cellFor(data, hash, n === 1 || data.lines[n - 2] !== hash);
    },
    lineMarkerChange: (update) => blameOf(update.startState) !== blameOf(update.state),
    initialSpacer: (view) => spacerFor(blameOf(view.state)),
    updateSpacer: (spacer, update) => (blameOf(update.startState)?.source === blameOf(update.state)?.source ? spacer : spacerFor(blameOf(update.state))),
    domEventHandlers: {
      mousemove(view, block, event) {
        const n = lineOf(view, block);
        if (n === hovered || !event.target.closest?.('.cm-blame-cell')) return false;
        hovered = n;
        onEvent?.(view, { kind: 'enter', line: n, from: 'column', rect: rectOf(event) });
        return false;
      },
      mouseleave(view, block) {
        hovered = 0;
        onEvent?.(view, { kind: 'leave', line: lineOf(view, block), from: 'column' });
        return false;
      },
      mousedown(view, block, event) {
        if (event.button !== 0 || !event.target.closest?.('.cm-blame-cell')) return false;
        onEvent?.(view, { kind: 'click', line: lineOf(view, block), from: 'column', rect: rectOf(event), touch: event.pointerType === 'touch' });
        return true;
      },
    },
  });
}
