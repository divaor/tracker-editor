import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { AREAS, areaLabel, cleanTags } from '../tracker-model.js';
import { Icon } from './icons.js';

// ---- Toasts --------------------------------------------------------------------

let pushToast = () => {};

/** Shows a short message; `action` adds a button (e.g. Undo). */
/** A message for a moment. With `key`, it replaces one with the same key, and dismissToast(key) removes it. */
export function toast(message, { kind = 'info', action, timeout = 5000, key = '' } = {}) {
  pushToast({ message, kind, action, timeout, key });
}
let dropToast = () => {};
export const dismissToast = (key) => dropToast(key);

export function Toasts() {
  const [list, setList] = useState([]);
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setList((l) => [...l.filter((x) => !t.key || x.key !== t.key).slice(-3), { ...t, id }]);
      setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), t.timeout);
    };
    dropToast = (key) => setList((l) => l.filter((x) => x.key !== key));
    return () => {
      pushToast = () => {};
      dropToast = () => {};
    };
  }, []);
  const dismiss = (id) => setList((l) => l.filter((x) => x.id !== id));
  return html`<div class="toasts" role="status" aria-live="polite">
    ${list.map(
      (t) => html`<div class="toast ${t.kind === 'error' ? 'error' : ''}" key=${t.id}>
        <span class="toast-msg">${t.message}</span>
        ${t.action && html`<button type="button" class="btn link" onClick=${() => {
          t.action.run();
          dismiss(t.id);
        }}>${t.action.label}</button>`}
        <button type="button" class="icon-btn sm" aria-label="Dismiss" onClick=${() => dismiss(t.id)}><${Icon} name="x" size=${15} /></button>
      </div>`,
    )}
  </div>`;
}

// ---- Modal ---------------------------------------------------------------------

// Dialogs shown, the last on top: Escape closes only that one (a question over a dialog).
const openModals = [];

export function Modal({ title, onClose, children, footer, wide = false, className = '' }) {
  const ref = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  // A layout effect, so Escape works from the moment the dialog shows.
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const self = {};
    openModals.push(self);
    ref.current?.querySelector('input, textarea, select, button.primary')?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && openModals.at(-1) === self) {
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      openModals.splice(openModals.indexOf(self), 1);
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, []);
  return html`<div class="modal-backdrop" onPointerDown=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal ${wide ? 'wide' : ''} ${className}" role="dialog" aria-modal="true" aria-label=${title} ref=${ref}>
      <div class="modal-head">
        <h2 class="modal-heading">${title}</h2>
        <span class="spacer" />
        <button type="button" class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" size=${18} /></button>
      </div>
      <div class="modal-body">${children}</div>
      ${footer && html`<div class="modal-foot">${footer}</div>`}
    </div>
  </div>`;
}

// ---- Forms ---------------------------------------------------------------------

export function Card({ title, icon, children, id }) {
  return html`<section class="settings-card" id=${id}>
    <h2>${icon && html`<${Icon} name=${icon} size=${18} />`}${title}</h2>
    ${children}
  </section>`;
}

export function Field({ label, hint, children, wide = false }) {
  return html`<label class="field ${wide ? 'span-2' : ''}">
    <span>${label}</span>
    ${children}
    ${hint && html`<small>${hint}</small>`}
  </label>`;
}

export function Check({ checked, label, hint, onChange }) {
  return html`<label class="field checkbox">
    <input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span>${label}${hint && html`<small>${hint}</small>`}</span>
  </label>`;
}

export function Segmented({ options, value, onChange, label, small = false }) {
  return html`<div class="segmented ${small ? 'small' : ''}" role="group" aria-label=${label}>
    ${options.map(
      (o) => html`<button type="button" key=${o.id} class=${o.id === value ? 'active' : ''} aria-pressed=${o.id === value} onClick=${() => onChange(o.id)}>
        ${o.icon && html`<${Icon} name=${o.icon} size=${15} />`}${o.label}
      </button>`,
    )}
  </div>`;
}

// ---- Projects and tags (as in the tracker) ---------------------------------------

const AREA_ICON = { work: 'briefcase', personal: 'person' };

export function ProjectChip({ project, name, onClick, small = false }) {
  const label = project?.name ?? name;
  if (!label) return null;
  const style = { '--pc': project?.color || 'var(--text-3)' };
  const inner = html`<span class="project-dot" />${label}`;
  return onClick
    ? html`<button type="button" class="project-chip ${small ? 'small' : ''}" style=${style} title=${`Project: ${label}`}
        onClick=${(e) => {
          e.stopPropagation();
          onClick();
        }}>${inner}</button>`
    : html`<span class="project-chip ${small ? 'small' : ''}" style=${style} title=${`Project: ${label}`}>${inner}</span>`;
}

export function scopeLabel(scope, projects) {
  if (!scope.length) return 'All projects';
  return scope
    .map((s) => {
      if (s === 'none') return 'No project';
      if (s.startsWith('area:')) return areaLabel(s.slice(5));
      return projects.find((p) => p.key === s.slice(8))?.name ?? s.slice(8);
    })
    .join(' + ');
}

function ProjectPicker({ projects, scope, onChange, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && onClose();
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  const toggle = (value) => onChange(scope.includes(value) ? scope.filter((s) => s !== value) : [...scope, value]);
  const groups = [...AREAS.map((a) => ({ id: a.id, label: a.label })), { id: '', label: 'Other projects' }];
  return html`<div class="project-picker" ref=${ref} role="dialog" aria-label="Choose projects">
    <div class="picker-body">
      ${groups.map((g) => {
        const list = projects.filter((p) => p.area === g.id);
        if (!list.length) return null;
        return html`<div class="picker-group" key=${g.id || 'other'}>
          <div class="picker-heading">${g.label}</div>
          ${list.map(
            (p) => html`<label class="picker-row" key=${p.key}>
              <input type="checkbox" checked=${scope.includes(`project:${p.key}`)} onChange=${() => toggle(`project:${p.key}`)} />
              <span class="project-dot" style=${{ '--pc': p.color }} /><span class="picker-name">${p.name}</span><span class="count">${p.total}</span>
            </label>`,
          )}
        </div>`;
      })}
      <div class="picker-group">
        <label class="picker-row">
          <input type="checkbox" checked=${scope.includes('none')} onChange=${() => toggle('none')} />
          <span class="picker-name muted">Files without a project</span>
        </label>
      </div>
      ${!projects.length && html`<p class="muted small picker-empty">No projects yet. Give a file a project, or use the tracker's projects after syncing.</p>`}
    </div>
    <div class="picker-foot">
      <span class="spacer" />
      <button type="button" class="btn sm" disabled=${!scope.length} onClick=${() => onChange([])}>Clear</button>
      <button type="button" class="btn primary sm" onClick=${onClose}>Done</button>
    </div>
  </div>`;
}

/** Project scope: All / Work / Personal / chosen projects (the tracker's projects). */
export function ScopeBar({ scope, projects, onChange }) {
  const [open, setOpen] = useState(false);
  const toggle = (value) => onChange(scope.includes(value) ? scope.filter((s) => s !== value) : [...scope, value]);
  const chosen = scope.filter((s) => s.startsWith('project:') || s === 'none');
  return html`<div class="scope-bar" role="group" aria-label="Project filter">
    <button type="button" class="scope-chip ${!scope.length ? 'active' : ''}" aria-pressed=${!scope.length} onClick=${() => onChange([])}>All</button>
    ${AREAS.map(
      (a) => html`<button type="button" key=${a.id} class="scope-chip ${scope.includes(`area:${a.id}`) ? 'active' : ''}" aria-pressed=${scope.includes(`area:${a.id}`)}
        onClick=${() => toggle(`area:${a.id}`)}><${Icon} name=${AREA_ICON[a.id]} size=${14} />${a.label}</button>`,
    )}
    ${chosen.map((s) => {
      const project = projects.find((p) => `project:${p.key}` === s);
      return html`<span class="scope-chip active chosen" key=${s} style=${{ '--pc': project?.color ?? 'var(--text-3)' }}>
        ${s !== 'none' && html`<span class="project-dot" />`}${s === 'none' ? 'No project' : (project?.name ?? s.slice(8))}
        <button type="button" class="chip-x" aria-label="Remove from filter" onClick=${() => toggle(s)}><${Icon} name="x" size=${12} /></button>
      </span>`;
    })}
    <div class="scope-more">
      <button type="button" class="scope-chip ${open ? 'open' : ''}" aria-expanded=${open} onClick=${() => setOpen(!open)}>
        <${Icon} name="folder" size=${14} />Projects<${Icon} name="chevronDown" size=${13} />
      </button>
      ${open && html`<${ProjectPicker} projects=${projects} scope=${scope} onChange=${onChange} onClose=${() => setOpen(false)} />`}
    </div>
  </div>`;
}

/** Tag editor: chips with remove buttons, suggestions from existing tags. */
export function TagInput({ value, onChange, suggestions = [], placeholder = 'Add a tag…' }) {
  const [text, setText] = useState('');
  const commit = (raw = text) => {
    const added = cleanTags(raw);
    if (added.length) onChange(cleanTags([...value, ...added]));
    setText('');
  };
  const listId = useRef(`tags-${Math.random().toString(36).slice(2)}`).current;
  const lower = value.map((t) => t.toLowerCase());
  return html`<div class="tag-input">
    ${value.map(
      (t) => html`<span class="tag tag-chip" key=${t}>#${t}<button type="button" class="chip-x" aria-label=${`Remove ${t}`}
        onClick=${() => onChange(value.filter((x) => x !== t))}><${Icon} name="x" size=${11} /></button></span>`,
    )}
    <input value=${text} list=${listId} placeholder=${value.length ? '' : placeholder} aria-label="Add tag" autocomplete="off" autocapitalize="off"
      onInput=${(e) => {
        const v = e.currentTarget.value;
        if (/[,\n]/.test(v)) commit(v);
        else setText(v);
      }}
      onKeyDown=${(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Backspace' && !text && value.length) {
          onChange(value.slice(0, -1));
        }
      }}
      onBlur=${() => commit()} />
    <datalist id=${listId}>${suggestions.filter((s) => !lower.includes(s.toLowerCase())).map((s) => html`<option key=${s} value=${s} />`)}</datalist>
  </div>`;
}
