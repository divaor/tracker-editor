// Windows: Tracker Editor in Explorer's "Open with" list for text and code files
// (without becoming their default program), "Edit with Tracker Editor" in the
// right-click menu of every file, and "Open in Tracker Editor" on folders. Kept in the
// current user's part of the registry (no admin rights needed), written as a .reg
// file that reg.exe imports; turning it off imports one that removes the same keys.
// The uninstaller removes them too (build/installer.nsh).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const PROG_ID = 'TrackerEditor.File';
const VERB = 'TrackerEditor';
const CLASSES = 'HKEY_CURRENT_USER\\Software\\Classes';

/** Text and code files the app offers to open ("Open with"). Any other file: "Edit with Tracker Editor". */
const TEXT_EXTS = (
  'txt text md markdown log csv tsv json jsonc json5 geojson xml xsd xsl xslt svg yaml yml toml ini cfg conf config env properties ' +
  'html htm css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte py pyw rb php pl pm lua r java kt kts scala groovy gradle ' +
  'c h cpp cc cxx hpp hh cs fs vb go rs swift m mm dart sql psql sh bash zsh fish ps1 psm1 psd1 bat cmd vbs ' +
  'dockerfile makefile mk cmake tf tfvars hcl proto graphql gql rst adoc tex bib srt vtt diff patch reg nfo url'
)
  .split(' ')
  .map((e) => `.${e}`);

// A .reg string: backslashes and quotes escaped.
const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The .reg file that registers (`on`) or removes the app as an editor for `exe` (the
 * program's full path; the portable exe's own path, not where it unpacks itself).
 */
function regFile(exe, { on = true, exts = TEXT_EXTS, name = 'Tracker Editor' } = {}) {
  const exeName = path.win32.basename(exe);
  const open = `"${exe}" "%1"`;
  const lines = ['Windows Registry Editor Version 5.00', ''];
  const key = (k, values = {}) => {
    lines.push(`[${CLASSES}\\${k}]`);
    for (const [n, v] of Object.entries(values)) lines.push(`${n === '@' ? '@' : quote(n)}=${v === null ? '-' : quote(v)}`);
    lines.push('');
  };
  const drop = (k) => lines.push(`[-${CLASSES}\\${k}]`, '');
  if (!on) {
    drop(`Applications\\${exeName}`);
    drop(PROG_ID);
    drop(`*\\shell\\${VERB}`);
    drop(`Directory\\shell\\${VERB}`);
    drop(`Directory\\Background\\shell\\${VERB}`);
    for (const ext of exts) key(`${ext}\\OpenWithProgids`, { [PROG_ID]: null });
    return lines.join('\r\n');
  }
  key(`Applications\\${exeName}`, { FriendlyAppName: name });
  key(`Applications\\${exeName}\\shell\\open\\command`, { '@': open });
  key(`Applications\\${exeName}\\SupportedTypes`, Object.fromEntries(exts.map((e) => [e, ''])));
  key(PROG_ID, { '@': `Text file (${name})` });
  key(`${PROG_ID}\\DefaultIcon`, { '@': `"${exe}",0` });
  key(`${PROG_ID}\\shell\\open\\command`, { '@': open });
  for (const ext of exts) key(`${ext}\\OpenWithProgids`, { [PROG_ID]: '' });
  key(`*\\shell\\${VERB}`, { '@': `Edit with ${name}`, Icon: `"${exe}",0` });
  key(`*\\shell\\${VERB}\\command`, { '@': open });
  key(`Directory\\shell\\${VERB}`, { '@': `Open in ${name}`, Icon: `"${exe}",0` });
  key(`Directory\\shell\\${VERB}\\command`, { '@': open });
  key(`Directory\\Background\\shell\\${VERB}`, { '@': `Open in ${name}`, Icon: `"${exe}",0` });
  key(`Directory\\Background\\shell\\${VERB}\\command`, { '@': `"${exe}" "%V"` });
  return lines.join('\r\n');
}

/** Imports the .reg file (UTF-16 with a BOM, as reg.exe expects). */
function importReg(content) {
  const file = path.join(os.tmpdir(), `tracker-editor-${process.pid}-${Date.now()}.reg`);
  fs.writeFileSync(file, `﻿${content}`, 'utf16le');
  return new Promise((resolve, reject) =>
    execFile('reg.exe', ['import', file], { windowsHide: true, timeout: 20000 }, (err, _out, stderr) => {
      fs.rmSync(file, { force: true });
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(true);
    }),
  );
}

/**
 * The paths the system gave the app to open (Open with, a file dropped on its icon,
 * the command line, a .desktop file's %U), from an argv: [{ path, dir }]. Switches,
 * tracker-editor:// links and the app's own path are left out; file:// URLs and
 * relative paths (from `cwd`) are turned into paths. `skip` is how many leading
 * arguments are the program; `exclude` lists paths that are not files to open (the
 * app's own folder when it runs as `electron .`).
 */
function launchedPaths(argv, { cwd = process.cwd(), skip = 1, scheme = 'tracker-editor', exclude = [] } = {}) {
  const out = [];
  const skipped = new Set(exclude.map((p) => path.resolve(p)));
  for (const arg of argv.slice(skip)) {
    if (typeof arg !== 'string' || !arg || arg.startsWith('-') || arg.startsWith(`${scheme}:`)) continue;
    let p = arg;
    if (/^file:\/\//i.test(arg)) {
      try {
        p = require('node:url').fileURLToPath(arg);
      } catch {
        continue;
      }
    } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(arg)) continue;
    p = path.resolve(cwd, p);
    if (skipped.has(p)) continue;
    try {
      const st = fs.statSync(p);
      if (st.isFile() || st.isDirectory()) out.push({ path: p, dir: st.isDirectory() });
    } catch {
      // not there: ignored
    }
  }
  return out;
}

module.exports = { regFile, importReg, launchedPaths, TEXT_EXTS, PROG_ID, VERB };
