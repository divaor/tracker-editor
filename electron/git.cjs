// Git for folders on this computer (desktop): the repository a folder is in, `git status`
// for it, and a file's text at the last commit; and the commands that change things (stage,
// commit, branches, stash, fetch, pull, push), run by `act`. It runs the `git` program
// installed on the computer; without one, or outside a repository, reading answers null.
// Reading uses GIT_OPTIONAL_LOCKS=0, so it never takes the index lock another Git program may
// need. Nothing ever waits for a question in a terminal: no prompts (a credential helper or
// an SSH agent signs in, or the command fails saying so), no editor (messages are given).

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(args, cwd, { encoding = 'utf8', timeout = 15000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding, timeout, maxBuffer, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr: String(stderr ?? '') })) : resolve(stdout),
    );
  });
}

// For the commands that change things: Git's own locks, and never a prompt or an editor.
function writeEnv(env = process.env) {
  const out = { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GCM_INTERACTIVE: env.GCM_INTERACTIVE ?? 'auto' };
  delete out.GIT_OPTIONAL_LOCKS;
  // ssh asks for nothing in a terminal (keys from the agent, hosts already known).
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) out.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  return out;
}

/**
 * Runs git and collects what it says: { stdout, stderr }; rejects with them (`err.stdout`,
 * `err.stderr`). `input` goes to its stdin; `onProgress(line)` gets each line of stderr as it
 * comes (--progress writes "\r" between updates).
 */
function runWrite(args, cwd, { input = null, timeout = 120_000, onProgress = null, env = writeEnv() } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('git', args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(Object.assign(err, { stdout: '', stderr: '' }));
    }
    let stdout = '';
    let stderr = '';
    let partial = '';
    const timer = setTimeout(() => proc.kill(), timeout);
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (!onProgress) return;
      const parts = (partial + d.toString()).split(/\r\n|\r|\n/);
      partial = parts.pop();
      for (const line of parts) if (line.trim()) onProgress(line);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { stdout, stderr }));
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(Object.assign(new Error(signal ? `git ${args[0]} took too long and was stopped` : `git ${args[0]} failed (${code})`), { code, stdout, stderr }));
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input ?? undefined);
  });
}

// What the page may name: paths inside the repository (with "/"), branches, stashes.
const safeRel = (rel) => typeof rel === 'string' && rel.length > 0 && rel.length < 4096 && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !rel.split('/').includes('..') && !/[\0\r\n]/.test(rel);
const safeBranch = (name) => typeof name === 'string' && name.length > 0 && name.length < 256 && !name.startsWith('-') && !/[\0\r\n\s~^:?*[\\]|\.\.|@\{/.test(name);
const safeStash = (ref) => typeof ref === 'string' && /^stash@\{\d{1,4}\}$/.test(ref);
const safeRemote = (name) => typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name) && !name.startsWith('-');
// A commit, branch, tag or "HEAD~2", "origin/main", "stash@{1}", "@{u}": never an option, a path or a range.
const safeRev = (rev) => typeof rev === 'string' && rev.length > 0 && rev.length < 200 && !rev.startsWith('-') && /^[\w./@{}~^+-]+$/.test(rev) && !rev.includes('..');
// "main..feature" or "a...b" too (for log and diff).
const safeRange = (range) => typeof range === 'string' && (safeRev(range) || (/^[^.]+\.{2,3}[^.]+$/.test(range) && range.split(/\.{2,3}/).every(safeRev)));
const safeTag = (name) => safeBranch(name) && name.length < 120;
// A line for .gitignore: one line, not a comment-out of the whole file.
const safePattern = (p) => typeof p === 'string' && p.trim().length > 0 && p.length <= 200 && !/[\0\r\n]/.test(p);

/** What Git said, cut to `max` characters (what goes to the model or the page stays small). */
const cap = (text, max = 40_000) => {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters left out)` : t;
};
/** A remote's address without a user name or password in it (https://user:token@host/…). */
const cleanUrl = (url) => String(url).replace(/^([a-z][\w+.-]*:\/\/)[^/@\s]*@/i, '$1');
const BACKUP_REFS = 'refs/tracker-editor/backups';
const MAX_BACKUPS = 50;

/** Git for a computer: `parseStatus` is gitStatus.js's (the page's module), `parse` its other parsers. */
function createGit({ parseStatus, parse = {}, runGit = run, runGitWrite = runWrite } = {}) {
  const roots = new Map(); // folder → { root (or null), at }
  let missing = false; // no git program
  const ROOT_MS = 30_000;

  /** The top folder of the repository `dir` is in, or null. */
  async function repoOf(dir) {
    if (missing) return null;
    const known = roots.get(dir);
    if (known && Date.now() - known.at < ROOT_MS) return known.root;
    let root = null;
    try {
      const out = await runGit(['rev-parse', '--show-toplevel'], dir, { timeout: 5000 });
      root = path.resolve(out.trim());
    } catch (err) {
      if (err.code === 'ENOENT') missing = true;
    }
    roots.set(dir, { root, at: Date.now() });
    return root;
  }

  const tryGit = async (args, root, opts) => {
    try {
      return await runGit(args, root, { timeout: 10000, ...opts });
    } catch {
      return '';
    }
  };

  /**
   * The shape of a repository for the model (Git with the model): status, branches, the graph
   * of recent commits on all of them, stashes, a merge or rebase halfway, remotes (addresses
   * without passwords), the reflog's last moves, tags, who commits, and our backups.
   */
  async function snapshot(root, parse) {
    const [statusOut, graph, branchesOut, stashOut, remotes, reflog, tags, name, email, ignore] = await Promise.all([
      tryGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], root),
      tryGit(['log', '--graph', `--exclude=${BACKUP_REFS}/*`, '--all', '--date-order', '--decorate=short', '--format=%h%d %s · %an, %cr', '-n', '60'], root),
      tryGit(['for-each-ref', '--format=%(refname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:relative)%00%(HEAD)', 'refs/heads', 'refs/remotes'], root),
      tryGit(['stash', 'list', '--format=%gd%x00%s%x00%cr'], root),
      tryGit(['remote', '-v'], root),
      tryGit(['reflog', 'show', '--date=relative', '--format=%h %gd %gs', '-n', '20'], root),
      tryGit(['tag', '--sort=-creatordate', '--format=%(refname:short) %(objectname:short) %(creatordate:relative)'], root),
      tryGit(['config', 'user.name'], root),
      tryGit(['config', 'user.email'], root),
      Promise.resolve(fs.existsSync(path.join(root, '.gitignore'))),
    ]);
    let inProgress = null;
    for (const [n, op] of [['MERGE_HEAD', 'merge'], ['REBASE_HEAD', 'rebase'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
      const p = (await tryGit(['rev-parse', '--git-path', n], root)).trim();
      if (p && fs.existsSync(path.resolve(root, p))) {
        inProgress = op;
        break;
      }
    }
    const status = statusOut ? parseStatus(statusOut) : null;
    const remoteList = [...new Set(remotes.split('\n').filter(Boolean).map((l) => {
      const [rname, url] = l.split(/\s+/);
      return `${rname} ${cleanUrl(url ?? '')}`;
    }))];
    return {
      root,
      status,
      graph: cap(graph, 12_000),
      branches: branchesOut && parse.parseBranches ? parse.parseBranches(branchesOut) : { local: [], remote: [] },
      stashes: stashOut && parse.parseStashes ? parse.parseStashes(stashOut) : [],
      inProgress,
      remotes: remoteList,
      reflog: cap(reflog, 4000),
      tags: tags.split('\n').filter(Boolean).slice(0, 10),
      identity: { name: Boolean(name.trim()), email: Boolean(email.trim()) },
      gitignore: ignore,
      backups: (await readBackups(root)).slice(0, 10).map(({ tips, ...b }) => b),
    };
  }

  // Backups (Git with the model): before a step that changes history or files, the commit HEAD
  // is on (a ref of ours, so Git never collects it) and the changes not committed (`git stash
  // create`: a commit, the files untouched), listed in a file in the .git folder.
  const backupFile = async (root) => path.resolve(root, (await runGit(['rev-parse', '--git-path', 'tracker-editor-backups.json'], root, { timeout: 5000 })).trim());
  async function readBackups(root) {
    try {
      const list = JSON.parse(fs.readFileSync(await backupFile(root), 'utf8'));
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  async function makeBackup(root, label, keep = []) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const head = (await tryGit(['rev-parse', '--verify', '-q', 'HEAD'], root)).trim();
    const branch = (await tryGit(['symbolic-ref', '--short', '-q', 'HEAD'], root)).trim();
    const changes = (await tryGit(['stash', 'create', `Tracker Editor backup: ${label}`], root)).trim();
    // Where every branch was (a deleted one is made again by the undo); the ones a step is about
    // to delete or rename (`keep`) get a ref of ours, so their commits stay.
    const tips = {};
    for (const line of (await tryGit(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], root)).split('\n')) {
      const [name, sha] = line.split(' ');
      if (name && sha) tips[name] = sha;
    }
    const kept = (Array.isArray(keep) ? keep : []).filter((b) => safeBranch(b) && tips[b]).slice(0, 20);
    if (head) await runGitWrite(['update-ref', '-m', `Tracker Editor backup: ${label}`, `${BACKUP_REFS}/${id}`, head], root);
    if (changes) await runGitWrite(['update-ref', '-m', 'Tracker Editor backup (changes)', `${BACKUP_REFS}/${id}-changes`, changes], root);
    for (const [i, b] of kept.entries()) await runGitWrite(['update-ref', '-m', `Tracker Editor backup: ${b}`, `${BACKUP_REFS}/${id}-kept-${i}`, tips[b]], root);
    const entry = { id, at: new Date().toISOString(), label, head, branch, changes, tips, kept: kept.length, keptNames: kept };
    const list = [entry, ...(await readBackups(root))];
    for (const old of list.slice(MAX_BACKUPS)) {
      await tryGit(['update-ref', '-d', `${BACKUP_REFS}/${old.id}`], root);
      await tryGit(['update-ref', '-d', `${BACKUP_REFS}/${old.id}-changes`], root);
      for (let i = 0; i < (old.kept ?? 0); i++) await tryGit(['update-ref', '-d', `${BACKUP_REFS}/${old.id}-kept-${i}`], root);
    }
    fs.writeFileSync(await backupFile(root), JSON.stringify(list.slice(0, MAX_BACKUPS), null, 1));
    return entry;
  }
  /**
   * Back to a backup: a merge or rebase halfway is aborted, the branch made again if it was
   * deleted, checked out, moved to the commit it was on, and the changes put back. Itself
   * backed up first, so the undo can be undone.
   */
  async function undoBackup(root, id) {
    const entry = (await readBackups(root)).find((b) => b.id === id);
    if (!entry) throw new Error('That backup is gone');
    const before = await makeBackup(root, `before undoing “${entry.label}”`);
    const w = (args, opts) => runGitWrite(args, root, opts);
    for (const [n, op] of [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
      const p = (await tryGit(['rev-parse', '--git-path', n], root)).trim();
      if (p && fs.existsSync(path.resolve(root, p))) await w([op, '--abort']).catch(() => {});
    }
    // Branches deleted since are made again where they were (the others stay where they are now).
    for (const [b, sha] of Object.entries(entry.tips ?? {})) {
      if (!safeBranch(b) || (await tryGit(['rev-parse', '--verify', '-q', `refs/heads/${b}`], root)).trim()) continue;
      // Its commit may be gone (collected): then it stays gone.
      if ((await tryGit(['rev-parse', '--verify', '-q', `${sha}^{commit}`], root)).trim()) await w(['branch', b, sha]).catch(() => {});
    }
    if (entry.head) {
      if (entry.branch) {
        const exists = (await tryGit(['rev-parse', '--verify', '-q', `refs/heads/${entry.branch}`], root)).trim();
        if (!exists) await w(['branch', entry.branch, entry.head]);
        const now = (await tryGit(['symbolic-ref', '--short', '-q', 'HEAD'], root)).trim();
        if (now !== entry.branch) await w(['switch', '-f', entry.branch]);
      } else {
        await w(['switch', '-f', '--detach', entry.head]);
      }
      await w(['reset', '-q', '--hard', entry.head]);
    }
    // The branches the step moved (move-branch, delete-branch, rename-branch) go back where they were.
    for (const b of entry.keptNames ?? []) {
      if (b === entry.branch || !safeBranch(b) || !entry.tips?.[b]) continue;
      await w(['branch', '-f', b, entry.tips[b]]).catch(() => {});
    }
    if (entry.changes) await w(['stash', 'apply', '--index', entry.changes]).catch(() => w(['stash', 'apply', entry.changes]));
    return { restored: entry, backup: before };
  }

  return {
    repoOf,
    /** `git status` for the repository `dir` is in: { root, branch, upstream, ahead, behind, files } or null. */
    async status(dir) {
      const root = await repoOf(dir);
      if (!root) return null;
      try {
        const out = await runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], root);
        return { root, ...parseStatus(out) };
      } catch {
        return null;
      }
    },
    /** A file's bytes at the last commit (HEAD): { root, rel, bytes }, or null (not in a repository, or new). */
    async headBytes(file) {
      const root = await repoOf(path.dirname(file));
      if (!root) return null;
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) return null;
      try {
        const bytes = await runGit(['show', `HEAD:${rel}`], root, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
        return { root, rel, bytes };
      } catch {
        return null;
      }
    },
    /** The branch checked out in the repository `root` ('detached' when none), or ''. */
    async branch(root) {
      try {
        const name = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, { timeout: 5000 })).trim();
        return name === 'HEAD' ? 'detached' : name;
      } catch {
        return '';
      }
    },
    /**
     * Does what the page asks in the repository `root` (from repoOf; the main process checked the
     * folder): `action.op` and its fields, checked here. Answers what the op gives, or throws
     * with `stdout`/`stderr` (gitError on the page says it in words). `onProgress(line)`: Git's
     * progress for fetch, pull and push.
     */
    async act(root, action, { onProgress = null } = {}) {
      const w = (args, opts = {}) => runGitWrite(args, root, { onProgress, ...opts });
      const rels = (list) => {
        if (!Array.isArray(list) || !list.length || list.length > 5000 || !list.every(safeRel)) throw new Error('Not files of this repository');
        return list;
      };
      const hasHead = async () => {
        try {
          await runGit(['rev-parse', '--verify', '-q', 'HEAD'], root, { timeout: 5000 });
          return true;
        } catch {
          return false;
        }
      };
      switch (action?.op) {
        case 'stage':
          // Deletions and new files too.
          return w(['add', '-A', '--', ...rels(action.paths)]);
        case 'stage-all':
          return w(['add', '-A']);
        case 'unstage':
          // A repository without a commit yet has nothing to go back to: out of the index.
          return (await hasHead()) ? w(['restore', '--staged', '--', ...rels(action.paths)]) : w(['rm', '--cached', '-r', '-q', '--', ...rels(action.paths)]);
        case 'unstage-all':
          return (await hasHead()) ? w(['reset', '-q']) : w(['rm', '--cached', '-r', '-q', '.']);
        case 'commit': {
          const message = String(action.message ?? '').replace(/\r\n?/g, '\n');
          if (!message.trim() && !action.amend) throw Object.assign(new Error('No message'), { stderr: 'Aborting commit due to empty commit message.' });
          const args = ['commit', ...(action.amend ? ['--amend'] : []), ...(message.trim() ? ['-F', '-'] : ['--no-edit'])];
          return w(args, { input: message.trim() ? message : null });
        }
        case 'last-message':
          return (await hasHead()) ? (await runGit(['log', '-1', '--format=%B'], root, { timeout: 5000 })).replace(/\n+$/, '') : '';
        case 'branches': {
          const out = await runGit(['for-each-ref', '--format=%(refname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:relative)%00%(HEAD)', 'refs/heads', 'refs/remotes'], root);
          return parse.parseBranches ? parse.parseBranches(out) : out;
        }
        case 'switch': {
          if (!safeBranch(action.name)) throw new Error('Not a branch name');
          if (action.create) {
            if (action.from && !safeBranch(action.from)) throw new Error('Not a branch name');
            // Git's own check of the name, before anything changes.
            await runGit(['check-ref-format', '--branch', action.name], root, { timeout: 5000 });
            // From another branch ("origin/dev"): not following it, so its first push makes a branch of its own name.
            return w(['switch', '-c', action.name, ...(action.from ? ['--no-track', action.from] : [])]);
          }
          // A remote branch ("origin/x") gets a local one that follows it.
          if (action.track) return w(['switch', '--track', action.name]);
          return w(['switch', action.name]);
        }
        case 'fetch':
          return w(['fetch', '--all', '--prune', '--progress'], { timeout: 300_000 });
        case 'pull': {
          const how = { merge: ['--no-rebase'], rebase: ['--rebase'] }[action.how] ?? ['--ff-only'];
          return w(['pull', ...how, '--progress'], { timeout: 300_000 });
        }
        case 'push': {
          const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root, { timeout: 5000 })).trim();
          let upstream = '';
          try {
            upstream = (await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root, { timeout: 5000 })).trim();
          } catch {
            // none yet
          }
          // Force: only with a lease (refused when the remote has commits this computer has not seen).
          const force = action.force ? ['--force-with-lease'] : [];
          if (upstream) return w(['push', '--progress', ...force], { timeout: 300_000 });
          // The first push of a branch: to the remote named (or the only one, or origin), followed from then on.
          const remotes = (await runGit(['remote'], root, { timeout: 5000 })).split('\n').filter(Boolean);
          const remote = safeRemote(action.remote) && remotes.includes(action.remote) ? action.remote : remotes.length === 1 ? remotes[0] : remotes.includes('origin') ? 'origin' : '';
          if (!remote || branch === 'HEAD') throw Object.assign(new Error('No remote'), { stderr: remote ? 'fatal: You are not currently on a branch.' : 'fatal: No configured push destination.' });
          return w(['push', '--progress', ...force, '-u', remote, 'HEAD'], { timeout: 300_000 });
        }
        case 'stashes': {
          const out = await runGit(['stash', 'list', '--format=%gd%x00%s%x00%cr'], root);
          return parse.parseStashes ? parse.parseStashes(out) : out;
        }
        case 'stash': {
          const message = String(action.message ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
          return w(['stash', 'push', ...(action.untracked ? ['--include-untracked'] : []), ...(message ? ['-m', message] : [])]);
        }
        case 'stash-apply':
        case 'stash-pop':
        case 'stash-drop':
          if (!safeStash(action.ref)) throw new Error('Not a stash');
          return w(['stash', action.op.slice(6), action.ref]);
        case 'in-progress': {
          // A merge or a rebase left halfway (conflicts): what can be aborted.
          for (const [name, op] of [['MERGE_HEAD', 'merge'], ['REBASE_HEAD', 'rebase'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
            const p = (await runGit(['rev-parse', '--git-path', name], root, { timeout: 5000 })).trim();
            if (fs.existsSync(path.resolve(root, p))) return op;
          }
          return null;
        }
        case 'abort': {
          const op = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[action.what];
          if (!op) throw new Error('Nothing to abort');
          return w([op, '--abort']);
        }
        // ---- Looking (Git with the model): what it asks to see, cut to size ----
        case 'log': {
          const count = Math.min(Math.max(Number(action.count) || 30, 1), 200);
          const range = action.range ?? action.ref;
          if (range != null && !safeRange(range)) throw new Error('Not a commit or range');
          const paths = action.paths ? rels(action.paths) : [];
          if (!(await hasHead())) return '(no commits yet)';
          const out = await runGit(['log', '--graph', '--date-order', '--decorate=short', '--format=%h%d %s · %an, %cr', '-n', String(count), ...(action.all ? [`--exclude=${BACKUP_REFS}/*`, '--all'] : range ? [range] : []), '--', ...paths], root);
          return cap(out);
        }
        case 'show': {
          if (!safeRev(action.rev)) throw new Error('Not a commit');
          return cap(await runGit(['show', '--stat', '--patch', '--format=fuller', '--no-color', action.rev, '--'], root));
        }
        case 'diff': {
          const paths = action.paths ? rels(action.paths) : [];
          const revs = [action.from, action.to].filter((r) => r != null);
          if (!revs.every(safeRange)) throw new Error('Not a commit');
          const args = ['diff', '--no-color', ...(action.stat ? ['--stat'] : []), ...(action.staged ? ['--cached'] : []), ...revs, '--', ...paths];
          return cap(await runGit(args, root)) || '(no differences)';
        }
        case 'file-at': {
          if (!safeRev(action.rev) || !safeRel(action.path)) throw new Error('Not a file at a commit');
          return cap(await runGit(['show', `${action.rev}:${action.path}`], root));
        }
        case 'read': {
          // A file as it is now in the repository's folder (never outside it: links are followed and checked).
          if (!safeRel(action.path)) throw new Error('Not a file of this repository');
          const real = fs.realpathSync(path.join(root, action.path));
          const top = fs.realpathSync(root);
          if (real !== top && !real.startsWith(top + path.sep)) throw new Error('Not a file of this repository');
          const stat = fs.statSync(real);
          if (!stat.isFile()) throw new Error('Not a file');
          const fd = fs.openSync(real, 'r');
          try {
            const buf = Buffer.alloc(Math.min(stat.size, 64 * 1024));
            fs.readSync(fd, buf, 0, buf.length, 0);
            return cap(buf.toString('utf8'), 40_000) + (stat.size > buf.length ? `\n… (the file is ${stat.size} bytes; the rest left out)` : '');
          } finally {
            fs.closeSync(fd);
          }
        }
        case 'reflog': {
          const count = Math.min(Math.max(Number(action.count) || 30, 1), 200);
          if (action.ref != null && !safeRev(action.ref)) throw new Error('Not a branch');
          try {
            return cap(await runGit(['reflog', 'show', '--date=relative', '--format=%h %gd %gs', '-n', String(count), ...(action.ref ? [action.ref] : [])], root));
          } catch {
            return '(no reflog)';
          }
        }
        case 'snapshot':
          return snapshot(root, parse);
        case 'backups':
          return readBackups(root);
        // ---- Changing things the panel has no button for (Git with the model) ----
        case 'merge': {
          if (!safeRev(action.rev)) throw new Error('Not a branch or commit');
          const how = { 'ff-only': ['--ff-only'], 'no-ff': ['--no-ff'], squash: ['--squash'] }[action.how] ?? [];
          return w(['merge', ...how, '--no-edit', action.rev]);
        }
        case 'rebase': {
          if (!safeRev(action.onto)) throw new Error('Not a branch or commit');
          return w(['rebase', action.onto]);
        }
        case 'continue': {
          const op = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick', revert: 'revert' }[action.what];
          if (!op) throw new Error('Nothing to continue');
          return w(op === 'merge' ? ['commit', '--no-edit'] : [op, '--continue']);
        }
        case 'rebase-skip':
          return w(['rebase', '--skip']);
        case 'reset': {
          const mode = { soft: '--soft', mixed: '--mixed', hard: '--hard' }[action.mode];
          if (!mode || !safeRev(action.rev)) throw new Error('Not a reset');
          return w(['reset', '-q', mode, action.rev]);
        }
        case 'revert': {
          if (!safeRev(action.rev)) throw new Error('Not a commit');
          // A merge commit: which parent's side to keep (1: the branch it was merged into).
          const mainline = [1, 2].includes(action.mainline) ? ['-m', String(action.mainline)] : [];
          return w(['revert', '--no-edit', ...mainline, action.rev]);
        }
        case 'cherry-pick':
          // One commit, or a range ("origin/main..main": the commits main has that origin/main lacks).
          if (!safeRange(action.rev)) throw new Error('Not a commit');
          return w(['cherry-pick', action.rev]);
        case 'move-branch':
          // Another branch (not the one checked out) moved to a commit: "put main back where origin/main is".
          if (!safeBranch(action.name) || !safeRev(action.to)) throw new Error('Not a branch or commit');
          return w(['branch', '-f', action.name, action.to]);
        case 'delete-branch':
          if (!safeBranch(action.name)) throw new Error('Not a branch name');
          return w(['branch', action.force ? '-D' : '-d', action.name]);
        case 'rename-branch': {
          if (!safeBranch(action.to) || (action.from != null && !safeBranch(action.from))) throw new Error('Not a branch name');
          await runGit(['check-ref-format', '--branch', action.to], root, { timeout: 5000 });
          return w(['branch', '-m', ...(action.from ? [action.from] : []), action.to]);
        }
        case 'restore': {
          // Throws away changes to files (back to the index, or to a commit's version).
          if (action.from != null && !safeRev(action.from)) throw new Error('Not a commit');
          return w(['restore', ...(action.from ? [`--source=${action.from}`, '--staged'] : []), '--worktree', '--', ...rels(action.paths)]);
        }
        case 'tag': {
          if (!safeTag(action.name) || (action.rev != null && !safeRev(action.rev))) throw new Error('Not a tag');
          const message = String(action.message ?? '').trim();
          return w(['tag', ...(message ? ['-a', '-F', '-'] : []), action.name, ...(action.rev ? [action.rev] : [])], { input: message || null });
        }
        case 'ignore': {
          const patterns = Array.isArray(action.patterns) ? action.patterns.filter(safePattern).slice(0, 50) : [];
          if (!patterns.length) throw new Error('No patterns');
          const file = path.join(root, '.gitignore');
          let text = '';
          try {
            text = fs.readFileSync(file, 'utf8');
          } catch {
            // none yet
          }
          const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
          const added = patterns.map((p) => p.trim()).filter((p) => !have.has(p));
          if (added.length) {
            const eol = text.includes('\r\n') ? '\r\n' : '\n';
            fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? eol : ''}${added.join(eol)}${eol}`);
          }
          return { added, already: patterns.length - added.length };
        }
        case 'untrack':
          // Out of Git (and the next commit), kept on disk: for files .gitignore should have caught.
          return w(['rm', '-r', '--cached', '-q', '--', ...rels(action.paths)]);
        case 'backup':
          return makeBackup(root, String(action.label ?? '').slice(0, 200), action.keep);
        case 'undo':
          return undoBackup(root, String(action.id ?? ''));
        default:
          throw new Error(`Unknown Git action: ${action?.op}`);
      }
    },
    /** The text staged for a file (the index), as bytes: { root, rel, bytes } or null (not staged, or not in a repository). */
    async indexBytes(file) {
      const root = await repoOf(path.dirname(file));
      if (!root) return null;
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (!safeRel(rel)) return null;
      try {
        return { root, rel, bytes: await runGit(['show', `:${rel}`], root, { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }) };
      } catch {
        return null;
      }
    },
    /** Stages `bytes` as a file's text (one change of it staged): written as a blob, put in the index with the file's mode. */
    async setIndexBytes(file, bytes) {
      const root = await repoOf(path.dirname(file));
      if (!root) throw new Error('Not in a Git repository');
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (!safeRel(rel)) throw new Error('Not a file of this repository');
      const sha = (await runGitWrite(['hash-object', '-w', '--stdin', `--path=${rel}`], root, { input: bytes })).stdout.trim();
      const staged = (await runGit(['ls-files', '-s', '--', rel], root, { timeout: 5000 })).trim();
      const mode = /^(\d{6}) /.exec(staged)?.[1] ?? '100644';
      await runGitWrite(['update-index', '--add', '--cacheinfo', `${mode},${sha},${rel}`], root);
      return { root, rel };
    },
    /** Forgets which folders are in which repository (a repository was made or removed). */
    forget: () => roots.clear(),
    /**
     * What making `dir` a repository would mean: { installed (the git program is there), root
     * (the repository `dir` is in already, or null), defaultBranch (the person's
     * init.defaultBranch, or '') }.
     */
    async info(dir) {
      if (!missing) {
        try {
          await runGit(['--version'], dir, { timeout: 5000 });
        } catch (err) {
          if (err.code === 'ENOENT') missing = true;
        }
      }
      if (missing) return { installed: false, root: null, defaultBranch: '' };
      roots.delete(dir);
      const root = await repoOf(dir);
      const named = (await tryGit(['config', '--get', 'init.defaultBranch'], dir)).trim();
      return { installed: true, root, defaultBranch: safeBranch(named) ? named : '' };
    },
    /**
     * Makes `dir` a Git repository (git init), its first branch named `branch` (else Git's own
     * choice): { root, branch }. Refuses a folder that is a repository's top already; one inside
     * another repository becomes a repository of its own (the page says so first).
     */
    async init(dir, { branch = '' } = {}) {
      if (branch && !safeBranch(branch)) throw new Error('Not a branch name');
      roots.delete(dir);
      const before = await repoOf(dir);
      if (missing) throw new Error('Git is not installed on this computer');
      const real = (p) => {
        try {
          return fs.realpathSync.native(p);
        } catch {
          return path.resolve(p);
        }
      };
      const key = (p) => (process.platform === 'win32' ? real(p).toLowerCase() : real(p));
      if (before && key(before) === key(dir)) throw new Error('This folder is a Git repository already');
      // Git's own check of the name, before anything is made.
      if (branch) await runGit(['check-ref-format', '--branch', branch], dir, { timeout: 5000 });
      await runGitWrite(['init', '-q'], dir);
      if (branch) await runGitWrite(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], dir);
      roots.clear();
      const root = await repoOf(dir);
      return { root, branch: (await tryGit(['symbolic-ref', '--short', 'HEAD'], dir)).trim() };
    },
    get missing() {
      return missing;
    },
  };
}

module.exports = { createGit, writeEnv, safeRel, safeBranch, safeRev, safeRange, cleanUrl };
