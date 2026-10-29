// Language servers, the page's pure part: file paths as the URIs servers use, their problems
// as the editor's, the places they answer with, the edits of a rename, and their progress.
// Pure: the tests import it; lsp.js and app.js use it.

/**
 * A path as a file:// URI the way VS Code writes them (servers answer in that form):
 * /home/a b/x.ts → file:///home/a%20b/x.ts; C:\Users\x.ts → file:///c%3A/Users/x.ts;
 * \\server\share\x → file://server/share/x.
 */
export function fileUri(path) {
  const p = String(path);
  const unc = /^\\\\([^\\]+)\\(.*)$/.exec(p);
  if (unc) return `file://${unc[1].toLowerCase()}/${unc[2].split('\\').map(encodeURIComponent).join('/')}`;
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (drive) return `file:///${drive[1].toLowerCase()}%3A/${drive[2].split(/[\\/]/).map(encodeURIComponent).join('/')}`;
  return `file://${p.split('/').map(encodeURIComponent).join('/')}`;
}

/** A file:// URI back as a path (`windows`: with backslashes and a drive letter). Null for other schemes. */
export function uriPath(uri, { windows = false } = {}) {
  const m = /^file:\/\/([^/]*)(\/.*)$/i.exec(String(uri));
  if (!m) return null;
  const path = decodeURIComponent(m[2]);
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(path);
  if (drive) return `${drive[1].toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`;
  if (m[1] && m[1] !== 'localhost') return `\\\\${m[1]}${path.replace(/\//g, '\\')}`;
  return windows ? path.replace(/\//g, '\\') : path;
}

/** The same file whatever its spelling: drive letters and (on Windows) case do not count. */
export const pathKey = (path, { windows = /^[A-Za-z]:[\\/]|^\\\\/.test(String(path)) } = {}) => (windows ? String(path).replace(/\//g, '\\').toLowerCase() : String(path));

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };

/** LSP {line, character} → an offset in `text` (null when it is outside). */
export function offsetOf(text, { line, character }) {
  let offset = 0;
  for (let n = 0; n < line; n++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return null;
    offset = next + 1;
  }
  const end = text.indexOf('\n', offset);
  const length = (end < 0 ? text.length : end) - offset;
  return character < 0 || character > length + 1 ? null : offset + Math.min(character, length);
}

/**
 * A server's diagnostics as the editor's problems: { from, to, severity, message, source,
 * line, column } over `text` (the text now: lines that moved meanwhile are mended by the next
 * report). Hints (faded code, "never read") stay out of the list (`hint: true` keeps them).
 */
export function toProblems(diagnostics, text, { hints = false } = {}) {
  const out = [];
  for (const d of diagnostics ?? []) {
    const severity = SEVERITY[d.severity ?? 1] ?? 'error';
    if (severity === 'hint' && !hints) continue;
    const from = offsetOf(text, d.range.start);
    if (from == null) continue;
    const to = offsetOf(text, d.range.end) ?? from;
    const code = d.code != null && d.code !== '' ? ` (${typeof d.code === 'object' ? d.code.value : d.code})` : '';
    out.push({ from, to: Math.max(from, to), severity, message: `${d.message}${code}`, source: d.source ?? '', line: d.range.start.line + 1, column: d.range.start.character + 1 });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** A definition or references answer (Location, Location[], LocationLink[]) as [{ uri, range }]. */
export function locations(result) {
  const list = Array.isArray(result) ? result : result ? [result] : [];
  return list.map((l) => (l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : { uri: l.uri, range: l.range })).filter((l) => l.uri && l.range);
}

/** A WorkspaceEdit's text edits by file: [{ uri, edits: [{ range, newText }] }] (file creations and renames left out). */
export function editsByFile(edit) {
  const files = new Map();
  const add = (uri, edits) => files.set(uri, [...(files.get(uri) ?? []), ...edits]);
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) add(uri, edits);
  for (const change of edit?.documentChanges ?? []) if (change.textDocument && change.edits) add(change.textDocument.uri, change.edits);
  return [...files].map(([uri, edits]) => ({ uri, edits }));
}

/**
 * What a WorkspaceEdit asks for: { files: [{ uri, edits }] (only those with edits), creates:
 * [{ uri, overwrite, ignoreIfExists }], unsupported: ['rename' | 'delete'] }. The editor makes
 * new files but does not rename or delete them (it says so the client cannot).
 */
export function editPlan(edit) {
  const creates = [];
  const unsupported = new Set();
  for (const change of edit?.documentChanges ?? []) {
    if (change.kind === 'create') creates.push({ uri: change.uri, overwrite: Boolean(change.options?.overwrite), ignoreIfExists: Boolean(change.options?.ignoreIfExists) });
    else if (change.kind === 'rename' || change.kind === 'delete') unsupported.add(change.kind);
  }
  return { files: editsByFile(edit).filter((f) => f.edits.length), creates, unsupported: [...unsupported] };
}

/**
 * The lines an edit changes, for a preview: [{ line (1-based), before: [lines], after: [lines] }],
 * neighbouring edits on the same lines together. Null when an edit does not fit the text.
 */
export function changedLines(text, edits, { max = 200 } = {}) {
  const spans = textChanges(text, edits);
  if (!spans) return null;
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const lineAt = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineEnd = (n) => (n + 1 < lineStarts.length ? lineStarts[n + 1] - 1 : text.length);
  // Groups of spans that touch the same lines.
  const groups = [];
  for (const s of spans) {
    const first = lineAt(s.from);
    const last = lineAt(s.to);
    const g = groups.at(-1);
    if (g && first <= g.last) {
      g.last = Math.max(g.last, last);
      g.spans.push(s);
    } else groups.push({ first, last, spans: [s] });
  }
  return groups.slice(0, max).map((g) => {
    const from = lineStarts[g.first];
    const to = lineEnd(g.last);
    let after = '';
    let at = from;
    for (const s of g.spans) {
      after += text.slice(at, s.from) + s.insert;
      at = s.to;
    }
    after += text.slice(at, to);
    // Lines the same before and after (a change ending at a line start) are not shown.
    const was = text.slice(from, to).split('\n');
    const now = after.split('\n');
    let lead = 0;
    while (lead < was.length && lead < now.length && was[lead] === now[lead]) lead++;
    let tail = 0;
    while (tail < was.length - lead && tail < now.length - lead && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
    return { line: g.first + 1 + lead, before: was.slice(lead, was.length - tail), after: now.slice(lead, now.length - tail) };
  });
}

/** The initialize message with the project folder as the workspace folder (some servers want one). */
export function withWorkspaceFolder(message, name = '') {
  // (Text in a file sent along has its quotes escaped, so it never matches.)
  if (!message.includes('"method":"initialize"')) return message;
  try {
    const msg = JSON.parse(message);
    if (msg.method !== 'initialize' || !msg.params?.rootUri || msg.params.workspaceFolders) return message;
    msg.params.workspaceFolders = [{ uri: msg.params.rootUri, name: name || decodeURIComponent(msg.params.rootUri.split('/').filter(Boolean).pop() ?? '') }];
    return JSON.stringify(msg);
  } catch {
    return message;
  }
}

/** Two LSP ranges overlap (an empty one touching the other counts). */
const isBefore = (a, b) => a.line < b.line || (a.line === b.line && a.character < b.character);
export const rangesTouch = (a, b) => !isBefore(a.end, b.start) && !isBefore(b.end, a.start);

// Code actions by kind: quick fixes first, then refactorings, then the file's own (imports…).
const KIND_ORDER = ['quickfix', 'refactor', 'source'];
const KIND_LABELS = { quickfix: 'Quick fix', refactor: 'Refactor', source: 'Source' };
/**
 * A codeAction answer (CodeAction or Command items) as rows to pick from: { title, kind,
 * group, preferred, disabled (its reason), item } — the preferred first in each group.
 */
export function codeActionRows(result) {
  const rows = (result ?? []).filter(Boolean).map((item, i) => {
    const command = typeof item.command === 'string';
    const kind = command ? '' : String(item.kind ?? '');
    const top = kind.split('.')[0];
    return { title: item.title, kind, group: KIND_LABELS[top] ?? 'Other', preferred: Boolean(item.isPreferred), disabled: item.disabled?.reason ?? '', item, i, order: KIND_ORDER.includes(top) ? KIND_ORDER.indexOf(top) : KIND_ORDER.length };
  });
  rows.sort((a, b) => a.order - b.order || Boolean(a.disabled) - Boolean(b.disabled) || b.preferred - a.preferred || a.i - b.i);
  return rows.map(({ i, order, ...row }) => row);
}

export const SYMBOL_KINDS = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];
/**
 * A workspace/symbol answer as rows: [{ title, kind, container, uri, line, column }] (1-based;
 * a symbol without a range is at line 1).
 */
export function symbolRows(result) {
  return (result ?? [])
    .filter((s) => s?.name && s.location?.uri)
    .map((s) => {
      const start = s.location.range?.start ?? { line: 0, character: 0 };
      return { title: s.name, kind: SYMBOL_KINDS[s.kind] ?? '', container: s.containerName ?? '', uri: s.location.uri, line: start.line + 1, column: start.character + 1 };
    });
}

/**
 * LSP text edits as CodeMirror changes over `text` ([{ from, to, insert }], in order). Null
 * when one does not fit the text or two overlap.
 */
export function textChanges(text, edits) {
  const spans = [];
  for (const e of edits) {
    const from = offsetOf(text, e.range.start);
    const to = offsetOf(text, e.range.end);
    if (from == null || to == null || to < from) return null;
    spans.push({ from, to, insert: e.newText });
  }
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < spans.length; i++) if (spans[i].from < spans[i - 1].to) return null;
  return spans;
}

/** `text` with LSP text edits applied (all ranges against the text as given). Null when one does not fit. */
export function applyTextEdits(text, edits) {
  const spans = textChanges(text, edits);
  if (!spans) return null;
  let out = text;
  for (const s of [...spans].reverse()) out = out.slice(0, s.from) + s.insert + out.slice(s.to);
  return out;
}

/** Line `n` (0-based) of a text. */
export const lineOf = (text, n) => String(text).split('\n')[n] ?? '';

/** What a server is busy with ($/progress begin/report): "Indexing 40%", or ''. */
export function progressText(tasks) {
  const busy = [...(tasks?.values?.() ?? [])].at(-1);
  if (!busy) return '';
  const pct = Number.isFinite(busy.percentage) ? ` ${Math.round(busy.percentage)}%` : '';
  return `${busy.title || busy.message || 'Working'}${pct}`;
}

/** The status bar's words for a server: "TypeScript 7.0.2 · ready", "Pyright on Box · Indexing 40%". */
export function serverLabel({ server, state, progress = '', where = null }) {
  const what = state === 'running' ? progress || 'ready' : state === 'starting' ? 'starting…' : state === 'restarting' ? 'restarting…' : state === 'stopped' ? 'stopped' : state;
  return `${server}${where?.kind === 'remote' ? ` on ${where.name}` : ''} · ${what}`;
}

/** Where a server runs, in words: "on this computer", "on Box" (an SSH server), or for a synced file alone. */
export function whereLabel(where) {
  if (where?.kind === 'remote') return `on ${where.name}`;
  if (where?.kind === 'notes') return 'on this computer, for single files';
  return 'on this computer';
}
