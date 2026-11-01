// Running tests (desktop): what the page needs to know about a test file's project, read in
// the main process (here or on an SSH server): its folder and those above it, nearest first,
// each with the names that say which framework and tool run the tests (package.json, lock
// files, config files, pyproject.toml, go.mod, Cargo.toml, composer.json, *.csproj…) and the
// text of the few files read for it. The page's testRun.js decides from that. Up to the
// folder picked here, a repository's top (.git), or 8 folders up.

const READ = ['package.json', 'composer.json', 'pyproject.toml'];
const MAX_READ = 512 * 1024;
const NAMES = new Set([
  'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json',
  'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'setup.py', 'conftest.py', 'uv.lock', 'poetry.lock', 'pdm.lock',
  'go.mod', 'Cargo.toml', 'composer.json', 'composer.lock', 'phpunit.xml', 'phpunit.xml.dist', '.git',
]);
const PATTERNS = [/^(vitest|vite|jest)\.(config|workspace)\.[cm]?[jt]s(on)?$/, /^\.mocharc(\.(c?js|json|jsonc|ya?ml))?$/, /\.(csproj|sln|slnx)$/];
const kept = (name) => NAMES.has(name) || PATTERNS.some((re) => re.test(name));

/**
 * The folders from `dir` up: [{ dir, names, texts }]. `io`: { list(dir) → names, read(path) →
 * Buffer|null (at most MAX_READ), join, dirname }; `stop`: the folder not to go above ('' = none).
 */
async function projectAround(dir, { list, read, join, dirname, stop = '', max = 8 }) {
  const out = [];
  let at = dir;
  for (let up = 0; up < max; up++) {
    let names;
    try {
      names = await list(at);
    } catch {
      break;
    }
    const found = names.filter(kept);
    const texts = {};
    const csproj = found.filter((n) => n.endsWith('.csproj')).slice(0, 3);
    for (const name of [...READ.filter((n) => found.includes(n)), ...csproj]) {
      try {
        const bytes = await read(join(at, name));
        if (bytes) texts[name] = bytes.toString('utf8');
      } catch {
        // unreadable: left out
      }
    }
    out.push({ dir: at, names: found, texts });
    const parent = dirname(at);
    if (found.includes('.git') || parent === at || (stop && at === stop)) break;
    at = parent;
  }
  return out;
}

module.exports = { projectAround, MAX_READ };
