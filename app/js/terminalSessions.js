// The terminals to open again (pure): the last session (the terminals open when the app last
// went away: settings `terminalLast`) and the recent ones (every terminal opened, newest first:
// settings `terminalRecent`). An entry is { connId ('local' or a server's id), cwd (the folder
// it was in last), shell (this computer's shell profile, '' = the usual one), name (its own
// name, '' = none) }. Terminals kept for running files, tests and tasks are left out.

/** At most this many recent terminals are kept, and this many in a session. */
export const MAX_RECENT = 12;
export const MAX_SESSION = 8;

const text = (v, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** One entry as kept (anything else dropped); null when it names no place. */
export function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const connId = text(e.connId, 100);
  if (!connId) return null;
  return { connId, cwd: text(e.cwd), shell: connId === 'local' ? text(e.shell, 100) : '', name: text(e.name, 60).trim() };
}

/** Where an entry is, as one string (its shell counts on this computer). */
export const entryKey = (e) => `${e.connId}\u0000${e.cwd}\u0000${e.connId === 'local' ? e.shell : ''}`;

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
  return cleanEntry({ connId: s.connId, cwd: s.cwdNow || s.cwd || '', shell, name: s.name || '' });
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
