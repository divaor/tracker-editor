// Command lines that log in to another machine (ssh, mosh, et, telnet), as a shell said it was
// running them (OSC 633;E, terminals.js): which program, who, where, and whether it runs a command
// there or is a login. A Terminals tab brought back offers to run such a line again (and runs it
// by itself when its session says so); nothing else is ever run again. Also what "Save as a server
// connection…" fills in. Pure, so the Node tests import it.

export const LOGIN_PROGRAMS = ['ssh', 'mosh', 'et', 'telnet'];
const MAX_LINE = 2000;

/**
 * A command line in words, as the shell `kind` splits it ('posix': quotes and backslashes;
 * 'powershell': quotes and the backtick, a backslash is a backslash; 'cmd': double quotes). null
 * when it is not one plain command: ; | & < > (and ` or $( in a POSIX shell) outside quotes, a
 * line break, an open quote. PowerShell's call operator (& 'C:\…\ssh.exe' host) is let through.
 */
export function shellWords(line, { kind = 'posix' } = {}) {
  const text = String(line ?? '').trim();
  if (!text || text.length > MAX_LINE || /[\r\n\0]/.test(text)) return null;
  const posix = kind !== 'powershell' && kind !== 'cmd';
  const words = [];
  let word = null; // null: between words
  let quote = '';
  let i = 0;
  if (kind === 'powershell' && /^&\s+/.test(text)) i = text.match(/^&\s+/)[0].length;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      // PowerShell: '' inside single quotes is one quote.
      if (c === "'" && kind === 'powershell' && text[i + 1] === "'") (word += "'"), i++;
      else if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (posix && c === '\\' && /["\\$`]/.test(text[i + 1] ?? '')) word += text[++i];
      else if (kind === 'powershell' && c === '`' && i + 1 < text.length) word += text[++i];
      else if (posix && (c === '`' || (c === '$' && text[i + 1] === '('))) return null;
      else word += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    if (/[;|&<>]/.test(c) || (posix && (c === '`' || (c === '$' && text[i + 1] === '(')))) return null;
    word ??= '';
    if (c === "'" && kind !== 'cmd') quote = "'";
    else if (c === '"') quote = '"';
    else if (posix && c === '\\') {
      if (i + 1 >= text.length) return null;
      word += text[++i];
    } else if (kind === 'powershell' && c === '`') {
      if (i + 1 >= text.length) return null;
      word += text[++i];
    } else word += c;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words.length ? words : null;
}

/** The program a word names: its file's name, lower case, without .exe ("/usr/bin/ssh", "C:\…\ssh.exe" → "ssh"). */
export function programName(word) {
  const base = String(word ?? '').split(/[\\/]/).pop().toLowerCase();
  return base.replace(/\.exe$/, '');
}

// OpenSSH's options: those that take a value, and those that do not.
const SSH_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw');
const SSH_FLAG = new Set('46AaCfGgKkMNnqsTtVvXxYy');
const HOST = /^(\[[0-9a-fA-F:.%\w]+\]|[\w.-]+|[0-9a-fA-F:]+(%\w+)?)$/;
// A host the shell fills in ($HOST, ${SERVER}, %SERVER% in cmd): a login still, not one to fill in.
const isVariable = (s) => /[$%]/.test(s) && /^[\w.${}%:-]+$/.test(s);

// "user@host" (the last @), "ssh://user@host:port", "[::1]".
function destination(word, { uri = false } = {}) {
  let rest = word;
  let port = null;
  if (uri) {
    const m = /^ssh:\/\/(?:([^@/]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d{1,5}))?\/?$/i.exec(word);
    if (!m) return null;
    return { user: m[1] ? decodeSafe(m[1]) : '', host: m[2].replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : null };
  }
  const at = rest.lastIndexOf('@');
  const user = at > 0 ? rest.slice(0, at) : '';
  rest = at >= 0 ? rest.slice(at + 1) : rest;
  if (!rest || !(HOST.test(rest) || isVariable(rest))) return null;
  return { user, host: rest.replace(/^\[|\]$/g, ''), port };
}
const decodeSafe = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const portOf = (v) => (/^\d{1,5}$/.test(String(v ?? '')) && Number(v) > 0 && Number(v) < 65536 ? Number(v) : null);

// ssh [options] destination [command]; options may come after the destination too (OpenSSH reads them there).
function parseSsh(words) {
  const out = { user: '', host: '', port: null, jump: '', identity: '', command: '' };
  let optUser = '';
  let optPort = null;
  let i = 1;
  let ended = false; // after --
  while (i < words.length) {
    const w = words[i];
    if (!ended && w === '--') {
      ended = true;
      i++;
      continue;
    }
    if (!ended && w.startsWith('-') && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        const c = w[j];
        if (SSH_FLAG.has(c)) continue;
        if (!SSH_VALUE.has(c)) return null;
        let value = w.slice(j + 1);
        if (!value) {
          i++;
          if (i >= words.length) return null;
          value = words[i];
        }
        if (c === 'p') optPort = portOf(value) ?? optPort;
        else if (c === 'l') optUser = value;
        else if (c === 'i') out.identity = value;
        else if (c === 'J') out.jump = value;
        else if (c === 'o') {
          const m = /^\s*(\w+)\s*(?:=|\s)\s*(.*)$/.exec(value);
          const key = m?.[1].toLowerCase();
          if (key === 'port') optPort = portOf(m[2]) ?? optPort;
          else if (key === 'user') optUser = m[2];
          else if (key === 'proxyjump') out.jump = m[2];
          else if (key === 'identityfile') out.identity = m[2];
          else if (key === 'hostname' && HOST.test(m[2])) out.hostName = m[2];
        }
        break;
      }
      i++;
      continue;
    }
    if (!out.host) {
      const d = destination(w, { uri: /^ssh:\/\//i.test(w) });
      if (!d) return null;
      Object.assign(out, { user: d.user, host: d.host, port: d.port });
      i++;
      ended = false;
      continue;
    }
    // The rest is a command run there.
    out.command = words.slice(i).join(' ');
    break;
  }
  if (!out.host) return null;
  out.user ||= optUser;
  out.port = optPort ?? out.port;
  return out;
}

// mosh [options] [--] [user@]host [--] [command]; the ssh port is in --ssh="ssh -p N".
function parseMosh(words) {
  const out = { user: '', host: '', port: null, jump: '', identity: '', command: '' };
  const VALUE = new Set(['--client', '--server', '--predict', '--family', '--port', '-p', '--bind-server', '--ssh', '--experimental-remote-ip']);
  let i = 1;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') {
      i++;
      break;
    }
    if (!w.startsWith('-')) break;
    const [name, inline] = w.includes('=') ? [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)] : [w, null];
    let value = inline;
    if (VALUE.has(name) && value === null) value = words[++i] ?? null;
    else if (!VALUE.has(name) && !/^(-[an46]+|--[\w-]+)$/.test(name)) return null;
    if (name === '--ssh' && value) {
      const inner = parseSsh([...(shellWords(value) ?? ['ssh']), 'x']);
      if (inner?.port) out.port = inner.port;
    }
  }
  const d = words[i] && destination(words[i]);
  if (!d) return null;
  Object.assign(out, { user: d.user, host: d.host });
  let rest = words.slice(i + 1);
  if (rest[0] === '--') rest = rest.slice(1);
  out.command = rest.join(' ');
  return out;
}

// et [options] [user@]host[:port]: the port is Eternal Terminal's own; -c runs a command there.
function parseEt(words) {
  const out = { user: '', host: '', port: null, jump: '', identity: '', command: '' };
  const VALUE = new Set(['-u', '--username', '--host', '-p', '--port', '-c', '--command', '-t', '--tunnel', '-r', '--reversetunnel', '--jumphost', '--jport', '--ssh-option', '--serverfifo', '-l', '--logdir', '--prefix', '--verbose']);
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('-') && w.length > 1) {
      const [name, inline] = w.includes('=') ? [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)] : [w, null];
      let value = inline;
      if (VALUE.has(name)) value ??= words[++i] ?? '';
      else if (!/^(-[xvNf]+|--[\w-]+)$/.test(name)) return null;
      if (name === '-u' || name === '--username') out.user = value;
      if (name === '--host') Object.assign(out, { host: value });
      if (name === '-c' || name === '--command') out.command = value;
      if (name === '--jumphost') out.jump = value;
      continue;
    }
    if (out.host) return null;
    const m = /^(?:(.+)@)?([^@:]+)(?::(\d{1,5}))?$/.exec(w);
    if (!m || !HOST.test(m[2])) return null;
    out.user ||= m[1] ?? '';
    out.host = m[2];
  }
  return out.host && HOST.test(out.host) ? out : null;
}

// telnet [options] host [port]
function parseTelnet(words) {
  const args = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith('-')) {
      if (/^-[lnbeskX]$/.test(w)) i++; // options with a value
      else if (!/^-[46878EFfKLrcdax]+$/.test(w)) return null;
      continue;
    }
    args.push(w);
  }
  if (!args.length || args.length > 2 || !HOST.test(args[0]) || (args[1] && !portOf(args[1]))) return null;
  const at = words.indexOf('-l');
  return { user: at > 0 ? (words[at + 1] ?? '') : '', host: args[0].replace(/^\[|\]$/g, ''), port: portOf(args[1]), jump: '', identity: '', command: '' };
}

/**
 * A login to another machine: { program ('ssh', 'mosh', 'et', 'telnet'), line (as typed), user,
 * host, port (null: the usual one), jump (ssh -J or ProxyJump), identity (-i: not used to fill
 * anything in), command (what it runs there, '' for none), login (no command: a shell there),
 * runsAlone (a login whose line has nothing a shell would expand: what a session may run by
 * itself) }; null for any other line (another program, more than one command, options not
 * understood). `kind` is the shell's ('posix', 'powershell', 'cmd').
 */
export function loginCommand(line, { kind = 'posix' } = {}) {
  const words = shellWords(line, { kind });
  if (!words) return null;
  const program = programName(words[0]);
  if (!LOGIN_PROGRAMS.includes(program)) return null;
  const parsed = { ssh: parseSsh, mosh: parseMosh, et: parseEt, telnet: parseTelnet }[program](words);
  if (!parsed || !parsed.host) return null;
  const text = String(line).trim();
  const login = !parsed.command;
  const { hostName, ...rest } = parsed;
  return { program, line: text, ...rest, ...(hostName ? { hostName } : {}), login, runsAlone: login && !/[$%`]/.test(text) };
}

/** "ana@192.0.2.181:2222" — where a login goes, in a line. */
export function loginLabel(cmd) {
  if (!cmd) return '';
  const host = cmd.host.includes(':') ? `[${cmd.host}]` : cmd.host;
  return `${cmd.user ? `${cmd.user}@` : ''}${host}${cmd.port ? `:${cmd.port}` : ''}`;
}

/**
 * What the server dialog starts with for a login (ssh, mosh and et sign in over SSH; telnet does
 * not, so null): an SFTP connection named after the host, its user and SSH port. The key file of
 * -i is not filled in (the dialog picks keys itself): "key" signs in then. A jump host is noted
 * (`jump`), not set: the dialog's is another connection.
 */
export function serverDraftOf(cmd) {
  if (!cmd || cmd.program === 'telnet') return null;
  const host = cmd.hostName || cmd.host;
  if (isVariable(host) || isVariable(cmd.user)) return null;
  return {
    protocol: 'sftp',
    name: cmd.hostName ? cmd.host : host,
    host,
    port: cmd.program === 'ssh' || cmd.program === 'mosh' ? (cmd.port ?? 22) : 22,
    user: cmd.user,
    auth: cmd.identity ? 'key' : 'password',
    ...(cmd.jump ? { jumpNote: cmd.jump } : {}),
  };
}
