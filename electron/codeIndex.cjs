// Code across the folders open in Folders (desktop): where a name is declared (F12 when it
// is not in the open file) and the symbols of every file (Ctrl+T). Files are listed with
// `list` and read with `read`, so the same code works on this computer and on servers; the
// rules come from the page's own modules (codeNav.js declarationKind, outline.js).

const { SKIP_DIRS } = require('./findInFolder.cjs');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Breadth-first over `root` (nearest first): each file entry, until `visit` returns false.
async function walk({ root, list, hidden = false, signal, maxFolders = 5000, ends, now, concurrency = 4 }, visit) {
  const pending = [root];
  let listed = 0;
  let stopped = false;
  while (pending.length && !stopped && !signal?.aborted) {
    if (listed >= maxFolders || now() > ends) return { truncated: true };
    await Promise.all(
      pending.splice(0, concurrency).map(async (dir) => {
        let entries = [];
        try {
          entries = await list(dir);
        } catch {
          return;
        }
        listed++;
        for (const entry of entries) {
          if (stopped || signal?.aborted) return;
          if (!hidden && entry.name.startsWith('.')) continue;
          if (entry.dir) {
            if (!entry.link && !SKIP_DIRS.has(entry.name)) pending.push(entry.path);
          } else if ((await visit(entry)) === false) stopped = true;
        }
      }),
    );
  }
  return { truncated: false, stopped };
}

/**
 * Where `word` is declared in the files under `roots`: { found: [{ path, line, column,
 * kind, text }], truncated }. `kindOf(line, column, word)` says 'strong', 'assign' or null;
 * assignments are given only when nothing stronger is found. Files whose name `isCode`
 * rejects, larger than `maxSize`, or not text are skipped.
 */
async function findDeclarations({ roots, list, read, decode, isCode, kindOf, word, hidden = false, signal, limit = 30, maxFiles = 8000, maxSize = 2 * 1024 * 1024, timeLimit = 6000, concurrency = 4, now = Date.now }) {
  const ends = now() + timeLimit;
  const re = new RegExp(`(?<![\\w$])${escape(word)}(?![\\w$])`, 'g');
  const strong = [];
  const assigned = [];
  let files = 0;
  let truncated = false;
  for (const root of roots) {
    const result = await walk({ root, list, hidden, signal, ends, now, concurrency }, async (entry) => {
      if (strong.length >= limit) return false;
      if (++files > maxFiles || now() > ends) {
        truncated = true;
        return false;
      }
      if (!isCode(entry.name) || (entry.size ?? 0) > maxSize) return true;
      let text;
      try {
        text = decode(await read(entry.path));
      } catch {
        return true;
      }
      if (!text.includes(word)) return true;
      const lines = text.split('\n');
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n];
        if (!line.includes(word)) continue;
        re.lastIndex = 0;
        for (let m = re.exec(line); m; m = re.exec(line)) {
          const kind = kindOf(line, m.index + 1, word);
          if (!kind) continue;
          const hit = { path: entry.path, line: n + 1, column: m.index + 1, kind, text: line.trim().slice(0, 200) };
          (kind === 'strong' ? strong : assigned).push(hit);
          break;
        }
      }
      return true;
    });
    if (result.truncated) truncated = true;
    if (strong.length >= limit || signal?.aborted) break;
  }
  return { found: (strong.length ? strong : assigned).slice(0, limit), truncated };
}

/**
 * The symbols (outline entries) of every code file under the folders it is given, kept
 * per file and read again only when a file changed. `outline(text, language)` and
 * `languageFor(name)` are outline.js's; `score(title, query)` ranks (search.js fuzzyScore).
 */
function createSymbolIndex({ list, read, decode, outline, languageFor, score }) {
  const files = new Map(); // path → { mtimeMs, root, symbols: [{ title, line, column, level }] }
  return {
    /** Reads what changed under `root`: { files, symbols, truncated }. */
    async refresh(root, { hidden = false, signal, maxFiles = 6000, maxSize = 1024 * 1024, timeLimit = 8000, concurrency = 4, now = Date.now } = {}) {
      const ends = now() + timeLimit;
      const seen = new Set();
      let count = 0;
      let truncated = false;
      const result = await walk({ root, list, hidden, signal, ends, now, concurrency }, async (entry) => {
        if (++count > maxFiles || now() > ends) {
          truncated = true;
          return false;
        }
        const language = languageFor(entry.name);
        if (!language || (entry.size ?? 0) > maxSize) return true;
        seen.add(entry.path);
        const known = files.get(entry.path);
        if (known && known.mtimeMs === entry.mtimeMs && entry.mtimeMs) return true;
        let text;
        try {
          text = decode(await read(entry.path));
        } catch {
          files.delete(entry.path);
          return true;
        }
        const lines = text.split('\n');
        const symbols = outline(text, language).map((s) => ({ ...s, column: Math.max(1, (lines[s.line - 1] ?? '').indexOf(s.title.replace(/^(TABLE|VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER|INDEX|SCHEMA) /, '')) + 1) }));
        files.set(entry.path, { mtimeMs: entry.mtimeMs, root, symbols });
        return true;
      });
      if (result.truncated) truncated = true;
      // Files gone from a folder read whole are forgotten.
      if (!truncated && !signal?.aborted) for (const [p, f] of files) if (f.root === root && !seen.has(p)) files.delete(p);
      let symbols = 0;
      for (const f of files.values()) if (f.root === root) symbols += f.symbols.length;
      return { files: seen.size, symbols, truncated };
    },
    /** The best `limit` symbols under `roots` for `query`: [{ title, line, column, level, path }]. */
    query(roots, query, { limit = 200 } = {}) {
      const out = [];
      for (const [path, f] of files) {
        if (!roots.includes(f.root)) continue;
        for (const s of f.symbols) {
          const value = query ? score(s.title, query) : 0;
          if (value >= 0) out.push({ ...s, path, score: value });
        }
      }
      out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
      return out.slice(0, limit).map(({ score: _s, ...s }) => s);
    },
    forget(root) {
      for (const [p, f] of files) if (f.root === root) files.delete(p);
    },
  };
}

module.exports = { findDeclarations, createSymbolIndex };
