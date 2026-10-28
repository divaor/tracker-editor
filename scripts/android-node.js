// The Android app's own Node.js, before Gradle builds it (CI runs this; `npm run android:node`):
//   1. libnode (nodejs-mobile, pinned) and its headers into android/app/libnode/, from the npm
//      package that carries them (`npm pack` checks its integrity);
//   2. the Node side into android/app/src/main/assets/nodejs/: mobile/node (the entry, the
//      bridge, the Electron stand-in), electron/*.cjs (the desktop's main process), the page
//      modules main.cjs imports, and the packages they need (without native parts).
// Neither is in the repository (android/.gitignore).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODEJS_MOBILE = '18.20.4';
const ABIS = ['arm64-v8a'];
const LIBNODE = path.join(ROOT, 'android', 'app', 'libnode');
const ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'nodejs');
// The modules electron/main.cjs imports from the page (app/js), and what those import.
const PAGE_MODULES = ['search.js', 'folders.js', 'docTypes.js', 'indent.js', 'codeNav.js', 'outline.js', 'gitStatus.js', 'replace.js'];
// Packages the main process needs on a phone (not node-pty, Electron or the build tools).
const PACKAGES = ['ssh2', 'basic-ftp', 'fflate'];
// Native parts are left out: the packages fall back to JavaScript without them.
const SKIP = [/^cpu-features$/, /^nan$/, /[\\/]crypto[\\/](build|src)([\\/]|$)/, /[\\/](test|tests|docs|examples|benchmark)([\\/]|$)/, /\.(md|map|d\.ts|gyp|cc|h)$/i];

function fetchLibnode() {
  const marker = path.join(LIBNODE, `.version-${NODEJS_MOBILE}`);
  if (fs.existsSync(marker)) return console.log(`libnode ${NODEJS_MOBILE}: already there`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodejs-mobile-'));
  console.log(`Fetching nodejs-mobile ${NODEJS_MOBILE} (about 100 MB)…`);
  execFileSync('npm', ['pack', `nodejs-mobile-react-native@${NODEJS_MOBILE}`, '--pack-destination', tmp, '--silent'], { stdio: 'inherit' });
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  const wanted = ['package/android/libnode/include', ...ABIS.map((abi) => `package/android/libnode/bin/${abi}/libnode.so`)];
  execFileSync('tar', ['xzf', path.join(tmp, tgz), '-C', tmp, ...wanted], { stdio: 'inherit' });
  fs.rmSync(LIBNODE, { recursive: true, force: true });
  fs.mkdirSync(LIBNODE, { recursive: true });
  fs.cpSync(path.join(tmp, 'package', 'android', 'libnode'), LIBNODE, { recursive: true });
  fs.writeFileSync(marker, '');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`libnode ${NODEJS_MOBILE} → ${path.relative(ROOT, LIBNODE)}`);
}

// A package and the ones it depends on (not the optional ones: native extras).
function dependencies(names, seen = new Set()) {
  for (const name of names) {
    if (seen.has(name)) continue;
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
    seen.add(name);
    dependencies(Object.keys(pkg.dependencies ?? {}), seen);
  }
  return seen;
}

const skipped = (rel) => SKIP.some((re) => re.test(rel));
function copyTree(from, to, base = from) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const rel = path.relative(base, src);
    if (skipped(rel) || entry.isSymbolicLink()) continue;
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest, base);
    else {
      fs.mkdirSync(to, { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}

function assemble() {
  fs.rmSync(ASSETS, { recursive: true, force: true });
  copyTree(path.join(ROOT, 'mobile', 'node'), path.join(ASSETS, 'mobile', 'node'));
  for (const f of fs.readdirSync(path.join(ROOT, 'electron')).filter((f) => f.endsWith('.cjs') && f !== 'preload.cjs')) {
    fs.mkdirSync(path.join(ASSETS, 'electron'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'electron', f), path.join(ASSETS, 'electron', f));
  }
  fs.mkdirSync(path.join(ASSETS, 'app', 'js'), { recursive: true });
  for (const f of PAGE_MODULES) fs.copyFileSync(path.join(ROOT, 'app', 'js', f), path.join(ASSETS, 'app', 'js', f));
  fs.writeFileSync(path.join(ASSETS, 'app', 'package.json'), '{ "type": "module" }\n');
  fs.writeFileSync(path.join(ASSETS, 'package.json'), '{ "private": true, "type": "commonjs" }\n');
  const packages = [...dependencies(PACKAGES)].filter((name) => !skipped(name));
  for (const name of packages) copyTree(path.join(ROOT, 'node_modules', name), path.join(ASSETS, 'node_modules', name));
  let files = 0;
  let bytes = 0;
  const count = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) count(path.join(dir, e.name));
      else {
        files++;
        bytes += fs.statSync(path.join(dir, e.name)).size;
      }
    }
  };
  count(ASSETS);
  console.log(`Node side → ${path.relative(ROOT, ASSETS)}: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB (${packages.join(', ')})`);
}

if (!process.argv.includes('--assets-only')) fetchLibnode();
assemble();
