// Next-edit suggestions in the editor (setting `nextEdits`; nextEdits.js says what to ask and what
// of the answer to show): a moment after an edit, the model's next edits in the file. Near the
// cursor one shows in place (what goes struck through, what comes as ghost text); farther, a mark
// at its line and a hint at the cursor's. Tab goes there, Tab again makes it (one step to undo),
// Escape drops it, and typing on leaves it stale. The grey text (inlineSuggest.js) comes first:
// nothing is asked while it is on its way or shown, and it takes a suggestion's place.
import { Decoration, EditorView, Prec, StateEffect, StateField, ViewPlugin, WidgetType, keymap } from '../vendor/cm/codemirror.js';
import { ghostOf, isGhostEffect, suggesting } from './inlineSuggest.js';
import { afterChange, diffParts, editsText, editSummary, endAfter, isNear, mapHistory, parseNextEdits, pickNext, placeEdit, recordEdit, WAIT_MS } from './nextEdits.js';

const setNext = StateEffect.define(); // { edits } | null

// The person's own edits (typed, deleted, pasted, dropped, a suggestion taken, undone) go into the
// edits made and leave a suggestion stale; a reload, a format, a server's rename or code action and
// the model's own new version are not theirs: those move the edits made and a suggestion with the text.
const NOT_THEIRS = ['input.reload', 'input.format', 'input.rename', 'input.codeaction', 'input.model'];
const personal = (tr) => !NOT_THEIRS.some((e) => tr.isUserEvent(e)) && ['input', 'delete', 'move', 'undo', 'redo'].some((e) => tr.isUserEvent(e));
// After those the model is asked again (not after an undo or a redo).
const asksAfter = (tr) => personal(tr) && !tr.isUserEvent('undo') && !tr.isUserEvent('redo');

/** The edits made in this tab (nextEdits.js recordEdit): what the request says was done. */
const historyField = StateField.define({
  create: () => [],
  update(history, tr) {
    if (!tr.docChanged) return history;
    const change = { startDoc: tr.startState.doc, doc: tr.newDoc, changes: tr.changes };
    return personal(tr) ? recordEdit(history, change) : mapHistory(history, change);
  },
});

/** The suggestions: { edits } (placed by nextEdits.js placeEdit), or null. */
const nextField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setNext)) return e.value;
      if (isGhostEffect(e)) return null; // the grey text at the cursor takes its place
    }
    if (!value || !tr.docChanged) return value;
    const typed = personal(tr);
    const edits = value.edits.map((e) => afterChange(e, { typed, changes: tr.changes })).filter(Boolean);
    return edits.length ? { edits } : null;
  },
});

/** The suggestions a state shows (for tests): [{ find, replace, why, from, to }], or null. */
export const nextEditsOf = (state) => state.field(nextField, false)?.edits ?? null;
/** The effect that shows placed suggestions (none: drops them). */
export const withNextEdits = (edits) => setNext.of(edits?.length ? { edits } : null);

class Text extends WidgetType {
  constructor(text, className, title = '') {
    super();
    this.text = text;
    this.className = className;
    this.title = title;
  }
  eq(other) {
    return other.text === this.text && other.className === this.className && other.title === this.title;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = this.className;
    el.textContent = this.text;
    if (this.title) el.title = this.title;
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function decorationsOf(state) {
  const s = state.field(nextField, false);
  const head = state.selection.main.head;
  const e = s && pickNext(s.edits, head);
  if (!e) return Decoration.none;
  const { doc } = state;
  const here = doc.lineAt(head);
  const first = doc.lineAt(e.from);
  const last = doc.lineAt(e.to);
  const out = [];
  if (isNear(here.number, first.number, last.number)) {
    for (const p of diffParts(e)) {
      if (p.to > p.from) out.push(Decoration.mark({ class: 'cm-ne-del' }).range(p.from, p.to));
      if (p.insert) out.push(Decoration.widget({ widget: new Text(p.insert, 'cm-ne-ins'), side: 1 }).range(p.to));
    }
    out.push(Decoration.widget({ widget: new Text('Tab takes it · Esc drops it', 'cm-ne-hint near', e.why), side: 2 }).range(last.to));
  } else {
    for (let n = first.number; n <= last.number; n++) out.push(Decoration.line({ class: 'cm-ne-line' }).range(doc.line(n).from));
    out.push(Decoration.widget({ widget: new Text(`✦ ${editSummary(e)}`, 'cm-ne-mark', e.why ? `The next edit: ${e.why}` : 'The next edit'), side: 2 }).range(last.to));
    out.push(Decoration.widget({ widget: new Text(`Tab ${e.from > head ? '↓' : '↑'} to the next edit`, 'cm-ne-hint', `Line ${first.number}${e.why ? `: ${e.why}` : ''} · Esc drops it`), side: 2 }).range(here.to));
  }
  return Decoration.set(out, true);
}

/** Tab: to the suggestion when it is not near the cursor, else make it (the rest of the answer stays, placed again). */
function takeNext(view) {
  const { state } = view;
  const s = state.field(nextField, false);
  if (!s || state.readOnly || state.selection.ranges.length > 1) return false;
  const head = state.selection.main.head;
  const e = pickNext(s.edits, head);
  if (!e) return false;
  const line = (pos) => state.doc.lineAt(pos).number;
  if (!isNear(line(head), line(e.from), line(e.to))) {
    const at = diffParts(e)[0]?.from ?? e.from;
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }), userEvent: 'select.nextedit' });
    return true;
  }
  const text = state.doc.toString();
  const after = text.slice(0, e.from) + e.replace + text.slice(e.to);
  const rest = s.edits
    .filter((x) => x !== e)
    .map((x) => placeEdit(after, x))
    .filter(Boolean);
  // One change of its own ('input.nextedit' never joins the typing before it): one Ctrl+Z.
  view.dispatch({ changes: { from: e.from, to: e.to, insert: e.replace }, selection: { anchor: endAfter(e) }, effects: setNext.of(rest.length ? { edits: rest } : null), userEvent: 'input.nextedit', scrollIntoView: true });
  return true;
}

function dismissNext(view) {
  if (!view.state.field(nextField, false)) return false;
  view.dispatch({ effects: setNext.of(null) });
  return true;
}

/**
 * The extension: `ask({ edits, text, cursor, name, language, signal }, view)` resolves to the
 * model's answer ('' asks nothing: app.js actions.nextEdits); `enabled()` is the setting (and a
 * model that answers at once); `languageOf` / `nameOf` give the file's language and name.
 */
export function nextEdits({ ask, enabled, languageOf = () => '', nameOf = () => '' }) {
  const asker = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.timer = null;
        this.controller = null;
      }
      update(u) {
        if (u.transactions.some((tr) => tr.docChanged && asksAfter(tr))) this.schedule(WAIT_MS);
        else if (u.docChanged) this.cancel();
      }
      cancel() {
        clearTimeout(this.timer);
        this.timer = null;
        this.controller?.abort();
        this.controller = null;
      }
      schedule(ms) {
        this.cancel();
        if (enabled()) this.timer = setTimeout(() => this.ask(), ms);
      }
      async ask() {
        this.timer = null;
        const { view } = this;
        const { state } = view;
        if (!enabled() || state.readOnly || state.field(nextField, false) || state.selection.ranges.length > 1 || ghostOf(state)) return;
        // The grey text first: a moment more while it is on its way.
        if (suggesting(view)) return this.schedule(300);
        const edits = editsText(state.field(historyField, false) ?? [], state.doc);
        if (!edits) return;
        const text = state.doc.toString();
        const controller = new AbortController();
        this.controller = controller;
        let reply = '';
        try {
          reply = await ask({ edits, text, cursor: state.selection.main.head, name: nameOf(state), language: languageOf(state), signal: controller.signal }, view);
        } catch {
          return; // the model could not be reached: nothing shown
        } finally {
          if (this.controller === controller) this.controller = null;
        }
        // Only for the text it was asked about, and not over the grey text.
        const now = view.state;
        if (controller.signal.aborted || !enabled() || now.doc !== state.doc || now.field(nextField, false) || ghostOf(now)) return;
        const found = parseNextEdits(reply, text);
        if (found.length) view.dispatch({ effects: setNext.of({ edits: found }) });
      }
      destroy() {
        this.cancel();
      }
    },
  );
  return [
    historyField,
    nextField,
    EditorView.decorations.compute(['doc', 'selection', nextField], decorationsOf),
    asker,
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: takeNext },
        { key: 'Escape', run: dismissNext },
      ]),
    ),
  ];
}
