// Line endings (0.53): what a new file gets (the system of the place it is in, unless the setting
// says, the kind of file needs one, or an .editorconfig names one), what a file on disk has
// (diskFiles.cjs / textBytes.js count them: LF, CRLF, a lone CR, or mixed), converting a tab, and
// keeping each line's own ending in a file that mixes them. Pure: the tests and the main process
// (Save a copy) import it.
import { diffBlocks } from './gitStatus.js';

export const EOLS = ['crlf', 'lf', 'cr'];
/** Settings `lineEndings`: 'auto' (the place's system), or one for every new file. */
export const EOL_SETTINGS = ['auto', 'crlf', 'lf'];
export const EOL_NAMES = { crlf: 'Windows (CRLF)', lf: 'Unix (LF)', cr: 'Classic Mac (CR)' };
export const EOL_SHORT = { crlf: 'CRLF', lf: 'LF', cr: 'CR', mixed: 'Mixed' };
export const EOL_HINTS = {
  crlf: 'Notepad and Windows programs, .bat and .cmd scripts, Windows servers',
  lf: 'Linux and macOS, Git repositories, shell scripts, web and Docker servers',
  cr: 'Mac OS 9 and older; rarely wanted now',
};
// A break as diskFiles.cjs's letters: 'C' CRLF, 'L' LF, 'R' a lone CR.
export const EOL_LETTER = { crlf: 'C', lf: 'L', cr: 'R' };
const EOL_OF_LETTER = { C: 'crlf', L: 'lf', R: 'cr' };

// Kinds of files whose endings are fixed wherever they are (what Git users put in .gitattributes):
// cmd.exe misreads batch files with LF (labels, GOTO and long lines go wrong), and a script run on
// Linux or macOS with CRLF fails ("bad interpreter: ^M", "$'\r': command not found").
export const CRLF_EXTS = ['bat', 'cmd', 'btm'];
export const LF_EXTS = ['sh', 'bash', 'zsh', 'ksh', 'fish'];

const extOf = (name) => /\.([^.\\/]+)$/.exec(String(name ?? ''))?.[1]?.toLowerCase() ?? '';
const baseName = (p) => String(p ?? '').split(/[\\/]/).pop();

/** 'crlf' or 'lf' when the kind of file needs it (its extension, or a "#!" first line: a script), else null. */
export function kindEol(name, text = '') {
  const ext = extOf(baseName(name));
  if (CRLF_EXTS.includes(ext)) return 'crlf';
  if (LF_EXTS.includes(ext) || String(text ?? '').startsWith('#!')) return 'lf';
  return null;
}

/**
 * The system a file's place runs: 'windows' or 'unix'. A server's file: Windows when its path is
 * /C:/… (an SFTP Windows server) or the server said so when it last connected (`conn.system`:
 * SFTP's home, FTP's SYST); Docker containers and WSL are Linux. Content:// files are the Android
 * phone's. This computer's: `platform` (the desktop app's process.platform, 'android' for the
 * phone's app); the web app has none, so `browserWindows` (the browser says it runs on Windows).
 */
export function systemOf(path, { platform = '', conn = null, browserWindows = false } = {}) {
  const p = String(path ?? '');
  if (p.startsWith('content://')) return 'unix';
  if (p.startsWith('remote://')) {
    const rest = p.slice('remote://'.length);
    const at = rest.indexOf('/');
    if (/^\/[A-Za-z]:/.test(at === -1 ? '' : rest.slice(at))) return 'windows';
    if (conn?.protocol === 'docker' || conn?.protocol === 'wsl') return 'unix';
    return conn?.system === 'windows' ? 'windows' : 'unix';
  }
  if (platform) return platform === 'win32' ? 'windows' : 'unix';
  return browserWindows ? 'windows' : 'unix';
}

/** The endings the setting gives a place: 'crlf' or 'lf' as set, or its system's ('auto'). */
export const placeEol = (setting, system) => (setting === 'crlf' || setting === 'lf' ? setting : system === 'windows' ? 'crlf' : 'lf');

/**
 * The line endings for a new text file named `name`: { eol, why }. An .editorconfig's
 * end_of_line for it wins (why 'editorconfig'), then the kind's rule ('kind': .bat CRLF, shell
 * scripts LF), then the setting ('setting') or, with 'auto', the system of its place ('system').
 */
export function newFileEol({ name = '', text = '', setting = 'auto', system = 'unix', editorconfig = null } = {}) {
  if (EOLS.includes(editorconfig)) return { eol: editorconfig, why: 'editorconfig' };
  const kind = kindEol(name, text);
  if (kind) return { eol: kind, why: 'kind' };
  if (setting === 'crlf' || setting === 'lf') return { eol: setting, why: 'setting' };
  return { eol: system === 'windows' ? 'crlf' : 'lf', why: 'system' };
}

// ---- A file on disk as a tab (store.js's disk tabs) ----
// eol: the endings Save gives its lines (a mixed file's: the most common, for lines added);
// fileEol: what the file holds as last read or saved ('mixed' for more than one kind); breaks: how
// many line breaks it had (0: none yet, so the place's endings); mixed ({ crlf, lf, cr }), eols (a
// letter per break) and eolBase (its text as read): a mixed file's, to keep each line's own;
// eolChoice 'keep': asked once, it keeps them; eolChosen: converted by hand (Save writes `eol`, over
// an .editorconfig too); ecEol: the .editorconfig's end_of_line for it.

/** What the file holds: 'lf', 'crlf', 'cr' or 'mixed' (tabs kept by older versions: their `eol`). */
export const fileEolOf = (tab) => tab?.fileEol ?? tab?.eol ?? 'lf';

/**
 * A read file's line endings as a tab's fields. `fallback`: the place's endings, for a file with
 * no line break yet (its first lines get those).
 */
export function eolFields(info, fallback = 'lf') {
  const none = info?.breaks === 0;
  const eol = none && EOLS.includes(fallback) ? fallback : EOLS.includes(info?.eol) ? info.eol : 'lf';
  const mixed = Boolean(info?.mixed);
  const keep = mixed && typeof info.eols === 'string';
  return {
    eol,
    fileEol: mixed ? 'mixed' : eol,
    breaks: info?.breaks,
    mixed: mixed ? info.mixed : undefined,
    eols: keep ? info.eols : undefined,
    eolBase: keep ? info.text : undefined,
    eolChoice: undefined,
    eolChosen: undefined,
  };
}

/** Whether Save changes the file's endings because they were converted here (the tab is then unsaved). */
export const endingsChanged = (tab) => Boolean(tab?.eolChosen) && tab.eol !== fileEolOf(tab);

/**
 * What Save does with the endings: { eol, why } (why: 'chosen' converted by hand, 'editorconfig',
 * 'keep' a mixed file's lines each keep theirs, or null: as the file has them), or null while a
 * mixed file's are undecided (Save asks first).
 */
export function saveTarget(tab) {
  if (tab.eolChosen) return { eol: tab.eol, why: 'chosen' };
  if (EOLS.includes(tab.ecEol)) return { eol: tab.ecEol, why: 'editorconfig' };
  if (fileEolOf(tab) === 'mixed' && typeof tab.eols === 'string') return tab.eolChoice === 'keep' ? { eol: tab.eol, why: 'keep' } : null;
  return { eol: tab.eol, why: null };
}

/** Whether the tab is a mixed file whose endings nobody chose yet (Save asks first). */
export const eolUndecided = (tab) => saveTarget(tab) === null;

/** The endings Save writes: saveTarget's, with `eols` (a letter per break) when a mixed file keeps each line's own; null: undecided. */
export function saveEndings(tab) {
  const target = saveTarget(tab);
  if (target?.why !== 'keep') return target;
  return { ...target, eols: keepEols(tab.eolBase ?? tab.text, tab.eols, tab.text, tab.eol) };
}

/** A tab's fields after a save with `ends` (saveEndings'): the file holds those now. */
export function savedEolFields(text, ends) {
  const uniform = ends.eols ? uniformEol(ends.eols) : ends.eol;
  const breaks = (String(text).match(/\n/g) ?? []).length;
  if (uniform || !breaks) return { eol: uniform ?? ends.eol, fileEol: uniform ?? ends.eol, breaks, mixed: undefined, eols: undefined, eolBase: undefined, eolChoice: undefined, eolChosen: undefined };
  return { eol: ends.eol, fileEol: 'mixed', breaks, mixed: countLetters(ends.eols), eols: ends.eols, eolBase: text, eolChosen: undefined };
}

/**
 * How to write `text` to a file read as `info` (disk.read's, not open in a tab): { eol, bom,
 * encoding, eols? }: its endings, BOM and encoding; a mixed file's lines keep theirs (`eols`), and
 * a file with no line break yet gets `fallback` (its place's) for the lines it gets.
 */
export function writeFormat(info, text, fallback = null) {
  const eol = info?.breaks === 0 && EOLS.includes(fallback) ? fallback : EOLS.includes(info?.eol) ? info.eol : 'lf';
  const format = { eol, bom: Boolean(info?.bom), encoding: info?.encoding ?? 'utf-8' };
  if (info?.mixed && typeof info.eols === 'string' && typeof info.text === 'string') format.eols = keepEols(info.text, info.eols, String(text), eol);
  return format;
}

/** The tab converted to `to` (an EOLS one, or 'keep': a mixed file's lines each keep theirs, new ones the most common): the fields to change. */
export function convertEndings(tab, to) {
  if (to === 'keep') return { eol: tab.mixed ? mostCommon(tab.mixed) : tab.eol, eolChosen: undefined, eolChoice: 'keep' };
  return { eol: to, eolChosen: true };
}

/** The kind most breaks are ({ crlf, lf, cr }; a tie: CRLF, then LF), as diskFiles.cjs decides a file's. */
export function mostCommon({ crlf = 0, lf = 0, cr = 0 } = {}) {
  return crlf > 0 && crlf >= lf && crlf >= cr ? 'crlf' : cr > lf ? 'cr' : 'lf';
}

/** 'crlf' / 'lf' / 'cr' when every break of `letters` is the same kind (or there are none: null), else null. */
export function uniformEol(letters) {
  const s = String(letters ?? '');
  if (!s) return null;
  return /^(.)\1*$/.test(s) ? EOL_OF_LETTER[s[0]] ?? null : null;
}

/** { crlf, lf, cr } of a string of break letters. */
export function countLetters(letters) {
  const counts = { crlf: 0, lf: 0, cr: 0 };
  for (const c of String(letters ?? '')) if (EOL_OF_LETTER[c]) counts[EOL_OF_LETTER[c]]++;
  return counts;
}

/** "120 Windows (CRLF), 3 Unix (LF)": a mixed file's counts in words. */
export function mixedWords(counts) {
  return EOLS.filter((e) => counts?.[e])
    .map((e) => `${counts[e].toLocaleString('en')} ${EOL_NAMES[e]}`)
    .join(', ');
}

/**
 * The letter of every break of `now` when the file read as `base` (with `letters`, a letter per
 * break) is saved keeping each line's own ending: lines that did not change keep theirs (by a line
 * diff), new and changed ones get `eol` (the file's most common).
 */
export function keepEols(base, letters, now, eol = 'lf') {
  const fill = EOL_LETTER[eol] ?? 'L';
  if (base === now) return letters;
  const a = String(base).split('\n');
  const b = String(now).split('\n');
  const out = new Array(Math.max(0, b.length - 1)).fill(fill);
  // The break after line i (the last line has none).
  const keep = (i, j) => {
    if (j < b.length - 1 && i < a.length - 1) out[j] = letters[i] ?? fill;
  };
  const blocks = diffBlocks(String(base), String(now)) ?? edgeBlocks(a, b);
  let ia = 0;
  let ib = 0;
  for (const block of blocks) {
    while (ia < block.aFrom && ib < block.bFrom) keep(ia++, ib++);
    ia = block.aTo;
    ib = block.bTo;
  }
  while (ia < a.length && ib < b.length) keep(ia++, ib++);
  return out.join('');
}

// Too different for the diff: what is the same at both ends keeps its endings.
function edgeBlocks(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [{ aFrom: start, aTo: endA, bFrom: start, bTo: endB }];
}

/**
 * What the status bar says of a disk tab's line endings: { text, title, tone } (tone 'warn' for a
 * mixed file nobody decided on). "CRLF"; "LF → CRLF" when Save converts them (by hand, or
 * "· .editorconfig"); "Mixed".
 */
export function eolStatus(tab) {
  const now = fileEolOf(tab);
  const ends = saveTarget(tab);
  const counts = tab.mixed ? mixedWords(tab.mixed) : '';
  if (now === 'mixed') {
    if (!ends) return { text: 'Mixed', tone: 'warn', title: `Mixed line endings: ${counts}. Saving asks how to save them; click to choose now.` };
    if (ends.why === 'keep') return { text: 'Mixed', tone: '', title: `Mixed line endings (${counts}): saving keeps each line's own; new lines get ${EOL_NAMES[tab.eol]}. Click to change.` };
    // The end of a large file, read-only: as it is.
    if (!ends.why) return { text: 'Mixed', tone: '', title: `Mixed line endings (${counts}).` };
    return { text: `Mixed → ${EOL_SHORT[ends.eol]}${ends.why === 'editorconfig' ? ' · .editorconfig' : ''}`, tone: '', title: `Mixed line endings (${counts}): saving makes every line ${EOL_NAMES[ends.eol]}${ends.why === 'editorconfig' ? ', as the .editorconfig says' : ''}. Click to change.` };
  }
  if (ends && ends.eol !== now) {
    const ec = ends.why === 'editorconfig';
    return { text: `${EOL_SHORT[now]} → ${EOL_SHORT[ends.eol]}${ec ? ' · .editorconfig' : ''}`, tone: '', title: `${EOL_NAMES[now]} line endings now; saving makes them ${EOL_NAMES[ends.eol]}${ec ? ', as the .editorconfig says' : ''}. Click to change.` };
  }
  return { text: EOL_SHORT[now] ?? 'LF', tone: '', title: `${EOL_NAMES[now] ?? EOL_NAMES.lf} line endings, kept when saving. Click to convert.` };
}

/**
 * The choices for a tab's line endings (the status bar's menu): [{ id, label, hint, checked }].
 * Classic Mac only for a file that has it; "Keep each line's own" only for a mixed file.
 */
export function eolChoices(tab) {
  const now = fileEolOf(tab);
  const ends = saveTarget(tab);
  const target = ends?.why === 'keep' ? 'keep' : ends?.eol;
  const ids = ['crlf', 'lf', ...(now === 'cr' || tab.eol === 'cr' || tab.mixed?.cr ? ['cr'] : [])];
  const rows = ids.map((id) => ({ id, label: EOL_NAMES[id], hint: EOL_HINTS[id], checked: target === id }));
  if (now === 'mixed' && typeof tab.eols === 'string') rows.push({ id: 'keep', label: 'Keep each line’s own', hint: `As the file has them now; new lines get ${EOL_NAMES[tab.eol]}`, checked: target === 'keep' });
  return rows;
}

/**
 * Counts for converting files to `target` (Folders' Line endings): files [{ eol }] as the main
 * process found them ('lf', 'crlf', 'cr', 'mixed', or 'none': no line break). { change, right, mixed }.
 */
export function eolCounts(files, target) {
  let change = 0;
  let right = 0;
  let mixed = 0;
  for (const f of files ?? []) {
    if (f.eol === 'none' || f.eol === target) right++;
    else {
      change++;
      if (f.eol === 'mixed') mixed++;
    }
  }
  return { change, right, mixed };
}
