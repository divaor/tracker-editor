// "file:line" in program output and logs, to open the file at that line: paths with a line
// (and column) as compilers, Node, Python, .NET and Go print them. Pure: the tests use it;
// the terminal and the editor (Ctrl+click) find them with it.

const EXT = '[A-Za-z0-9]{1,10}';
// A path: C:\…, \\server\…, /…, ~/…, ./…, ../… or a relative one with at least a name.ext.
const PATH = `(?:[A-Za-z]:[\\\\/]|\\\\\\\\|~?/|\\.{1,2}[\\\\/])?(?:[\\w.@+-]+[\\\\/])*[\\w.@+-]+\\.${EXT}`;
const PATTERNS = [
  // Python: File "x.py", line 12 (in quotes, so spaces count; not "<stdin>")
  new RegExp(`File "([^"<>\\n]*\\.${EXT})", line (\\d+)`, 'g'),
  // .NET: in C:\path\File.cs:line 42
  new RegExp(`(?:^|\\s)in (${PATH}):line (\\d+)`, 'g'),
  // MSBuild, TypeScript: file.ts(12,5)
  new RegExp(`(${PATH})\\((\\d+)(?:,(\\d+))?\\)`, 'g'),
  // file:12:5, file:12 (also inside "at fn (file:12:5)" and file:// URLs)
  new RegExp(`(?:file:\\/\\/)?(${PATH}):(\\d+)(?::(\\d+))?`, 'g'),
];

/**
 * The file references in one line of text: [{ from, to, path, line, column }] (from–to:
 * where the reference is in the line, to underline). Overlapping ones count once.
 */
export function findFileRefs(text) {
  const found = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const path = m[1];
      const from = m.index + m[0].indexOf(path);
      const to = m.index + m[0].length;
      if (found.some((f) => from < f.to && to > f.from)) continue;
      // Version numbers and times are not files ("v1.2:3", "10.5:30").
      if (/^\d+(\.\d+)+$/.test(path)) continue;
      found.push({ from, to, path, line: Number(m[2]), column: m[3] ? Number(m[3]) : 1 });
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

/**
 * Where a reference points: an absolute path stays; a relative one is taken from `base`
 * (the folder of the file or the terminal). "~/" is left to the caller (null).
 */
export function resolveRef(path, base = '') {
  if (/^[A-Za-z]:[\\/]|^\\\\|^\//.test(path)) return path;
  if (path.startsWith('~')) return null;
  if (!base) return null;
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const parts = `${base.replace(/[\\/]+$/, '')}${sep}${path}`.split(/[\\/]/);
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.') out.push(p);
  }
  return out.join(sep);
}
