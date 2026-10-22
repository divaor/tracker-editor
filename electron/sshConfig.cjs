// The hosts in an OpenSSH client config (~/.ssh/config), to set them up as
// servers here: each Host without wildcards, with what applies to it (the first
// value of each keyword wins, as in OpenSSH; IdentityFile adds up). Include is
// followed through `readInclude`; Match blocks are skipped. Pure apart from that.

const KEYS = new Set(['hostname', 'user', 'port', 'identityfile', 'proxyjump', 'proxycommand']);

/** "Keyword value", "Keyword=value", with "quoted values" kept together. */
function splitLine(line) {
  const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!m) return [line.toLowerCase(), []];
  const args = [];
  const re = /"([^"]*)"|(\S+)/g;
  let a;
  while ((a = re.exec(m[2]))) args.push(a[1] ?? a[2]);
  return [m[1].toLowerCase(), args];
}

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

/** Whether `alias` matches a Host line's patterns (any positive one, no negated one). */
function hostMatches(patterns, alias) {
  let hit = false;
  for (const p of patterns) {
    const negated = p.startsWith('!');
    if (!globToRegExp(negated ? p.slice(1) : p).test(alias)) continue;
    if (negated) return false;
    hit = true;
  }
  return hit;
}

/**
 * Blocks of a config: [{ patterns (null: applies to all, before any Host; [] for
 * Match), lines: [[keyword, args]] }]. `readInclude(pattern)` gives the texts of
 * the files an Include names.
 */
function parseBlocks(text, readInclude = () => [], depth = 0, blocks = [{ patterns: null, lines: [] }]) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, args] = splitLine(line);
    if (key === 'host') blocks.push({ patterns: args, lines: [] });
    else if (key === 'match') blocks.push({ patterns: [], lines: [] }); // conditions on more than the name: left out
    else if (key === 'include') {
      if (depth < 8) for (const pattern of args) for (const included of readInclude(pattern)) parseBlocks(included, readInclude, depth + 1, blocks);
    } else blocks.at(-1).lines.push([key, args]);
  }
  return blocks;
}

/** %h, %p, %r, %u, %d, %n and %% in a value; ~ at its start. */
function expand(value, { alias, host = alias, port = 22, user = '', localUser = '', home = '' }) {
  const out = value.replace(/%([hprudn%])/g, (_, t) => ({ h: host, p: String(port), r: user, u: localUser, d: home, n: alias, '%': '%' })[t]);
  return out.startsWith('~/') || out === '~' ? home + out.slice(1) : out;
}

/**
 * The hosts named in a config: [{ alias, host, port, user, identityFiles,
 * proxyJump, proxyCommand }], in the order they appear.
 */
function parseSshConfig(text, { readInclude, home = '', localUser = '' } = {}) {
  const blocks = parseBlocks(text, readInclude);
  const aliases = [];
  for (const b of blocks) for (const p of b.patterns ?? []) if (!/[*?!]/.test(p) && !aliases.includes(p)) aliases.push(p);
  return aliases.map((alias) => {
    const found = { identityfile: [] };
    for (const b of blocks) {
      if (b.patterns && !hostMatches(b.patterns, alias)) continue;
      for (const [key, args] of b.lines) {
        if (!KEYS.has(key) || !args.length) continue;
        if (key === 'identityfile') found.identityfile.push(args[0]);
        else if (found[key] === undefined) found[key] = key === 'proxycommand' ? args.join(' ') : args[0];
      }
    }
    const host = found.hostname ? expand(found.hostname, { alias, home, localUser }) : alias;
    const port = Number(found.port) || 22;
    const user = found.user ? expand(found.user, { alias, host, port, home, localUser }) : localUser;
    const ctx = { alias, host, port, user, home, localUser };
    const jump = found.proxyjump && found.proxyjump.toLowerCase() !== 'none' ? found.proxyjump : '';
    return {
      alias,
      host,
      port,
      user,
      identityFiles: found.identityfile.filter((f) => f.toLowerCase() !== 'none').map((f) => expand(f, ctx)),
      proxyJump: jump,
      proxyCommand: Boolean(found.proxycommand && found.proxycommand.toLowerCase() !== 'none'),
    };
  });
}

/** A ProxyJump hop that is not a Host of the config: "[user@]host[:port]" (or ssh://…). */
function parseHop(spec) {
  const m = /^(?:ssh:\/\/)?(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(spec.trim());
  if (!m) return null;
  return { user: m[1] ?? '', host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]) || 22 };
}

module.exports = { parseSshConfig, parseHop, hostMatches, globToRegExp };
