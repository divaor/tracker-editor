// Puts the front-end libraries into app/vendor so the web app runs without a
// build step (GitHub Pages, Electron). Run with `npm run vendor` after
// upgrading any of them.
// - Preact/htm, marked and DOMPurify ship browser builds that are copied as is.
// - CodeMirror is bundled with esbuild into app/vendor/cm/: codemirror.js plus
//   one chunk per language, loaded the first time a file needs it. files.json
//   lists them so the service worker can cache all of them for offline use.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'app', 'vendor');
const cmDir = path.join(outDir, 'cm');

const files = [
  { from: 'node_modules/htm/preact/standalone.module.js', to: 'preact-htm.js', pkg: 'htm' },
  { from: 'node_modules/marked/lib/marked.esm.js', to: 'marked.js', pkg: 'marked' },
  { from: 'node_modules/dompurify/dist/purify.es.mjs', to: 'purify.js', pkg: 'dompurify' },
];

const pkgInfo = async (pkg) => JSON.parse(await readFile(path.join(root, 'node_modules', pkg, 'package.json'), 'utf8'));

await mkdir(outDir, { recursive: true });
for (const file of files) {
  const { version, license } = await pkgInfo(file.pkg);
  const source = await readFile(path.join(root, file.from), 'utf8');
  const body = source.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');
  await writeFile(path.join(outDir, file.to), `/* ${file.pkg}@${version} (${license}) - vendored by scripts/vendor.js */\n${body}`);
  console.log(`app/vendor/${file.to} <- ${file.pkg}@${version}`);
}

await rm(cmDir, { recursive: true, force: true });
const { version: cmVersion } = await pkgInfo('@codemirror/view');
await build({
  entryPoints: { codemirror: path.join(root, 'vendor-src', 'codemirror.js') },
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  outdir: cmDir,
  chunkNames: 'chunks/[name]-[hash]',
  banner: { js: `/* CodeMirror 6 (@codemirror/view ${cmVersion}, MIT) and its language packages - bundled by scripts/vendor.js */` },
  legalComments: 'none',
  logLevel: 'warning',
});
const chunks = (await readdir(path.join(cmDir, 'chunks'))).sort().map((name) => `chunks/${name}`);
await writeFile(path.join(cmDir, 'files.json'), `${JSON.stringify(['codemirror.js', ...chunks], null, 2)}\n`);
console.log(`app/vendor/cm/codemirror.js + ${chunks.length} chunks <- CodeMirror ${cmVersion}`);
