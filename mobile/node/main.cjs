// The Android app's own Node.js (nodejs-mobile, started by NodeService in a process of its
// own) runs the desktop app's main process, electron/main.cjs, so the folders view, servers
// (SFTP, FTP, FTPS), terminals over SSH, mirrors, transfers and find in a folder work on the
// phone as on a computer. require('electron') gets electronShim.cjs; the page reaches the
// handlers through bridge.cjs on 127.0.0.1.
//
// argv[2] is the start configuration from the app (JSON): { token, nativeToken, portFile,
// projectDir, nativeLibDir, paths: { userData, home, documents, downloads, desktop, temp },
// secretKey, origin, version }.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { fillIn } = require('./phone.cjs');
const { createBridge } = require('./bridge.cjs');

// Its output goes to node.log ("Send a log"): never the configuration, which holds the tokens.
const filled = fillIn();
const config = JSON.parse(process.argv[2] ?? '{}');
const here = config.projectDir ?? path.join(__dirname, '..');
console.log(`Node.js ${process.version} (${process.arch}), app ${config.version ?? '?'}${filled.length ? `; filled in: ${filled.join(', ')}` : ''}`);

// Where things go: the app's own folders (temporary files, settings), not the phone's root.
if (config.paths?.temp) process.env.TMPDIR = config.paths.temp;
if (config.paths?.userData) process.env.HOME = path.join(config.paths.userData, 'home');
fs.mkdirSync(process.env.HOME ?? here, { recursive: true });
process.env.TRACKER_ANDROID = '1';
// The terminal panel's shell on the phone.
if (!process.env.SHELL || !fs.existsSync(process.env.SHELL)) process.env.SHELL = fs.existsSync('/system/bin/sh') ? '/system/bin/sh' : '/bin/sh';

const event = {};
const bridge = createBridge({ token: config.token, nativeToken: config.nativeToken, origin: config.origin ?? 'https://localhost', event });
globalThis.__trackerAndroid = { config, bridge };

// Electron, and node-pty for a shell on the phone, are stand-ins here.
const STAND_INS = { electron: path.join(__dirname, 'electronShim.cjs'), '@lydell/node-pty': path.join(__dirname, 'pty.cjs') };
const shimPath = STAND_INS.electron;
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return STAND_INS[request] ?? resolve.call(this, request, ...rest);
};
Object.assign(event, require(shimPath).pageEvent);

// A failing handler must not end the app's file access.
process.on('uncaughtException', (err) => console.error('Uncaught', err));
process.on('unhandledRejection', (err) => console.error('Unhandled', err));

// When the main process cannot load, Node ends at once with the reason in the log (the app
// says it could not start), rather than staying without a port.
try {
  require(path.join(here, 'electron', 'main.cjs'));
  require('./android.cjs')(bridge, config);
} catch (err) {
  console.error('The main process could not load:', err?.stack ?? err);
  process.exit(1);
}

bridge.listen(config.port ?? 0).then(
  (port) => {
    console.log(`Listening on 127.0.0.1:${port}`);
    if (!config.portFile) return;
    const tmp = `${config.portFile}.tmp`;
    fs.writeFileSync(tmp, String(port));
    fs.renameSync(tmp, config.portFile);
  },
  (err) => {
    console.error('Could not listen:', err);
    process.exit(1);
  },
);
