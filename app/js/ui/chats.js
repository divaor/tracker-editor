// The chats with the model kept on this device (chats.js, chatStore.js), as a list inside the
// model panels: those about this file, this project (its tab group), all of them, the saved ones;
// words find one; each opens again, is saved for good (☆), renamed or deleted (with Undo).
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { CHAT_FILTERS, CHAT_KINDS, filterChats, filterCounts, linkLabel } from '../chats.js';
import { chats } from '../chatStore.js';
import { shortAgo } from '../format.js';
import { ClearButton, toast } from './components.js';
import { Icon } from './icons.js';

/** The chats as the store has them now; re-renders when they change. */
export function useChats() {
  const [, bump] = useState(0);
  useEffect(() => {
    let live = true;
    chats.ready().then(() => live && bump((n) => n + 1));
    const off = chats.subscribe(() => bump((n) => n + 1));
    return () => {
      live = false;
      off();
    };
  }, []);
  return chats.list();
}

/** Deletes a chat, with Undo in the toast (it comes back in its place). */
export async function deleteChat(row, { onDeleted } = {}) {
  const chat = await chats.remove(row.id);
  onDeleted?.(row.id);
  toast(`Deleted the chat “${row.title}”`, chat ? { action: { label: 'Undo', run: () => chats.restore(chat) }, timeout: 8000 } : {});
}

/**
 * `here`: { key, group } of what the panel is about now (the open file, its tab group);
 * `currentId`: the chat shown; `onOpen(row)`, `onDeleted(id)`. New chat is in the panel's head.
 */
export function ChatList({ here = {}, currentId = null, onOpen, onDeleted }) {
  const rows = useChats();
  const counts = filterCounts(rows, here);
  const [show, setShow] = useState(() => (here.key && counts.file ? 'file' : here.group?.id && counts.project ? 'project' : 'all'));
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState(null); // { id, title }
  const search = useRef(null);
  useLayoutEffect(() => search.current?.focus(), []);
  const filters = CHAT_FILTERS.filter((f) => (f.id === 'file' ? here.key : f.id === 'project' ? here.group?.id : true));
  const shown = filterChats(rows, { show, key: here.key, group: here.group, query });
  const rename = async () => {
    const { id, title } = renaming;
    setRenaming(null);
    await chats.rename(id, title);
  };
  const groupName = here.group?.name;

  return html`<div class="chat-list">
    <div class="chat-list-top">
      <div class="chat-filters" role="group" aria-label="Which chats">
        ${filters.map(
          (f) => html`<button type="button" key=${f.id} class=${`chip ${show === f.id ? 'on' : ''}`} aria-pressed=${show === f.id}
            title=${f.id === 'project' && groupName ? `The chats about ${groupName}` : f.id === 'saved' ? 'The chats you saved: kept for good' : ''} onClick=${() => setShow(f.id)}>
            ${f.id === 'project' && groupName ? groupName : f.label}<span class="chat-count">${counts[f.id]}</span>
          </button>`,
        )}
      </div>
      <div class="chat-search">
        <${Icon} name="search" size=${14} />
        <input ref=${search} value=${query} placeholder="Find a chat" aria-label="Find a chat" onInput=${(e) => setQuery(e.currentTarget.value)} />
        <${ClearButton} value=${query} onClear=${() => setQuery('')} />
      </div>
    </div>
    ${!shown.length &&
    html`<p class="muted small chat-empty">${query ? 'No chat has those words.' : show === 'saved' ? 'No saved chats yet: ☆ saves one for good.' : show === 'file' ? 'No chats about this file yet.' : show === 'project' ? 'No chats in this project yet.' : 'No chats yet. They are kept on this device as you ask.'}</p>`}
    <ul class="chat-rows">
      ${shown.map((r) => {
        const kind = CHAT_KINDS[r.kind] ?? CHAT_KINDS.ask;
        const place = linkLabel(r.link);
        return html`<li key=${r.id} class=${`chat-row ${r.id === currentId ? 'current' : ''}`}>
          ${renaming?.id === r.id
            ? html`<${RenameField} value=${renaming.title} onInput=${(title) => setRenaming({ ...renaming, title })} onDone=${rename} onCancel=${() => setRenaming(null)} />`
            : html`<button type="button" class="chat-open" title=${`${kind.hint}${place ? ` · ${place}` : ''}`} onClick=${() => onOpen(r)}>
                <span class="chat-kind"><${Icon} name=${kind.icon} size=${14} /></span>
                <span class="chat-main">
                  <span class="chat-title">${r.title}</span>
                  <span class="chat-meta">
                    ${place && html`<span class="chat-place">${r.link?.group?.color ? html`<span class="view-dot" style=${{ '--gc': r.link.group.color }} />` : ''}${place}</span>`}
                    <span class="chat-when">${shortAgo(r.updatedAt)}</span>
                  </span>
                  ${r.preview && html`<span class="chat-preview">${r.preview}</span>`}
                </span>
              </button>
              <span class="chat-tools">
                <button type="button" class=${`icon-btn xs chat-star ${r.saved ? 'on' : ''}`} aria-pressed=${r.saved} aria-label=${r.saved ? 'Saved: kept for good (click to unsave)' : 'Save it: kept for good'} title=${r.saved ? 'Saved: kept for good' : 'Save: kept for good (the others go after the newest 500)'}
                  onClick=${() => chats.setSaved(r.id, !r.saved)}><${Icon} name="star" size=${14} /></button>
                <button type="button" class="icon-btn xs" aria-label="Rename" title="Rename" onClick=${() => setRenaming({ id: r.id, title: r.title })}><${Icon} name="edit" size=${14} /></button>
                <button type="button" class="icon-btn xs" aria-label="Delete" title="Delete (Undo in the message)" onClick=${() => deleteChat(r, { onDeleted })}><${Icon} name="trash" size=${14} /></button>
              </span>`}
        </li>`;
      })}
    </ul>
    <p class="muted small chat-foot">Kept on this device only, never synced.</p>
  </div>`;
}

/** A chat's name being changed: Enter keeps it, Escape leaves it as it was. */
function RenameField({ value, onInput, onDone, onCancel }) {
  const input = useRef(null);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return html`<form class="chat-rename" onSubmit=${(e) => (e.preventDefault(), value.trim() && onDone())}>
    <input ref=${input} value=${value} aria-label="The chat’s name" onInput=${(e) => onInput(e.currentTarget.value)}
      onKeyDown=${(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), onCancel())} />
    <button type="submit" class="btn sm primary" disabled=${!value.trim()}>Rename</button>
  </form>`;
}

/** The head's buttons for a chat: ☆ (saved) when there is one, the list, New chat. */
export function ChatButtons({ chatId, saved = false, listOpen = false, busy = false, onToggleList, onNew }) {
  return html`${chatId &&
    html`<button type="button" class=${`icon-btn sm chat-star ${saved ? 'on' : ''}`} aria-pressed=${saved} aria-label=${saved ? 'Saved: kept for good (click to unsave)' : 'Save this chat: kept for good'}
      title=${saved ? 'Saved: kept for good' : 'Save this chat: kept for good (others go after the newest 500)'} onClick=${() => chats.setSaved(chatId, !saved)}><${Icon} name="star" size=${15} /></button>`}
    <button type="button" class=${`icon-btn sm ${listOpen ? 'on' : ''}`} aria-pressed=${listOpen} aria-label="Chats" title="Chats: this file’s, this project’s, all of them" onClick=${onToggleList}><${Icon} name="history" size=${15} /></button>
    ${chatId && html`<button type="button" class="btn ghost sm chat-new-btn" disabled=${busy} title="A new chat (this one stays in Chats)" onClick=${onNew}><${Icon} name="plus" size=${14} /><span class="label">New chat</span></button>`}`;
}

/** The line at the top of a chat taken up again: when it began, and what it is about. */
export function KeptNote({ chat }) {
  if (!chat?.createdAt) return null;
  const place = linkLabel(chat.link);
  const when = new Date(chat.createdAt);
  const day = Number.isNaN(when.getTime()) ? '' : when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return html`<p class="muted small chat-kept"><${Icon} name="history" size=${13} /><span>A chat kept from ${day}${place ? ` · ${place}` : ''}</span></p>`;
}
