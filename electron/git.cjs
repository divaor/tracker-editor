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
            return w(['switch', '-c', action.name, ...(action.from ? [action.from] : [])]);
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
          if (upstream) return w(['push', '--progress'], { timeout: 300_000 });
          // The first push of a branch: to the remote named (or the only one, or origin), followed from then on.
          const remotes = (await runGit(['remote'], root, { timeout: 5000 })).split('\n').filter(Boolean);
          const remote = safeRemote(action.remote) && remotes.includes(action.remote) ? action.remote : remotes.length === 1 ? remotes[0] : remotes.includes('origin') ? 'origin' : '';
          if (!remote || branch === 'HEAD') throw Object.assign(new Error('No remote'), { stderr: remote ? 'fatal: You are not currently on a branch.' : 'fatal: No configured push destination.' });
          return w(['push', '--progress', '-u', remote, 'HEAD'], { timeout: 300_000 });
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
          for (const [name, op] of [['MERGE_HEAD', 'merge'], ['REBASE_HEAD', 'rebase'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick']]) {
            const p = (await runGit(['rev-parse', '--git-path', name], root, { timeout: 5000 })).trim();
            if (fs.existsSync(path.resolve(root, p))) return op;
          }
          return null;
        }
        case 'abort': {
          const op = { merge: 'merge', rebase: 'rebase', 'cherry-pick': 'cherry-pick' }[action.what];
          if (!op) throw new Error('Nothing to abort');
          return w([op, '--abort']);
        }
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
    get missing() {
      return missing;
    },
  };
}

module.exports = { createGit, writeEnv, safeRel, safeBranch };
