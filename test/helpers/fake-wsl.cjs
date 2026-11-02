#!/usr/bin/env node
// A stand-in for wsl.exe, for the tests of WSL places (electron/places.cjs): its distributions
// are described by the JSON file FAKE_WSL_STATE names ({ distros: [{ name, home, path }] }) and
// their files are this machine's. `-l -q` answers in UTF-16 with a byte order mark, as wsl.exe
// does; `-d <name> [-u <user>] --exec <command> <args…>` runs the command here in the
// distribution's home; an unknown name gets wsl.exe's own error, in UTF-16 too.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const state = (() => {
  try {
    return JSON.parse(fs.readFileSync(process.env.FAKE_WSL_STATE, 'utf8'));
  } catch {
    return { distros: [] };
  }
})();
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
const args = process.argv.slice(2);
// No arguments (`node --test` runs this file so): nothing to do.
if (!args.length) process.exit(0);
if (state.log) fs.appendFileSync(state.log, `${JSON.stringify(args)}\n`);

if (args[0] === '-l' || args[0] === '--list') {
  process.stdout.write(utf16(state.distros.map((d) => `${d.name}\r\n`).join('')));
  process.exit(0);
}
let distro = '';
let user = '';
let i = 0;
for (; i < args.length; i++) {
  if (args[i] === '-d' || args[i] === '--distribution') distro = args[++i];
  else if (args[i] === '-u' || args[i] === '--user') user = args[++i];
  else if (args[i] === '--cd') i++;
  else if (args[i] === '--exec' || args[i] === '-e') {
    i++;
    break;
  } else {
    process.stderr.write(utf16(`Invalid command line argument: ${args[i]}\r\n`));
    process.exit(1);
  }
}
const d = state.distros.find((x) => x.name === distro);
if (!d) {
  process.stderr.write(utf16('There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n'));
  process.exit(255);
}
if (user && d.users && !d.users.includes(user)) {
  process.stderr.write(utf16('User not found.\r\nError code: Wsl/Service/CreateInstance/WSL_E_USER_NOT_FOUND\r\n'));
  process.exit(255);
}
const cmd = args.slice(i);
const child = spawn(cmd[0], cmd.slice(1), { cwd: d.home, env: { PATH: d.path ?? '/usr/local/bin:/usr/bin:/bin', HOME: d.home, WSL_DISTRO_NAME: d.name, ...(process.stdin.isTTY ? { TERM: 'xterm-256color' } : {}) }, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
