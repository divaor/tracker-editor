// Two texts side by side, shown as JetBrains' diff viewer shows them. Each side scrolls on its
// own and the other follows (the lines that match stay level), changed lines are tinted by kind
// (changed blue, added green, removed grey; where a side has none of a block's lines, a thin
// line marks the place), the words that changed inside a changed block are marked stronger,
// and in the strip between the sides a ribbon joins each block's lines on the left to its
// lines on the right, with » and « on its ends to copy the block across. Unchanged stretches
// fold away. The comparison is lineDiff.js's; an edit on either side compares again around it.

import { Decoration, EditorState, EditorView, GutterMarker, StateEffect, StateField, ViewPlugin, WidgetType, getChunks, gutter, unifiedMergeView } from '../vendor/cm/codemirror.js';
import { diffTexts, foldRuns, mapFolds, replaceLinesChange, updateChunks } from './lineDiff.js';
import { chunkAtLine, mapThrough, ribbonPath, scrollPoints, stepChunk } from './diffLayout.js';

const setDiff = StateEffect.define();
const setFolds = StateEffect.define();

/** What a side knows of the comparison: { side: 'a' | 'b', chunks, highlight }. */
const diffField = StateField.define({
  create: () => ({ side: 'a', chunks: [], highlight: 'words' }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDiff)) return e.value;
    return value;
  },
});

const lineDecos = new Map();
const lineDeco = (cls) => {
  let deco = lineDecos.get(cls);
  if (!deco) lineDecos.set(cls, (deco = Decoration.line({ class: cls })));
  return deco;
};
const WORD = Decoration.mark({ class: 'cm-diff-word' });

class KindMarker extends GutterMarker {
  constructor(kind) {
    super();
    this.elementClass = `cm-diff-bar cm-diff-${kind}`;
  }
  eq(other) {
    return other.elementClass === this.elementClass;
  }
}
const BARS = { insert: new KindMarker('insert'), delete: new KindMarker('delete'), modify: new KindMarker('modify') };

const sideKeys = (side) => (side === 'a' ? ['a0', 'a1', 'fromA', 'toA'] : ['b0', 'b1', 'fromB', 'toB']);

/** The tints, word marks and gutter bars of the chunks in view on one side. */
function sideDecorations(view) {
  const { side, chunks, highlight } = view.state.field(diffField);
  const [x0, x1, from, to] = sideKeys(side);
  const doc = view.state.doc;
  const paint = highlight !== 'none';
  const words = highlight === 'words' || highlight === 'chars';
  const first = doc.lineAt(view.viewport.from).number - 1;
  const last = doc.lineAt(view.viewport.to).number - 1;
  const deco = [];
  const bars = [];
  let i = 0;
  let hi = chunks.length;
  while (i < hi) {
    const mid = (i + hi) >> 1;
    if (chunks[mid][x1] < first) i = mid + 1;
    else hi = mid;
  }
  for (; i < chunks.length; i++) {
    const c = chunks[i];
    const s = c[x0];
    const e = c[x1];
    if (s > last + 1) break;
    if (s === e) {
      // None of the block's lines here: a thin line where they would be.
      if (!paint) continue;
      if (s < doc.lines) {
        if (s >= first) deco.push(lineDeco(`cm-diff-gap cm-diff-${c.kind}`).range(doc.line(s + 1).from));
      } else deco.push(lineDeco(`cm-diff-gap-end cm-diff-${c.kind}`).range(doc.line(doc.lines).from));
      continue;
    }
    const base = doc.line(s + 1).from;
    const marks = words ? c.inner.filter((m) => m[to] > m[from]).map((m) => [base + m[from], base + m[to]]) : [];
    let k = 0;
    for (let l = Math.max(s, first); l < Math.min(e, last + 1); l++) {
      const line = doc.line(l + 1);
      bars.push(BARS[c.kind].range(line.from));
      if (!paint) continue;
      deco.push(lineDeco(`cm-diff-line cm-diff-${c.kind}${l === s ? ' cm-diff-first' : ''}${l === e - 1 ? ' cm-diff-last' : ''}`).range(line.from));
      while (k < marks.length && marks[k][1] <= line.from) k++;
      for (let j = k; j < marks.length && marks[j][0] <= line.to; j++) {
        const mf = Math.max(marks[j][0], line.from);
        const mt = Math.min(marks[j][1], line.to);
        if (mt > mf) deco.push(WORD.range(mf, mt));
      }
    }
  }
  return { deco: Decoration.set(deco, true), bars: Decoration.set(bars, true) };
}

const decorations = ViewPlugin.fromClass(
  class {
    constructor(view) {
      ({ deco: this.deco, bars: this.bars } = sideDecorations(view));
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.startState.field(diffField) !== u.state.field(diffField)) ({ deco: this.deco, bars: this.bars } = sideDecorations(u.view));
    }
  },
  { decorations: (p) => p.deco },
);

const barGutter = gutter({ class: 'cm-diffGutter', markers: (view) => view.plugin(decorations)?.bars ?? Decoration.none });

/** "N unchanged lines": a click shows them (on both sides). */
class FoldWidget extends WidgetType {
  constructor(lines, id, open) {
    super();
    this.lines = lines;
    this.id = id;
    this.open = open;
  }
  eq(other) {
    return other.lines === this.lines && other.id === this.id;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-diffFold';
    el.title = 'Show these lines';
    el.textContent = `${this.lines.toLocaleString()} unchanged line${this.lines === 1 ? '' : 's'}`;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.open(this.id);
    });
    return el;
  }
  ignoreEvent(e) {
    return e instanceof MouseEvent;
  }
  get estimatedHeight() {
    return 24;
  }
}

const foldField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setFolds)) return e.value;
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const foldDecorations = (doc, folds, side, open) => {
  const [x0, x1] = sideKeys(side);
  return Decoration.set(
    folds.filter((f) => f[x1] <= doc.lines && f[x1] > f[x0]).map((f) => Decoration.replace({ widget: new FoldWidget(f[x1] - f[x0], f.id, open), block: true }).range(doc.line(f[x0] + 1).from, doc.line(f[x1]).to)),
    true,
  );
};

const linesOf = (doc) => ({ lines: doc.lines, line: (i) => doc.line(i + 1).text });
const shapeOf = (doc) => ({ lines: doc.lines, length: doc.length, lineFrom: (i) => doc.line(i + 1).from });
const posOfLine = (doc, line) => (line < doc.lines ? doc.line(line + 1).from : doc.length);
const SVG = 'http://www.w3.org/2000/svg';

/**
 * A comparison side by side in `parent`. `extensions(side)` gives each side's editor its own
 * extensions ('a' the left, 'b' the right); `options` { whitespace, highlight, collapse }
 * (lineDiff.js); `readOnly` { a, b } hides the copy buttons that would change that side;
 * `onUpdate()` after the chunks change. Returns { a, b, dom, chunks(), current(side), go(step,
 * side), copy(index, toRight), copyAll(toRight), destroy() }.
 */
export function createDiffView(parent, { left, right, extensions = () => [], options = {}, readOnly = {}, onUpdate = () => {} }) {
  const opts = { whitespace: options.whitespace ?? 'exact', highlight: options.highlight ?? 'words' };
  let chunks = diffTexts(left, right, opts);
  let foldId = 0;
  let folds = options.collapse === false ? [] : foldRuns(chunks, left.split('\n').length, right.split('\n').length).map((f) => ({ ...f, id: ++foldId }));
  let a = null;
  let b = null;
  const viewOf = (side) => (side === 'a' ? a : b);
  const otherOf = (side) => (side === 'a' ? 'b' : 'a');
  const stateOf = (side) => ({ side, chunks, highlight: opts.highlight });

  const dom = document.createElement('div');
  dom.className = 'cm-diffView';
  const wrapA = dom.appendChild(document.createElement('div'));
  wrapA.className = 'cm-diffSide cm-diffSide-a';
  const strip = dom.appendChild(document.createElement('div'));
  strip.className = 'cm-diffStrip';
  const svg = strip.appendChild(document.createElementNS(SVG, 'svg'));
  svg.setAttribute('class', 'cm-diffRibbons');
  svg.setAttribute('aria-hidden', 'true');
  const buttons = strip.appendChild(document.createElement('div'));
  buttons.className = 'cm-diffButtons';
  const wrapB = dom.appendChild(document.createElement('div'));
  wrapB.className = 'cm-diffSide cm-diffSide-b';

  // ---- Geometry: each chunk's top and bottom on both sides, and the scroll map from them ----
  let geo = null;
  const lineTop = (view, line) => {
    const doc = view.state.doc;
    return line < doc.lines ? view.lineBlockAt(doc.line(line + 1).from).top : view.lineBlockAt(doc.length).bottom;
  };
  const geometry = () => {
    if (geo) return geo;
    const bounds = chunks.map((c) => [lineTop(a, c.a0), lineTop(a, c.a1), lineTop(b, c.b0), lineTop(b, c.b1)]);
    const points = scrollPoints(bounds, lineTop(a, a.state.doc.lines), lineTop(b, b.state.doc.lines), a.defaultLineHeight / 2);
    return (geo = { bounds, points });
  };

  // ---- Scrolling in step: the side scrolled last leads, the other follows ----
  let leader = 'b';
  const expected = { a: null, b: null };
  // Where the document starts inside a side's scroller (its padding, anything above the text).
  const docStart = (view) => view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
  const follow = (from) => {
    const lead = viewOf(from);
    const to = otherOf(from);
    const other = viewOf(to);
    const ls = lead.scrollDOM;
    const os = other.scrollDOM;
    // The height followed: the top of the screen until it is scrolled half a screen (both sides
    // start at their first lines), then its middle, where the lines that match sit level.
    const frac = Math.min(0.5, Math.max(0, ls.scrollTop / Math.max(1, ls.clientHeight)));
    const y = ls.scrollTop + ls.clientHeight * frac - docStart(lead);
    const { points } = geometry();
    const yOther = from === 'a' ? mapThrough(points.a, points.b, y) : mapThrough(points.b, points.a, y);
    // At the same height on the screen: the leader's (a horizontal scrollbar makes the other
    // side's screen shorter).
    const top = Math.max(0, yOther + docStart(other) - ls.clientHeight * frac);
    if (Math.abs(os.scrollTop - top) >= 1) {
      os.scrollTop = top;
      expected[to] = os.scrollTop;
    }
    if (os.scrollLeft !== ls.scrollLeft) os.scrollLeft = ls.scrollLeft;
  };
  let raf = 0;
  let resync = false;
  const frame = (again = false) => {
    resync = resync || again;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!a || !b) return;
      if (resync) follow(leader);
      resync = false;
      draw();
    });
  };
  const onScroll = (side) => () => {
    const s = viewOf(side).scrollDOM;
    if (expected[side] !== null && Math.abs(s.scrollTop - expected[side]) < 2) {
      expected[side] = null;
      return frame();
    }
    // Scrolled by the person (or by the editor, to show its cursor): this side leads.
    expected[side] = null;
    leader = side;
    follow(side);
    frame();
  };
  const lead = (side) => () => {
    leader = side;
  };

  // ---- The ribbons and the copy buttons in the strip ----
  const shownButtons = new Map();
  const titles = (c, toRight) => {
    const none = toRight ? c.a0 === c.a1 : c.b0 === c.b1;
    return none ? `Remove these lines on the ${toRight ? 'right' : 'left'} (the ${toRight ? 'left' : 'right'} has none)` : `Copy this change to the ${toRight ? 'right' : 'left'}`;
  };
  const button = (key, i, toRight, top) => {
    let el = shownButtons.get(key);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = `cm-diffCopy ${toRight ? 'to-right' : 'to-left'}`;
      el.textContent = toRight ? '»' : '«';
      el.tabIndex = -1;
      buttons.append(el);
      shownButtons.set(key, el);
    }
    const c = chunks[i];
    el.dataset.chunk = String(i);
    el.dataset.kind = c.kind;
    const title = titles(c, toRight);
    if (el.title !== title) {
      el.title = title;
      el.setAttribute('aria-label', title);
    }
    el.style.top = `${Math.round(top)}px`;
    return key;
  };
  let size = 0; // the buttons' size (CSS --diff-copy-size: larger on touch screens)
  function draw() {
    const w = strip.clientWidth;
    const h = strip.clientHeight;
    if (!w || !h) return;
    size ||= parseFloat(getComputedStyle(strip).getPropertyValue('--diff-copy-size')) || 16;
    const top = strip.getBoundingClientRect().top;
    const offA = a.documentTop - top;
    const offB = b.documentTop - top;
    const { bounds } = geometry();
    let lo = 0;
    let hi = bounds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (Math.max(bounds[mid][1] + offA, bounds[mid][3] + offB) < -1) lo = mid + 1;
      else hi = mid;
    }
    let paths = '';
    const kept = new Set();
    for (let i = lo; i < bounds.length; i++) {
      const [a0, a1, b0, b1] = bounds[i];
      const ya0 = a0 + offA;
      const ya1 = a1 + offA;
      const yb0 = b0 + offB;
      const yb1 = b1 + offB;
      if (Math.min(ya0, yb0) > h + 1) break;
      const { kind } = chunks[i];
      const { fill, edges } = ribbonPath(w, ya0, ya1, yb0, yb1);
      if (opts.highlight !== 'none') paths += `<path class="cm-diff-ribbon cm-diff-${kind}" d="${fill}"/>`;
      paths += `<path class="cm-diff-edge cm-diff-${kind}" d="${edges}"/>`;
      const at = (y0, y1) => (y1 - y0 >= size + 2 ? y0 + 1 : (y0 + y1 - size) / 2);
      if (!readOnly.b) kept.add(button(`r${i}`, i, true, at(ya0, ya1)));
      if (!readOnly.a) kept.add(button(`l${i}`, i, false, at(yb0, yb1)));
    }
    svg.innerHTML = paths;
    for (const [key, el] of shownButtons)
      if (!kept.has(key)) {
        el.remove();
        shownButtons.delete(key);
      }
  }
  buttons.addEventListener('mousedown', (e) => {
    const el = e.target.closest('.cm-diffCopy');
    if (!el) return;
    e.preventDefault();
    copy(Number(el.dataset.chunk), el.classList.contains('to-right'));
  });

  // ---- Edits: the comparison again around them, the folds they touched gone ----
  const open = (id) => {
    folds = folds.filter((f) => f.id !== id);
    for (const side of ['a', 'b']) {
      const view = viewOf(side);
      view.dispatch({ effects: setFolds.of(foldDecorations(view.state.doc, folds, side, open)) });
    }
  };
  const dispatchFor = (side) => (trs, view) => {
    if (!trs.some((tr) => tr.docChanged)) return view.update(trs);
    const before = trs[0].startState.doc;
    const last = trs[trs.length - 1];
    const after = last.newDoc;
    let changes = trs[0].changes;
    for (let i = 1; i < trs.length; i++) changes = changes.compose(trs[i].changes);
    let from = Infinity;
    let to = -1;
    changes.iterChangedRanges((fromA, toA) => {
      from = Math.min(from, fromA);
      to = Math.max(to, toA);
    });
    const edit = { side, from: before.lineAt(from).number - 1, to: before.lineAt(to).number, delta: after.lines - before.lines };
    const docA = side === 'a' ? after : a.state.doc;
    const docB = side === 'b' ? after : b.state.doc;
    const res = updateChunks(chunks, edit, linesOf(docA), linesOf(docB), opts);
    chunks = res.chunks;
    folds = mapFolds(folds, res.region);
    geo = null;
    view.update([...trs, last.state.update({ effects: [setDiff.of(stateOf(side)), setFolds.of(foldDecorations(after, folds, side, open))] })]);
    const other = viewOf(otherOf(side));
    other.update([other.state.update({ effects: [setDiff.of(stateOf(otherOf(side))), setFolds.of(foldDecorations(other.state.doc, folds, otherOf(side), open))] })]);
    onUpdate();
  };
  const watch = EditorView.updateListener.of((u) => {
    if (u.docChanged || u.heightChanged || u.geometryChanged || u.viewportChanged || u.startState.field(diffField) !== u.state.field(diffField)) {
      geo = null;
      frame(true);
    }
  });
  const make = (side, doc, wrap) =>
    new EditorView({
      parent: wrap,
      dispatchTransactions: dispatchFor(side),
      state: EditorState.create({
        doc,
        extensions: [
          extensions(side),
          diffField.init(() => stateOf(side)),
          foldField.init((state) => foldDecorations(state.doc, folds, side, open)),
          decorations,
          barGutter,
          watch,
          EditorView.editorAttributes.of({ class: `cm-diff-${side === 'a' ? 'left' : 'right'}` }),
        ],
      }),
    });
  a = make('a', left, wrapA);
  b = make('b', right, wrapB);
  for (const side of ['a', 'b']) {
    const view = viewOf(side);
    view.scrollDOM.addEventListener('scroll', onScroll(side), { passive: true });
    for (const type of ['wheel', 'pointerdown', 'touchstart', 'keydown', 'focusin']) view.dom.addEventListener(type, lead(side), { passive: true, capture: true });
  }
  parent.append(dom);
  // Each side scrolls past its end by a screen less a line (as JetBrains' editors do), so the
  // last lines of the shorter side can still sit level with the other side's.
  const pastEnd = new ResizeObserver(() => {
    for (const [wrap, view] of [[wrapA, a], [wrapB, b]]) {
      wrap.style.setProperty('--diff-past-end', `${Math.max(6, Math.round(wrap.clientHeight - view.defaultLineHeight - 6))}px`);
      view.requestMeasure();
    }
    frame(true);
  });
  pastEnd.observe(dom);
  frame();

  /** Puts chunk `i` in view: the cursor at its start on both sides, `side` scrolled to it. */
  const reveal = (i, side) => {
    const c = chunks[i];
    if (!c) return;
    leader = side;
    for (const s of ['a', 'b']) {
      const view = viewOf(s);
      const pos = posOfLine(view.state.doc, s === 'a' ? c.a0 : c.b0);
      view.dispatch({ selection: { anchor: pos }, userEvent: 'select.byChunk', effects: s === side ? EditorView.scrollIntoView(pos, { y: 'center' }) : [] });
    }
  };
  /** Copies chunk `i` across: `toRight` makes the right side's lines the left's, else the other way. */
  function copy(i, toRight) {
    const c = chunks[i];
    if (!c || readOnly[toRight ? 'b' : 'a']) return false;
    const [src, dst, s0, s1, d0, d1] = toRight ? [a, b, c.a0, c.a1, c.b0, c.b1] : [b, a, c.b0, c.b1, c.a0, c.a1];
    const lines = [];
    for (let l = s0; l < s1; l++) lines.push(src.state.doc.line(l + 1).text);
    dst.dispatch({ changes: replaceLinesChange(shapeOf(dst.state.doc), d0, d1, lines), userEvent: 'input.copy' });
    return true;
  }
  const lineAt = (side) => {
    const view = viewOf(side);
    return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
  };
  return {
    a,
    b,
    dom,
    chunks: () => chunks,
    current: (side) => chunkAtLine(chunks, side, lineAt(side)),
    go: (step, side) => {
      const i = stepChunk(chunks, side, lineAt(side), step);
      if (i >= 0) reveal(i, side);
      return i;
    },
    copy,
    copyAll: (toRight) => {
      const [src, dst] = toRight ? [a, b] : [b, a];
      if (readOnly[toRight ? 'b' : 'a']) return;
      dst.dispatch({ changes: { from: 0, to: dst.state.doc.length, insert: src.state.doc.toString() }, userEvent: 'input.copy' });
    },
    destroy: () => {
      if (raf) cancelAnimationFrame(raf);
      pastEnd.disconnect();
      a.destroy();
      b.destroy();
      dom.remove();
    },
  };
}

// ---- The unified view (phones): @codemirror/merge's, with this comparison's chunks ----

// @codemirror/merge makes its chunks with Chunk.build / updateA / updateB from its own diff of
// characters. A unified view whose diffConfig carries LINE_DIFF gets lineDiff.js's instead: the
// same lines and words as side by side. (Our bundle does not export Chunk: it is taken from a
// chunk the package made.)
const LINE_DIFF = Symbol('lineDiff');
const madeFor = new WeakMap(); // a list of chunks → { a, b, ours }: the texts and the line chunks it came from
let ChunkClass = null;

const lineEnd = (doc, line) => (line < doc.lines ? doc.line(line + 1).from : doc.length + 1);

/**
 * The package's chunks from line chunks. A block added or removed after a last line that has
 * no line break cannot sit after it in the package's terms: it takes that line in (as the
 * package's own diff would).
 */
function made(ours, a, b) {
  const out = [];
  const list = [];
  for (let c of ours) {
    if ((c.a0 === c.a1 && c.a0 >= a.lines) || (c.b0 === c.b1 && c.b0 >= b.lines)) {
      const la = a.line(c.a0).text;
      const textA = [la, ...Array.from({ length: c.a1 - c.a0 }, (_, i) => a.line(c.a0 + i + 1).text)].join('\n');
      const textB = [la, ...Array.from({ length: c.b1 - c.b0 }, (_, i) => b.line(c.b0 + i + 1).text)].join('\n');
      c = { ...c, a0: c.a0 - 1, b0: c.b0 - 1, kind: 'modify', inner: [{ fromA: la.length, toA: textA.length, fromB: la.length, toB: textB.length }] };
      const prev = list[list.length - 1];
      if (prev && (prev.a1 > c.a0 || prev.b1 > c.b0)) {
        list.pop();
        out.pop();
        c = { ...c, a0: prev.a0, b0: prev.b0, inner: [] };
      }
    }
    const fromA = posOfLine(a, c.a0);
    const fromB = posOfLine(b, c.b0);
    list.push(c);
    out.push(new ChunkClass(c.inner, fromA, c.a1 > c.a0 ? lineEnd(a, c.a1) : fromA, fromB, c.b1 > c.b0 ? lineEnd(b, c.b1) : fromB, c.precise !== false));
  }
  madeFor.set(out, { a, b, ours: list });
  return out;
}

function updated(chunks, a, b, changes, side, opts) {
  const known = madeFor.get(chunks);
  if (!known) return made(diffTexts(a.toString(), b.toString(), opts), a, b);
  const before = side === 'a' ? known.a : known.b;
  const after = side === 'a' ? a : b;
  let from = Infinity;
  let to = -1;
  changes.iterChangedRanges((fromA, toA) => {
    from = Math.min(from, fromA);
    to = Math.max(to, toA);
  });
  if (to < 0) return made(known.ours, a, b);
  const edit = { side, from: before.lineAt(from).number - 1, to: before.lineAt(to).number, delta: after.lines - before.lines };
  return made(updateChunks(known.ours, edit, linesOf(a), linesOf(b), opts).chunks, a, b);
}

function patchChunks() {
  if (ChunkClass !== null) return Boolean(ChunkClass);
  const probe = EditorState.create({ doc: 'b', extensions: unifiedMergeView({ original: 'a' }) });
  const Chunk = getChunks(probe)?.chunks[0]?.constructor;
  ChunkClass = typeof Chunk?.build === 'function' && typeof Chunk.updateA === 'function' ? Chunk : false;
  if (!ChunkClass) return false;
  const { build, updateA, updateB } = Chunk;
  Chunk.build = function (a, b, conf) {
    return conf?.[LINE_DIFF] ? made(diffTexts(a.toString(), b.toString(), conf[LINE_DIFF]), a, b) : build.call(this, a, b, conf);
  };
  Chunk.updateA = function (chunks, a, b, changes, conf) {
    return conf?.[LINE_DIFF] ? updated(chunks, a, b, changes, 'a', conf[LINE_DIFF]) : updateA.call(this, chunks, a, b, changes, conf);
  };
  Chunk.updateB = function (chunks, a, b, changes, conf) {
    return conf?.[LINE_DIFF] ? updated(chunks, a, b, changes, 'b', conf[LINE_DIFF]) : updateB.call(this, chunks, a, b, changes, conf);
  };
  return true;
}

/**
 * The unified view (one text, the other side's lines shown removed in place): @codemirror/merge's
 * unifiedMergeView with `config`, comparing by lineDiff.js with `options` ({ whitespace,
 * highlight, collapse }).
 */
export function unifiedDiff(config, options = {}) {
  const opts = { whitespace: options.whitespace ?? 'exact', highlight: options.highlight ?? 'words' };
  const ours = patchChunks();
  return [
    unifiedMergeView({
      ...config,
      highlightChanges: opts.highlight === 'words' || opts.highlight === 'chars',
      diffConfig: ours ? { [LINE_DIFF]: opts } : { scanLimit: 500 },
      collapseUnchanged: options.collapse === false ? undefined : config.collapseUnchanged,
    }),
    EditorView.editorAttributes.of({ class: `cm-diffUnified cm-diff-hl-${opts.highlight}` }),
  ];
}
