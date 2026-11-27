// Folders' list of places and going up (0.54): folders.js topOf, upOf, wideOf, fullCrumbs, placeKey,
// openPlacement; folderList.js driveOf, nestFolders, fitsFilter, folderListModel. Windows paths
// are tested as strings here (the main process uses its own path module for them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullCrumbs, openPlacement, placeKey, topOf, upOf, wideOf } from '../app/js/folders.js';
import { driveColors, driveOf, fitsFilter, folderListModel, nestFolders, openableRows } from '../app/js/folderList.js';
import { FOLDER_COLORS } from '../app/js/tabGroups.js';

test('the top a folder goes up to: a drive, a share, the phone’s storage, a server, else /', () => {
  assert.equal(topOf('F:\\Work_AI\\_worktrees'), 'F:\\');
  assert.equal(topOf('f:/x'), 'F:\\');
  assert.equal(topOf('C:\\'), 'C:\\');
  assert.equal(topOf('\\\\nas\\share\\site\\x'), '\\\\nas\\share');
  assert.equal(topOf('/storage/emulated/0/Documents'), '/storage/emulated/0');
  assert.equal(topOf('/storage/1234-ABCD/DCIM'), '/storage/1234-ABCD');
  assert.equal(topOf('remote://s1/var/www'), 'remote://s1/');
  assert.equal(topOf('/home/ana/src'), '/');
  assert.equal(topOf(''), '');
});

test('up: to the top and no further', () => {
  assert.equal(upOf('F:\\Work_AI'), 'F:\\');
  assert.equal(upOf('F:\\'), null);
  assert.equal(upOf('F:\\Work_AI\\_worktrees\\x'), 'F:\\Work_AI\\_worktrees');
  assert.equal(upOf('\\\\nas\\share\\site'), '\\\\nas\\share');
  assert.equal(upOf('\\\\nas\\share'), null);
  assert.equal(upOf('/home/ana'), '/home');
  assert.equal(upOf('/home'), '/');
  assert.equal(upOf('/'), null);
  assert.equal(upOf('/storage/emulated/0/Documents'), '/storage/emulated/0');
  assert.equal(upOf('/storage/emulated/0'), null, 'the phone’s storage is its top');
  assert.equal(upOf('remote://s1/var'), 'remote://s1/');
  assert.equal(upOf('remote://s1/'), null);
});

test('Allow all: the drive, share or storage; on macOS and Linux the home folder, a volume, else /', () => {
  assert.equal(wideOf('F:\\Work_AI'), 'F:\\');
  assert.equal(wideOf('\\\\nas\\share\\x'), '\\\\nas\\share');
  assert.equal(wideOf('/storage/emulated/0/Download'), '/storage/emulated/0');
  assert.equal(wideOf('/home/ana/src', { home: '/home/ana' }), '/home/ana');
  assert.equal(wideOf('/home/ana', { home: '/home/ana/' }), '/home/ana');
  assert.equal(wideOf('/home', { home: '/home/ana' }), '/', 'above the home folder: all of /');
  assert.equal(wideOf('/Volumes/Data/work', { home: '/Users/ana' }), '/Volumes/Data');
  assert.equal(wideOf('/media/ana/usb/x'), '/media/ana/usb');
  assert.equal(wideOf('/srv/site'), '/');
});

test('the whole path as crumbs: from the drive, the share, ~ or /, a server by its name', () => {
  assert.deepEqual(fullCrumbs('F:\\Work_AI\\_worktrees'), [
    { name: 'F:', path: 'F:\\' },
    { name: 'Work_AI', path: 'F:\\Work_AI' },
    { name: '_worktrees', path: 'F:\\Work_AI\\_worktrees' },
  ]);
  assert.deepEqual(fullCrumbs('F:\\'), [{ name: 'F:', path: 'F:\\' }]);
  assert.deepEqual(fullCrumbs('/home/ana/src/app', { home: '/home/ana' }).map((c) => c.name), ['~', 'src', 'app']);
  assert.equal(fullCrumbs('/home/ana/src', { home: '/home/ana' })[0].path, '/home/ana');
  assert.deepEqual(fullCrumbs('/srv/site', { home: '/home/ana' }), [
    { name: '/', path: '/' },
    { name: 'srv', path: '/srv' },
    { name: 'site', path: '/srv/site' },
  ]);
  assert.deepEqual(fullCrumbs('/storage/emulated/0/Documents').map((c) => c.name), ['Phone storage', 'Documents']);
  assert.deepEqual(fullCrumbs('remote://s1/var/www', { top: 'web' }), [
    { name: 'web', path: 'remote://s1/' },
    { name: 'var', path: 'remote://s1/var' },
    { name: 'www', path: 'remote://s1/var/www' },
  ]);
  assert.deepEqual(fullCrumbs('\\\\nas\\share\\site').map((c) => c.name), ['\\\\nas\\share', 'site']);
});

test('the place a folder is on: a drive, a share, a server, a volume, or here', () => {
  assert.equal(placeKey('F:\\a'), placeKey('f:\\b\\c'));
  assert.notEqual(placeKey('F:\\a'), placeKey('C:\\a'));
  assert.equal(placeKey('\\\\nas\\share\\a'), placeKey('\\\\NAS\\Share\\b'));
  assert.notEqual(placeKey('\\\\nas\\share\\a'), placeKey('\\\\nas\\other\\a'));
  assert.equal(placeKey('remote://s1/a'), 'remote:s1');
  assert.equal(placeKey('/home/ana'), 'here');
  assert.equal(placeKey('/srv/x'), 'here');
  assert.equal(placeKey('/Volumes/Data/x'), '/Volumes/Data');
});

test('openPlacement: in place on the same drive, beside elsewhere, focus when shown', () => {
  const shown = ['F:\\Work_AI'];
  assert.equal(openPlacement('F:\\Client_apps', shown, 'F:\\Work_AI'), 'replace', 'the same drive');
  assert.equal(openPlacement('C:\\xampp\\htdocs', shown, 'F:\\Work_AI'), 'beside', 'another drive');
  assert.equal(openPlacement('E:\\', shown, 'F:\\Work_AI'), 'beside');
  assert.equal(openPlacement('remote://s1/var/www', shown, 'F:\\Work_AI'), 'beside', 'a server');
  assert.equal(openPlacement('f:\\work_ai\\', shown, 'F:\\Work_AI'), 'focus', 'shown already (case and separators aside)');
  assert.equal(openPlacement('F:\\Work_AI\\_worktrees\\x', ['C:\\a', 'F:\\Work_AI'], 'C:\\a'), 'replace', 'inside a folder shown: that one goes there');
  assert.equal(openPlacement('F:\\', ['C:\\a', 'F:\\Work_AI'], 'C:\\a'), 'replace', 'holding a folder shown');
  // Two servers, two places.
  assert.equal(openPlacement('remote://s1/home', ['remote://s1/var'], 'remote://s1/var'), 'replace');
  assert.equal(openPlacement('remote://s2/home', ['remote://s1/var'], 'remote://s1/var'), 'beside');
  assert.equal(openPlacement('/home/ana/x', ['/srv/site'], '/srv/site'), 'replace', 'one disk on Linux');
  assert.equal(openPlacement('/media/ana/usb/x', ['/srv/site'], '/srv/site'), 'beside', 'a mounted volume');
  assert.equal(openPlacement('C:\\x', [], ''), 'replace', 'nothing shown');
  assert.equal(openPlacement('C:\\x', ['F:\\a', 'C:\\y'], ''), 'beside', 'without a current one: the first shown');
});

test('drives: the group each folder goes under', () => {
  assert.deepEqual(driveOf('F:\\Work_AI'), { key: 'f:\\', path: 'F:\\', label: 'F:', kind: 'drive' });
  assert.equal(driveOf('\\\\nas\\share\\x').kind, 'share');
  assert.deepEqual(driveOf('/home/ana/x', { home: '/home/ana' }), { key: '/home/ana', path: '/home/ana', label: 'Home', kind: 'home' });
  assert.deepEqual(driveOf('/srv/www/x'), { key: '/srv', path: '/srv', label: '/srv', kind: 'top' });
  assert.equal(driveOf('/Volumes/Data/x').label, 'Data');
  assert.equal(driveOf('/storage/emulated/0/x').label, 'Phone storage');
  assert.equal(driveOf('remote://s1/x').kind, 'server');
});

// The folders of the screenshot that asked for this.
const PICKED = [
  'F:\\Work_AI', 'C:\\Users\\Ana Ruiz\\Downloads', 'F:\\Client_apps', 'F:\\', 'E:\\', 'C:\\xampp\\htdocs\\shop-dev',
  'F:\\Work_AI\\_worktrees\\airunners-orbit-infra', 'C:\\Users\\Ana Ruiz\\.orbit\\sops\\kanban-test-0126', 'C:\\temp',
  'F:\\Work_AI\\shared\\recovered\\2026-11-02-fer', 'F:\\Work_AI\\ai-scaffold\\scaffold-apps\\rag-pro', 'F:\\Client_apps\\app-frontend',
  'F:\\Work_AI\\_releases\\audio', 'C:\\xampp\\htdocs\\shop_lab', 'F:\\Client_apps\\work', 'F:\\Client_apps\\lab-runs\\demo\\tool-calibration',
  'C:\\Users\\ANARUI~1\\AppData\\Local\\Temp', 'C:\\xampp\\htdocs\\shop_lab\\apps\\tool_calibration\\app', 'F:\\Client_apps\\lab-runs\\php-half-2026-11-23',
  'F:\\Work_AI\\_worktrees\\client_backend-orbit-ac', 'F:\\Work_AI\\shared\\orbit-access', 'C:\\Users\\Ana Ruiz\\Desktop', 'C:\\Users\\Ana Ruiz',
  'F:\\Work_AI\\shared\\orbit-ssh',
];
const tree = (rows) => rows.map((r) => `${'  '.repeat(r.depth)}${r.junction ? '[' : ''}${r.prefix}${r.name}${r.junction ? ']' : ''}`);

test('nesting: folders under the ones that hold them, common parents as one line, the way there muted', () => {
  const f = nestFolders(PICKED.filter((p) => p.startsWith('F:')), 'F:\\');
  assert.equal(f.head, true, 'F:\\ itself was picked');
  assert.deepEqual(tree(f.rows), [
    'Client_apps',
    '  app-frontend',
    '  [lab-runs]',
    '    demo\\tool-calibration',
    '    php-half-2026-11-23',
    '  work',
    'Work_AI',
    '  _releases\\audio',
    '  [_worktrees]',
    '    airunners-orbit-infra',
    '    client_backend-orbit-ac',
    '  ai-scaffold\\scaffold-apps\\rag-pro',
    '  [shared]',
    '    orbit-access',
    '    orbit-ssh',
    '    recovered\\2026-11-02-fer',
  ]);
  const rag = f.rows.find((r) => r.name === 'rag-pro');
  assert.deepEqual([rag.prefix, rag.path], ['ai-scaffold\\scaffold-apps\\', 'F:\\Work_AI\\ai-scaffold\\scaffold-apps\\rag-pro']);
  const c = nestFolders(PICKED.filter((p) => p.startsWith('C:')), 'C:\\');
  assert.equal(c.head, false);
  assert.deepEqual(tree(c.rows), [
    'temp',
    '[Users]',
    '  Ana Ruiz',
    '    .orbit\\sops\\kanban-test-0126',
    '    Desktop',
    '    Downloads',
    '  ANARUI~1\\AppData\\Local\\Temp',
    '[xampp\\htdocs]',
    '  shop_lab',
    '    apps\\tool_calibration\\app',
    '  shop-dev',
  ]);
  // A server's folders, and the paths kept as picked (a picked folder is forgotten by its own name).
  assert.deepEqual(tree(nestFolders(['remote://s1/var/www/a', 'remote://s1/var/www/b', 'remote://s1/home/me'], 'remote://s1/').rows), ['home/me', '[var/www]', '  a', '  b']);
  assert.equal(nestFolders(['c:\\temp'], 'C:\\').rows[0].path, 'c:\\temp');
  assert.deepEqual(tree(nestFolders(['/home/ana/src/a', '/home/ana/notes'], '/home/ana').rows), ['notes', 'src/a']);
});

test('the filter: a name, a * ? pattern, or text anywhere in the path or the server’s name', () => {
  assert.equal(fitsFilter('F:\\Work_AI\\_worktrees\\x', 'worktr'), true);
  assert.equal(fitsFilter('F:\\Work_AI\\_worktrees\\x', 'work_ai'), true);
  assert.equal(fitsFilter('F:\\Work_AI', 'client'), false);
  assert.equal(fitsFilter('C:\\temp', 't*p'), true);
  assert.equal(fitsFilter('C:\\temp\\x', 't*p'), false, 'a pattern is for the name');
  assert.equal(fitsFilter('remote://s1/var/www', 'www'), true);
  assert.equal(fitsFilter('remote://s1/var/www', 'staging', 'Acme staging'), true);
  assert.equal(fitsFilter('remote://s1/', 'staging'), false);
  assert.equal(fitsFilter('anything', '  '), true);
});

test('drive colors: one each, from the folder colors', () => {
  const colors = driveColors([{ key: 'c', path: 'C:\\' }, { key: 'e', path: 'E:\\' }, { key: 'f', path: 'F:\\' }]);
  assert.equal(new Set(colors.values()).size, 3);
  for (const c of colors.values()) assert.ok(FOLDER_COLORS.includes(c));
  assert.deepEqual(driveColors([{ key: 'f', path: 'F:\\' }, { key: 'c', path: 'C:\\' }, { key: 'e', path: 'E:\\' }]), colors, 'the same whatever the order');
});

const SERVERS = [
  { id: 's1', label: 'Acme staging', detail: 'SFTP · ana@192.0.2.205', icon: 'server', state: 'connected' },
  { id: 's2', label: 'Acme prod', detail: 'FTP · ana@192.0.2.151', icon: 'server', state: 'disconnected' },
];

test('the sections: shown, favorites, this computer by drive, servers with their folders, recent, comparisons', () => {
  const sections = folderListModel({
    shown: ['F:\\Work_AI', 'remote://s1/var/www'],
    current: 'F:\\Work_AI',
    roots: PICKED,
    favorites: ['F:\\Client_apps', 'remote://s1/home/ana'],
    recent: ['C:\\temp\\logs', 'remote://s1/etc/nginx', 'F:\\Client_apps', 'F:\\Work_AI', 'C:\\temp'],
    servers: SERVERS,
    saved: [
      { id: 'a', name: '', mode: 'folders', left: { path: 'F:\\Work_AI' }, right: { path: 'remote://s1/var/www' } },
      { id: 'b', name: 'notes', mode: 'files', left: { key: 'f:1' }, right: { key: 'f:2' } },
      { id: 'c', name: 'sync', mode: 'panes', left: { path: 'C:\\temp' }, right: { path: 'E:\\' } },
    ],
    colorOf: (p) => (p === 'F:\\Work_AI' ? '#0e8a8a' : null),
  });
  assert.deepEqual(sections.map((s) => s.id), ['shown', 'favorites', 'computer', 'servers', 'recent', 'saved']);
  const [shown, favorites, computer, servers, recent, saved] = sections;
  assert.deepEqual(shown.rows.map((r) => [r.path, r.current]), [['F:\\Work_AI', true], ['remote://s1/var/www', false]]);
  assert.equal(shown.rows[0].color, '#0e8a8a', 'in its header’s color');
  assert.deepEqual(favorites.rows.map((r) => r.path), ['F:\\Client_apps', 'remote://s1/home/ana']);
  assert.ok(favorites.rows.every((r) => r.favorite));
  const drives = computer.rows.filter((r) => r.type === 'drive');
  assert.deepEqual(drives.map((d) => [d.name, d.pick, d.count]), [['C:', false, 9], ['E:', true, 1], ['F:', true, 14]]);
  assert.equal(new Set(drives.map((d) => d.color)).size, 3, 'a color each');
  const sis = computer.rows.find((r) => r.path === 'F:\\Work_AI');
  assert.deepEqual([sis.shown, sis.current, sis.picked, sis.depth], [true, true, true, 1]);
  const worktrees = computer.rows.find((r) => r.name === '_worktrees');
  assert.deepEqual([worktrees.junction, worktrees.picked, worktrees.color], [true, false, null]);
  assert.equal(computer.rows.find((r) => r.path === 'F:\\Client_apps').favorite, true);
  // Servers: each with the folders used there (not favorites).
  assert.deepEqual(servers.rows.map((r) => (r.type === 'server' ? `server:${r.id}:${r.shown}` : r.path)), ['server:s1:true', 'remote://s1/etc/nginx', 'server:s2:false']);
  // Recent: on this computer, not favorites, picked or shown.
  assert.deepEqual(recent.rows.map((r) => r.path), ['C:\\temp\\logs']);
  // Saved: folder comparisons and two panes.
  assert.deepEqual(saved.rows.map((r) => [r.id, r.mode, r.left, r.right]), [['a', 'folders', 'F:\\Work_AI', 'remote://s1/var/www'], ['c', 'panes', 'C:\\temp', 'E:\\']]);
  // What a click or Enter can take: not the junction lines nor C: (not picked).
  const open = openableRows(sections);
  assert.ok(!open.some((r) => r.junction) && !open.some((r) => r.type === 'drive' && r.name === 'C:'));
  assert.ok(openableRows(sections, { reachable: (p) => p.startsWith('F:') }).some((r) => r.name === '_worktrees'), 'a junction inside a folder picked can open');
});

test('the filter goes across the sections; the folders found are nested among themselves', () => {
  const model = (query) => folderListModel({ shown: ['F:\\Work_AI'], current: 'F:\\Work_AI', roots: PICKED, recent: ['remote://s1/etc/nginx'], servers: SERVERS, query, hereLabel: 'This device' });
  const worktrees = model('orbit');
  assert.deepEqual(worktrees.map((s) => s.id), ['computer']);
  assert.equal(worktrees[0].label, 'This device');
  assert.deepEqual(tree(worktrees[0].rows), [
    'C:',
    '  Users\\Ana Ruiz\\.orbit\\sops\\kanban-test-0126',
    'F:',
    '  [Work_AI]',
    '    [_worktrees]',
    '      airunners-orbit-infra',
    '      client_backend-orbit-ac',
    '    [shared]',
    '      orbit-access',
    '      orbit-ssh',
  ]);
  // Enter takes the first that fits itself: not F:\ (picked, shown for what it holds) nor Work_AI (a common parent here).
  assert.equal(openableRows(model('orbit'), { reachable: (p) => p.startsWith('F:'), matching: true })[0].path, 'C:\\Users\\Ana Ruiz\\.orbit\\sops\\kanban-test-0126');
  assert.equal(openableRows(model('app-front'), { matching: true })[0].path, 'F:\\Client_apps\\app-frontend');
  assert.equal(openableRows(model('nginx'), { matching: true })[0].path, 'remote://s1/etc/nginx', 'not its server');
  assert.deepEqual(model('staging').map((s) => s.id), ['servers'], 'a server by its name, with its folders');
  assert.deepEqual(model('staging')[0].rows.map((r) => r.path), ['remote://s1/', 'remote://s1/etc/nginx']);
  assert.deepEqual(model('nginx')[0].rows.map((r) => r.path), ['remote://s1/', 'remote://s1/etc/nginx']);
  assert.deepEqual(model('zzz'), []);
});
