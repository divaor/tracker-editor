// Chats with the model, kept on this device (never synced): the model panel (the bubble, Ctrl+K),
// Files with the model, Git with the model and Ask about my files keep their conversations here,
// each linked to what it is about (a file, the project or folder group it is in), so closing a
// panel loses nothing and a chat can be taken up again later, from its file, its project or the
// list of them all. Pure: chatStore.js keeps them (kv), the panels make and read their `state`.
import { isWithin } from './folders.js';
import { foldSearch } from './tracker-model.js';

/** What each panel's chats are called, with their icon. */
export const CHAT_KINDS = {
  ask: { label: 'Model', icon: 'sparkle', hint: 'The model panel (the bubble, Ctrl+K)' },
  files: { label: 'Files', icon: 'filePlus', hint: 'Files with the model' },
  git: { label: 'Git', icon: 'branch', hint: 'Git with the model' },
  library: { label: 'My files', icon: 'search', hint: 'Ask about my files' },
};
/** The newest this many are kept; saved ones always, whatever their number. */
export const MAX_CHATS = 500;
/** A chat's stored size (its texts, in characters): older messages are shortened past it. */
export const MAX_CHAT_CHARS = 1_500_000;
export const TITLE_CHARS = 80;
const PREVIEW_CHARS = 140;
/** What a cut part keeps of its start. */
const CUT_KEEP = 1500;

/** The filters of the list: this file, this project (its tab group), all, the saved ones. */
export const CHAT_FILTERS = [
  { id: 'file', label: 'This file' },
  { id: 'project', label: 'This project' },
  { id: 'all', label: 'All' },
  { id: 'saved', label: 'Saved' },
];

export const newChatId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * A chat's title from its first question: the question itself, or an action's name with the
 * file it was about ("Explain · app.js").
 */
export function chatTitle(question, { name = '', action = false } = {}) {
  const q = oneLine(question);
  if (!q) return name ? `About ${name}` : 'New chat';
  return clip(action && name ? `${q} · ${name}` : q, TITLE_CHARS);
}

/** The last answer's first words, for the list. */
export function chatPreview(text) {
  const plain = oneLine(String(text ?? '').replace(/```[\s\S]*?(```|$)/g, ' [code] ').replace(/[#*_>`|]/g, ' '));
  return clip(plain, PREVIEW_CHARS);
}

/** A chat's row in the index (no `state`): what the list shows and filters on. */
export function chatRow(chat) {
  return {
    id: chat.id,
    kind: chat.kind,
    title: chat.title || 'New chat',
    named: Boolean(chat.named),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    saved: Boolean(chat.saved),
    link: chat.link ?? null,
    turns: chat.turns ?? 0,
    preview: chat.preview ?? '',
  };
}

const newestFirst = (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));

/** The index with `row` in it (replacing its old one), newest first. */
export function withRow(index, row) {
  return [row, ...(index ?? []).filter((r) => r.id !== row.id)].sort(newestFirst);
}

/**
 * The index cut to `max` chats: saved ones always stay, then the newest others. `dropped` are
 * the ids that went (their records are deleted too).
 */
export function pruneIndex(index, max = MAX_CHATS) {
  const sorted = [...(index ?? [])].sort(newestFirst);
  let room = Math.max(0, max - sorted.filter((r) => r.saved).length);
  const keep = [];
  const dropped = [];
  for (const r of sorted) {
    if (r.saved) keep.push(r);
    else if (room > 0) {
      keep.push(r);
      room -= 1;
    } else dropped.push(r.id);
  }
  return { index: keep, dropped };
}

/**
 * Whether a chat's link is in a tab group (`group`: { id, folder?, project? }): the same group,
 * a folder inside the group's folder, or a file of the group's project.
 */
export function inGroup(link, group) {
  if (!link || !group?.id) return false;
  if (link.group?.id && link.group.id === group.id) return true;
  // A folder group's folder, or the folders linked to a project.
  const folders = [group.folder, ...(group.folders ?? [])].filter(Boolean);
  if (link.folder && folders.some((f) => isWithin(link.folder, f))) return true;
  if (group.project && link.project && foldSearch(link.project) === foldSearch(group.project)) return true;
  return false;
}

/**
 * The rows the list shows: `show` 'file' (chats about `key`), 'project' (in `group`), 'all',
 * 'saved'; `query`: words found in the title, the last answer, the file and the project.
 */
export function filterChats(index, { show = 'all', key = null, group = null, query = '', kind = null } = {}) {
  const words = foldSearch(query).split(' ').filter(Boolean);
  return (index ?? []).filter((r) => {
    if (kind && r.kind !== kind) return false;
    if (show === 'file' && (!key || r.link?.key !== key)) return false;
    if (show === 'project' && !inGroup(r.link, group)) return false;
    if (show === 'saved' && !r.saved) return false;
    if (!words.length) return true;
    const hay = foldSearch([r.title, r.preview, r.link?.name, r.link?.group?.name, r.link?.folder, r.link?.project].filter(Boolean).join(' '));
    return words.every((w) => hay.includes(w));
  });
}

/** How many rows each filter has (the chips' numbers). */
export function filterCounts(index, { key = null, group = null } = {}) {
  return Object.fromEntries(CHAT_FILTERS.map((f) => [f.id, filterChats(index, { show: f.id, key, group }).length]));
}

/**
 * The chat a panel takes up again when it opens: the one shown last for this tab or target
 * (`current`, while it is still kept; null when New chat was asked for), else the newest of
 * `kind` about it (`key` a tab, `folder` a folder or repository).
 */
export function chatToResume(index, { kind, key = null, folder = null, current } = {}) {
  if (current === null) return null;
  if (current && (index ?? []).some((r) => r.id === current && r.kind === kind)) return current;
  const about = (r) => r.kind === kind && ((key && r.link?.key === key) || (!key && folder && r.link?.folder === folder));
  return [...(index ?? [])].sort(newestFirst).find(about)?.id ?? null;
}

/** What a chat is about, in a few words: "app.js · shop", a folder's name, "the editor". */
export function linkLabel(link) {
  if (!link) return '';
  if (link.help) return 'the editor';
  const place = link.group?.name ?? '';
  const name = link.name || (link.folder ? baseName(link.folder) : '');
  if (name && place && place !== name) return `${name} · ${place}`;
  return name || place;
}
const baseName = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p);

/**
 * The turns of a long chat that go to the model again with a follow-up: the first (it answers
 * about the text the chat began with) and the latest that fit in `budget` characters with it.
 * `left` is how many in the middle stayed out.
 */
export function fitTurns(turns, budget) {
  const size = (t) => String(t.question ?? '').length + String(t.answer ?? '').length;
  if (turns.length <= 2 || turns.reduce((n, t) => n + size(t), 0) <= budget) return { turns, left: 0 };
  let room = budget - size(turns[0]);
  const tail = [];
  for (let i = turns.length - 1; i > 0; i--) {
    // The newest always goes, whatever its size.
    if (tail.length && size(turns[i]) > room) break;
    tail.unshift(turns[i]);
    room -= size(turns[i]);
  }
  return { turns: [turns[0], ...tail], left: turns.length - 1 - tail.length };
}

/** A note in place of the turns a long chat left out. */
export const leftOutNote = (n) => `[${n} earlier ${n === 1 ? 'exchange' : 'exchanges'} of this chat left out here, for length]`;

/**
 * The model's messages of a long chat ({ role, content }) within `budget` characters: the
 * oldest are shortened first (their start kept), the newest `keepLast` never.
 */
export function fitMessages(messages, budget, { keepLast = 4 } = {}) {
  const out = (messages ?? []).map((m) => ({ ...m }));
  let total = out.reduce((n, m) => n + String(m.content ?? '').length, 0);
  for (let i = 0; i < out.length - keepLast && total > budget; i++) {
    const text = String(out[i].content ?? '');
    if (text.length <= CUT_KEEP + 200) continue;
    const cut = `${text.slice(0, CUT_KEEP)}\n[… ${text.length - CUT_KEEP} characters of an earlier part of this chat left out]`;
    total -= text.length - cut.length;
    out[i].content = cut;
  }
  return out;
}

/** How much of a chat goes again with a follow-up, by where the model runs (a model on this computer has a small context). */
export const historyBudget = (connection) => (connection === 'local' ? 24_000 : connection === 'async' ? 80_000 : 240_000);

/** A chat's size as stored (its texts). */
export const chatChars = (chat) => JSON.stringify(chat ?? null).length;

/**
 * A chat small enough to keep: its model messages shortened (oldest first), then the text it
 * was about cut, while it is over `max` characters.
 */
export function shrinkChat(chat, max = MAX_CHAT_CHARS) {
  if (chatChars(chat) <= max) return chat;
  const state = { ...(chat.state ?? {}) };
  if (Array.isArray(state.history)) state.history = fitMessages(state.history, Math.floor(max / 2), { keepLast: 2 });
  let next = { ...chat, state };
  if (chatChars(next) > max && state.conv?.context?.text) {
    const text = state.conv.context.text;
    next = { ...next, state: { ...state, conv: { ...state.conv, context: { ...state.conv.context, text: `${text.slice(0, 20_000)}\n[… cut when kept]` } } } };
  }
  return next;
}

/**
 * Cards of steps (Files and Git with the model) as they show in a chat taken up again: what was
 * waiting or running did not happen ('stopped'); Undo is gone with the session that could do it.
 */
export function settledSteps(parts) {
  const open = new Set(['waiting', 'pending', 'running', 'preparing']);
  return (parts ?? []).map((p) => (p?.steps ? { steps: p.steps.map((s) => ({ ...s, status: open.has(s.status) ? 'stopped' : s.status, undo: null, many: 0 })) } : p));
}

/** The text a chat was about, as kept: within `max` characters (the model never got more of it). */
export function keptContext(context, max = 20_000) {
  if (!context) return null;
  const { key = null, from = 0, to = 0, text = '', whole = false, name = '', language = '', label, help, file, errorText, fixTarget, symbols } = context;
  return {
    key,
    from,
    to,
    text: text.length > max ? `${text.slice(0, max)}\n[… cut when kept]` : text,
    whole,
    name,
    language,
    ...(label ? { label } : {}),
    ...(help ? { help: true } : {}),
    ...(file ? { file: { name: file.name ?? '', language: file.language ?? '' } } : {}),
    ...(errorText ? { errorText: String(errorText).slice(0, 8000) } : {}),
    ...(fixTarget ? { fixTarget } : {}),
    ...(symbols ? { symbols } : {}),
  };
}

/** An action as a chat keeps it (what asking again needs, nothing else). */
export function keptAction(action) {
  if (!action) return null;
  const { id = 'custom', label = '', kind = 'answer', prompt = '', auto, trouble, value, group, icon } = action;
  return { id, label, kind, prompt, ...(auto ? { auto } : {}), ...(trouble ? { trouble } : {}), ...(value ? { value } : {}), ...(group ? { group } : {}), ...(icon ? { icon } : {}) };
}
