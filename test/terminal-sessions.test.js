import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEntries, entryLabel, entryOf, folderName, MAX_RECENT, MAX_SESSION, notOpen, sessionOf, sessionSummary, withRecent } from '../app/js/terminalSessions.js';

const session = (o) => ({ key: Math.random().toString(36), term: {}, connId: 'local', cwd: '', cwdNow: '', shellId: '', profile: '', name: '', runner: false, task: '', ...o });

test('a session is the terminals open now: where each is, its shell and name; run and task terminals left out', () => {
  const list = [
    session({ cwd: '/home/ana/proj', cwdNow: '/home/ana/proj/src', profile: 'zsh' }),
    session({ connId: 'srv1', cwd: '/var/www', name: 'Web logs', profile: 'ignored' }),
    session({ runner: true, cwd: '/home/ana/proj' }),
    session({ task: 'dir:test', cwd: '/x' }),
    session({ cwd: '/home/ana/proj', cwdNow: '/home/ana/proj/src', profile: 'zsh' }), // the same place twice: once
  ];
  assert.deepEqual(sessionOf(list), [
    { connId: 'local', cwd: '/home/ana/proj/src', shell: 'zsh', name: '' },
    { connId: 'srv1', cwd: '/var/www', shell: '', name: 'Web logs' },
  ]);
  // The shell asked for, when the shell did not say its profile yet.
  assert.equal(entryOf(session({ shellId: 'gitbash' })).shell, 'gitbash');
  assert.equal(sessionOf(Array.from({ length: 20 }, (_, i) => session({ cwd: `/d${i}` }))).length, MAX_SESSION);
});

test('recent terminals: newest first, once each, at most MAX_RECENT; odd entries dropped', () => {
  const a = { connId: 'local', cwd: '/a', shell: '', name: '' };
  const b = { connId: 'srv1', cwd: '/b', shell: 'zsh', name: 'B' }; // a server's shell is not kept
  let recent = withRecent([], [a]);
  recent = withRecent(recent, [b]);
  recent = withRecent(recent, [a]);
  assert.deepEqual(recent, [a, { ...b, shell: '' }]);
  assert.deepEqual(cleanEntries([null, 'x', { cwd: '/no-place' }, { connId: 'local', cwd: 5 }]), [{ connId: 'local', cwd: '', shell: '', name: '' }]);
  const many = Array.from({ length: 30 }, (_, i) => ({ connId: 'local', cwd: `/d${i}` }));
  assert.equal(withRecent(many, []).length, MAX_RECENT);
  // The same folder in another shell on this computer is another terminal.
  assert.equal(withRecent([{ connId: 'local', cwd: '/a', shell: 'cmd' }], [{ connId: 'local', cwd: '/a', shell: 'pwsh' }]).length, 2);
});

test('what can be opened again: not open now, and its place still there', () => {
  const entries = [
    { connId: 'local', cwd: '/a', shell: '', name: '' },
    { connId: 'srv1', cwd: '/b', shell: '', name: '' },
    { connId: 'gone', cwd: '/c', shell: '', name: '' },
  ];
  const open = [session({ cwd: '/x', cwdNow: '/a' })];
  assert.deepEqual(
    notOpen(entries, open, (id) => id !== 'gone').map((e) => e.cwd),
    ['/b'],
  );
  // Entries given as entries work too.
  assert.deepEqual(notOpen(entries, [{ connId: 'srv1', cwd: '/b' }]).map((e) => e.cwd), ['/a', '/c']);
});

test('how they read: the name, else the folder; where; the whole path and a shell not the usual one', () => {
  const opts = { serverName: (id) => (id === 'srv1' ? 'web-1' : ''), shellLabel: (id) => (id === 'gitbash' ? 'Git Bash' : id) };
  assert.deepEqual(entryLabel({ connId: 'local', cwd: 'C:\\Users\\ana\\proj\\', shell: 'gitbash', name: '' }, opts), { label: 'proj', where: 'This computer', detail: 'C:\\Users\\ana\\proj\\ · Git Bash' });
  assert.deepEqual(entryLabel({ connId: 'srv1', cwd: '/var/www', shell: '', name: 'Logs' }, opts), { label: 'Logs', where: 'web-1', detail: '/var/www' });
  assert.deepEqual(entryLabel({ connId: 'srv1', cwd: '', shell: '', name: '' }, opts), { label: 'start folder', where: 'web-1', detail: 'Start folder' });
  assert.equal(entryLabel({ connId: 'zz', cwd: '/' }, opts).where, 'zz');
  assert.equal(folderName('/'), '/');
  assert.equal(folderName('/var/www/site'), 'site');
  const four = ['/a', '/b', '/c', '/d'].map((cwd) => ({ connId: 'local', cwd }));
  assert.equal(sessionSummary(four, opts), '4 terminals: a, b, c and 1 more');
  assert.equal(sessionSummary(four.slice(0, 1), opts), '1 terminal: a');
});

test('a shell that changes folder takes its old line in the recent list', () => {
  const before = { connId: 'local', cwd: '/proj', shell: '', name: '' };
  const after = { connId: 'local', cwd: '/proj/src', shell: '', name: '' };
  const other = { connId: 'srv1', cwd: '/b', shell: '', name: '' };
  assert.deepEqual(withRecent([before, other], [after], { drop: [before] }), [after, other]);
  // A place still open in another terminal stays.
  assert.deepEqual(withRecent([before, other], [after, before], { drop: [before] }), [after, before, other]);
});
