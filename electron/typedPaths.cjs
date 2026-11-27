// Paths typed in quick open or pasted (0.54): environment variables and ~ in them expanded here,
// in the main process, so "%USERPROFILE%\.tinta\settings", "$HOME/src", "${XDG_CONFIG_HOME}/x",
// "$env:APPDATA\Code" and "~/notes" name the folder they mean. Only variables that hold a path
// are expanded: one of the usual folder variables, or any whose value is a path that exists
// here. Any other value never reaches the page (a variable can hold a secret); a variable that is
// not set, or holds something else, gives a message naming it (and the nearest folder variable).
// Pure but for `exists`, so the tests give it the environment and the file system it sees.

const path = require('node:path');

// The usual folder variables (by name, upper case): their value is taken when it is one path.
const FOLDER_NAMES =
  /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|ALLUSERSPROFILE|PUBLIC|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|SYSTEMROOT|WINDIR|SYSTEMDRIVE|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR|ONEDRIVE|ONEDRIVECONSUMER|ONEDRIVECOMMERCIAL|PWD|OLDPWD|GOPATH|GOROOT|VIRTUAL_ENV|CONDA_PREFIX|XDG_[A-Z0-9_]+|[A-Z0-9_]+_(HOME|DIR|ROOT|PREFIX))$/;
// %NAME% (cmd), ${env:NAME} and $env:NAME (PowerShell), ${NAME} and $NAME (sh), ~ at the start.
const VARIABLE = /%([A-Za-z_][\w()-]*)%|\$\{env:([A-Za-z_][\w()-]*)\}|\$env:([A-Za-z_][\w()]*)|\$\{([A-Za-z_][\w-]*)\}|\$([A-Za-z_]\w*)/g;
const loose = (name) => name.toLowerCase().replace(/[_-]/g, '');

/** Whether a variable's value is one whole path for `platform` (a list, a command or text is not). */
function isPathValue(value, platform) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\u0000-\u001f]/.test(value)) return false;
  if (platform === 'win32') return !value.includes(';') && (/^[A-Za-z]:$/.test(value) || path.win32.isAbsolute(value));
  return value.startsWith('/') && !value.includes(':');
}

/**
 * The variables of `env` a typed path may use: { name: value } of those holding a path that is
 * a usual folder variable or exists here (`exists`). HOME is this computer's home folder when it
 * is not set (Windows).
 */
function folderVariables(env = {}, { platform = process.platform, home = '', exists = () => false } = {}) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isPathValue(value, platform)) continue;
    if (FOLDER_NAMES.test(name.toUpperCase()) || exists(value)) out[name] = value;
  }
  if (home && !Object.keys(out).some((n) => n.toUpperCase() === 'HOME')) out.HOME = home;
  return out;
}

/** The variable `name` stands for among `vars`: its own name first, then without case, then without case, "_" and "-" ("User_profile" is USERPROFILE). */
function findVariable(name, vars) {
  const names = Object.keys(vars);
  return names.find((n) => n === name) ?? names.find((n) => n.toLowerCase() === name.toLowerCase()) ?? names.find((n) => loose(n) === loose(name)) ?? null;
}

// How far apart two names are (letters added, dropped, changed or two swapped), for "did you mean".
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** The folder variable nearest to `name` (a typo or two away), or null. */
function nearest(name, vars) {
  const want = loose(name);
  let best = null;
  for (const n of Object.keys(vars)) {
    const d = distance(want, loose(n));
    if (d <= Math.max(1, Math.floor(want.length / 4)) && (!best || d < best.d)) best = { n, d };
  }
  return best?.n ?? null;
}

// The variable as it was typed, to name it in a message.
const written = (m) => (m[1] ? `%${m[1]}%` : m[2] ? `\${env:${m[2]}}` : m[3] ? `$env:${m[3]}` : m[4] ? `\${${m[4]}}` : `$${m[5]}`);
const sameForm = (m, name) => (m[1] ? `%${name}%` : m[2] || m[3] ? `$env:${name}` : `$${name}`);

/**
 * A typed path with its variables and a leading ~ expanded: { path, expanded } (`expanded`: it
 * had any), or { problem } (a message naming the variable). Expanded once (a value holding
 * "%X%" stays as it is); the separators made the platform's when something was expanded. A
 * bare $NAME that is not set is left as written, except at the start ("C:\$Recycle.Bin",
 * "\\server\c$"); %NAME%, ${NAME} and $env:NAME are always variables.
 */
function expandTyped(typed, { env = {}, platform = process.platform, home = '', exists = () => false } = {}) {
  if (typeof typed !== 'string') return { problem: 'That is not a path.' };
  let text = typed.trim();
  if (/^(["']).*\1$/.test(text)) text = text.slice(1, -1).trim();
  if (!text || text.length > 1024 || /[\r\n]/.test(text)) return { problem: 'That is not a path.' };
  const vars = folderVariables(env, { platform, home, exists });
  let expanded = false;
  let problem = null;
  let out = '';
  let at = 0;
  if (/^~(?=$|[\\/])/.test(text)) {
    if (!home) return { problem: 'The home folder is not known here.' };
    out = home;
    at = 1;
    expanded = true;
  }
  VARIABLE.lastIndex = at;
  for (let m = VARIABLE.exec(text); m; m = VARIABLE.exec(text)) {
    const name = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    // A bare $name inside the path is one only by its own name ("/tmp/a$b" keeps its $b otherwise).
    const inside = Boolean(m[5]) && m.index > 0;
    const found = inside ? (Object.hasOwn(vars, name) ? name : null) : findVariable(name, vars);
    if (!found) {
      // A $ inside a name that is not a variable stays as it is.
      if (m[5] && m.index > 0) continue;
      if (!problem) {
        const near = nearest(name, vars);
        problem = `No folder variable ${written(m)}${near ? `; did you mean ${sameForm(m, near)}?` : '.'}`;
      }
      continue;
    }
    out += text.slice(at, m.index) + vars[found];
    at = m.index + m[0].length;
    expanded = true;
  }
  if (problem) return { problem };
  out += text.slice(at);
  if (!expanded) return { path: out, expanded: false };
  const sep = platform === 'win32' ? '\\' : '/';
  // "a" + "/" + "b": no doubled separators where a value ended with one, the platform's everywhere.
  let joined = out.replace(/[\\/]+/g, sep);
  if (platform === 'win32' && /^[\\/]{2}/.test(out)) joined = `\\${joined}`;
  return { path: joined, expanded: true };
}

/**
 * A path typed for a server (the side-by-side dialog's and the comparison's "path on this
 * server"): "~", "$HOME" and "${HOME}" at its start are that server's home (`home`, as the
 * session found it). → the path, starting with "/" when it named the home; others as typed.
 */
function expandOnServer(typed, home) {
  const text = String(typed ?? '').trim();
  const m = /^(~|\$HOME|\$\{HOME\})(?=$|\/)/.exec(text);
  if (!m || !home) return text;
  const base = String(home).replace(/\/+$/, '');
  return `${base}${text.slice(m[0].length)}` || '/';
}

module.exports = { expandTyped, expandOnServer, folderVariables, findVariable, isPathValue, FOLDER_NAMES };
