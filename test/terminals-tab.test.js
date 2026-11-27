// Terminals tabs (0.54): the record kept for a tab, how it comes back, the sessions saved by name,
// and what a shell says it runs (OSC 633;E).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanLayout, cleanOutput, cleanSavedSessions, cleanTabRecord, cleanTabTerminal, keptLogin, MAX_SAVED_SESSIONS, MAX_TAB_TERMINALS, recordOfSaved, restorePlan, savedSessionOf, tabRecordPatch, tabTerminalOf, terminalsTabName, withSavedSession } from '../app/js/terminalSessions.js';
import { commandLine, commandStarted } from '../app/js/terminalTabs.js';

const live = (o) => ({ key: 'ta1', term: {}, connId: 'local', cwd: '/home/ana', cwdNow: '', shellId: '', profile: 'bash', shell: 'posix', name: '', keep: '', tmux: false, running: null, offer: null, ...o });

test('a tab terminal: an entry with its id, its shell’s kind, the login it ran and whether tmux keeps it', () => {
  assert.deepEqual(tabTerminalOf(live({ cwdNow: '/home/ana/src', name: '181', running: { command: 'ssh ana@192.0.2.181' } })), {
    id: 'ta1', connId: 'local', cwd: '/home/ana/src', shell: 'bash', name: '181', kind: 'posix', running: 'ssh ana@192.0.2.181',
  });
  // Only logins are kept: another command line is not.
  assert.equal(tabTerminalOf(live({ running: { command: 'mysql -u root -psecret' } })).running, undefined);
  assert.equal(tabTerminalOf(live({ running: { command: 'npm run dev' } })).running, undefined);
  // The login it still offers to run again (brought back, not run yet) stays.
  assert.equal(tabTerminalOf(live({ offer: { line: 'ssh web-1' } })).running, 'ssh web-1');
  // A server's: its tmux name, and tmux only with one.
  assert.deepEqual(tabTerminalOf(live({ connId: 'srv1', keep: 'te-abcd12', tmux: true, profile: '' })), { id: 'ta1', connId: 'srv1', cwd: '/home/ana', shell: '', name: '', keep: 'te-abcd12', kind: 'posix', tmux: true });
  assert.equal(cleanTabTerminal({ id: 'ta1', connId: 'srv1', tmux: true }).tmux, undefined);
  // No id, a bad id, no place: none.
  assert.equal(cleanTabTerminal({ connId: 'local' }), null);
  assert.equal(cleanTabTerminal({ id: '../x', connId: 'local' }), null);
  assert.equal(cleanTabTerminal({ id: 'ta1' }), null);
  // PowerShell reads its own lines.
  assert.equal(keptLogin('C:\\Windows\\System32\\OpenSSH\\ssh.exe 181', 'powershell'), 'C:\\Windows\\System32\\OpenSSH\\ssh.exe 181');
});

test('the layout: every terminal once, the one in use shown, a split of two', () => {
  assert.deepEqual(cleanLayout({ order: ['b', 'zz', 'b', 'a'], active: 'a', split: null }, ['a', 'b', 'c']), { order: ['b', 'a', 'c'], active: 'a', split: null });
  assert.deepEqual(cleanLayout({ order: ['a', 'b', 'c'], active: 'c', split: { left: 'a', right: 'b' } }, ['a', 'b', 'c']), { order: ['a', 'b', 'c'], active: 'a', split: { left: 'a', right: 'b' } });
  assert.equal(cleanLayout({ split: { left: 'a', right: 'a' } }, ['a', 'b']).split, null);
  assert.equal(cleanLayout({ split: { left: 'a', right: 'gone' } }, ['a', 'b']).split, null);
  assert.deepEqual(cleanLayout(null, []), { order: [], active: null, split: null });
});

test('a record from the terminals now; the record as kept', () => {
  const sessions = [live({ key: 'ta1', name: '181', running: { command: 'ssh 181' } }), live({ key: 'tb2', connId: 'srv1', keep: 'te-zzzz99', tmux: true, profile: '' })];
  const patch = tabRecordPatch(sessions, { order: ['ta1', 'tb2'], active: 'tb2', split: { left: 'ta1', right: 'tb2' } });
  assert.deepEqual(patch.terminals.map((t) => t.id), ['ta1', 'tb2']);
  assert.deepEqual(patch.layout, { order: ['ta1', 'tb2'], active: 'tb2', split: { left: 'ta1', right: 'tb2' } });
  const r = cleanTabRecord({ mode: 'terminals', name: '  Servers ', ...patch, runAgain: 1, savedId: 'bad id!', from: 'f:x' });
  assert.deepEqual(Object.keys(r), ['mode', 'name', 'terminals', 'layout', 'runAgain']);
  assert.equal(r.name, 'Servers');
  assert.equal(r.runAgain, true);
  assert.equal(cleanTabRecord({ mode: 'files' }), null);
  assert.equal(cleanTabRecord({ mode: 'terminals' }).name, 'Terminals');
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, connId: 'local' }));
  assert.equal(cleanTabRecord({ mode: 'terminals', terminals: many }).terminals.length, MAX_TAB_TERMINALS);
  assert.equal(terminalsTabName([]), 'Terminals');
  assert.equal(terminalsTabName(['terminals', 'Terminals 2']), 'Terminals 3');
});

test('coming back: output kept, tmux ones attach, logins offered, run by themselves only when the session says so', () => {
  const record = {
    mode: 'terminals',
    name: 'Servers',
    runAgain: false,
    terminals: [
      { id: 'ta', connId: 'local', cwd: '/home/ana', shell: 'pwsh', name: '181', kind: 'powershell', running: 'ssh ana@192.0.2.181' },
      { id: 'tb', connId: 'local', cwd: '/tmp', shell: 'bash', name: '', kind: 'posix', running: 'ssh -t web-1 tmux attach' },
      { id: 'tc', connId: 'srv1', cwd: '/var/www', name: 'web', keep: 'te-abcd12', tmux: true },
      { id: 'td', connId: 'gone', cwd: '/x' },
    ],
    layout: { order: ['tb', 'ta', 'tc', 'td'], active: 'td', split: null },
  };
  const outputs = { ta: { text: '\x1b[32mPS C:\\>\x1b[0m', color: true, cols: 120, rows: 30, at: 5 }, tc: { text: 'not shown: tmux draws it', cols: 80, rows: 24 } };
  const plan = restorePlan(record, { hasPlace: (id) => id !== 'gone', outputs });
  assert.deepEqual(plan.terminals.map((t) => t.id), ['ta', 'tb', 'tc']);
  assert.deepEqual(plan.gone.map((t) => t.id), ['td']);
  assert.deepEqual(plan.layout, { order: ['tb', 'ta', 'tc'], active: 'tb', split: null });
  const [a, b, c] = plan.terminals;
  assert.deepEqual(a.output, { text: '\x1b[32mPS C:\\>\x1b[0m', color: true, cols: 120, rows: 30, at: 5 });
  assert.equal(a.offer.host, '192.0.2.181');
  assert.equal(a.autoRun, false, 'not unless the session says so');
  assert.equal(b.offer.login, false);
  assert.equal(c.output, null, 'tmux shows its own screen');
  assert.equal(c.keep, 'te-abcd12');
  const again = restorePlan({ ...record, runAgain: true }, { hasPlace: () => true, openKeeps: ['te-abcd12'] });
  assert.equal(again.terminals[0].autoRun, true);
  assert.equal(again.terminals[1].autoRun, false, 'a command run there is offered, never run by itself');
  assert.equal(again.terminals[2].keep, '', 'open elsewhere already: a session of its own');
  assert.equal(restorePlan(record, { outputs, keepOutput: false }).terminals[0].output, null);
  assert.equal(cleanOutput({ text: '' }), null);
  assert.equal(cleanOutput({ text: 'x', cols: 9999 }).cols, 100);
});

test('saved sessions: named copies without output; opened again with ids of their own', () => {
  const record = cleanTabRecord({
    mode: 'terminals',
    name: 'Work',
    runAgain: true,
    terminals: [
      { id: 'ta', connId: 'local', cwd: '/a', shell: 'zsh', name: '181', running: 'ssh 181' },
      { id: 'tb', connId: 'srv1', cwd: '/b', keep: 'te-abcd12', tmux: true },
    ],
    layout: { order: ['ta', 'tb'], active: 'tb', split: { left: 'ta', right: 'tb' } },
  });
  const saved = savedSessionOf(record, { id: 's1', name: 'Servers', at: 9 });
  assert.deepEqual(Object.keys(saved), ['id', 'name', 'terminals', 'layout', 'runAgain', 'savedAt']);
  assert.equal(saved.terminals[0].running, 'ssh 181');
  let list = withSavedSession([], saved);
  list = withSavedSession(list, { ...saved, id: 's2', name: 'Other' });
  list = withSavedSession(list, { ...saved, id: 's3', name: 'servers' }); // the same name: replaces it
  assert.deepEqual(list.map((s) => s.id), ['s3', 's2']);
  assert.equal(cleanSavedSessions([{ id: 'x', name: '', terminals: saved.terminals }, { id: 'y', name: 'Empty', terminals: [] }, null]).length, 0);
  assert.equal(cleanSavedSessions(Array.from({ length: 50 }, (_, i) => ({ ...saved, id: `s${i}`, name: `n${i}` }))).length, MAX_SAVED_SESSIONS);
  let n = 0;
  const opened = recordOfSaved(saved, { newId: () => `tn${++n}` });
  assert.deepEqual(opened.terminals.map((t) => t.id), ['tn1', 'tn2']);
  assert.deepEqual(opened.layout, { order: ['tn1', 'tn2'], active: 'tn2', split: { left: 'tn1', right: 'tn2' } });
  assert.equal(opened.savedId, 's1');
  assert.equal(opened.runAgain, true);
  assert.equal(recordOfSaved({ id: 'z' }, { newId: () => 'tz' }), null);
});

test('what a shell says it runs (OSC 633;E), believed only with its nonce', () => {
  assert.equal(commandLine('E;ssh ana@192.0.2.181;n0nce', 'n0nce'), 'ssh ana@192.0.2.181');
  // Escaped as VS Code's integration writes it: \\ a backslash, \x3b a semicolon, \x0a a line break.
  assert.equal(commandLine('E;echo a\\x3b b \\\\n\\x0aok;n', 'n'), 'echo a; b \\n\nok');
  // PowerShell escapes the backslash as \x5c.
  assert.equal(commandLine('E;C:\\x5cssh.exe 181;n', 'n'), 'C:\\ssh.exe 181');
  for (const [data, nonce] of [['E;ssh evil;other', 'n'], ['E;ssh evil', 'n'], ['E;ssh evil;', ''], ['E;ssh;x;y', 'x'], ['D;0', 'n'], [null, 'n']]) assert.equal(commandLine(data, nonce), null, String(data));
  assert.equal(commandStarted('C'), true);
  assert.equal(commandStarted('D;0'), false);
});
