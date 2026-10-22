// Puts the front-end libraries into app/vendor so the web app runs without a
// build step (GitHub Pages, Electron). Run with `npm run vendor` after
// upgrading any of them.
// - Preact/htm, marked and DOMPurify ship browser builds that are copied as is.
// - CodeMirror is bundled with esbuild into app/vendor/cm/: codemirror.js plus
//   one chunk per language, loaded the first time a file needs it. files.json
//   lists them so the service worker can cache all of them for offline use.
// - xterm.js (with its fit add-on) is bundled into app/vendor/xterm/xterm.js, next
//   to its stylesheet: the terminal on servers in the desktop app.
// - Text recognition (tesseract.js) goes to app/vendor/ocr/: the library, its
//   worker, the WebAssembly core (SIMD, LSTM only) and the English and Spanish
//   models. About 9 MB, so they are cached when first used, not precached.
import { readFile, writeFile, mkdir, readdir, rm, copyFile } from 'node:fs/promises';
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

const xtermDir = path.join(outDir, 'xterm');
await rm(xtermDir, { recursive: true, force: true });
const { version: xtermVersion } = await pkgInfo('@xterm/xterm');
const { version: fitVersion } = await pkgInfo('@xterm/addon-fit');
await build({
  entryPoints: { xterm: path.join(root, 'vendor-src', 'xterm.js') },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  outdir: xtermDir,
  banner: { js: `/* @xterm/xterm@${xtermVersion} and @xterm/addon-fit@${fitVersion} (MIT) - bundled by scripts/vendor.js */` },
  legalComments: 'none',
  logLevel: 'warning',
});
const xtermCss = await readFile(path.join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8');
await writeFile(path.join(xtermDir, 'xterm.css'), `/* @xterm/xterm@${xtermVersion} (MIT) - vendored by scripts/vendor.js */\n${xtermCss}`);
// Only the desktop app uses it: cached when first used, not precached on phones.
await writeFile(path.join(xtermDir, 'files.json'), `${JSON.stringify(['xterm.js', 'xterm.css'], null, 2)}\n`);
console.log(`app/vendor/xterm/ <- @xterm/xterm@${xtermVersion}, @xterm/addon-fit@${fitVersion}`);

// Formatting (Format document): Prettier's standalone build with the parsers used here, and
// sql-formatter bundled. Loaded when first used, and cached then (vendor/format/files.json).
const formatDir = path.join(outDir, 'format');
await rm(formatDir, { recursive: true, force: true });
await mkdir(path.join(formatDir, 'plugins'), { recursive: true });
const { version: prettierVersion } = await pkgInfo('prettier');
const { version: sqlVersion } = await pkgInfo('sql-formatter');
// Saved as .js: every server (and the app:// protocol) serves those as JavaScript modules.
const prettierFiles = ['standalone', ...['babel', 'estree', 'typescript', 'postcss', 'html', 'markdown', 'yaml', 'graphql'].map((p) => `plugins/${p}`)];
for (const file of prettierFiles) {
  const source = await readFile(path.join(root, 'node_modules', 'prettier', `${file}.mjs`), 'utf8');
  await writeFile(path.join(formatDir, `${file}.js`), `/* prettier@${prettierVersion} (MIT) - vendored by scripts/vendor.js */\n${source.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n')}`);
}
await build({
  stdin: { contents: "export { format } from 'sql-formatter';", resolveDir: root },
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2022',
  outfile: path.join(formatDir, 'sql-formatter.js'),
  banner: { js: `/* sql-formatter@${sqlVersion} (MIT) - bundled by scripts/vendor.js */` },
  legalComments: 'none',
  logLevel: 'warning',
});
await writeFile(path.join(formatDir, 'files.json'), `${JSON.stringify([...prettierFiles.map((f) => `${f}.js`), 'sql-formatter.js'], null, 2)}\n`);
console.log(`app/vendor/format/ <- prettier@${prettierVersion}, sql-formatter@${sqlVersion}`);

const ocrDir = path.join(outDir, 'ocr');
await rm(ocrDir, { recursive: true, force: true });
await mkdir(ocrDir, { recursive: true });
const { version: ocrVersion } = await pkgInfo('tesseract.js');
const { version: coreVersion } = await pkgInfo('tesseract.js-core');
const scripts = [
  { from: 'node_modules/tesseract.js/dist/tesseract.esm.min.js', to: 'tesseract.js', what: `tesseract.js@${ocrVersion} (Apache-2.0)` },
  { from: 'node_modules/tesseract.js/dist/worker.min.js', to: 'worker.min.js', what: `tesseract.js@${ocrVersion} worker (Apache-2.0)` },
  { from: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', to: 'tesseract-core-simd-lstm.wasm.js', what: `tesseract.js-core@${coreVersion} (Apache-2.0)` },
];
for (const file of scripts) {
  const source = await readFile(path.join(root, file.from), 'utf8');
  const body = source.replace(/\n?\/\/# sourceMappingURL=.*\s*$/, '\n');
  await writeFile(path.join(ocrDir, file.to), `/* ${file.what} - vendored by scripts/vendor.js */\n${body}`);
}
const models = ['eng', 'spa'];
for (const lang of models) {
  // "best_int": the accurate LSTM models, stored as integers (smaller, as fast as "fast").
  await copyFile(path.join(root, 'node_modules', '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`), path.join(ocrDir, `${lang}.traineddata.gz`));
}
const ocrFiles = [...scripts.map((f) => f.to), ...models.map((l) => `${l}.traineddata.gz`)];
await writeFile(path.join(ocrDir, 'files.json'), `${JSON.stringify(ocrFiles, null, 2)}\n`);
console.log(`app/vendor/ocr/ <- tesseract.js@${ocrVersion}, tesseract.js-core@${coreVersion}, models ${models.join(', ')}`);
