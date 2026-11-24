// Archives (electron/archives.cjs): 7-Zip in WebAssembly, run in a worker behind a jail. Real
// archives made by the engine itself in a temporary folder, and malicious ones made by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as page from '../app/js/archives.js';

const require = createRequire(import.meta.url);
const A = require('../electron/archives.cjs');
const { zipSync, strToU8 } = require('fflate');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editor-archives-')));

// A folder of files: { 'a/b.txt': 'text' | Buffer, 'empty/': null }.
function tree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (rel.endsWith('/')) fs.mkdirSync(p, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
  }
}
// Every path under `dir` (relative, '/' separated), folders with a trailing slash.
function listAll(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).split(path.sep).join('/');
    if (e.isDirectory()) out.push(`${rel}/`, ...listAll(p, base));
    else out.push(e.isSymbolicLink() ? `${rel}@` : rel);
  }
  return out.sort();
}
// No staging folders left anywhere under `dir`.
const noStaging = (dir) => assert.deepEqual(listAll(dir).filter((p) => /\.part-/.test(p)), []);

// A tar made by hand: entries { name, body?, type: '0' file | '5' folder | '2' symlink | '1' hard link, link? }.
function tarOf(entries) {
  const blocks = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${(e.type === '0' || !e.type ? body.length : 0).toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    if (e.link) h.write(e.link, 157, 100, 'utf8');
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h);
    if (e.type === '0' || !e.type) blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const SAMPLE = {
  'project/readme.md': '# Hello\n'.repeat(1000),
  'project/src/año ñandú.txt': 'unicode name',
  'project/src/blob.bin': Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 31) % 256)),
  'project/src/empty/': null,
  'project/-r': 'a file named like a switch',
  // Windows cannot have * or ? in a name: there the file named like a wildcard is not made.
  ...(process.platform === 'win32' ? {} : { 'project/*star?.txt': 'a file named like a wildcard' }),
  'project/@list.txt': 'a file named like a list file',
};

// RAR 4, CAB and ISO 9660 made by hand (7-Zip reads them but cannot make them): stored files.
let table;
function crc32(buf) {
  table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = ~0;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function rarOf(files) {
  const block = (type, flags, rest) => {
    const h = Buffer.alloc(7 + rest.length);
    h[2] = type;
    h.writeUInt16LE(flags, 3);
    h.writeUInt16LE(h.length, 5);
    rest.copy(h, 7);
    h.writeUInt16LE(crc32(h.subarray(2)) & 0xffff, 0);
    return h;
  };
  const parts = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]), block(0x73, 0, Buffer.alloc(6))];
  for (const { name, body } of files) {
    const data = Buffer.from(body);
    const nameBytes = Buffer.from(name);
    const rest = Buffer.alloc(25 + nameBytes.length);
    rest.writeUInt32LE(data.length, 0);
    rest.writeUInt32LE(data.length, 4);
    rest[8] = 3; // Unix
    rest.writeUInt32LE(crc32(data), 9);
    rest.writeUInt32LE(DOS_DATE << 16, 13);
    rest[17] = 20;
    rest[18] = 0x30; // stored
    rest.writeUInt16LE(nameBytes.length, 19);
    rest.writeUInt32LE(0o100644, 21);
    nameBytes.copy(rest, 25);
    parts.push(block(0x74, 0x8000, rest), data);
  }
  parts.push(block(0x7b, 0x4000, Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function cabOf(files) {
  const entries = files.map(({ name, body }) => ({ name: Buffer.from(`${name}\0`), data: Buffer.from(body) }));
  const all = Buffer.concat(entries.map((e) => e.data));
  const coffFiles = 36 + 8;
  const filesSize = entries.reduce((n, e) => n + 16 + e.name.length, 0);
  const blocks = [];
  for (let at = 0; at < all.length || (at === 0 && !blocks.length); at += 32768) {
    const chunk = all.subarray(at, at + 32768);
    const h = Buffer.alloc(8);
    h.writeUInt16LE(chunk.length, 4);
    h.writeUInt16LE(chunk.length, 6);
    blocks.push(h, chunk);
    if (!all.length) break;
  }
  const dataSize = blocks.reduce((n, b) => n + b.length, 0);
  const head = Buffer.alloc(36);
  head.write('MSCF', 0, 'latin1');
  head.writeUInt32LE(coffFiles + filesSize + dataSize, 8);
  head.writeUInt32LE(coffFiles, 16);
  head[24] = 3;
  head[25] = 1;
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(entries.length, 28);
  const folder = Buffer.alloc(8);
  folder.writeUInt32LE(coffFiles + filesSize, 0);
  folder.writeUInt16LE(blocks.length / 2, 4);
  let offset = 0;
  const fileRecords = entries.map((e) => {
    const r = Buffer.alloc(16);
    r.writeUInt32LE(e.data.length, 0);
    r.writeUInt32LE(offset, 4);
    r.writeUInt16LE(DOS_DATE, 10);
    r.writeUInt16LE(0x20, 14);
    offset += e.data.length;
    return Buffer.concat([r, e.name]);
  });
  return Buffer.concat([head, folder, ...fileRecords, ...blocks]);
}

function isoOf(files) {
  const S = 2048;
  const both32 = (b, at, v) => (b.writeUInt32LE(v, at), b.writeUInt32BE(v, at + 4));
  const both16 = (b, at, v) => (b.writeUInt16LE(v, at), b.writeUInt16BE(v, at + 2));
  const record = (id, lba, size, dir) => {
    const idBytes = typeof id === 'number' ? Buffer.from([id]) : Buffer.from(id, 'latin1');
    const len = 33 + idBytes.length + (idBytes.length % 2 === 0 ? 1 : 0);
    const r = Buffer.alloc(len);
    r[0] = len;
    both32(r, 2, lba);
    both32(r, 10, size);
    r.set([120, 1, 1, 0, 0, 0, 0], 18);
    r[25] = dir ? 2 : 0;
    both16(r, 28, 1);
    r[32] = idBytes.length;
    idBytes.copy(r, 33);
    return r;
  };
  const ROOT = 20;
  let lba = 21;
  const placed = files.map(({ name, body }) => {
    const data = Buffer.from(body);
    const at = lba;
    lba += Math.max(1, Math.ceil(data.length / S));
    return { name: `${name.toUpperCase()};1`, data, at };
  });
  const total = lba;
  const image = Buffer.alloc(total * S);
  const pvd = image.subarray(16 * S, 17 * S);
  pvd[0] = 1;
  pvd.write('CD001', 1, 'latin1');
  pvd[6] = 1;
  pvd.fill(0x20, 8, 72);
  pvd.write('TEST', 40, 'latin1');
  both32(pvd, 80, total);
  both16(pvd, 120, 1);
  both16(pvd, 124, 1);
  both16(pvd, 128, S);
  both32(pvd, 132, 10);
  pvd.writeUInt32LE(18, 140);
  pvd.writeUInt32BE(19, 148);
  record(0, ROOT, S, true).copy(pvd, 156);
  pvd[881] = 1;
  const term = image.subarray(17 * S, 18 * S);
  term[0] = 255;
  term.write('CD001', 1, 'latin1');
  term[6] = 1;
  // Path tables: the root alone.
  const lpt = image.subarray(18 * S);
  lpt[0] = 1;
  lpt.writeUInt32LE(ROOT, 2);
  lpt.writeUInt16LE(1, 6);
  const mpt = image.subarray(19 * S);
  mpt[0] = 1;
  mpt.writeUInt32BE(ROOT, 2);
  mpt.writeUInt16BE(1, 6);
  let at = ROOT * S;
  for (const r of [record(0, ROOT, S, true), record(1, ROOT, S, true), ...placed.map((p) => record(p.name, p.at, p.data.length, false))]) {
    r.copy(image, at);
    at += r.length;
  }
  for (const p of placed) p.data.copy(image, p.at * S);
  return image;
}

// ---- Names, kinds and command lines -------------------------------------------------------

test('names that may be written, here and on Windows', () => {
  for (const ok of ['a.txt', 'año', 'con.txt', 'a:b', 'trailing.', '...x']) assert.equal(A.safeName(ok, false), true, ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '..\\x', 'nul\u0000', 'tab\tname', 'x'.repeat(256)]) assert.equal(A.safeName(bad, false), false, JSON.stringify(bad));
  for (const bad of ['con.txt', 'NUL', 'com1.log', 'a:b', 'what?', 'a*b', 'a<b', 'pipe|', 'trailing.', 'space ', '.. ']) assert.equal(A.safeName(bad, true), false, bad);
  assert.equal(A.safeName('normal name.txt', true), true);
});

test('archives by name: the folder each extracts to', () => {
  const cases = { 'photos.tar.gz': ['.tar.gz', 'photos'], 'backup.7z.001': ['.7z.001', 'backup'], 'a.TGZ': ['.tgz', 'a'], 'site.zip': ['.zip', 'site'], 'log.txt.gz': ['.gz', 'log.txt'], 'app.apk': ['.apk', 'app'], 'disc.iso': ['.iso', 'disc'], 'b.zip.002': ['.zip.002', 'b'], 'notes.txt': ['', 'notes'], '.zip': ['', 'Archive'], 'x.rar': ['.rar', 'x'] };
  for (const [name, [ext, stem]] of Object.entries(cases)) {
    assert.equal(A.archiveExt(name), ext, name);
    assert.equal(A.stemOf(name), stem, name);
    // The page's copy agrees.
    assert.equal(page.archiveExt(name), ext, name);
    assert.equal(page.stemOf(name), stem, name);
  }
  assert.equal(page.isArchiveName('a.tar.xz'), true);
  assert.equal(page.isArchiveName('a.docx'), false);
  assert.equal(page.laterVolume('b.7z.002'), true);
  assert.equal(page.laterVolume('b.7z.001'), false);
});

test('the page’s fixed choices are the main process’s', () => {
  assert.deepEqual(page.ARCHIVE_EXTS, A.ARCHIVE_EXTS);
  assert.deepEqual(page.COMPRESS_FORMATS.map((f) => f.id), Object.keys(A.COMPRESS_FORMATS));
  for (const f of page.COMPRESS_FORMATS) {
    const m = A.COMPRESS_FORMATS[f.id];
    assert.deepEqual([f.ext, f.password, f.hideNames, f.levels], [m.ext, m.password, m.hideNames, m.levels], f.id);
  }
  assert.deepEqual(Object.fromEntries(page.LEVELS.map((l) => [l.id, l.mx])), A.LEVELS);
  assert.deepEqual(page.EXCLUDE_GROUPS.map((g) => g.id), Object.keys(A.EXCLUDE_GROUPS));
  for (const g of page.EXCLUDE_GROUPS) {
    const m = A.EXCLUDE_GROUPS[g.id];
    assert.deepEqual([g.dirs ?? [], g.files ?? [], g.prefix ?? ''], [m.dirs ?? [], m.files ?? [], m.prefix ?? ''], g.id);
  }
  // Split sizes the page offers fit the main process's limits.
  for (const s of page.SPLIT_SIZES.filter((x) => x.mb)) assert.doesNotThrow(() => A.compressChoices({ volume: page.splitBytes(s.id) }));
  assert.equal(page.splitBytes('off'), null);
  assert.equal(page.splitBytes('custom', '2.5'), 2.5 * 1024 * 1024);
  assert.ok(Number.isNaN(page.splitBytes('custom', 'lots')));
});

test('command lines: only fixed switches before "--", every name after it as a path in a mount', () => {
  const pw = '-r --help @x *';
  const c = A.compressChoices({ format: '7z', level: 'ultra', password: pw, hideNames: true, volume: 1024 * 1024, exclude: ['deps', 'nope', 'junk'] });
  assert.deepEqual(c.exclude, ['deps', 'junk']);
  for (const steps of [A.compressArgs(c, ['/s0/-r', '/s0/@x']), A.compressArgs(A.compressChoices({ format: 'tar.gz' }), ['/s0/*'])]) {
    for (const args of steps) {
      const dash = args.indexOf('--');
      assert.ok(dash > 0);
      // Before it: fixed switches, and the password glued to -p.
      for (const a of args.slice(1, dash)) assert.match(a, /^-(t(zip|7z|tar|gzip|xz|bzip2)|bd|y|spd|sccUTF-8|mx\d|mcu=on|mem=AES256|mhe=on|v\d+b|p.*)$/, a);
      // After it: absolute paths only.
      for (const a of args.slice(dash + 1)) assert.match(a, /^\//, a);
    }
  }
  assert.ok(A.compressArgs(c, ['/s0/a'])[0].includes(`-p${pw}`));
  for (const args of [A.listArgs('/src/-x.zip', 'p'), A.extractArgs('/src/@y.7z', '/out/content', 'p', 'tar')]) {
    const dash = args.indexOf('--');
    assert.ok(args.includes('-spd'), 'wildcards off');
    assert.equal(args.length, dash + 2);
    assert.match(args.at(-1), /^\/src\//);
  }
  // Nothing outside the lists gets through.
  assert.throws(() => A.compressChoices({ format: 'tar', password: 'x' }), /no password/);
  assert.throws(() => A.compressChoices({ volume: 10 }), /64 KB/);
  assert.throws(() => A.compressChoices({ volume: '1e3' }), /64 KB/);
  assert.throws(() => A.compressChoices({ password: 'a\u0000b' }), /cannot be used/);
  assert.deepEqual(A.compressChoices({ format: '-tzip', level: '-mx9' }).format, 'zip');
  assert.equal(A.compressChoices({ format: 'zip', password: 'x', hideNames: true }).hideNames, false, 'zip cannot hide names');
  assert.equal(A.compressChoices({ format: '7z', hideNames: true }).hideNames, false, 'only with a password');
});

test('archives by their first bytes', async () => {
  assert.equal(A.sniffArchive(Buffer.from('PK\x03\x04rest', 'latin1')), 'zip');
  assert.equal(A.sniffArchive(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])), '7z');
  assert.equal(A.sniffArchive(Buffer.from('Rar!\x1a\x07\x01\x00', 'latin1')), 'rar');
  assert.equal(A.sniffArchive(Buffer.from([0x1f, 0x8b, 0x08, 0])), 'gzip');
  assert.equal(A.sniffArchive(Buffer.from('BZh91AY&SY', 'latin1')), 'bzip2');
  assert.equal(A.sniffArchive(Buffer.from('BZh9 text', 'latin1')), null);
  assert.equal(A.sniffArchive(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0])), 'xz');
  assert.equal(A.sniffArchive(Buffer.from('MSCF\0\0\0\0', 'latin1')), 'cab');
  assert.equal(A.sniffArchive(tarOf([{ name: 'a.txt', body: 'x' }])), 'tar');
  const iso = Buffer.alloc(34000);
  iso.write('\x01CD001', 32768, 'latin1');
  assert.equal(A.sniffArchive(iso), 'iso');
  assert.equal(A.sniffArchive(Buffer.from('just some text')), null);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'no-extension'), zipSync({ 'a.txt': strToU8('hi') }));
  assert.equal(A.sniffFile(path.join(dir, 'no-extension')), 'zip');
});

test('a technical listing read', () => {
  const text = ['Listing archive: a.zip', '', '--', 'Path = a.zip', 'Type = zip', 'Physical Size = 698', '', '----------', 'Path = src', 'Folder = +', 'Size = 0', 'Packed Size = 0', 'Modified = 2026-01-02 03:04:05.7230000', 'Attributes = D drwxr-xr-x', 'Encrypted = -', '', 'Path = src/a.txt', 'Folder = -', 'Size = 6', 'Packed Size = 34', 'Modified = 2026-01-02 03:04:05', 'Encrypted = +', 'Method = AES-256 Deflate', '', 'Path = src/l', 'Size = 0', 'Symbolic Link = /etc/passwd', ''].join('\n');
  const got = A.parseListing(text);
  assert.equal(got.type, 'zip');
  assert.equal(got.physical, 698);
  assert.deepEqual(got.entries.map((e) => [e.name, e.dir, e.size, e.packed, e.encrypted, e.link]), [['src', true, 0, 0, false, false], ['src/a.txt', false, 6, 34, true, false], ['src/l', false, 0, 0, false, true]]);
  assert.equal(got.entries[1].mtime, new Date(2026, 0, 2, 3, 4, 5).getTime());
  assert.deepEqual(A.topNames([{ name: '/abs.txt' }, { name: './a/b' }, { name: '../up/x' }, { name: 'C:/d.txt' }, { name: 'a' }]), ['abs.txt', 'a', 'up', 'd.txt']);
  assert.equal(A.problemOf('ERROR: Wrong password : a.txt'), 'password');
  assert.equal(A.problemOf('ERROR: x.7z : Cannot open encrypted archive. Wrong password?'), 'password');
  assert.equal(A.problemOf('ERROR: Data Error : a.bin'), 'damaged');
  assert.equal(A.problemOf('Everything is Ok'), null);
});

// ---- Round trips ------------------------------------------------------------------------------

test('every format: compressed, listed and extracted, names and contents whole', async () => {
  const dir = tmp();
  tree(dir, SAMPLE);
  for (const format of Object.keys(A.COMPRESS_FORMATS)) {
    const got = await A.compressPaths([path.join(dir, 'project')], dir, `p-${format}`, { format });
    assert.equal(got.made.length, 1, format);
    assert.equal(path.basename(got.made[0]), `p-${format}${A.COMPRESS_FORMATS[format].ext}`);
    assert.equal(got.files, 6);
    const info = await A.listArchive(got.made[0]);
    assert.equal(info.type, format === 'tar.gz' ? 'tar.gz' : format, format);
    assert.deepEqual(info.tops, ['project'], format);
    assert.equal(info.files, 6, format);
    assert.ok(info.entries.some((e) => e.name === 'project/src/año ñandú.txt' && e.size === 12), format);
    const x = await A.extractArchive(got.made[0], { to: 'folder' });
    assert.equal(path.basename(x.folder), `p-${format}`);
    assert.equal(x.files, 6, format);
    assert.deepEqual(listAll(x.folder), listAll(dir).filter((p) => p.startsWith('project/')).map((p) => p).sort().filter((p) => !p.includes('p-')), format);
    for (const rel of Object.keys(SAMPLE).filter((r) => !r.endsWith('/'))) {
      assert.ok(fs.readFileSync(path.join(x.folder, rel)).equals(fs.readFileSync(path.join(dir, rel))), `${format}: ${rel}`);
    }
    assert.ok(fs.statSync(path.join(x.folder, 'project/src/empty')).isDirectory(), format);
  }
  noStaging(dir);
});

test('levels: store keeps the bytes as they are, ultra makes it smallest', async () => {
  const dir = tmp();
  tree(dir, { 'text/a.txt': 'all work and no play '.repeat(20000) });
  const sizes = {};
  for (const level of ['store', 'fastest', 'ultra']) {
    const got = await A.compressPaths([path.join(dir, 'text')], dir, `t-${level}`, { format: '7z', level });
    sizes[level] = got.size;
    const info = await A.listArchive(got.made[0]);
    if (level === 'store') assert.match(info.entries.find((e) => !e.dir).method, /Copy/);
  }
  assert.ok(sizes.store > 400000, `${sizes.store}`);
  assert.ok(sizes.ultra < sizes.fastest && sizes.fastest < sizes.store / 50, JSON.stringify(sizes));
  // A zip stores what does not compress.
  tree(dir, { 'media/photo.jpg': crypto.randomBytes(300000) });
  const zip = await A.compressPaths([path.join(dir, 'media')], dir, 'media', { format: 'zip', level: 'normal' });
  const photo = (await A.listArchive(zip.made[0])).entries.find((e) => e.name === 'media/photo.jpg');
  assert.ok(photo.packed <= photo.size + 64, `${photo.packed} for ${photo.size}`);
});

test('what is left out: links, and the groups ticked (never what was picked itself)', async (t) => {
  const dir = tmp();
  tree(dir, {
    'app/src/index.js': 'code',
    'app/node_modules/x/i.js': 'dep',
    'app/.git/HEAD': 'ref',
    'app/dist/out.js': 'built',
    'app/build.sh': 'a file named like a build folder stays',
    'app/.DS_Store': 'junk',
    'app/src/._index.js': 'junk',
    'app/src/Thumbs.db': 'junk',
    'outside.txt': 'outside the folder',
    'node_modules/y/j.js': 'picked itself',
  });
  try {
    fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(dir, 'app', 'link.txt'));
    fs.symlinkSync('../outside.txt', path.join(dir, 'app', 'src', 'rel-link.txt'));
  } catch {
    t.diagnostic('no symlinks here');
  }
  const got = await A.compressPaths([path.join(dir, 'app'), path.join(dir, 'node_modules')], dir, 'app', { format: 'zip', exclude: ['deps', 'vcs', 'build', 'junk'] });
  const names = (await A.listArchive(got.made[0])).entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['app', 'app/build.sh', 'app/src', 'app/src/index.js', 'node_modules', 'node_modules/y', 'node_modules/y/j.js']);
  if (fs.existsSync(path.join(dir, 'app', 'link.txt'))) assert.deepEqual(got.leftOut.map((l) => l.name).sort(), ['app/link.txt', 'app/src/rel-link.txt']);
  // Nothing ticked: all but the links.
  const all = await A.compressPaths([path.join(dir, 'app')], dir, 'all', { format: 'tar', exclude: [] });
  const allNames = (await A.listArchive(all.made[0])).entries.map((e) => e.name);
  assert.ok(allNames.includes('app/node_modules/x/i.js') && allNames.includes('app/.git/HEAD') && allNames.includes('app/src/._index.js'));
  assert.ok(!allNames.some((n) => /link/.test(n)));
});

test('several picked from different folders; the name taken already gets a number', async () => {
  const dir = tmp();
  tree(dir, { 'a/one.txt': '1', 'b/two.txt': '2', 'Archive.zip': 'already here' });
  const got = await A.compressPaths([path.join(dir, 'a', 'one.txt'), path.join(dir, 'b', 'two.txt')], dir, 'Archive', { format: 'zip' });
  assert.equal(path.basename(got.made[0]), 'Archive (2).zip');
  assert.equal(fs.readFileSync(path.join(dir, 'Archive.zip'), 'utf8'), 'already here');
  assert.deepEqual((await A.listArchive(got.made[0])).entries.map((e) => e.name).sort(), ['one.txt', 'two.txt']);
  await assert.rejects(A.compressPaths([path.join(dir, 'a')], dir, 'bad/name', {}), /cannot have/);
});

// ---- Passwords ---------------------------------------------------------------------------------

test('passwords: zip with AES-256, 7z with the names hidden; right, wrong and none', async () => {
  const dir = tmp();
  tree(dir, { 'secret/plan.txt': 'the plan', 'secret/sub/more.txt': 'more' });
  // A zip's password is plain ASCII (7-Zip cannot make one with others); a 7z's can be anything.
  await assert.rejects(A.compressPaths([path.join(dir, 'secret')], dir, 's', { format: 'zip', password: 'pässwörd' }), /no accents/);
  const zip = await A.compressPaths([path.join(dir, 'secret')], dir, 's', { format: 'zip', password: 'pass word 1!' });
  const listing = await A.listArchive(zip.made[0]);
  assert.equal(listing.encrypted, 2, 'the names show, the files are encrypted');
  assert.ok(listing.entries.filter((e) => !e.dir).every((e) => /AES-256/.test(e.method)), 'AES, never ZipCrypto');
  const seven = await A.compressPaths([path.join(dir, 'secret')], dir, 's', { format: '7z', password: 'pässwörd 1', hideNames: true });
  assert.deepEqual(await A.listArchive(seven.made[0]), { needsPassword: true, wrong: false }, 'names hidden without the password');
  assert.deepEqual(await A.listArchive(seven.made[0], { password: 'nope' }), { needsPassword: true, wrong: true });
  assert.equal((await A.listArchive(seven.made[0], { password: 'pässwörd 1' })).files, 2);
  for (const [file, pw] of [[zip.made[0], 'pass word 1!'], [seven.made[0], 'pässwörd 1']]) {
    assert.deepEqual(await A.extractArchive(file, { to: 'folder' }), { needsPassword: true, wrong: false });
    assert.deepEqual(await A.extractArchive(file, { to: 'folder', password: 'wrong' }), { needsPassword: true, wrong: true });
    const x = await A.extractArchive(file, { to: 'folder', password: pw });
    assert.equal(fs.readFileSync(path.join(x.folder, 'secret', 'plan.txt'), 'utf8'), 'the plan');
  }
  // tar formats have none.
  await assert.rejects(A.compressPaths([path.join(dir, 'secret')], dir, 't', { format: 'tar.gz', password: 'x' }), /no password/);
  noStaging(dir);
});

test('a 7z of one file with its names hidden: a wrong password is said, not a crash (volumes too)', async () => {
  // With a wrong password this 7-Zip build stops on the header it decrypts (it cannot catch its own
  // errors): the hidden names are found in the archive itself, so the page is asked for the password.
  const dir = tmp();
  tree(dir, { 'plan.md': '# The plan\n' });
  const one = (await A.compressPaths([path.join(dir, 'plan.md')], dir, 'secret', { format: '7z', password: 'open sesame', hideNames: true })).made[0];
  tree(dir, { 'big/a.bin': crypto.randomBytes(200 * 1024) });
  const parts = (await A.compressPaths([path.join(dir, 'big')], dir, 'parts', { format: '7z', password: 'open sesame', hideNames: true, volume: 64 * 1024 })).made;
  assert.ok(parts.length > 2);
  for (const file of [one, parts[0]]) {
    assert.deepEqual(await A.listArchive(file), { needsPassword: true, wrong: false });
    assert.deepEqual(await A.listArchive(file, { password: 'wrong' }), { needsPassword: true, wrong: true });
    assert.deepEqual(await A.extractArchive(file, { to: 'folder', password: 'wrong' }), { needsPassword: true, wrong: true });
    assert.ok((await A.listArchive(file, { password: 'open sesame' })).files >= 1);
  }
  const x = await A.extractArchive(one, { to: 'folder', password: 'open sesame' });
  assert.equal(fs.readFileSync(path.join(x.folder, 'plan.md'), 'utf8'), '# The plan\n');
  // A 7z without a password: its names are not hidden.
  const plain = (await A.compressPaths([path.join(dir, 'plan.md')], dir, 'plain', { format: '7z' })).made[0];
  assert.equal((await A.listArchive(plain)).files, 1);
  noStaging(dir);
});

test('a ZipCrypto archive made elsewhere opens with its password', async (t) => {
  const dir = tmp();
  tree(dir, { 'old/a.txt': 'legacy' });
  const { spawnSync } = await import('node:child_process');
  const made = spawnSync('zip', ['-r', '-P', 'legacy pw', 'old.zip', 'old'], { cwd: dir });
  if (made.error || made.status !== 0) return t.skip('no zip command here');
  assert.deepEqual(await A.extractArchive(path.join(dir, 'old.zip'), { to: 'folder', password: 'nope' }), { needsPassword: true, wrong: true });
  const x = await A.extractArchive(path.join(dir, 'old.zip'), { to: 'folder', name: 'old-out', password: 'legacy pw' });
  assert.equal(fs.readFileSync(path.join(x.folder, 'old', 'a.txt'), 'utf8'), 'legacy');
});

// ---- Extract here ----------------------------------------------------------------------------

test('extract here: names already there replaced, kept both or skipped', async () => {
  const dir = tmp();
  tree(dir, { 'src/a.txt': 'new a', 'src/dir/b.txt': 'new b', 'src/c.txt': 'new c' });
  const zip = (await A.compressPaths([path.join(dir, 'src', 'a.txt'), path.join(dir, 'src', 'dir'), path.join(dir, 'src', 'c.txt')], dir, 'pack', { format: 'zip' })).made[0];
  const fresh = (name) => {
    const d = path.join(dir, name);
    tree(d, { 'a.txt': 'old a', 'dir/old.txt': 'old' });
    const copy = path.join(d, 'pack.zip');
    fs.copyFileSync(zip, copy);
    return { d, copy };
  };
  // Skip: those stay as they were; the rest comes in.
  let { d, copy } = fresh('skip');
  let got = await A.extractArchive(copy, { to: 'here', onExists: 'skip' });
  assert.deepEqual(got.skipped.sort(), ['a.txt', 'dir']);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'old a');
  assert.deepEqual(listAll(d), ['a.txt', 'c.txt', 'dir/', 'dir/old.txt', 'pack.zip']);
  // Keep both: the new ones get a number.
  ({ d, copy } = fresh('keep'));
  got = await A.extractArchive(copy, { to: 'here', onExists: 'keep' });
  assert.deepEqual(listAll(d), ['a (2).txt', 'a.txt', 'c.txt', 'dir (2)/', 'dir (2)/b.txt', 'dir/', 'dir/old.txt', 'pack.zip']);
  assert.equal(fs.readFileSync(path.join(d, 'a (2).txt'), 'utf8'), 'new a');
  // Replace: the old ones go (to the trash given), the new ones take their names.
  ({ d, copy } = fresh('replace'));
  const trashed = [];
  got = await A.extractArchive(copy, { to: 'here', onExists: 'replace', trash: async (p) => (trashed.push(path.basename(p)), fs.rmSync(p, { recursive: true })) });
  assert.deepEqual(trashed.sort(), ['a.txt', 'dir']);
  assert.equal(got.replaced, 2);
  assert.deepEqual(listAll(d), ['a.txt', 'c.txt', 'dir/', 'dir/b.txt', 'pack.zip']);
  assert.equal(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'new a');
  assert.deepEqual(got.made.map((p) => path.basename(p)).sort(), ['a.txt', 'c.txt', 'dir']);
  noStaging(dir);
});

test('rar, cab and iso made elsewhere: listed and extracted; a rar’s unsafe names stay inside', async () => {
  const dir = tmp();
  const files = [{ name: 'hello.txt', body: 'hello from a hand-made archive\n' }, { name: 'second.txt', body: 'x'.repeat(40000) }];
  const made = { 'a.rar': rarOf(files), 'a.cab': cabOf(files), 'a.iso': isoOf(files) };
  for (const [name, bytes] of Object.entries(made)) {
    fs.writeFileSync(path.join(dir, name), bytes);
    const info = await A.listArchive(path.join(dir, name));
    assert.equal(info.type, name.slice(2), name);
    assert.equal(info.files, 2, name);
    assert.equal(A.sniffFile(path.join(dir, name)), name.slice(2));
    const x = await A.extractArchive(path.join(dir, name), { to: 'folder', name: `${name}-out` });
    const got = fs.readdirSync(x.folder).sort();
    assert.deepEqual(got.map((n) => n.toLowerCase()), ['hello.txt', 'second.txt'], name);
    assert.equal(fs.readFileSync(path.join(x.folder, got[0]), 'utf8'), 'hello from a hand-made archive\n');
    assert.equal(fs.statSync(path.join(x.folder, got[1])).size, 40000);
  }
  // A rar whose names try to leave.
  fs.mkdirSync(path.join(dir, 'in'));
  fs.writeFileSync(path.join(dir, 'in', 'evil.rar'), rarOf([{ name: '../up.txt', body: 'up' }, { name: '/abs.txt', body: 'abs' }, { name: 'ok.txt', body: 'ok' }]));
  const before = listAll(dir);
  const x = await A.extractArchive(path.join(dir, 'in', 'evil.rar'), { to: 'here' });
  const after = listAll(dir).filter((p) => !before.includes(p));
  assert.ok(after.every((p) => p.startsWith('in/')), after.join(' '));
  assert.ok(x.made.length >= 1);
  noStaging(dir);
});

test('a gz of one file, a tar.gz and an xz made elsewhere extract to what they hold', async (t) => {
  const dir = tmp();
  const zlib = await import('node:zlib');
  fs.writeFileSync(path.join(dir, 'log.txt.gz'), zlib.gzipSync('line\n'.repeat(1000)));
  fs.writeFileSync(path.join(dir, 'site.tgz'), zlib.gzipSync(tarOf([{ name: 'site/', type: '5' }, { name: 'site/index.html', body: '<h1>hi</h1>' }])));
  let got = await A.extractArchive(path.join(dir, 'log.txt.gz'), { to: 'here' });
  assert.equal(fs.readFileSync(path.join(dir, 'log.txt'), 'utf8'), 'line\n'.repeat(1000));
  const info = await A.listArchive(path.join(dir, 'site.tgz'));
  assert.equal(info.type, 'tar.gz');
  assert.deepEqual(info.tops, ['site']);
  got = await A.extractArchive(path.join(dir, 'site.tgz'), { to: 'here' });
  assert.equal(fs.readFileSync(path.join(dir, 'site', 'index.html'), 'utf8'), '<h1>hi</h1>');
  assert.deepEqual(got.made, [path.join(dir, 'site')]);
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('xz', ['--version']).status === 0) {
    fs.writeFileSync(path.join(dir, 'w.tar'), tarOf([{ name: 'w.txt', body: 'xz' }]));
    spawnSync('xz', [path.join(dir, 'w.tar')]);
    got = await A.extractArchive(path.join(dir, 'w.tar.xz'), { to: 'folder' });
    assert.equal(fs.readFileSync(path.join(got.folder, 'w.txt'), 'utf8'), 'xz');
  } else t.diagnostic('no xz here');
  noStaging(dir);
});

// ---- Volumes -----------------------------------------------------------------------------------

test('split into volumes, listed and extracted from the first one', async () => {
  const dir = tmp();
  const bytes = crypto.randomBytes(300 * 1024);
  tree(dir, { 'big/rand.bin': bytes, 'big/note.txt': 'note' });
  for (const format of ['7z', 'zip', 'tar.gz']) {
    const got = await A.compressPaths([path.join(dir, 'big')], dir, `v-${format}`, { format, volume: 100 * 1024 });
    const ext = A.COMPRESS_FORMATS[format].ext;
    assert.deepEqual(got.made.map((p) => path.basename(p)), [1, 2, 3, 4].map((n) => `v-${format}${ext}.00${n}`), format);
    assert.ok(got.made.slice(0, -1).every((p) => fs.statSync(p).size === 100 * 1024));
    assert.equal((await A.listArchive(got.made[0])).files, 2, format);
    const x = await A.extractArchive(got.made[0], { to: 'folder' });
    assert.equal(path.basename(x.folder), `v-${format}`);
    assert.ok(fs.readFileSync(path.join(x.folder, 'big', 'rand.bin')).equals(bytes), format);
  }
  // Smaller than one volume: one file with its plain name.
  const small = await A.compressPaths([path.join(dir, 'big', 'note.txt')], dir, 'small', { format: '7z', volume: 1024 * 1024 });
  assert.deepEqual(small.made.map((p) => path.basename(p)), ['small.7z']);
  // A part missing: said so, nothing left behind.
  fs.rmSync(path.join(dir, 'v-7z.7z.003'));
  await assert.rejects(A.extractArchive(path.join(dir, 'v-7z.7z.001'), { to: 'folder', name: 'broken' }), /missing|damaged/);
  assert.ok(!fs.existsSync(path.join(dir, 'broken')));
  noStaging(dir);
});

// ---- Never outside the destination -----------------------------------------------------------

test('malicious zips: "..", absolute paths, drive letters, backslashes and a link stay inside or are left out', async () => {
  const dir = tmp();
  const zip = path.join(dir, 'inside', 'evil.zip');
  fs.mkdirSync(path.dirname(zip));
  // fflate writes the names as given; a symlink entry is a Unix mode in the external attributes.
  const files = {
    '../evil.txt': strToU8('no'),
    'ok/fine.txt': strToU8('yes'),
    '/abs.txt': strToU8('abs'),
    'a/../../up.txt': strToU8('up'),
    'C:/drive.txt': strToU8('drive'),
    '..\\back.txt': strToU8('back'),
    'sub\\..\\..\\win.txt': strToU8('win'),
    'link': [strToU8('../../outside'), { os: 3, attrs: 0o120777 << 16 }],
  };
  fs.writeFileSync(zip, zipSync(files));
  const before = listAll(dir);
  const got = await A.extractArchive(zip, { to: 'folder' });
  const made = listAll(got.folder);
  assert.ok(made.includes('ok/fine.txt'));
  // Nothing new anywhere but the new folder.
  assert.deepEqual(listAll(dir).filter((p) => !p.startsWith('inside/evil/') || p === 'inside/evil/'), [...before, 'inside/evil/'].sort());
  // On Windows a drive letter ("C:") is no name either: refused there, a plain folder elsewhere.
  const windowsOnly = process.platform === 'win32' ? ['C:', 'C:/drive.txt'] : [];
  assert.deepEqual(got.refused.sort(), ['..\\back.txt', ...windowsOnly, 'sub\\..\\..\\win.txt'].sort());
  // No link was made; names with a backslash are left out.
  assert.ok(!made.some((p) => p.endsWith('@')), made.join(' '));
  assert.ok(!made.some((p) => p.includes('\\')), made.join(' '));
  assert.ok(got.links.includes('link') || !made.includes('link'), JSON.stringify(got));
  noStaging(dir);
});

test('malicious tars: links (to "..", absolute, hard) are not made and nothing goes through them', async () => {
  const dir = tmp();
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  const tar = path.join(dir, 'work', 'evil.tar');
  fs.mkdirSync(path.dirname(tar));
  fs.writeFileSync(
    tar,
    tarOf([
      { name: 'ok.txt', body: 'fine' },
      { name: 'up', type: '2', link: '..' },
      { name: 'up/through.txt', body: 'through a link to ..' },
      { name: 'abs', type: '2', link: outside },
      { name: 'abs/through2.txt', body: 'through an absolute link' },
      { name: 'passwd', type: '1', link: '/etc/passwd' },
      { name: 'again', type: '1', link: 'ok.txt' },
      { name: '../../escape.txt', body: 'escape' },
      { name: '/etc/abs.txt', body: 'absolute' },
    ]),
  );
  const got = await A.extractArchive(tar, { to: 'here' });
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing through the absolute link');
  assert.ok(!fs.existsSync(path.join(dir, 'through.txt')) && !fs.existsSync(path.join(dir, 'escape.txt')) && !fs.existsSync(path.join(path.dirname(dir), 'escape.txt')));
  const here = listAll(path.join(dir, 'work'));
  assert.ok(here.includes('ok.txt'));
  assert.ok(!here.some((p) => p.endsWith('@')), here.join(' '));
  // A file never shares its data with one outside (a hard link): none has more than one name.
  for (const p of here.filter((x) => !x.endsWith('/'))) assert.equal(fs.statSync(path.join(dir, 'work', p)).nlink, 1, p);
  assert.ok(got.links.length >= 3, JSON.stringify(got.links));
  noStaging(dir);
});

test('names Windows cannot have are left out there', async () => {
  const dir = tmp();
  const zip = path.join(dir, 'w.zip');
  fs.writeFileSync(zip, zipSync({ 'con.txt': strToU8('no'), 'a/b:c': strToU8('no'), 'what?.txt': strToU8('no'), 'dots. ': strToU8('no'), 'fine.txt': strToU8('yes') }));
  const got = await A.extractArchive(zip, { to: 'folder', windows: true });
  assert.deepEqual(listAll(got.folder).filter((p) => !p.endsWith('/')), ['fine.txt']);
  assert.deepEqual(got.refused.sort(), ['a/b:c', 'con.txt', 'dots. ', 'what?.txt']);
});

// ---- Caps, damage, Stop ----------------------------------------------------------------------

test('an archive that expands far beyond its size is not extracted', async () => {
  const dir = tmp();
  const zip = path.join(dir, 'bomb.zip');
  fs.writeFileSync(zip, zipSync({ 'zeros.bin': new Uint8Array(20 * 1024 * 1024) }, { level: 9 }));
  assert.ok(fs.statSync(zip).size < 100 * 1024);
  await assert.rejects(A.extractArchive(zip, { to: 'folder', maxBytes: 5 * 1024 * 1024 }), /far more than its size/);
  assert.ok(!fs.existsSync(path.join(dir, 'bomb')));
  // Its directory says 10 bytes, but it inflates to a megabyte: stopped while writing.
  const liar = Buffer.from(zipSync({ 'a.bin': new Uint8Array(1024 * 1024) }, { level: 9 }));
  const central = liar.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  liar.writeUInt32LE(10, central + 24);
  fs.writeFileSync(path.join(dir, 'liar.zip'), liar);
  await assert.rejects(A.extractArchive(path.join(dir, 'liar.zip'), { to: 'folder', maxBytes: 64 * 1024 }), /far more than its size|damaged/);
  assert.ok(!fs.existsSync(path.join(dir, 'liar')));
  // The jail's own cap, while writing.
  const { mount, inside } = { mount: { at: '/src', host: dir }, inside: '/src/bomb.zip' };
  fs.mkdirSync(path.join(dir, 'out'));
  const r = await A.runStep({ args: A.extractArgs(inside, '/out', 'x'), mounts: [mount, { at: '/out', host: path.join(dir, 'out'), write: true }], cwd: '/src', cap: 1024 * 1024 });
  assert.equal(r.over, 'bytes');
  // Too many entries.
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, strToU8('x')]));
  fs.writeFileSync(path.join(dir, 'many.zip'), zipSync(many));
  await assert.rejects(A.extractArchive(path.join(dir, 'many.zip'), { to: 'folder', maxEntries: 10 }), /too many files/);
  const r2 = await A.runStep({ args: A.extractArgs('/src/many.zip', '/out/m', 'x'), mounts: [mount, { at: '/out', host: path.join(dir, 'out'), write: true }], cwd: '/src', maxEntries: 10 });
  assert.equal(r2.over, 'entries');
  noStaging(dir);
});

test('not an archive, or a damaged one: said so, nothing left behind', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'fake.zip'), 'just text, not an archive');
  await assert.rejects(A.listArchive(path.join(dir, 'fake.zip')), /not an archive/);
  await assert.rejects(A.extractArchive(path.join(dir, 'fake.zip'), { to: 'folder' }), /not an archive/);
  const zip = Buffer.from(zipSync({ 'a.txt': strToU8('hello hello hello') }, { level: 0 }));
  zip[zip.indexOf(Buffer.from('hello'))] = 'j'.charCodeAt(0);
  fs.writeFileSync(path.join(dir, 'bad.zip'), zip);
  await assert.rejects(A.extractArchive(path.join(dir, 'bad.zip'), { to: 'folder' }), /damaged/);
  assert.deepEqual(listAll(dir), ['bad.zip', 'fake.zip']);
});

test('files holding archive data (a stored Office file, a zip in a database) and old dates come out whole', async () => {
  const dir = tmp();
  const docx = Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<w:document>hello</w:document>') }, { level: 0 }));
  const noise = crypto.randomBytes(50000);
  tree(dir, { 'p/report.docx': docx, 'p/data.sqlite': Buffer.concat([noise, docx, noise]), 'p/old.txt': 'old' });
  fs.utimesSync(path.join(dir, 'p', 'old.txt'), new Date('1970-01-02'), new Date('1970-01-02'));
  for (const format of ['zip', '7z']) {
    const got = await A.compressPaths([path.join(dir, 'p')], dir, `p-${format}`, { format });
    const x = await A.extractArchive(got.made[0], { to: 'folder' });
    assert.deepEqual(fs.readdirSync(path.join(x.folder, 'p')).sort(), ['data.sqlite', 'old.txt', 'report.docx']);
    assert.ok(fs.readFileSync(path.join(x.folder, 'p', 'report.docx')).equals(docx));
    assert.ok(fs.readFileSync(path.join(x.folder, 'p', 'data.sqlite')).equals(fs.readFileSync(path.join(dir, 'p', 'data.sqlite'))));
  }
});

test('Stop: the worker ends, the staging folder goes, no archive is left', async () => {
  const dir = tmp();
  tree(dir, { 'big/a.bin': crypto.randomBytes(24 * 1024 * 1024) });
  const controller = new AbortController();
  let seen = 0;
  const running = A.compressPaths([path.join(dir, 'big')], dir, 'big', { format: '7z', level: 'ultra' }, { signal: controller.signal, onProgress: (p) => (seen = p.done) });
  setTimeout(() => controller.abort(), 400);
  await assert.rejects(running, (err) => err.stopped === true);
  assert.deepEqual(fs.readdirSync(dir), ['big']);
  // Extracting stopped too.
  const made = await A.compressPaths([path.join(dir, 'big')], dir, 'pack', { format: 'zip', level: 'store' });
  const c2 = new AbortController();
  // Stopped as soon as it starts writing.
  const x = A.extractArchive(made.made[0], { to: 'folder', signal: c2.signal, onProgress: () => c2.abort() });
  await assert.rejects(x, (err) => err.stopped === true);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['big', 'pack.zip']);
  assert.ok(seen >= 0);
});

test('progress is reported while compressing and extracting', async () => {
  const dir = tmp();
  tree(dir, { 'p/a.bin': crypto.randomBytes(2 * 1024 * 1024), 'p/b.txt': 'x'.repeat(1024 * 1024) });
  const seen = [];
  const got = await A.compressPaths([path.join(dir, 'p')], dir, 'p', { format: 'zip' }, { onProgress: (p) => seen.push(p) });
  assert.ok(seen.length > 0 && seen.every((p) => p.done <= p.total && p.total >= 3 * 1024 * 1024));
  const seenX = [];
  await A.extractArchive(got.made[0], { to: 'folder', onProgress: (p) => seenX.push(p) });
  assert.ok(seenX.length > 0 && seenX.at(-1).done > 0);
});

// ---- The page's wording --------------------------------------------------------------------------

test('the page: names, requests and messages', () => {
  assert.equal(page.defaultStem([{ name: 'photos', dir: true }]), 'photos');
  assert.equal(page.defaultStem([{ name: 'report.final.pdf', dir: false }]), 'report.final');
  assert.equal(page.defaultStem([{ name: 'a' }, { name: 'b' }]), 'Archive');
  assert.equal(page.stemProblem(''), 'Type a name.');
  assert.match(page.stemProblem('a/b'), /cannot have/);
  assert.equal(page.stemProblem('ok name'), '');
  assert.deepEqual(page.compressRequest({ format: 'tar.gz', password: 'x', hideNames: true, split: '100' }), { format: 'tar.gz', level: 'normal', password: '', hideNames: false, volume: 100 * 1024 * 1024, exclude: ['deps', 'junk'] });
  assert.equal(page.compressRequest({ format: '7z', password: 'x', hideNames: true }).hideNames, true);
  assert.equal(page.compressRequest({ format: 'tar', level: 'ultra' }).level, 'normal');
  const { rows, total } = page.filterEntries([{ name: 'src/App.js' }, { name: 'src/app.css' }, { name: 'README.md' }], 'APP src', 1);
  assert.deepEqual([rows.map((r) => r.name), total], [['src/App.js'], 2]);
  assert.equal(page.listingSummary({ files: 2, folders: 1, size: 10, packed: 5, type: 'zip' }), '2 files · 1 folder · 10 bytes (5 bytes packed) · zip');
  assert.equal(page.extractedMessage({ files: 3, folders: 1, folder: '/x/photos', skipped: [], links: ['a'], refused: [] }, 'photos.zip'), 'Extracted 3 files from photos.zip into photos (1 link not made)');
  assert.deepEqual(page.topsToAsk({ tops: ['a', 'b/c', ''] }), ['a']);
});
