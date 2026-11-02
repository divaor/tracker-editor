// The breadcrumbs bar over an editor view: where the file is, then the class, function or
// section around the cursor ("site › src › store.js › Store › save"), each a button. A click,
// or Enter / ↓ on one, opens what is next to it: a folder's folders and files and the other
// files next to the file (the app lists them: `onMenu` without items), a symbol's siblings, the
// last symbol's children (with items, made here from the outline). The bar sits above the text,
// after the find bar's place. crumbs.js has the pure parts; editor.js gives the place
// (`placeOf`), the outline and the symbols around the cursor.
import { EditorView, StateEffect, ViewPlugin } from '../vendor/cm/codemirror.js';
import { symbolChildren, symbolCrumbs, symbolSiblings, topSymbols } from './crumbs.js';

/** Asks the bars to read their file's place again (the folders in Folders changed, a file was renamed…). */
export const refreshCrumbs = StateEffect.define();

const SVG = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 1 1 .9-8.9A6 6 0 0 1 19 11a3.5 3.5 0 0 1-.5 7z"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  symbol: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
};
const ICON_OF = { root: 'folder', folder: 'folder', server: 'server', file: 'file', files: 'cloud', project: 'folder', tracker: 'doc', item: 'doc', symbol: 'symbol', outline: 'list' };

function crumbButton(c, i) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `cm-crumb kind-${c.kind}`;
  b.dataset.i = String(i);
  b.tabIndex = -1;
  b.title = c.kind === 'symbol' ? `${c.label} (line ${c.line}): what is next to it` : c.kind === 'outline' ? 'The outline of the file' : `${c.title || c.label}: what is next to it`;
  b.setAttribute('aria-haspopup', 'menu');
  const icon = document.createElement('span');
  icon.className = 'cm-crumb-icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[ICON_OF[c.kind]] ?? ''}</svg>`;
  const label = document.createElement('span');
  label.className = 'cm-crumb-label';
  label.textContent = c.label;
  b.append(icon, label);
  return b;
}

/**
 * The bar, for one editor host: `placeOf(view)` → the place's crumbs (crumbs.js placeCrumbs),
 * `scopeOf(state, pos)` / `outlineOf(state)` (editor.js), `keyOf(view)` the tab's key, and
 * `onMenu({ view, key, crumb, at, owner, items?, label })` shows a crumb's menu. `auto()`: the
 * setting is left as it is (the stylesheet hides the bar on phones then).
 */
export function breadcrumbsBar({ placeOf, scopeOf, outlineOf, keyOf, onMenu, auto = () => true }) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.dom = document.createElement('nav');
        this.dom.className = 'cm-crumbs';
        this.dom.setAttribute('aria-label', 'Where you are: the file and the code around the cursor');
        // A press keeps the text's focus; the click opens the menu.
        this.dom.addEventListener('mousedown', (e) => e.target.closest('.cm-crumb') && e.preventDefault());
        this.dom.addEventListener('click', (e) => {
          const b = e.target.closest('.cm-crumb');
          if (b) this.open(Number(b.dataset.i), b);
        });
        this.dom.addEventListener('keydown', (e) => this.key(e));
        view.dom.insertBefore(this.dom, view.scrollDOM);
        this.place = placeOf(view) ?? [];
        this.crumbs = [];
        this.signature = '';
        this.render();
      }

      update(u) {
        if (u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshCrumbs)))) {
          this.place = placeOf(u.view) ?? [];
          this.render();
        } else if (u.selectionSet || u.docChanged || u.transactions.some((tr) => tr.reconfigured)) this.render();
      }

      render() {
        const { state } = this.view;
        const entries = outlineOf(state);
        const symbols = symbolCrumbs(entries, scopeOf(state, state.selection.main.head));
        const crumbs = [...this.place, ...symbols];
        // Outside every symbol: a last crumb that lists the file's outline.
        if (!symbols.length && entries.length) crumbs.push({ kind: 'outline', label: '…' });
        this.dom.classList.toggle('auto', auto());
        const signature = JSON.stringify(crumbs.map((c) => [c.kind, c.label, c.index ?? '']));
        if (signature === this.signature) return;
        this.signature = signature;
        this.crumbs = crumbs;
        const had = this.dom.contains(document.activeElement) ? Number(document.activeElement.dataset.i) : -1;
        const nodes = [];
        crumbs.forEach((c, i) => {
          if (i) {
            const sep = document.createElement('span');
            sep.className = 'cm-crumb-sep';
            sep.setAttribute('aria-hidden', 'true');
            sep.textContent = '›';
            nodes.push(sep);
          }
          nodes.push(crumbButton(c, i));
        });
        this.dom.replaceChildren(...nodes);
        this.dom.hidden = !crumbs.length;
        if (had >= 0) this.dom.querySelector(`[data-i="${Math.min(had, crumbs.length - 1)}"]`)?.focus();
        // Too long for the bar: the deepest crumbs show.
        this.dom.scrollLeft = this.dom.scrollWidth;
      }

      /** Focuses the last crumb (Mod+Shift+.): ←/→ move, Enter or ↓ opens one, Escape goes back to the text. */
      focusLast() {
        const all = this.dom.querySelectorAll('.cm-crumb');
        if (!all.length) return false;
        all[all.length - 1].focus();
        return true;
      }

      key(e) {
        const b = e.target.closest?.('.cm-crumb');
        if (!b) return;
        const all = [...this.dom.querySelectorAll('.cm-crumb')];
        const i = all.indexOf(b);
        const go = (j) => {
          e.preventDefault();
          all[(j + all.length) % all.length]?.focus();
        };
        if (e.key === 'ArrowRight') go(i + 1);
        else if (e.key === 'ArrowLeft') go(i - 1);
        else if (e.key === 'Home') go(0);
        else if (e.key === 'End') go(all.length - 1);
        else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          this.open(Number(b.dataset.i), b);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.view.focus();
        }
      }

      open(i, button) {
        const c = this.crumbs[i];
        if (!c) return;
        const r = button.getBoundingClientRect();
        const base = { view: this.view, key: keyOf(this.view), crumb: c, at: { x: r.left, y: r.bottom + 2 }, owner: button };
        if (c.kind !== 'symbol' && c.kind !== 'outline') return onMenu({ ...base, label: c.label });
        const entries = outlineOf(this.view.state);
        const row = (x) => ({ key: `s${x.index}`, label: x.title, hint: `line ${x.line}`, checked: x.index === c.index, run: () => this.jump(x.line) });
        if (c.kind === 'outline') return onMenu({ ...base, label: 'The outline', items: topSymbols(entries).map(row) });
        const siblings = symbolSiblings(entries, c.index);
        const last = i === this.crumbs.length - 1;
        const children = last ? symbolChildren(entries, c.index) : [];
        const items = children.length
          ? [{ heading: true, key: 'in', label: `In ${c.label}` }, ...children.map(row), { separator: true }, { heading: true, key: 'by', label: 'Next to it' }, ...siblings.map(row)]
          : siblings.map(row);
        onMenu({ ...base, label: c.label, items });
      }

      /** Goes to a line (a symbol picked in a menu): the cursor at its text, in the middle of the view. */
      jump(line) {
        if (this.destroyed) return;
        const v = this.view;
        const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)));
        const at = l.from + (l.text.length - l.text.trimStart().length);
        v.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }), userEvent: 'select' });
        v.focus();
      }

      destroy() {
        this.destroyed = true;
        this.dom.remove();
      }
    },
  );
}
