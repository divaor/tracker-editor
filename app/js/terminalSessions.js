// The terminals to open again (pure): the last session (the terminals open when the app last
// went away: settings `terminalLast`) and the recent ones (every terminal opened, newest first:
// settings `terminalRecent`). An entry is { connId ('local' or a server's id), cwd (the folder
// it was in last), shell (this computer's shell profile, '' = the usual one), name (its own
// name, '' = none), keep (a server's: its tmux session's name, when it is kept there) }. Terminals
// kept for running files, tests and tasks are left out.
// Below: Terminals tabs (0.54), sessions in a tab of their own brought back as they were, and the
// sessions saved by name (settings `terminalSessions`).
import { loginCommand } from './sshCommand.js';

/** At most this many recent terminals are kept, and this many in a session. */
export const MAX_RECENT = 12;
export const MAX_SESSION = 8;

const text = (v, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One entry as kept (anything else dropped); null when it names no place. */
export function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const connId = text(e.connId, 100);
  if (!connId) return null;
  const keep = connId !== 'local' && /^te-[a-z0-9]{4,24}$/.test(e.keep ?? '') ? e.keep : '';
  return { connId, cwd: text(e.cwd), shell: connId === 'local' ? text(e.shell, 100) : '', name: text(e.name, 60).trim(), ...(keep ? { keep } : {}) };
}

/** Where an entry is, as one string (its shell counts on this computer). */
export const entryKey = (e) => (e.keep ? `${e.connId}\u0000tmux\u0000${e.keep}` : `${e.connId}\u0000${e.cwd}\u0000${e.connId === 'local' ? e.shell : ''}`);

/** A list of entries kept: clean, once each (the first wins), at most `max`. */
export function cleanEntries(list, max = MAX_RECENT) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const e = cleanEntry(raw);
    if (!e || seen.has(entryKey(e))) continue;
    seen.add(entryKey(e));
    out.push(e);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A terminal session (terminals.js) as an entry: where it is now (the folder the shell says,
 * else the one it opened in), its shell and name; null for one kept for running things.
 */
export function entryOf(s) {
  if (!s || s.runner || s.task) return null;
  const shell = s.connId === 'local' ? s.profile || s.shellId || '' : '';
  return cleanEntry({ connId: s.connId, cwd: s.cwdNow || s.cwd || '', shell, name: s.name || '', keep: s.keep || '' });
}

/** The terminals open now, as a session to keep (in the tabs' order). */
export const sessionOf = (sessions) => cleanEntries((sessions ?? []).map(entryOf), MAX_SESSION);

/**
 * The recent list with `entries` first (newest first, once each); `drop`: where those terminals
 * were before (a shell that changed folder takes its old place's line, not a line more per cd).
 */
export function withRecent(recent, entries, { drop = [] } = {}) {
  const now = new Set(cleanEntries(entries, Infinity).map(entryKey));
  const gone = new Set(cleanEntries(drop, Infinity).map(entryKey).filter((k) => !now.has(k)));
  return cleanEntries([...(entries ?? []), ...cleanEntries(recent, Infinity).filter((e) => !gone.has(entryKey(e)))], MAX_RECENT);
}

/**
 * What can be opened again: the entries not open now (`open`: sessions or entries) and whose
 * place still exists (`hasPlace(connId)`: this computer, or a server with a shell).
 */
export function notOpen(entries, open, hasPlace = () => true) {
  const now = new Set((open ?? []).map((o) => (o && 'term' in o ? entryOf(o) : cleanEntry(o))).filter(Boolean).map(entryKey));
  return cleanEntries(entries, Infinity).filter((e) => !now.has(entryKey(e)) && hasPlace(e.connId));
}

/** The last folder of a path ("/var/www/site" → "site"; "C:\\proj" → "proj"; "/" stays). */
export function folderName(path) {
  const p = String(path ?? '').replace(/[\\/]+$/, '');
  if (!p) return String(path ?? '') || '';
  const name = p.split(/[\\/]/).pop();
  return name || p;
}

/**
 * How an entry reads in a menu: { label (its name, else the folder's), where ("This computer",
 * a server's name), detail (the whole folder, and the shell's label when not the usual one) }.
 */
export function entryLabel(e, { serverName = (id) => id, shellLabel = () => '' } = {}) {
  const where = e.connId === 'local' ? 'This computer' : serverName(e.connId) || e.connId;
  const folder = folderName(e.cwd) || (e.connId === 'local' ? 'home folder' : 'start folder');
  const shell = e.connId === 'local' && e.shell ? shellLabel(e.shell) : '';
  return { label: e.name || folder, where, detail: [e.cwd || (e.connId === 'local' ? 'Home folder' : 'Start folder'), shell].filter(Boolean).join(' · ') };
}

/** "3 terminals: web-1, api, This computer" — the session in a line. */
export function sessionSummary(entries, opts) {
  const names = entries.map((e) => entryLabel(e, opts).label);
  const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : '');
  return `${entries.length} terminal${entries.length === 1 ? '' : 's'}: ${shown}`;
}

// ---- Terminals tabs: a session in a tab of its own, brought back as it was ----
// A Terminals tab is a comparison tab of mode 'terminals' (store's c:<id>, as Git history is):
// { mode: 'terminals', name, terminals, layout: { order, active, split } (terminalTabs.js's state,
// by the terminals' ids), runAgain (logins run again by themselves when it opens), savedId (the
// saved session it was opened from or saved as) }. Each terminal is an entry plus `id` (its key in
// the tab, and its kept output's), `kind` (its shell's: 'posix', 'powershell', 'cmd', 'wsl'),
// `running` (the login it was running when last seen, as its shell said: only ssh, mosh, et and
// telnet lines are kept, sshCommand.js) and `tmux` (it ran in tmux on its server: it attaches again).
// Its output (the last lines, with their colors) is kept apart, in kv (terminalsTabs.js), never
// in the record nor in a saved session.

export const MAX_TAB_TERMINALS = 12;
export const MAX_SAVED_SESSIONS = 30;
/** The output kept per terminal: at most this many lines past the screen, and this many characters. */
export const MAX_OUTPUT_LINES = 1000;
export const MAX_OUTPUT_CHARS = 400_000;
const TERM_ID = /^t[a-z0-9]{1,32}$/;
const SHELL_KINDS = ['posix', 'powershell', 'cmd', 'wsl'];
const parseKind = (kind) => (kind === 'powershell' || kind === 'cmd' ? kind : 'posix');

/** A command line worth keeping: a login to another machine (sshCommand.js) as the shell `kind` reads it; else ''. */
export function keptLogin(line, kind = 'posix') {
  const l = text(line, 2000).trim();
  return l && loginCommand(l, { kind: parseKind(kind) }) ? l : '';
}

/** One terminal of a Terminals tab as kept; null when it names no place or has no id. */
export function cleanTabTerminal(t) {
  const e = cleanEntry(t);
  if (!e || typeof t.id !== 'string' || !TERM_ID.test(t.id)) return null;
  const kind = SHELL_KINDS.includes(t.kind) ? t.kind : '';
  const running = keptLogin(t.running, kind);
  return { id: t.id, ...e, ...(kind ? { kind } : {}), ...(running ? { running } : {}), ...(t.tmux && e.keep ? { tmux: true } : {}) };
}

function cleanTabTerminals(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = cleanTabTerminal(raw);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= MAX_TAB_TERMINALS) break;
  }
  return out;
}

/**
 * A tab's layout (terminalTabs.js's state) for the terminals `ids`: every one once in `order`
 * (unknown ones dropped, missing ones at the end), `active` one of them (shown: on a side when
 * split), `split` two different ones or null.
 */
export function cleanLayout(layout, ids) {
  const known = new Set(ids);
  const listed = [...new Set((Array.isArray(layout?.order) ? layout.order : []).filter((k) => known.has(k)))];
  const order = [...listed, ...ids.filter((k) => !listed.includes(k))];
  const s = layout?.split;
  const split = s && known.has(s.left) && known.has(s.right) && s.left !== s.right ? { left: s.left, right: s.right } : null;
  let active = known.has(layout?.active) ? layout.active : (order[0] ?? null);
  if (split && active !== split.left && active !== split.right) active = split.left;
  return { order, active, split };
}

/** "Terminals", else "Terminals 2", 3… past the names taken. */
export function terminalsTabName(taken = []) {
  const names = new Set(taken.map((n) => String(n).toLowerCase()));
  if (!names.has('terminals')) return 'Terminals';
  for (let i = 2; ; i++) if (!names.has(`terminals ${i}`)) return `Terminals ${i}`;
}

/** A Terminals tab's record as kept (its own fields; others, such as the store's `from`, are the store's). */
export function cleanTabRecord(c) {
  if (!c || typeof c !== 'object' || c.mode !== 'terminals') return null;
  const terminals = cleanTabTerminals(c.terminals);
  const savedId = /^[\w-]{1,40}$/.test(c.savedId ?? '') ? c.savedId : '';
  return { mode: 'terminals', name: text(c.name, 60).trim() || 'Terminals', terminals, layout: cleanLayout(c.layout, terminals.map((t) => t.id)), runAgain: Boolean(c.runAgain), ...(savedId ? { savedId } : {}) };
}

/**
 * A live terminal (terminals.js) as a tab terminal: where it is now, its shell, name, tmux name,
 * and the login it runs (what its shell said, else the one it still offers to run again).
 */
export function tabTerminalOf(s) {
  if (!s) return null;
  const shell = s.connId === 'local' ? s.profile || s.shellId || '' : '';
  return cleanTabTerminal({ id: s.key, connId: s.connId, cwd: s.cwdNow || s.cwd || '', shell, name: s.name || '', keep: s.keep || '', kind: s.shell || '', running: s.running?.command || s.offer?.line || '', tmux: Boolean(s.tmux) });
}

/** What a tab's record takes from its terminals now (in their order) and its tabs' state: { terminals, layout }. */
export function tabRecordPatch(sessions, tabs) {
  const terminals = cleanTabTerminals((sessions ?? []).map(tabTerminalOf));
  return { terminals, layout: cleanLayout(tabs, terminals.map((t) => t.id)) };
}

/** Kept output as read back: { text, color, cols, rows, at }, or null. */
export function cleanOutput(o) {
  if (!o || typeof o.text !== 'string' || !o.text) return null;
  const size = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  return { text: o.text.slice(-Math.round(MAX_OUTPUT_CHARS * 1.25)), color: Boolean(o.color), cols: size(o.cols, 20, 500, 100), rows: size(o.rows, 5, 200, 24), at: Number.isFinite(o.at) ? o.at : 0 };
}

/**
 * How a Terminals tab comes back: { name, runAgain, layout, terminals, gone }. Each terminal is
 * its record plus `output` (its kept output, unless `keepOutput` is off or it attaches to tmux,
 * which shows its own), `offer` (the login it was running: loginCommand's, else null) and
 * `autoRun` (the session runs logins again by itself and this one may be: no command there,
 * nothing a shell would expand). `gone`: terminals whose place is gone (`hasPlace(connId)`).
 * `openKeeps`: tmux names open now elsewhere: those start a session of their own.
 */
export function restorePlan(record, { hasPlace = () => true, outputs = {}, keepOutput = true, openKeeps = [] } = {}) {
  const r = cleanTabRecord({ ...record, mode: 'terminals' });
  const terminals = [];
  const gone = [];
  for (const t of r.terminals) {
    if (!hasPlace(t.connId)) {
      gone.push(t);
      continue;
    }
    const offer = t.running && !t.tmux ? loginCommand(t.running, { kind: parseKind(t.kind) }) : null;
    const keep = t.keep && openKeeps.includes(t.keep) ? '' : (t.keep ?? '');
    terminals.push({ ...t, keep, output: keepOutput && !(t.tmux && keep) ? cleanOutput(outputs?.[t.id]) : null, offer, autoRun: Boolean(r.runAgain && offer?.runsAlone) });
  }
  return { name: r.name, runAgain: r.runAgain, layout: cleanLayout(r.layout, terminals.map((t) => t.id)), terminals, gone };
}

// ---- Sessions saved by name (settings `terminalSessions`): { id, name, terminals, layout, runAgain, savedAt } ----

/** One saved session as kept; null without a name or a terminal. */
export function cleanSavedSession(s) {
  if (!s || typeof s !== 'object' || !/^[\w-]{1,40}$/.test(s.id ?? '')) return null;
  const name = text(s.name, 60).trim();
  const terminals = cleanTabTerminals(s.terminals);
  if (!name || !terminals.length) return null;
  return { id: s.id, name, terminals, layout: cleanLayout(s.layout, terminals.map((t) => t.id)), runAgain: Boolean(s.runAgain), savedAt: Number.isFinite(s.savedAt) ? s.savedAt : 0 };
}

/** The saved sessions as kept: clean, once each by id and by name (the first wins), at most MAX_SAVED_SESSIONS. */
export function cleanSavedSessions(list) {
  const ids = new Set();
  const names = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = cleanSavedSession(raw);
    if (!s || ids.has(s.id) || names.has(s.name.toLowerCase())) continue;
    ids.add(s.id);
    names.add(s.name.toLowerCase());
    out.push(s);
    if (out.length >= MAX_SAVED_SESSIONS) break;
  }
  return out;
}

/** A Terminals tab's record saved as `name` (its terminals, layout and whether it runs logins again; never its output). */
export const savedSessionOf = (record, { id, name, at = Date.now() }) => cleanSavedSession({ ...cleanTabRecord({ ...record, mode: 'terminals' }), id, name, savedAt: at });

/** The list with `saved` first: it replaces the one with its id, or with its name. */
export function withSavedSession(list, saved) {
  const s = cleanSavedSession(saved);
  if (!s) return cleanSavedSessions(list);
  return cleanSavedSessions([s, ...cleanSavedSessions(list).filter((x) => x.id !== s.id && x.name.toLowerCase() !== s.name.toLowerCase())]);
}

/** A Terminals tab's record from a saved session: its terminals with ids of their own (`newId()`), the layout with them. */
export function recordOfSaved(saved, { newId }) {
  const s = cleanSavedSession(saved);
  if (!s) return null;
  const ids = new Map(s.terminals.map((t) => [t.id, newId()]));
  const map = (k) => ids.get(k) ?? null;
  const layout = { order: s.layout.order.map(map), active: map(s.layout.active), split: s.layout.split ? { left: map(s.layout.split.left), right: map(s.layout.split.right) } : null };
  return cleanTabRecord({ mode: 'terminals', name: s.name, terminals: s.terminals.map((t) => ({ ...t, id: ids.get(t.id) })), layout, runAgain: s.runAgain, savedId: s.id });
}
