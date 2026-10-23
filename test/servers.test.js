// 0.10: servers from the SSH config, jump hosts (without a server).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseSshConfig, parseHop, hostMatches } = require('../electron/sshConfig.cjs');
const { createRemote } = require('../electron/remote.cjs');

const CONFIG = `
# defaults first apply where nothing more specific came before
Host web
  HostName web.example.com
  User deploy
  IdentityFile ~/.ssh/web_key

Host db db-replica
  HostName %h.internal
  Port 2200
  ProxyJump bastion

Host bastion
  HostName bastion.example.com
  User=jump
  IdentityFile "~/.ssh/my key"

Host legacy
  ProxyCommand ssh -W %h:%p old-gateway
  ProxyJump none

Match host *.example.com
  User nobody

Host !db *
  User everyone
  IdentityFile ~/.ssh/id_default

Include extra.conf
`;

const include = (pattern) => (pattern === 'extra.conf' ? ['Host extra\n  HostName 10.0.0.9\n  User %u\n  Port 2022\n'] : []);

test('SSH config: plain Host names, first value wins, IdentityFile adds up', () => {
  const hosts = parseSshConfig(CONFIG, { readInclude: include, home: '/home/me', localUser: 'me' });
  assert.deepEqual(hosts.map((h) => h.alias), ['web', 'db', 'db-replica', 'bastion', 'legacy', 'extra']);
  const web = hosts.find((h) => h.alias === 'web');
  assert.equal(web.host, 'web.example.com');
  assert.equal(web.user, 'deploy'); // not "everyone": the first value wins
  assert.equal(web.port, 22);
  assert.deepEqual(web.identityFiles, ['/home/me/.ssh/web_key', '/home/me/.ssh/id_default']);
});

test('SSH config: tokens, negated patterns, ProxyJump none, ProxyCommand, Match left out', () => {
  const hosts = parseSshConfig(CONFIG, { readInclude: include, home: '/home/me', localUser: 'me' });
  const db = hosts.find((h) => h.alias === 'db');
  assert.equal(db.host, 'db.internal');
  assert.equal(db.port, 2200);
  assert.equal(db.proxyJump, 'bastion');
  assert.equal(db.user, 'me', '"Host !db *" does not apply to db; the local user then');
  assert.deepEqual(db.identityFiles, []);
  assert.equal(hosts.find((h) => h.alias === 'db-replica').user, 'everyone');
  const bastion = hosts.find((h) => h.alias === 'bastion');
  assert.equal(bastion.user, 'jump', 'Keyword=value works, and Match blocks are not used');
  assert.equal(bastion.identityFiles[0], '/home/me/.ssh/my key', 'quoted values keep their spaces');
  const legacy = hosts.find((h) => h.alias === 'legacy');
  assert.equal(legacy.proxyJump, '');
  assert.equal(legacy.proxyCommand, true);
  const extra = hosts.find((h) => h.alias === 'extra');
  assert.deepEqual([extra.host, extra.user, extra.port], ['10.0.0.9', 'everyone', 2022], 'Include is followed (after "Host !db *", whose User came first)');
  assert.equal(parseSshConfig('Host x\n  User %u\n  IdentityFile %d/.ssh/%r_%h\n', { localUser: 'me', home: '/h' })[0].identityFiles[0], '/h/.ssh/me_x');
});

test('SSH config: patterns and jump specs', () => {
  assert.equal(hostMatches(['*.example.com'], 'a.example.com'), true);
  assert.equal(hostMatches(['*.example.com', '!b.example.com'], 'b.example.com'), false);
  assert.equal(hostMatches(['web?'], 'web1'), true);
  assert.equal(hostMatches(['web?'], 'web12'), false);
  assert.deepEqual(parseHop('ops@gate.example.com:2201'), { user: 'ops', host: 'gate.example.com', port: 2201 });
  assert.deepEqual(parseHop('gate'), { user: '', host: 'gate', port: 22 });
  assert.deepEqual(parseHop('ssh://u@[::1]:2222'), { user: 'u', host: '::1', port: 2222 });
  assert.deepEqual(parseSshConfig('', {}), []);
});

const fakeRemote = () => {
  let stored = {};
  return createRemote({
    store: { read: () => stored, write: (d) => (stored = JSON.parse(JSON.stringify(d))) },
    secrets: { get: () => '', set: () => {} },
    askHostKey: async () => true,
  });
};

test('importing from the SSH config: jump hosts come along, keys found, nothing twice', () => {
  const remote = fakeRemote();
  const hosts = parseSshConfig(CONFIG, { readInclude: include, home: '/home/me', localUser: 'me' });
  const exists = (f) => ['/home/me/.ssh/web_key', '/home/me/.ssh/my key'].includes(f);
  const { made } = remote.importSsh(hosts, ['db', 'web'], { home: '/home/me', exists, agent: false });
  const conns = remote.connections();
  const byName = Object.fromEntries(conns.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['bastion', 'db', 'web']);
  assert.equal(made.length, 3);
  assert.equal(byName.db.jump, byName.bastion.id, 'db is reached through bastion');
  assert.deepEqual([byName.bastion.auth, byName.bastion.keyPath], ['key', '/home/me/.ssh/my key']);
  assert.deepEqual([byName.web.auth, byName.web.keyPath], ['key', '/home/me/.ssh/web_key']);
  assert.equal(byName.db.auth, 'password', 'no key and no agent: a password, asked when connecting');
  // Again: the same servers are reused.
  const again = remote.importSsh(hosts, ['db', 'bastion'], { home: '/home/me', exists, agent: false });
  assert.deepEqual(again.made, []);
  assert.equal(remote.connections().length, 3);
  assert.equal(again.reused.length, 2);
});

test('importing: the agent when one runs, inline jump hosts, loops refused', () => {
  const remote = fakeRemote();
  const hosts = parseSshConfig('Host app\n  HostName app.internal\n  User me\n  ProxyJump ops@gate.example.com:2201,inner\nHost inner\n  HostName 10.1.1.1\n  User me\nHost a\n  ProxyJump b\nHost b\n  ProxyJump a\n', { localUser: 'me', home: '/h' });
  remote.importSsh(hosts, ['app'], { home: '/h', exists: () => false, agent: true });
  const byName = Object.fromEntries(remote.connections().map((c) => [c.name, c]));
  assert.equal(byName.app.auth, 'agent');
  assert.equal(byName.app.jump, byName.inner.id, 'the last hop is the jump host');
  assert.equal(byName.inner.jump, '', 'a Host of the config keeps its own settings');
  assert.deepEqual([byName['gate.example.com'].user, byName['gate.example.com'].port], ['ops', 2201]);
  assert.throws(() => remote.importSsh(hosts, ['a'], { home: '/h', exists: () => false, agent: true }), /lead back to it/);
});

test('jump hosts: only SFTP servers set up here, never in a loop', () => {
  const remote = fakeRemote();
  const gate = remote.saveConnection({ name: 'gate', protocol: 'sftp', host: 'gate', user: 'u' });
  const inner = remote.saveConnection({ name: 'inner', protocol: 'sftp', host: 'inner', user: 'u', jump: gate.id });
  assert.equal(inner.jump, gate.id);
  assert.throws(() => remote.saveConnection({ ...gate, jump: inner.id }), /reached through this server/);
  assert.throws(() => remote.saveConnection({ name: 'x', protocol: 'sftp', host: 'x', jump: 'nonexistent' }), /not set up here/);
  const ftp = remote.saveConnection({ name: 'f', protocol: 'ftp', host: 'f' });
  assert.equal(remote.saveConnection({ name: 'y', protocol: 'ftp', host: 'y', jump: gate.id }).jump, '', 'FTP servers have no jump host');
  assert.throws(() => remote.saveConnection({ name: 'z', protocol: 'sftp', host: 'z', jump: ftp.id }), /not an SFTP server/);
  assert.throws(() => remote.deleteConnection(gate.id), /inner is reached through this server/);
  remote.saveConnection({ ...inner, jump: '' });
  assert.equal(remote.deleteConnection(gate.id), true);
});

test('names from a server never lead outside the folder they are copied into', async () => {
  const { localUnder } = require('../electron/remote.cjs');
  const path = await import('node:path');
  const root = path.resolve('/tmp/mirror-root');
  assert.equal(localUnder(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  for (const bad of ['../x', 'a/../../x', '', 'a//b', './x']) assert.throws(() => localUnder(root, bad), /cannot be a file here/, bad);
});

test('FTP without MLSD: the time a plain listing shows, to the minute', () => {
  const { listedTime } = require('../electron/remote.cjs');
  const now = new Date(2026, 9, 23, 18, 0);
  const at = (raw) => listedTime(raw, now);
  assert.equal(at('Oct 23 14:05'), new Date(2026, 9, 23, 14, 5).getTime());
  assert.equal(at('Oct  3 09:07'), new Date(2026, 9, 3, 9, 7).getTime());
  // No year: a date ahead is last year's (listings show the last 6 months that way).
  assert.equal(at('Dec 30 10:00'), new Date(2025, 11, 30, 10, 0).getTime());
  assert.equal(at('Oct 23 2024'), new Date(2024, 9, 23).getTime());
  assert.equal(at('23 Oct 14:05'), new Date(2026, 9, 23, 14, 5).getTime());
  assert.equal(at('2024-10-23 14:05'), new Date(2024, 9, 23, 14, 5).getTime());
  // Windows / IIS.
  assert.equal(at('10-23-26 02:05PM'), new Date(2026, 9, 23, 14, 5).getTime());
  assert.equal(at('10-23-26 12:15AM'), new Date(2026, 9, 23, 0, 15).getTime());
  assert.equal(at('10-23-2026 14:05'), new Date(2026, 9, 23, 14, 5).getTime());
  // Other languages.
  assert.equal(at('10月 23日 14:05'), new Date(2026, 9, 23, 14, 5).getTime());
  assert.equal(at('okt 23 14:05'), new Date(2026, 9, 23, 14, 5).getTime());
  assert.equal(at('Dez 1 2023'), new Date(2023, 11, 1).getTime());
  for (const bad of ['xyz 1 10:00', '', undefined, 'Oct 23 25:00', 'yesterday']) assert.equal(at(bad), 0, String(bad));
});
