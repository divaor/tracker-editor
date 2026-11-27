import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginCommand, loginLabel, programName, serverDraftOf, shellWords } from '../app/js/sshCommand.js';

test('a command line in words, as each shell splits it; more than one plain command is none', () => {
  assert.deepEqual(shellWords('ssh  ana@192.0.2.181'), ['ssh', 'ana@192.0.2.181']);
  assert.deepEqual(shellWords(`ssh -o 'ProxyJump bastion' "my host" a\\ b`), ['ssh', '-o', 'ProxyJump bastion', 'my host', 'a b']);
  assert.deepEqual(shellWords('ssh "a\\"b"'), ['ssh', 'a"b']);
  for (const line of ['ssh host; rm -rf ~', 'ssh host | tee log', 'ssh host && ls', 'ssh host > out', 'ssh `whoami`@h', 'ssh $(cat h)', "ssh 'open", 'ssh host\nls', '', '   ']) assert.equal(shellWords(line), null, line);
  // PowerShell: a backslash is a backslash, the backtick escapes, the call operator.
  assert.deepEqual(shellWords('C:\\Windows\\System32\\OpenSSH\\ssh.exe -p 22 a@b', { kind: 'powershell' }), ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', '-p', '22', 'a@b']);
  assert.deepEqual(shellWords("& 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe' host", { kind: 'powershell' }), ['C:\\Program Files\\Git\\usr\\bin\\ssh.exe', 'host']);
  assert.deepEqual(shellWords("ssh 'it''s'", { kind: 'powershell' }), ['ssh', "it's"]);
  assert.equal(shellWords('ssh host; ls', { kind: 'powershell' }), null);
  assert.equal(programName('/usr/bin/ssh'), 'ssh');
  assert.equal(programName('C:\\Windows\\System32\\OpenSSH\\SSH.EXE'), 'ssh');
});

test('ssh: who and where, from the destination, -l, -p, -o and ssh:// addresses', () => {
  assert.deepEqual(loginCommand('ssh ana@192.0.2.181'), { program: 'ssh', line: 'ssh ana@192.0.2.181', user: 'ana', host: '192.0.2.181', port: null, jump: '', identity: '', command: '', login: true, runsAlone: true });
  const c = loginCommand('ssh -p 2222 -i ~/.ssh/id_ed25519 -J jump@bastion -l root web-1');
  assert.equal(c.user, 'root');
  assert.equal(c.port, 2222);
  assert.equal(c.jump, 'jump@bastion');
  assert.equal(c.identity, '~/.ssh/id_ed25519');
  assert.equal(c.login, true);
  assert.equal(loginCommand('ssh -p2222 -vvv -tt host').port, 2222);
  assert.equal(loginCommand('ssh -oPort=2200 -o User=ana host').port, 2200);
  assert.equal(loginCommand('ssh -oPort=2200 -o User=ana host').user, 'ana');
  assert.equal(loginCommand('ssh -o ProxyJump=b host').jump, 'b');
  // The destination's user wins over -l; ssh:// with a port.
  assert.equal(loginCommand('ssh -l other ana@host').user, 'ana');
  assert.deepEqual([loginCommand('ssh ssh://ana@example.com:2022').user, loginCommand('ssh ssh://ana@example.com:2022').host, loginCommand('ssh ssh://ana@example.com:2022').port], ['ana', 'example.com', 2022]);
  // Options after the destination (OpenSSH reads them there), IPv6, a user with an @.
  assert.equal(loginCommand('ssh host -p 2201').port, 2201);
  assert.equal(loginCommand('ssh admin@[fe80::1]').host, 'fe80::1');
  assert.equal(loginCommand('ssh ana@corp.com@gateway').user, 'ana@corp.com');
  // ssh.exe by its path, in PowerShell.
  assert.equal(loginCommand('C:\\Windows\\System32\\OpenSSH\\ssh.exe 181', { kind: 'powershell' }).host, '181');
});

test('a command run there is not a login; lines a shell would expand are not run by themselves', () => {
  const remote = loginCommand('ssh -t web-1 tmux attach');
  assert.equal(remote.command, 'tmux attach');
  assert.equal(remote.login, false);
  assert.equal(remote.runsAlone, false);
  assert.equal(loginCommand('ssh host -- uptime').command, 'uptime');
  assert.equal(loginCommand('ssh $HOST').runsAlone, false);
  assert.equal(loginCommand('ssh %SERVER%', { kind: 'cmd' }).runsAlone, false);
});

test('only ssh, mosh, et and telnet; nothing else is a login, nor options ssh does not have', () => {
  for (const line of ['sudo ssh host', 'sshpass -p secret ssh host', 'scp a host:b', 'ls -la', 'rsync -a x host:y', 'ssh', 'ssh -p', 'ssh -Z host', 'git push', 'echo ssh host', 'TERM=xterm ssh host', 'ssh host; reboot']) assert.equal(loginCommand(line), null, line);
});

test('mosh, et and telnet', () => {
  const m = loginCommand('mosh --ssh="ssh -p 2222" ana@web-1');
  assert.deepEqual([m.program, m.user, m.host, m.port, m.login], ['mosh', 'ana', 'web-1', 2222, true]);
  assert.equal(loginCommand('mosh web-1 -- htop').command, 'htop');
  assert.equal(loginCommand('mosh -p 60001 web-1').port, null, 'mosh -p is its UDP port, not SSH’s');
  const e = loginCommand('et -x ana@web-1:2022');
  assert.deepEqual([e.program, e.user, e.host, e.port], ['et', 'ana', 'web-1', null]);
  assert.equal(loginCommand('et web-1 -c "tail -f log"').login, false);
  const t = loginCommand('telnet -l admin 10.0.0.5 23');
  assert.deepEqual([t.program, t.user, t.host, t.port], ['telnet', 'admin', '10.0.0.5', 23]);
  assert.equal(loginCommand('telnet a b c'), null);
});

test('what the server dialog starts with; telnet is not SSH', () => {
  assert.deepEqual(serverDraftOf(loginCommand('ssh -p 2222 ana@192.0.2.181')), { protocol: 'sftp', name: '192.0.2.181', host: '192.0.2.181', port: 2222, user: 'ana', auth: 'password' });
  const keyed = serverDraftOf(loginCommand('ssh -i ~/.ssh/k -J bastion web-1'));
  assert.equal(keyed.auth, 'key');
  assert.equal(keyed.port, 22);
  assert.equal(keyed.jumpNote, 'bastion');
  assert.equal(serverDraftOf(loginCommand('ssh -o HostName=10.0.0.9 web')).host, '10.0.0.9');
  assert.equal(serverDraftOf(loginCommand('ssh -o HostName=10.0.0.9 web')).name, 'web');
  assert.equal(serverDraftOf(loginCommand('telnet host')), null);
  assert.equal(serverDraftOf(null), null);
  assert.equal(serverDraftOf(loginCommand('ssh $HOST')), null, 'a host the shell fills in');
  assert.equal(loginLabel(loginCommand('ssh -p 2222 ana@192.0.2.181')), 'ana@192.0.2.181:2222');
  assert.equal(loginLabel(loginCommand('ssh admin@fe80::1')), 'admin@[fe80::1]');
});
