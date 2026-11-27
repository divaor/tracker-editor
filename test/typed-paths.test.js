// Paths typed in quick open with environment variables (electron/typedPaths.cjs, 0.54): expanded in
// the main process, only variables that hold a path, the platform's separators. In test:phone-node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { expandTyped, expandOnServer, folderVariables, findVariable, isPathValue } = require('../electron/typedPaths.cjs');

const WINDOWS = {
  USERPROFILE: 'C:\\Users\\Ana Ruiz',
  APPDATA: 'C:\\Users\\Ana Ruiz\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Ana Ruiz\\AppData\\Local',
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\Ana Ruiz',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  TEMP: 'C:\\Users\\ANARUI~1\\AppData\\Local\\Temp',
  Path: 'C:\\Windows;C:\\Windows\\System32',
  JAVA_HOME: 'C:\\Program Files\\Java\\jdk-21',
  GITHUB_TOKEN: 'ghp_abc123',
  PROJECTS: 'D:\\work',
  NOT_HERE: 'D:\\gone',
  LIST_DIR: 'C:\\a;C:\\b',
};
const win = { env: WINDOWS, platform: 'win32', home: 'C:\\Users\\Ana Ruiz', exists: (p) => p === 'D:\\work' };
const POSIX = {
  HOME: '/home/ana',
  XDG_CONFIG_HOME: '/home/ana/.config',
  TMPDIR: '/tmp',
  PATH: '/usr/bin:/bin',
  API_KEY: '/AbCdEf0123+xyz=',
  EDITOR: 'vim',
  SITE: '/srv/site',
  OUTER: '/srv/$SITE',
};
const posix = { env: POSIX, platform: 'linux', home: '/home/ana', exists: (p) => ['/srv/site', '/srv/$SITE'].includes(p) };

test('Windows variables: %NAME%, $env:NAME, ${env:NAME}, $NAME, ~, with / or \\', () => {
  assert.deepEqual(expandTyped('%USERPROFILE%\\.tinta\\settings', win), { path: 'C:\\Users\\Ana Ruiz\\.tinta\\settings', expanded: true });
  assert.equal(expandTyped('%USERPROFILE%/.tinta/settings', win).path, 'C:\\Users\\Ana Ruiz\\.tinta\\settings', '/ made \\');
  assert.equal(expandTyped('$env:APPDATA\\Code\\User', win).path, 'C:\\Users\\Ana Ruiz\\AppData\\Roaming\\Code\\User');
  assert.equal(expandTyped('${env:LOCALAPPDATA}/Programs', win).path, 'C:\\Users\\Ana Ruiz\\AppData\\Local\\Programs');
  assert.equal(expandTyped('$USERPROFILE/x', win).path, 'C:\\Users\\Ana Ruiz\\x');
  assert.equal(expandTyped('~/notes', win).path, 'C:\\Users\\Ana Ruiz\\notes');
  assert.equal(expandTyped('%HOMEDRIVE%%HOMEPATH%\\Desktop', win).path, 'C:\\Users\\Ana Ruiz\\Desktop', 'a drive and a rooted path');
  assert.equal(expandTyped('%ProgramFiles(x86)%\\Git', win).path, 'C:\\Program Files (x86)\\Git');
  assert.equal(expandTyped('%JAVA_HOME%\\bin', win).path, 'C:\\Program Files\\Java\\jdk-21\\bin');
  assert.equal(expandTyped('%TEMP%\\', win).path, 'C:\\Users\\ANARUI~1\\AppData\\Local\\Temp\\');
  assert.equal(expandTyped('$HOME\\x', win).path, 'C:\\Users\\Ana Ruiz\\x', 'HOME is the home folder where it is not set');
  assert.equal(expandTyped('"%USERPROFILE%\\My files"', win).path, 'C:\\Users\\Ana Ruiz\\My files', 'quotes around it');
});

test('names: exactly first, then without case, "_" and "-" (User_profile is USERPROFILE)', () => {
  assert.equal(expandTyped('%User_profile%/.tinta/settings', win).path, 'C:\\Users\\Ana Ruiz\\.tinta\\settings');
  assert.equal(expandTyped('%userprofile%', win).path, 'C:\\Users\\Ana Ruiz');
  assert.equal(expandTyped('%App-Data%', win).path, 'C:\\Users\\Ana Ruiz\\AppData\\Roaming');
  const vars = { Home: '/a', HOME: '/b', H_OME: '/c' };
  assert.equal(findVariable('HOME', vars), 'HOME', 'its own name first');
  assert.equal(findVariable('home', vars), 'Home', 'then without case');
  assert.equal(findVariable('h-ome', { H_OME: '/c' }), 'H_OME', 'then without "_" and "-"');
  assert.equal(findVariable('nothing', vars), null);
});

test('only values that are one path: never a token, a list or a command', () => {
  assert.equal(isPathValue('C:\\Users\\x', 'win32'), true);
  assert.equal(isPathValue('C:', 'win32'), true, 'a drive alone (HOMEDRIVE)');
  assert.equal(isPathValue('C:\\a;C:\\b', 'win32'), false, 'a list');
  assert.equal(isPathValue('ghp_abc123', 'win32'), false);
  assert.equal(isPathValue('/usr/bin:/bin', 'linux'), false, 'a list');
  assert.equal(isPathValue('vim', 'linux'), false);
  assert.equal(isPathValue('/a\nb', 'linux'), false);
  const winVars = folderVariables(WINDOWS, win);
  assert.ok(!('GITHUB_TOKEN' in winVars) && !('Path' in winVars) && !('LIST_DIR' in winVars));
  assert.ok('PROJECTS' in winVars, 'a variable of its own that names a folder here');
  assert.ok(!('NOT_HERE' in winVars), 'one that names nothing here is not a folder variable');
  assert.match(expandTyped('%GITHUB_TOKEN%\\x', win).problem, /^No folder variable %GITHUB_TOKEN%/);
  assert.doesNotMatch(expandTyped('%GITHUB_TOKEN%\\x', win).problem, /ghp_/, 'its value is never said');
  assert.match(expandTyped('%Path%', win).problem, /No folder variable %Path%/);
  // A token that starts with "/" is not a folder variable unless it names something here.
  const posixVars = folderVariables(POSIX, posix);
  assert.ok(!('API_KEY' in posixVars) && !('EDITOR' in posixVars) && !('PATH' in posixVars));
  assert.match(expandTyped('$API_KEY/x', posix).problem, /No folder variable \$API_KEY/);
  assert.doesNotMatch(expandTyped('$API_KEY/x', posix).problem, /AbCd/);
  assert.equal(expandTyped('%PROJECTS%\\site', win).path, 'D:\\work\\site');
});

test('POSIX variables: $NAME, ${NAME}, %NAME%, ~', () => {
  assert.deepEqual(expandTyped('$HOME/src', posix), { path: '/home/ana/src', expanded: true });
  assert.equal(expandTyped('${XDG_CONFIG_HOME}/tinta', posix).path, '/home/ana/.config/tinta');
  assert.equal(expandTyped('%HOME%/x', posix).path, '/home/ana/x');
  assert.equal(expandTyped('$HOME\\x\\y', posix).path, '/home/ana/x/y', '\\ made /');
  assert.equal(expandTyped('~', posix).path, '/home/ana');
  assert.equal(expandTyped('~/', posix).path, '/home/ana/');
  assert.equal(expandTyped('$TMPDIR//a', posix).path, '/tmp/a', 'no doubled separators');
  assert.equal(expandTyped('$SITE/www', posix).path, '/srv/site/www');
});

test('expanded once; a missing variable is named, with the nearest folder variable', () => {
  assert.equal(expandTyped('$OUTER/x', posix).path, '/srv/$SITE/x', 'a value holding $SITE is not expanded again');
  assert.equal(expandTyped('$HOME/$SITE', posix).path, '/home/ana//srv/site'.replace('//', '/'), 'two in one path');
  assert.deepEqual(expandTyped('%USERPROFLE%\\x', win), { problem: 'No folder variable %USERPROFLE%; did you mean %USERPROFILE%?' });
  assert.deepEqual(expandTyped('$HOEM/x', posix), { problem: 'No folder variable $HOEM; did you mean $HOME?' });
  assert.deepEqual(expandTyped('${NOPE}/x', posix), { problem: 'No folder variable ${NOPE}.' });
  assert.deepEqual(expandTyped('$env:NOPE', win), { problem: 'No folder variable $env:NOPE.' });
  assert.match(expandTyped('%NOPE%\\%USERPROFLE%', win).problem, /%NOPE%/, 'the first one missing');
});

test('paths without variables stay as typed; a $ inside a name is not a variable', () => {
  assert.deepEqual(expandTyped('C:\\$Recycle.Bin', win), { path: 'C:\\$Recycle.Bin', expanded: false });
  assert.deepEqual(expandTyped('\\\\server\\c$\\share', win), { path: '\\\\server\\c$\\share', expanded: false });
  assert.deepEqual(expandTyped('/tmp/a$b', posix), { path: '/tmp/a$b', expanded: false });
  assert.deepEqual(expandTyped('C:\\100%\\x', win), { path: 'C:\\100%\\x', expanded: false });
  assert.equal(expandTyped('\\\\nas\\%USERNAME%', { ...win, env: { ...WINDOWS } }).problem, 'No folder variable %USERNAME%.');
  assert.deepEqual(expandTyped('', posix), { problem: 'That is not a path.' });
  assert.deepEqual(expandTyped('a\nb', posix), { problem: 'That is not a path.' });
  assert.deepEqual(expandTyped(null, posix), { problem: 'That is not a path.' });
  assert.deepEqual(expandTyped('~/x', { ...posix, home: '' }), { problem: 'The home folder is not known here.' });
});

test('on a server: ~ and $HOME are its home', () => {
  assert.equal(expandOnServer('~/www', '/home/me'), '/home/me/www');
  assert.equal(expandOnServer('~', '/home/me/'), '/home/me');
  assert.equal(expandOnServer('$HOME/site', '/home/me'), '/home/me/site');
  assert.equal(expandOnServer('${HOME}', '/'), '/');
  assert.equal(expandOnServer('/var/www', '/home/me'), '/var/www');
  assert.equal(expandOnServer('~other/x', '/home/me'), '~other/x', 'another user’s home is not known');
  assert.equal(expandOnServer('$HOMEBREW/x', '/home/me'), '$HOMEBREW/x');
});
