// The editor's find and replace bar (CodeMirror's search panel, drawn our way):
// one line with the search field and its toggles (match case, whole word,
// regular expression) inside it, the match count, previous/next, select all
// and close; a second line for replacing, opened with the chevron or Ctrl+H.
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  runScopeHandlers,
  selectMatches,
  setSearchQuery,
} from '../vendor/cm/codemirror.js';

/** Matches counted at most (a larger count shows as "10000+"). */
export const COUNT_CAP = 10000;

/**
 * Counts the matches of `query` in `state` (up to `cap`) and finds which one the
 * main selection is on: { total, index (1-based, 0 = none), capped, valid }.
 */
export function countMatches(query, state, cap = COUNT_CAP) {
  if (!query.search) return { total: 0, index: 0, capped: false, valid: true };
  if (!query.valid) return { total: 0, index: 0, capped: false, valid: false };
  const { from, to } = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let index = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === from && next.value.to === to) index = total;
    if (total >= cap) return { total, index, capped: true, valid: true };
  }
  return { total, index, capped: false, valid: true };
}

/** The count's text: "3 of 12", "12 matches", "No results", "Invalid pattern". */
export function countLabel({ total, index, capped, valid }, search = '') {
  if (!valid) return 'Invalid pattern';
  if (!search) return '';
  if (!total) return 'No results';
  const all = capped ? `${total}+` : String(total);
  return index ? `${index} of ${all}` : `${all} ${total === 1 && !capped ? 'match' : 'matches'}`;
}

const SVG = {
  chevron: '<path d="m9 6 6 6-6 6" />',
  up: '<path d="M12 19V5M6 11l6-6 6 6" />',
  down: '<path d="M12 5v14M6 13l6 6 6-6" />',
  all: '<path d="M4 6h10M4 12h10M4 18h10" /><path d="m16 15 2 2 3-4" />',
  close: '<path d="M6 6l12 12M18 6 6 18" />',
};
const icon = (name) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[name]}</svg>`;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children);
  return node;
}

// The replace line stays open (or closed) from one search to the next.
let replaceShown = false;
const panels = new WeakMap(); // view → its panel

class SearchPanel {
  constructor(view) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    this.counted = null;
    this.timer = 0;
    panels.set(view, this);
    const field = (name, label, extra = {}) =>
      el('input', { class: 'sp-input', name, placeholder: label, 'aria-label': label, autocomplete: 'off', spellcheck: 'false', form: '', ...extra, oninput: () => this.commit() });
    const toggle = (name, text, title) => el('button', { type: 'button', class: 'sp-toggle', name, title, 'aria-label': title, 'aria-pressed': 'false', onmousedown: (e) => e.preventDefault(), onclick: () => this.flip(name) }, [text]);
    const button = (name, title, iconName, run) =>
      el('button', { type: 'button', class: 'sp-icon', name, title, 'aria-label': title, html: icon(iconName), onclick: () => (run(view), this.recount()) });

    this.searchField = field('search', 'Find', { 'main-field': 'true' });
    this.replaceField = field('replace', 'Replace');
    this.toggles = {
      case: toggle('case', 'Aa', 'Match case'),
      word: toggle('word', 'ab', 'Whole word'),
      re: toggle('re', '.*', 'Regular expression'),
    };
    this.toggles.word.classList.add('sp-word');
    this.count = el('span', { class: 'sp-count', 'aria-live': 'polite' });
    this.expand = el('button', {
      type: 'button',
      class: 'sp-expand',
      title: 'Replace (Ctrl+H)',
      'aria-label': 'Show replace',
      html: icon('chevron'),
      onclick: () => this.showReplace(!replaceShown, true),
    });
    this.replaceRow = el('div', { class: 'sp-row sp-replace-row' }, [
      el('div', { class: 'sp-field' }, [this.replaceField]),
      el('button', { type: 'button', class: 'sp-btn', name: 'replace', title: 'Replace the next match (Enter)', onclick: () => this.replaceOne() }, ['Replace']),
      el('button', { type: 'button', class: 'sp-btn', name: 'replaceAll', title: 'Replace every match (Ctrl+Enter)', onclick: () => (replaceAll(view), this.recount()) }, ['Replace all']),
    ]);
    this.dom = el('div', { class: 'find-bar', onkeydown: (e) => this.keydown(e) }, [
      this.expand,
      el('div', { class: 'sp-rows' }, [
        el('div', { class: 'sp-row' }, [
          el('div', { class: 'sp-field' }, [this.searchField, el('span', { class: 'sp-toggles' }, Object.values(this.toggles))]),
          this.count,
          el('span', { class: 'sp-nav' }, [
            button('prev', 'Previous match (Shift+Enter)', 'up', findPrevious),
            button('next', 'Next match (Enter)', 'down', findNext),
            button('select', 'Select all matches (Alt+Enter)', 'all', selectMatches),
          ]),
          el('button', { type: 'button', class: 'sp-icon sp-close', title: 'Close (Escape)', 'aria-label': 'Close', html: icon('close'), onclick: () => closeSearchPanel(view) }),
        ]),
        this.replaceRow,
      ]),
    ]);
    this.setQuery(this.query);
    this.showReplace(replaceShown);
  }

  get top() {
    return true;
  }

  get pos() {
    return 80;
  }

  mount() {
    this.searchField.select();
    this.recount();
  }

  destroy() {
    clearTimeout(this.timer);
    panels.delete(this.view);
  }

  /** Shows or hides the replace line (never in a read-only tab); `focus` puts the caret in it. */
  showReplace(on, focus = false) {
    const can = !this.view.state.readOnly;
    replaceShown = on;
    const open = on && can;
    this.replaceRow.hidden = !open;
    this.expand.hidden = !can;
    this.expand.classList.toggle('open', open);
    this.expand.setAttribute('aria-expanded', String(open));
    this.expand.setAttribute('aria-label', open ? 'Hide replace' : 'Show replace');
    this.dom.classList.toggle('sp-replacing', open);
    if (focus) (open ? this.replaceField : this.searchField).focus();
  }

  flip(name) {
    const t = this.toggles[name];
    t.setAttribute('aria-pressed', String(t.getAttribute('aria-pressed') !== 'true'));
    this.commit();
  }

  pressed(name) {
    return this.toggles[name].getAttribute('aria-pressed') === 'true';
  }

  commit() {
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.pressed('case'),
      wholeWord: this.pressed('word'),
      regexp: this.pressed('re'),
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  setQuery(query) {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.toggles.case.setAttribute('aria-pressed', String(query.caseSensitive));
    this.toggles.word.setAttribute('aria-pressed', String(query.wholeWord));
    this.toggles.re.setAttribute('aria-pressed', String(query.regexp));
  }

  keydown(e) {
    if (runScopeHandlers(this.view, e, 'search-panel')) return e.preventDefault();
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && e.target === this.searchField) {
      e.preventDefault();
      if (e.altKey) selectMatches(this.view);
      else (e.shiftKey ? findPrevious : findNext)(this.view);
      this.recount();
    } else if (e.key === 'Enter' && e.target === this.replaceField) {
      e.preventDefault();
      if (mod) replaceAll(this.view), this.recount();
      else this.replaceOne();
    } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      this.showReplace(true, true);
    }
  }

  /** Replaces the match the selection is on, or else the next one (CodeMirror's command only selects it first). */
  replaceOne() {
    const { state } = this.view;
    const { from, to } = state.selection.main;
    const at = this.query.valid && this.query.search ? this.query.getCursor(state, from, to).next() : { done: true };
    if (at.done || at.value.from !== from || at.value.to !== to) findNext(this.view);
    replaceNext(this.view);
    this.recount();
  }

  update(update) {
    let changed = update.docChanged || update.selectionSet;
    for (const tr of update.transactions)
      for (const effect of tr.effects)
        if (effect.is(setSearchQuery)) {
          changed = true;
          if (!effect.value.eq(this.query)) this.setQuery(effect.value);
        }
    if (update.startState.readOnly !== update.state.readOnly) this.showReplace(replaceShown);
    if (changed) this.recount();
  }

  /** Counts again a moment later (typing in a big file stays smooth). */
  recount() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const counted = countMatches(this.query, this.view.state);
      this.count.textContent = countLabel(counted, this.query.search);
      this.count.classList.toggle('none', !!this.query.search && (!counted.valid || !counted.total));
      this.searchField.classList.toggle('invalid', !counted.valid);
    }, 40);
  }
}

/** The extension's `createPanel`. */
export const createSearchPanel = (view) => new SearchPanel(view);

/** Opens the bar with the replace line and puts the caret in it (Ctrl+H). */
export function openReplacePanel(view) {
  replaceShown = true;
  openSearchPanel(view);
  const panel = panels.get(view);
  if (panel) {
    panel.showReplace(true);
    // openSearchPanel focuses the search field; the replace field wins when there is something to find.
    if (panel.searchField.value) panel.replaceField.focus();
  }
  return true;
}
