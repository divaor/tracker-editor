// The minimap: the file at a glance along the right of an editor view (a canvas beside the
// scrollbar), the part on screen as a box. A click there brings that part to the middle,
// dragging the box scrolls, the wheel scrolls the editor. Colors come from the syntax tree
// where it is parsed (each node type's highlighting tags), else muted. Ticks on its right edge
// mark the whole file's problems, Git's changes and, while the find bar is open, the matches.
// Not drawn in views narrower than MINIMAP.minView (phones, narrow panes). minimapLayout.js has
// the arithmetic (pure, tested).
import { EditorView, ViewPlugin, forEachDiagnostic, getSearchQuery, syntaxTree, tags } from '../vendor/cm/codemirror.js';
import { gitInfo } from './gitGutter.js';
import { MINIMAP, dragScroll, lineAtY, lineRuns, markTicks, minimapLayout, onBox } from './minimapLayout.js';

const PALETTES = {
  light: {
    text: 'rgba(45,43,38,.42)',
    comment: 'rgba(153,68,0,.55)',
    string: 'rgba(170,17,17,.62)',
    keyword: 'rgba(119,0,136,.68)',
    number: 'rgba(17,102,68,.7)',
    type: 'rgba(0,128,85,.7)',
    tag: 'rgba(17,119,0,.7)',
    def: 'rgba(0,0,220,.6)',
    box: 'rgba(25,23,18,.075)',
    boxActive: 'rgba(25,23,18,.13)',
    boxLine: 'rgba(25,23,18,.16)',
  },
  dark: {
    text: 'rgba(171,178,191,.42)',
    comment: 'rgba(125,135,153,.6)',
    string: 'rgba(152,195,121,.72)',
    keyword: 'rgba(198,120,221,.78)',
    number: 'rgba(209,154,102,.78)',
    type: 'rgba(229,192,123,.78)',
    tag: 'rgba(224,108,117,.78)',
    def: 'rgba(97,175,239,.78)',
    box: 'rgba(255,255,255,.065)',
    boxActive: 'rgba(255,255,255,.12)',
    boxLine: 'rgba(255,255,255,.15)',
  },
};
// The marks' colors (the Git bar's and the problems' own).
const MARK_COLORS = { error: '#d14343', warning: '#c98a14', info: '#2f6fd6', added: '#2e9e5b', modified: '#2f6fd6', deleted: '#d14343', match: '#c79a1e' };
const MAX_MARKS = 4000;

// A node type's highlighting rule (what syntaxHighlighting reads), found among its props: a
// rule has `tags` and a numeric `mode`. Its tags give the minimap's color, or none.
const kinds = new WeakMap();
const DEFS = [tags.definition(tags.variableName), tags.definition(tags.propertyName), tags.function(tags.definition(tags.variableName))];
function kindOfType(type) {
  if (kinds.has(type)) return kinds.get(type);
  let kind = null;
  for (const value of Object.values(type.props ?? {})) {
    if (!value || !Array.isArray(value.tags) || typeof value.mode !== 'number') continue;
    for (const t of value.tags) {
      const set = t.set ?? [t];
      kind =
        set.includes(tags.comment) ? 'comment'
        : set.includes(tags.string) || set.includes(tags.regexp) ? 'string'
        : set.includes(tags.keyword) || set.includes(tags.heading) ? 'keyword'
        : set.includes(tags.number) || set.includes(tags.bool) || set.includes(tags.null) || set.includes(tags.atom) ? 'number'
        : set.includes(tags.typeName) || set.includes(tags.className) || set.includes(tags.namespace) ? 'type'
        : set.includes(tags.tagName) ? 'tag'
        : DEFS.some((d) => set.includes(d)) ? 'def'
        : null;
      if (kind) break;
    }
    break;
  }
  kinds.set(type, kind);
  return kind;
}

/** The syntax's colored spans over [from, to): [{ from, to, kind }], outer before inner (document order). */
function spansFor(state, from, to) {
  const out = [];
  const tree = syntaxTree(state);
  if (!tree || !tree.length) return out;
  tree.iterate({
    from,
    to,
    enter(node) {
      const kind = kindOfType(node.type);
      if (kind) out.push({ from: node.from, to: node.to, kind });
    },
  });
  return out;
}

/** The whole file's marks: problems, Git's changed lines, and the find bar's matches while it is open. */
function marksOf(view) {
  const { state } = view;
  const { doc } = state;
  const marks = [];
  forEachDiagnostic(state, (d, from) => {
    if (marks.length < MAX_MARKS) marks.push({ line: doc.lineAt(Math.min(from, doc.length)).number, kind: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info' });
  });
  for (const c of gitInfo(state)?.changes ?? []) {
    if (c.kind === 'deleted') marks.push({ line: Math.max(1, c.at), kind: 'deleted' });
    else {
      // A long block: enough lines to draw it, not each one.
      const step = Math.max(1, Math.ceil((c.to - c.from + 1) / 400));
      for (let n = c.from; n <= c.to; n += step) marks.push({ line: n, kind: c.kind });
      marks.push({ line: c.to, kind: c.kind });
    }
  }
  if (view.dom.querySelector('.find-bar')) {
    const query = getSearchQuery(state);
    if (query.valid && query.search) {
      const cursor = query.getCursor(state);
      for (let i = 0, r = cursor.next(); !r.done && i < 2000; i++, r = cursor.next()) marks.push({ line: doc.lineAt(r.value.from).number, kind: 'match' });
    }
  }
  return marks;
}

const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches;

/** The minimap for a view, in light or dark colors. */
export function minimap({ dark = false } = {}) {
  const palette = dark ? PALETTES.dark : PALETTES.light;
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.dom = document.createElement('div');
        this.dom.className = 'cm-minimap';
        this.dom.setAttribute('aria-hidden', 'true');
        this.canvas = document.createElement('canvas');
        this.dom.appendChild(this.canvas);
        view.dom.appendChild(this.dom);
        this.shown = false;
        this.layout = null;
        this.marks = null; // the whole file's, read again after edits and effects
        this.timer = null;
        this.drag = null;
        this.onScroll = () => this.schedule();
        view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
        this.canvas.addEventListener('pointerdown', (e) => this.press(e));
        this.canvas.addEventListener('pointermove', (e) => this.move(e));
        this.canvas.addEventListener('pointerup', (e) => this.release(e));
        this.canvas.addEventListener('pointercancel', (e) => this.release(e));
        this.canvas.addEventListener('lostpointercapture', () => (this.drag = null));
        // The wheel scrolls the text (Ctrl+wheel is left to the editor's text size).
        this.canvas.addEventListener(
          'wheel',
          (e) => {
            if (e.ctrlKey || e.metaKey) return;
            e.preventDefault();
            const unit = e.deltaMode === 1 ? this.view.defaultLineHeight : e.deltaMode === 2 ? this.view.scrollDOM.clientHeight : 1;
            this.view.scrollDOM.scrollBy({ top: e.deltaY * unit, left: e.deltaX * unit });
          },
          { passive: false },
        );
        this.schedule();
      }

      update(u) {
        if (u.docChanged || u.transactions.some((tr) => tr.effects.length)) {
          // Edits and effects (problems found, a search) are drawn a moment later, together.
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.marks = null;
            this.schedule();
          }, u.docChanged ? 150 : 60);
        }
        if (u.docChanged || u.viewportChanged || u.geometryChanged || u.heightChanged) this.schedule();
      }

      schedule() {
        this.view.requestMeasure({ key: this, read: () => this.read(), write: (m) => this.write(m) });
      }

      read() {
        const { view } = this;
        const width = view.dom.clientWidth;
        if (width < MINIMAP.minView || phone()) return { show: false };
        const scroller = view.scrollDOM;
        const sr = scroller.getBoundingClientRect();
        const dr = view.dom.getBoundingClientRect();
        const clientHeight = scroller.clientHeight;
        const visTop = Math.max(0, sr.top - view.documentTop);
        const { doc } = view.state;
        const topLine = doc.lineAt(view.lineBlockAtHeight(visTop).from).number;
        const bottomLine = doc.lineAt(view.lineBlockAtHeight(Math.max(0, visTop + clientHeight - 1)).from).number;
        return {
          show: true,
          top: sr.top - dr.top,
          right: dr.right - sr.right + (scroller.offsetWidth - scroller.clientWidth),
          height: clientHeight,
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight,
          topLine,
          bottomLine,
        };
      }

      write(m) {
        const { view } = this;
        // CodeMirror sets the editor's classes again when its attributes change (another tab's
        // state in this view, a theme), so the mark that makes room is checked every time.
        const marked = view.dom.classList.contains('cm-has-minimap');
        if (!m.show) {
          this.shown = false;
          this.dom.hidden = true;
          if (marked) {
            view.dom.classList.remove('cm-has-minimap');
            view.requestMeasure();
          }
          return;
        }
        this.shown = true;
        this.dom.hidden = false;
        if (!marked) {
          // Room for it after the text (the CSS pads .cm-content); the editor measures again.
          view.dom.classList.add('cm-has-minimap');
          view.requestMeasure();
        }
        const width = MINIMAP.width;
        Object.assign(this.dom.style, { top: `${m.top}px`, right: `${m.right}px`, height: `${m.height}px`, width: `${width}px` });
        const ratio = Math.min(3, globalThis.devicePixelRatio || 1);
        const w = Math.round(width * ratio);
        const h = Math.max(1, Math.round(m.height * ratio));
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w;
          this.canvas.height = h;
          this.canvas.style.width = `${width}px`;
          this.canvas.style.height = `${m.height}px`;
        }
        const started = performance.now();
        const { state } = view;
        const layout = minimapLayout({ lines: state.doc.lines, height: m.height, topLine: m.topLine, bottomLine: m.bottomLine, scrollTop: m.scrollTop, scrollHeight: m.scrollHeight, clientHeight: m.clientHeight });
        this.layout = layout;
        this.geometry = m;
        const ctx = this.canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, m.height);
        this.drawLines(ctx, layout, m.height);
        // The part on screen.
        ctx.fillStyle = this.drag ? palette.boxActive : palette.box;
        ctx.fillRect(0, layout.boxTop, width - MINIMAP.edge, layout.boxHeight);
        ctx.fillStyle = palette.boxLine;
        ctx.fillRect(0, layout.boxTop, width - MINIMAP.edge, 1);
        ctx.fillRect(0, layout.boxTop + layout.boxHeight - 1, width - MINIMAP.edge, 1);
        // The whole file's marks, on the edge.
        if (!this.marks) this.marks = marksOf(view);
        const ticks = markTicks(this.marks, { lines: state.doc.lines, height: m.height });
        for (const t of ticks) {
          ctx.fillStyle = MARK_COLORS[t.kind];
          ctx.fillRect(width - MINIMAP.edge + 1, t.y, MINIMAP.edge - 1, t.h);
        }
        const ms = performance.now() - started;
        // What it drew, for the checks (and a look in the inspector).
        Object.assign(this.canvas.dataset, { first: String(layout.first), last: String(layout.last), box: `${layout.boxTop.toFixed(1)},${layout.boxHeight.toFixed(1)}`, ticks: String(ticks.length), ms: ms.toFixed(1) });
      }

      drawLines(ctx, layout, height) {
        const { state } = this.view;
        const { doc } = state;
        const lh = MINIMAP.lineHeight;
        const cw = MINIMAP.charWidth;
        const maxCols = Math.floor((MINIMAP.width - MINIMAP.inset - MINIMAP.edge - 2) / cw);
        const first = layout.first;
        const last = Math.min(doc.lines, layout.last);
        if (first > last) return;
        const from = doc.line(first).from;
        const to = doc.line(last).to;
        const spans = spansFor(state, from, to);
        let next = 0;
        let active = [];
        let fill = null;
        for (let n = first; n <= last; n++) {
          const line = doc.line(n);
          const y = (n - first) * lh - layout.offset;
          if (y > height) break;
          // The spans over this line: those started before its end, not ended before its start.
          while (next < spans.length && spans[next].from < line.to + 1) active.push(spans[next++]);
          if (active.length) active = active.filter((s) => s.to > line.from);
          const text = line.length > maxCols * 4 ? line.text.slice(0, maxCols * 4) : line.text;
          for (const run of lineRuns(text, { from: line.from, spans: active, tabSize: state.tabSize, maxCols })) {
            const color = palette[run.kind] ?? palette.text;
            if (color !== fill) ctx.fillStyle = fill = color;
            ctx.fillRect(MINIMAP.inset + run.col * cw, y + 0.25, run.len * cw, lh - 0.6);
          }
        }
      }

      press(e) {
        if (e.button !== 0 || !this.layout) return;
        // The text keeps the focus and the cursor stays where it was.
        e.preventDefault();
        const y = e.clientY - this.canvas.getBoundingClientRect().top;
        const scroller = this.view.scrollDOM;
        if (!onBox(this.layout, y)) {
          const { doc } = this.view.state;
          const line = doc.line(lineAtY(this.layout, y, doc.lines));
          this.view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
        }
        this.drag = { y0: e.clientY, s0: null, scroller };
        this.canvas.setPointerCapture?.(e.pointerId);
        this.schedule();
      }

      move(e) {
        if (!this.drag) {
          if (this.layout) this.canvas.style.cursor = onBox(this.layout, e.clientY - this.canvas.getBoundingClientRect().top) ? 'grab' : '';
          return;
        }
        const { scroller } = this.drag;
        // From where a jump left it (the first move after the press).
        if (this.drag.s0 === null) {
          this.drag.s0 = scroller.scrollTop;
          this.drag.y0 = e.clientY;
          return;
        }
        const m = this.geometry;
        scroller.scrollTop = dragScroll({ startScrollTop: this.drag.s0, dy: e.clientY - this.drag.y0, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, track: this.layout.track, box: this.layout.boxHeight });
        if (m) this.schedule();
      }

      release(e) {
        if (!this.drag) return;
        this.drag = null;
        this.canvas.releasePointerCapture?.(e.pointerId);
        this.schedule();
      }

      destroy() {
        clearTimeout(this.timer);
        this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
        this.view.dom.classList.remove('cm-has-minimap');
        this.dom.remove();
      }
    },
  );
}
