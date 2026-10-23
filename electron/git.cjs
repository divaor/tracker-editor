// Git for folders on this computer (desktop): the repository a folder is in, `git status`
// for it, and a file's text at the last commit. It runs the `git` program installed on the
// computer; without one, or outside a repository, everything answers null. Read-only:
// GIT_OPTIONAL_LOCKS=0 keeps it from taking the index lock another Git program may need.

const { execFile } = require('node:child_process');
const path = require('node:path');

function run(args, cwd, { encoding = 'utf8', timeout = 15000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding, timeout, maxBuffer, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr: String(stderr ?? '') })) : resolve(stdout),
    );
  });
}

/** Git for a computer: `parseStatus` is gitStatus.js's (the page's module). */
function createGit({ parseStatus, runGit = run } = {}) {
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
    /** Forgets which folders are in which repository (a repository was made or removed). */
    forget: () => roots.clear(),
    get missing() {
      return missing;
    },
  };
}

module.exports = { createGit };
