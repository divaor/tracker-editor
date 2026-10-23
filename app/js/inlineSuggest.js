// Suggestions as you type, from the connected model: grey text after the cursor a moment
// after you stop typing. Tab takes all of it, Ctrl+→ its next word, Escape (or typing
// something else) drops it. `ask` does the asking (app.js: the model's /completions, or
// its chat); completion.js decides when to ask and what of the answer to keep.
import { Decoration, EditorView, Prec, StateEffect, StateField, ViewPlugin, WidgetType, keymap } from '../vendor/cm/codemirror.js';
import { cleanCompletion, restCovered, shouldSuggest } from './completion.js';

// { pos, text, cover } or null: `cover` characters after pos (an auto-closed ")") are replaced by it.
const setGhost = StateEffect.define();
const WAIT_MS = 450;

class Ghost extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-ghost';
    el.textContent = this.text;
    el.title = 'Tab takes it · Ctrl+→ one word · Esc drops it';
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const ghostField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (!value) return null;
    if (tr.docChanged) {
      // Typing what the suggestion says keeps the rest of it.
      let typed = null;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        typed = typed === null && fromA === value.pos && toA === fromA ? inserted.toString() : false;
      });
      if (typed && value.text.startsWith(typed)) {
        const rest = value.text.slice(typed.length);
        return rest ? { ...value, pos: value.pos + typed.length, text: rest } : null;
      }
      return null;
    }
    return tr.selection ? null : value;
  },
  // What it replaces is hidden meanwhile, so the line reads as it will be.
  provide: (f) =>
    EditorView.decorations.from(f, (v) =>
      !v ? Decoration.none
      : v.cover ? Decoration.set([Decoration.replace({ widget: new Ghost(v.text) }).range(v.pos, v.pos + v.cover)])
      : Decoration.set([Decoration.widget({ widget: new Ghost(v.text), side: 1 }).range(v.pos)]),
    ),
});

/** Whether a state shows a suggestion (for tests and the status bar). */
export const ghostOf = (state) => state.field(ghostField, false) ?? null;

function accept(view) {
  const g = view.state.field(ghostField, false);
  if (!g) return false;
  view.dispatch({ changes: { from: g.pos, to: g.pos + (g.cover ?? 0), insert: g.text }, selection: { anchor: g.pos + g.text.length }, effects: setGhost.of(null), userEvent: 'input.complete', scrollIntoView: true });
  return true;
}
function acceptWord(view) {
  const g = view.state.field(ghostField, false);
  if (!g) return false;
  const word = /^\s*[\w$]+|^\s*\S/.exec(g.text)?.[0] ?? g.text;
  const rest = g.text.slice(word.length);
  // The last word also takes the place of what the suggestion covers.
  const to = rest ? g.pos : g.pos + (g.cover ?? 0);
  view.dispatch({ changes: { from: g.pos, to, insert: word }, selection: { anchor: g.pos + word.length }, effects: setGhost.of(rest ? { ...g, pos: g.pos + word.length, text: rest } : null), userEvent: 'input.complete' });
  return true;
}
function dismiss(view) {
  if (!view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}

/**
 * The extension: `ask({ prefix, suffix, language, name, signal }, view)` resolves to the model's
 * answer; `enabled()` is the setting (and a model connected); `languageOf` / `nameOf` give
 * the file's language and name from a state.
 */
export function inlineSuggestions({ ask, enabled, languageOf = () => '', nameOf = () => '' }) {
  const asker = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.timer = null;
        this.controller = null;
      }
      update(u) {
        const typed = u.transactions.some((tr) => tr.isUserEvent('input.type') || tr.isUserEvent('delete.backward'));
        if (u.docChanged && typed) this.schedule();
        else if (u.docChanged || u.selectionSet) this.cancel();
      }
      cancel() {
        clearTimeout(this.timer);
        this.controller?.abort();
        this.controller = null;
      }
      schedule() {
        this.cancel();
        if (enabled()) this.timer = setTimeout(() => this.ask(), WAIT_MS);
      }
      async ask() {
        const { state } = this.view;
        const sel = state.selection.main;
        if (!sel.empty || state.selection.ranges.length > 1 || state.field(ghostField, false)) return;
        const line = state.doc.lineAt(sel.head);
        if (!shouldSuggest({ before: line.text.slice(0, sel.head - line.from), after: line.text.slice(sel.head - line.from) })) return;
        const prefix = state.sliceDoc(Math.max(0, sel.head - 3000), sel.head);
        const suffix = state.sliceDoc(sel.head, Math.min(state.doc.length, sel.head + 1000));
        const controller = new AbortController();
        this.controller = controller;
        let answer = '';
        try {
          answer = await ask({ prefix, suffix, language: languageOf(state), name: nameOf(state), signal: controller.signal }, this.view);
        } catch {
          return; // the model could not be reached: nothing shown
        }
        // Only if nothing moved meanwhile.
        const now = this.view.state;
        if (controller.signal.aborted || now.doc !== state.doc || !now.selection.main.eq(sel)) return;
        const text = cleanCompletion(answer, { prefix, suffix });
        const rest = line.text.slice(sel.head - line.from);
        if (text) this.view.dispatch({ effects: setGhost.of({ pos: sel.head, text, cover: restCovered(text, rest) }) });
      }
      destroy() {
        this.cancel();
      }
    },
  );
  return [
    ghostField,
    asker,
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: accept },
        { key: 'Mod-ArrowRight', run: acceptWord },
        { key: 'Escape', run: dismiss },
      ]),
    ),
  ];
}
