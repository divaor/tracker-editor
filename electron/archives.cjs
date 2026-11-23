// Archives for the folders view (folders on this computer): showing what one holds,
// extracting it (zip, 7z, rar, tar and its compressed kinds, gz, bz2, xz, cab, iso…),
// and compressing files and folders into zip, 7z, tar, tar.gz, tar.xz or tar.bz2, with
// passwords (AES-256), levels, volumes and folders left out.
//
// The engine is 7-Zip compiled to WebAssembly (the 7z-wasm package, pinned). Each step
// runs in a worker thread (a big archive never blocks the main process; Stop ends the
// worker) on a fresh instance whose file system sees only the folders involved (emscripten
// NODEFS mounts), behind a jail: writes only inside the one folder the step may write
// (`/out`), no symbolic links made or followed, no name with "..", a backslash, a control
// character or (on Windows) a character or name Windows cannot have; the bytes and entries
// written are counted against caps (zip bombs). Every 7-Zip command line is made here from
// fixed choices: the page sends paths (checked by main.cjs), ids from fixed lists, a
// password and a number; file names reach 7-Zip only after a "--" and as absolute paths
// inside the mounts, with wildcards off (-spd), so no name is ever read as a switch.
// Extracting goes into a hidden staging folder beside the destination, which is checked
// (no links, every path inside) before anything is moved into place, and removed on any
// failure or Stop.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const folders = require('./folders.cjs');

// ---- Fixed choices (app/js/archives.js has the page's copy; test/archives.test.js keeps them equal) ----

/** What Compress can make: 7-Zip's type, then (tar.*) the compressor the tar goes through. */
const COMPRESS_FORMATS = {
  zip: { ext: '.zip', type: 'zip', password: true, hideNames: false, levels: true },
  '7z': { ext: '.7z', type: '7z', password: true, hideNames: true, levels: true },
  tar: { ext: '.tar', type: 'tar', password: false, hideNames: false, levels: false },
  'tar.gz': { ext: '.tar.gz', type: 'tar', then: 'gzip', password: false, hideNames: false, levels: true },
  'tar.xz': { ext: '.tar.xz', type: 'tar', then: 'xz', password: false, hideNames: false, levels: true },
  'tar.bz2': { ext: '.tar.bz2', type: 'tar', then: 'bzip2', password: false, hideNames: false, levels: true },
};
/** 7-Zip's -mx for each level. */
const LEVELS = { store: 0, fastest: 1, normal: 5, maximum: 7, ultra: 9 };
/** What can be left out of what is compressed: folders by name (`dirs`), files by name, files whose name starts with `prefix`. */
const EXCLUDE_GROUPS = {
  deps: { dirs: ['node_modules', 'bower_components', '.venv'] },
  vcs: { dirs: ['.git', '.svn', '.hg'] },
  build: { dirs: ['dist', 'build', 'target', 'out', '.next', '.nuxt', '.svelte-kit', '__pycache__', '.pytest_cache', '.gradle'] },
  junk: { files: ['.DS_Store', 'Thumbs.db', 'desktop.ini', 'ehthumbs.db'], dirs: ['__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd'], prefix: '._' },
};
// Volumes: from 64 KB to 1 TB.
const MIN_VOLUME = 64 * 1024;
const MAX_VOLUME = 1024 ** 4;
const MAX_PASSWORD = 1024;

// Archive names: the multi-part extensions first (photos.tar.gz → photos).
const ARCHIVE_EXTS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.lzma', '.tar.lz', '.tar.z', '.zip', '.7z', '.rar', '.tar', '.tgz', '.tbz2', '.tbz', '.txz', '.tlz', '.gz', '.bz2', '.xz', '.lzma', '.zst', '.z', '.cab', '.iso', '.jar', '.war', '.ear', '.apk', '.xpi', '.cpio', '.rpm', '.deb', '.wim', '.arj', '.lzh', '.vhd', '.vhdx', '.dmg'];
// Compressors of one file: a tar inside one is extracted in a second step.
const STREAM_TYPES = new Set(['gzip', 'bzip2', 'xz', 'lzma', 'zstd', 'z', 'lzip']);

// Limits: entries and how far an archive may expand (as zip.cjs had: 200 times its size,
// at least 1 GB, at most 16 GB), checked from the listing and again while writing.
const MAX_ENTRIES = 100000;
const expandCap = (size) => Math.min(16 * 1024 ** 3, Math.max(1024 ** 3, size * 200));
// What the page is given of a listing, at most.
const MAX_LISTED = 20000;
// A tar inside gzip/xz/bzip2 is listed through a temporary copy only up to this size (packed).
const DEEP_LIST_MAX = 64 * 1024 * 1024;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(\..*)?$/i;

/**
 * Whether one part of a path (a file or folder name) may be written: never "", "." or "..",
 * a slash or backslash, a control character or more than 255 characters; on Windows also
 * none of < > : " | ? *, no reserved name (con, nul, com1…) and no dot or space at the end
 * (Windows drops those: ".. " would become "..").
 */
function safeName(part, windows = process.platform === 'win32') {
  if (typeof part !== 'string' || !part || part === '.' || part === '..' || part.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(part)) return false;
  if (windows && (/[<>:"|?*]/.test(part) || RESERVED.test(part) || /[. ]$/.test(part))) return false;
  return true;
}

/** The archive's kind by name: its extension as in ARCHIVE_EXTS (".tar.gz", ".zip"…), a volume's (".7z.001") too, or ''. */
function archiveExt(name) {
  const lower = String(name ?? '').toLowerCase();
  const volume = /\.\d{3}$/.exec(lower);
  const base = volume ? lower.slice(0, -4) : lower;
  const ext = ARCHIVE_EXTS.find((e) => base.endsWith(e) && base.length > e.length) ?? '';
  return ext && volume ? `${ext}${volume[0]}` : ext || (volume && /\.(zip|7z|rar|tar)$/.test(base) ? volume[0] : '');
}

/** The name an archive's contents get as a folder: photos.tar.gz → photos, backup.7z.001 → backup. */
function stemOf(name) {
  const base = String(name ?? '');
  const ext = archiveExt(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base.replace(/\.[^.]+$/, '');
  return stem.replace(/[. ]+$/, '') || 'Archive';
}

/** An archive by its first bytes (a few hundred; 32 KB more for an ISO): 'zip', '7z', 'rar', 'gzip'… or null. */
function sniffArchive(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const at = (offset, sig) => sig.every((v, i) => b[offset + i] === v);
  const text = (offset, s) => at(offset, [...s].map((c) => c.charCodeAt(0)));
  if (at(0, [0x50, 0x4b, 0x03, 0x04]) || at(0, [0x50, 0x4b, 0x05, 0x06]) || at(0, [0x50, 0x4b, 0x07, 0x08])) return 'zip';
  if (at(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (at(0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  if (at(0, [0x1f, 0x8b, 0x08])) return 'gzip';
  if (text(0, 'BZh') && b[3] >= 0x31 && b[3] <= 0x39 && at(4, [0x31, 0x41, 0x59, 0x26, 0x53, 0x59])) return 'bzip2';
  if (at(0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (at(0, [0x28, 0xb5, 0x2f, 0xfd])) return 'zstd';
  if (text(0, 'MSCF') && at(4, [0, 0, 0, 0])) return 'cab';
  if (text(257, 'ustar')) return 'tar';
  if (text(32769, 'CD001')) return 'iso';
  return null;
}

/** sniffArchive of a file on disk. */
function sniffFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(32774);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return sniffArchive(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}

// ---- Command lines ------------------------------------------------------------------------
// Every argument is a fixed string, a number checked here, the password (one argument of its
// own after -p) or an absolute path inside the mounts after "--".

function checkPassword(password) {
  if (password == null || password === '') return '';
  if (typeof password !== 'string' || password.length > MAX_PASSWORD || /[\u0000\r\n]/.test(password)) throw new Error('That password cannot be used.');
  return password;
}

/** The volume size in bytes (null: one file), checked. */
function checkVolume(volume) {
  if (volume == null || volume === 0 || volume === '') return null;
  const n = Number(volume);
  if (!Number.isSafeInteger(n) || n < MIN_VOLUME || n > MAX_VOLUME) throw new Error('Volumes can be from 64 KB to 1 TB.');
  return n;
}

/** The choices for compressing, each checked against the fixed lists: { format, level, password, hideNames, volume, exclude }. */
function compressChoices(options = {}) {
  const format = Object.hasOwn(COMPRESS_FORMATS, options.format) ? options.format : 'zip';
  const spec = COMPRESS_FORMATS[format];
  const level = Object.hasOwn(LEVELS, options.level) ? options.level : 'normal';
  const password = spec.password ? checkPassword(options.password) : '';
  if (!spec.password && options.password) throw new Error(`A ${format} archive has no password: choose zip or 7z for one.`);
  // 7-Zip cannot make a zip with any other (and other programs read other characters differently).
  if (format === 'zip' && password && !/^[\x20-\x7e]+$/.test(password)) throw new Error('A zip’s password can have only letters a–z, digits, spaces and the usual symbols (no accents). For any password, choose 7z.');
  const exclude = (Array.isArray(options.exclude) ? options.exclude : []).filter((g) => Object.hasOwn(EXCLUDE_GROUPS, g));
  return { format, spec, level, password, hideNames: Boolean(spec.hideNames && password && options.hideNames), volume: checkVolume(options.volume), exclude: [...new Set(exclude)] };
}

/** The 7-Zip arguments of each step of compressing `sources` (paths inside the mounts) into /out. */
function compressArgs(choices, sources) {
  const { spec, level, password, hideNames, volume } = choices;
  const common = ['-bd', '-y', '-spd', '-sccUTF-8'];
  const vol = volume ? [`-v${volume}b`] : [];
  const lock = password ? [`-p${password}`, ...(spec.type === 'zip' ? ['-mem=AES256'] : []), ...(hideNames ? ['-mhe=on'] : [])] : [];
  const mx = spec.levels ? [`-mx${LEVELS[level]}`] : [];
  const out = `/out/archive${spec.ext}`;
  if (!spec.then) return [['a', `-t${spec.type}`, ...common, ...mx, ...(spec.type === 'zip' ? ['-mcu=on'] : []), ...lock, ...vol, '--', out, ...sources]];
  // A tar, then compressed (one file in, one out).
  const tar = '/out/archive.tar';
  return [
    ['a', '-ttar', ...common, '--', tar, ...sources],
    ['a', `-t${spec.then}`, ...common, `-mx${Math.max(1, LEVELS[level])}`, ...vol, '--', out, tar],
  ];
}

/** The arguments to list `archive` (an absolute path inside the mounts). */
const listArgs = (archive, password) => ['l', '-slt', '-bd', '-spd', '-sccUTF-8', `-p${password}`, '--', archive];
/** The arguments to extract `archive` into `outDir` (both inside the mounts); existing names in it are kept (the first of a name twice). */
const extractArgs = (archive, outDir, password, type = '') => ['x', '-bd', '-y', '-aos', '-spd', '-sccUTF-8', ...(type ? [`-t${type}`] : []), `-p${password}`, `-o${outDir}`, '--', archive];
// Without a password from the person, one nobody has (7-Zip would ask for one on the console).
const noPassword = () => `none-${crypto.randomBytes(12).toString('hex')}`;

// ---- Reading 7-Zip's output ---------------------------------------------------------------

// "2026-11-23 18:13:02.7230000" (local time) → ms.
function parseTime(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s ?? '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

/**
 * A technical listing (l -slt): { type, physical, entries: [{ name, dir, size, packed, mtime,
 * encrypted, link, method }], props } for the archive (the last "Type =" block before the
 * entries: the innermost one).
 */
function parseListing(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => l.trim() === '----------');
  const block = (from, to) => {
    const props = {};
    for (const l of lines.slice(from, to)) {
      const at = l.indexOf(' = ');
      if (at > 0) props[l.slice(0, at)] = l.slice(at + 3);
      else if (/ =$/.test(l)) props[l.slice(0, -2)] = '';
    }
    return props;
  };
  // The archive's own properties: from "--" to "----------".
  const head = lines.lastIndexOf('--', start === -1 ? lines.length : start);
  const props = head >= 0 ? block(head + 1, start === -1 ? lines.length : start) : {};
  const entries = [];
  if (start >= 0) {
    let from = start + 1;
    for (let i = start + 1; i <= lines.length; i++) {
      if (i < lines.length && lines[i].trim() !== '') continue;
      if (i > from) {
        const p = block(from, i);
        // xz and bzip2 keep no name: the item is named after the archive (listArchive does it).
        if (p.Path !== undefined || p.Size !== undefined) {
          const attrs = p.Attributes ?? '';
          entries.push({
            name: p.Path ?? '',
            dir: p.Folder === '+' || /^D/.test(attrs) || / d[rwx-]{9}/.test(attrs),
            size: Number(p.Size) || 0,
            packed: Number(p['Packed Size']) || 0,
            mtime: parseTime(p.Modified),
            encrypted: p.Encrypted === '+',
            link: Boolean(p['Symbolic Link'] || p['Hard Link'] || p.Link) || / l[rwx-]{9}/.test(attrs),
            method: p.Method ?? '',
          });
        }
      }
      from = i + 1;
    }
  }
  return { type: (props.Type ?? '').toLowerCase(), physical: Number(props['Physical Size']) || 0, props, entries };
}

/** What went wrong, from 7-Zip's output: 'password', 'notArchive', 'volume', 'damaged', 'space', 'memory' or null. */
function problemOf(text, code = 0) {
  const t = String(text ?? '');
  if (/Wrong password|Cannot open encrypted archive|Can not open encrypted archive/i.test(t)) return 'password';
  if (/Missing volume|Unavailable data|There is no such archive|Can not open the file as archive/i.test(t) && /\.\d{3}\b/.test(t)) return 'volume';
  if (/Can(no|')t open (the file )?as (an )?archive|Is not archive|Cannot open the file as archive/i.test(t)) return 'notArchive';
  if (/Unexpected end of (data|archive)|Data Error|CRC Failed|Headers Error|Unsupported Method|Unconfirmed start/i.test(t)) return 'damaged';
  if (/not enough space|ENOSPC|No space left/i.test(t)) return 'space';
  if (code === 8 || /Can't allocate required memory|not enough memory/i.test(t)) return 'memory';
  return null;
}

const MESSAGES = {
  notArchive: 'That is not an archive this can open, or it is damaged.',
  unreadable: 'That archive could not be read: it is damaged, or made in a way this cannot open.',
  volume: 'A part of this archive is missing: keep all its parts (.001, .002…) together and open the first one.',
  damaged: 'That archive is damaged.',
  space: 'There is not enough space on the disk.',
  memory: 'There is not enough memory for that.',
};

// ---- The engine: 7-Zip in a worker ---------------------------------------------------------

// Runs inside the worker (made into source text: it must not use anything around it but
// safeName and RESERVED, given to it as source too).
async function workerMain() {
  const { parentPort, workerData } = require('node:worker_threads');
  const nodeFs = require('node:fs');
  const posix = require('node:path').posix;
  const { glue, wasm, step } = workerData;
  const lines = [];
  const refused = [];
  const links = [];
  const leftOut = [];
  let written = 0;
  let read = 0;
  let entries = 0;
  let over = '';
  let last = 0;
  const progress = (force) => {
    const now = Date.now();
    if (!force && now - last < 150) return;
    last = now;
    parentPort.postMessage({ type: 'progress', written, read, entries });
  };
  // The glue's own process.binding('constants') (deprecated, and not everywhere): the fs constants.
  const proc = Object.create(process, { binding: { value: (name) => (name === 'constants' ? { fs: nodeFs.constants } : process.binding(name)) } });
  const factory = new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', `${glue}\nreturn SevenZip;`)(require, { exports: {} }, {}, '/7zz.umd.js', '/', proc);
  const m = await factory({
    print: (s) => lines.push(s),
    printErr: (s) => lines.push(s),
    stdin: () => null,
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(wasm, imports).then(
        (instance) => done(instance, wasm),
        (err) => parentPort.postMessage({ type: 'done', crash: String(err && err.message || err) }),
      );
      return {};
    },
  });
  const FS = m.FS;
  for (const mount of step.mounts) {
    FS.mkdir(mount.at);
    FS.mount(m.NODEFS, { root: mount.host }, mount.at);
  }
  FS.chdir(step.cwd || '/');

  // ---- The jail ----
  const EPERM = 63;
  const ENOENT = 44;
  const fail = (errno) => new FS.ErrnoError(errno);
  const writable = step.mounts.filter((x) => x.write).map((x) => x.at);
  const abs = (p) => posix.resolve(FS.cwd(), String(p));
  const mountOf = (a) => writable.find((at) => a === at || a.startsWith(`${at}/`));
  const relIn = (a) => {
    const at = mountOf(a) ?? step.mounts.find((x) => a === x.at || a.startsWith(`${x.at}/`))?.at;
    return at ? a.slice(at.length + 1) : a;
  };
  const check = (p) => {
    if (typeof p !== 'string') return; // a node already opened (checked then)
    const a = abs(p);
    const at = mountOf(a);
    const rel = at ? a.slice(at.length + 1) : a;
    if (!at || (rel && !rel.split('/').every((part) => safeName(part, step.windows)))) {
      refused.push(rel);
      throw fail(EPERM);
    }
  };
  const wrap = (name, before) => {
    const orig = FS[name];
    if (typeof orig !== 'function') return;
    FS[name] = function (...args) {
      before(...args);
      return orig.apply(this, args);
    };
  };
  // Over a cap: the main thread is told at once (it ends the worker), and every write after fails.
  const tooFar = (what) => {
    if (!over) parentPort.postMessage({ type: 'over', over: what });
    over = what;
    throw fail(51);
  };
  const counted = (p) => {
    if (typeof p === 'string' && mountOf(abs(p)) && ++entries > step.maxEntries) tooFar('entries');
  };
  wrap('mkdir', (p) => (check(p), counted(p)));
  wrap('mknod', (p) => check(p));
  wrap('rmdir', (p) => check(p));
  wrap('unlink', (p) => check(p));
  wrap('rename', (a, b) => (check(a), check(b)));
  wrap('truncate', (p) => check(p));
  wrap('utime', (p) => check(p));
  wrap('chmod', (p) => check(p));
  wrap('lchmod', (p) => check(p));
  wrap('chown', (p) => check(p));
  wrap('lchown', (p) => check(p));
  // Links are never made, nor followed (a link in a folder being compressed is left out).
  FS.symlink = (target, p) => {
    links.push(relIn(abs(p)));
    throw fail(EPERM);
  };
  FS.readlink = () => {
    throw fail(ENOENT);
  };
  m.NODEFS.node_ops.readlink = () => {
    throw fail(ENOENT);
  };
  const outStreams = new WeakSet();
  const open = FS.open;
  FS.open = function (p, flags, mode) {
    const f = typeof flags === 'string' ? (/[wa+]/.test(flags) ? 1 : 0) : flags;
    const writing = (f & (1 | 2 | 64 | 512 | 1024)) !== 0;
    if (writing) {
      check(p);
      if (typeof flags === 'string' ? /[wa]/.test(flags) : f & 64) counted(p);
    }
    const stream = open.call(this, p, flags, mode);
    if (writing) outStreams.add(stream);
    return stream;
  };
  const write = FS.write;
  FS.write = function (stream, buffer, offset, length) {
    const mine = outStreams.has(stream);
    if (mine && (over || written + length > step.cap)) tooFar(over || 'bytes');
    const n = write.apply(this, arguments);
    if (mine) {
      written += n;
      progress();
    }
    return n;
  };
  const readOp = FS.read;
  FS.read = function (stream) {
    const n = readOp.apply(this, arguments);
    if (!outStreams.has(stream)) {
      read += n;
      progress();
    }
    return n;
  };
  // What compressing will read (files: no links, the names left out skipped), told before it starts.
  if (step.measure) {
    const { dirs, files, prefixes } = step.exclude;
    let bytes = 0;
    let count = 0;
    const pending = step.measure.map((p) => [p, true]);
    while (pending.length) {
      const [p, top] = pending.pop();
      let st;
      try {
        st = nodeFs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      const name = require('node:path').basename(p);
      if (st.isDirectory()) {
        if (!top && dirs.includes(name)) continue;
        let names = [];
        try {
          names = nodeFs.readdirSync(p);
        } catch {
          // unreadable: 7-Zip says so
        }
        for (const n of names) pending.push([require('node:path').join(p, n), false]);
      } else if (st.isFile()) {
        if (!top && (files.includes(name) || prefixes.some((x) => name.startsWith(x)))) continue;
        count++;
        bytes += st.size;
      }
    }
    parentPort.postMessage({ type: 'measured', bytes, files: count });
  }
  // Folders being compressed: links and the names left out never show.
  if (step.exclude) {
    const { dirs, files, prefixes } = step.exclude;
    const readdir = FS.readdir;
    FS.readdir = function (p) {
      const names = readdir.call(this, p);
      const dir = abs(p);
      if (mountOf(dir)) return names;
      return names.filter((name) => {
        if (name === '.' || name === '..') return true;
        let st;
        try {
          st = FS.lstat(`${dir}/${name}`);
        } catch {
          return false;
        }
        const isDir = FS.isDir(st.mode);
        if (FS.isLink(st.mode)) {
          leftOut.push({ name: relIn(`${dir}/${name}`), why: 'link' });
          return false;
        }
        if ((isDir ? dirs : files).includes(name) || (!isDir && prefixes.some((x) => name.startsWith(x)))) return false;
        return true;
      });
    };
  }

  let code = null;
  let crash = '';
  try {
    code = m.callMain(step.args);
  } catch (err) {
    if (err && typeof err.status === 'number') code = err.status;
    else if (!over) crash = String((err && err.message) || err);
  }
  progress(true);
  parentPort.postMessage({ type: 'done', code, crash, over, text: lines.join('\n'), refused, links, leftOut, written, read, entries });
}
const WORKER_SOURCE = `const RESERVED = ${RESERVED};\nconst safeName = ${safeName.toString()};\n(${workerMain.toString()})().catch((err) => require('node:worker_threads').parentPort.postMessage({ type: 'done', crash: String(err && err.message || err) }));`;

let engine = null;
/** 7-Zip's glue (source) and compiled WebAssembly, read once (through the main process's fs: inside the asar too). */
function loadEngine() {
  engine ??= (async () => {
    const dir = path.dirname(require.resolve('7z-wasm/package.json'));
    const glue = fs.readFileSync(path.join(dir, '7zz.umd.js'), 'utf8');
    const wasm = await WebAssembly.compile(fs.readFileSync(path.join(dir, '7zz.wasm')));
    return { glue, wasm };
  })().catch((err) => {
    engine = null;
    throw new Error(`Archives cannot be opened here: ${err.message}`);
  });
  return engine;
}

const stoppedError = () => Object.assign(new Error('Stopped.'), { stopped: true });

/**
 * Runs one 7-Zip command in a worker: `step` = { args, mounts: [{ at, host, write }], cwd,
 * exclude?, cap, maxEntries, windows }. Resolves with { code, crash, over, text, refused,
 * links, leftOut, written, read, entries }; rejects with { stopped } when `signal` aborts.
 */
async function runStep(step, { signal, onProgress } = {}) {
  if (signal?.aborted) throw stoppedError();
  const { glue, wasm } = await loadEngine();
  const { Worker } = require('node:worker_threads');
  const full = { cap: Number.MAX_SAFE_INTEGER, maxEntries: Number.MAX_SAFE_INTEGER, windows: process.platform === 'win32', ...step };
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { glue, wasm, step: full } });
    let settled = false;
    const end = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', stop);
      worker.terminate().then(() => fn(value), () => fn(value));
    };
    const stop = () => end(reject, stoppedError());
    signal?.addEventListener('abort', stop);
    worker.on('message', (msg) => {
      if (msg.type === 'progress' || msg.type === 'measured') onProgress?.(msg);
      else if (msg.type === 'done') end(resolve, msg);
      // Over a cap: ended at once, not left to go through the rest.
      else if (msg.type === 'over') end(resolve, { code: null, crash: '', over: msg.over, text: '', refused: [], links: [], leftOut: [], written: 0, read: 0, entries: 0 });
    });
    worker.on('error', (err) => end(reject, err));
    worker.on('exit', () => end(reject, new Error('The archive engine stopped.')));
  });
}

// ---- Listing --------------------------------------------------------------------------------

// The first part of each name, as 7-Zip writes it ("/a", "./a", "../a" and "C:a" → "a").
function topNames(entries) {
  const tops = new Set();
  for (const e of entries) {
    const parts = e.name.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
    if (parts[0] && /^[A-Za-z]:$/.test(parts[0])) parts.shift();
    if (parts[0]) tops.add(parts[0]);
  }
  return [...tops];
}

// The one file of a compressor that keeps no name (xz, bzip2), as 7-Zip names it: t.tar.xz → t.tar, t.txz → t.tar.
function streamItemName(name) {
  const m = /^(.*)\.(tgz|tbz2?|txz|tlz|tzst)$/i.exec(name);
  if (m) return `${m[1]}.tar`;
  return name.replace(/\.(gz|bz2|xz|lzma|zst|z|lz)$/i, '') || name;
}

// An archive's parts: name.7z.001, .002… (or the file alone).
function partsOf(file) {
  const m = /^(.*)\.(\d{3})$/.exec(path.basename(file));
  if (!m) return [file];
  const parts = [];
  for (let n = 1; n < 1000; n++) {
    const part = path.join(path.dirname(file), `${m[1]}.${String(n).padStart(3, '0')}`);
    if (!fs.existsSync(part)) break;
    parts.push(part);
  }
  return parts.length ? parts : [file];
}
// The size of an archive with its volumes.
const archiveSize = (file) => partsOf(file).reduce((n, p) => n + fs.statSync(p).size, 0);

// `length` bytes at `offset` of the parts joined.
function readParts(parts, offset, length) {
  const out = Buffer.alloc(length);
  let got = 0;
  let base = 0;
  for (const part of parts) {
    const size = fs.statSync(part).size;
    if (offset + got < base + size && got < length) {
      const fd = fs.openSync(part, 'r');
      try {
        got += fs.readSync(fd, out, got, Math.min(length - got, base + size - (offset + got)), offset + got - base);
      } finally {
        fs.closeSync(fd);
      }
    }
    base += size;
  }
  return out.subarray(0, got);
}

/**
 * Whether a 7z hides its names behind a password (its header encoded with AES: coder 06 F1 07 01).
 * Read from the archive itself: with a wrong password this build of 7-Zip may stop on what it
 * decrypts instead of saying so.
 */
function hiddenNames(file) {
  try {
    const parts = partsOf(file);
    const start = readParts(parts, 0, 32);
    if (start.length < 32 || sniffArchive(start) !== '7z') return false;
    const offset = Number(start.readBigUInt64LE(12));
    const size = Number(start.readBigUInt64LE(20));
    if (!size || size > 1024 * 1024) return false;
    const header = readParts(parts, 32 + offset, size);
    // kEncodedHeader, then its coders: AES among them.
    return header[0] === 0x17 && header.includes(Buffer.from([0x06, 0xf1, 0x07, 0x01]));
  } catch {
    return false;
  }
}

const mountOfFile = (file) => {
  const real = fs.realpathSync(file);
  return { real, mount: { at: '/src', host: path.dirname(real) }, inside: `/src/${path.basename(real)}` };
};

// A listing's result for the page.
function listed(parsed, { limit = MAX_LISTED } = {}) {
  const entries = parsed.entries;
  const files = entries.filter((e) => !e.dir);
  return {
    type: parsed.type,
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
    count: entries.length,
    files: files.length,
    folders: entries.length - files.length,
    size: files.reduce((n, e) => n + e.size, 0),
    packed: parsed.physical || files.reduce((n, e) => n + e.packed, 0),
    encrypted: files.filter((e) => e.encrypted).length,
    links: entries.filter((e) => e.link).length,
    tops: topNames(entries),
  };
}

/**
 * What `file` holds, without extracting it: { type, entries, count, files, folders, size,
 * packed, encrypted, links, tops, truncated, inner? } or { needsPassword, wrong } (names
 * hidden by a password: a 7z with encrypted headers). A tar inside gzip, xz or bzip2 is listed
 * too (`inner`: the compressor's type) when it is at most DEEP_LIST_MAX packed, through a
 * temporary copy that is removed at once.
 */
async function listArchive(file, { password = '', signal, deep = true, tmpDir = require('node:os').tmpdir() } = {}) {
  const given = checkPassword(password);
  const hidden = hiddenNames(file);
  // Its names cannot be read without the password: asked for before anything runs.
  if (hidden && !given) return { needsPassword: true, wrong: false };
  const { mount, inside } = mountOfFile(file);
  const r = await runStep({ args: listArgs(inside, given || noPassword()), mounts: [mount], cwd: '/src' }, { signal });
  // 7-Zip stopped on an error of its own (this build does not catch them): with names hidden, a wrong password.
  if (r.crash) {
    if (hidden) return { needsPassword: true, wrong: true };
    throw new Error(MESSAGES.unreadable);
  }
  const problem = problemOf(r.text, r.code);
  if (problem === 'password') return { needsPassword: true, wrong: Boolean(given) };
  const parsed = parseListing(r.text);
  if (!parsed.entries.length && (problem || r.code >= 2)) throw new Error(MESSAGES[problem] ?? MESSAGES.notArchive);
  for (const e of parsed.entries) if (!e.name) e.name = streamItemName(path.basename(file));
  const out = listed(parsed);
  // A tar inside a compressor: what the tar holds.
  const inner = parsed.entries.length === 1 && STREAM_TYPES.has(parsed.type) && /\.tar$/i.test(parsed.entries[0].name) ? parsed.entries[0] : null;
  if (deep && inner && archiveSize(file) <= DEEP_LIST_MAX) {
    const tmp = fs.mkdtempSync(path.join(tmpDir, 'archive-list-'));
    try {
      const x = await runStep({ args: extractArgs(inside, '/out', noPassword()), mounts: [mount, { at: '/out', host: tmp, write: true }], cwd: '/src', cap: expandCap(archiveSize(file)), maxEntries: 4 }, { signal });
      const tarName = fs.readdirSync(tmp).find((n) => fs.lstatSync(path.join(tmp, n)).isFile());
      if (x.code < 2 && tarName) {
        const t = await runStep({ args: listArgs(`/out/${tarName}`, noPassword()), mounts: [{ at: '/out', host: tmp }], cwd: '/out' }, { signal });
        const tarParsed = parseListing(t.text);
        if (tarParsed.type === 'tar' && tarParsed.entries.length) return { ...listed(tarParsed), type: `tar.${parsed.type === 'gzip' ? 'gz' : parsed.type === 'bzip2' ? 'bz2' : parsed.type}`, inner: parsed.type, packed: archiveSize(file) };
      }
    } finally {
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  }
  return inner ? { ...out, inner: parsed.type, tarInside: true, tops: [] } : out;
}

// ---- Extracting -----------------------------------------------------------------------------

/**
 * After 7-Zip: every entry under `root` checked with lstat. Links (none should be there), files
 * with other names (hard links) and anything but files and folders are removed and named in
 * `links`; nothing may resolve outside `root`. Returns { files, folders, bytes }.
 */
async function sweep(root, links) {
  const realRoot = await fs.promises.realpath(root);
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const pending = [root];
  // A folder at a time, its entries together (never blocking the main process on a big one).
  while (pending.length) {
    const dir = pending.pop();
    const names = await fs.promises.readdir(dir);
    const stats = await Promise.all(names.map((name) => fs.promises.lstat(path.join(dir, name))));
    for (const [i, name] of names.entries()) {
      const p = path.join(dir, name);
      const st = stats[i];
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1) || !(st.isFile() || st.isDirectory()) || !safeName(name)) {
        await fs.promises.rm(p, { recursive: true, force: true });
        links.push(rel);
        continue;
      }
      if (st.isDirectory()) {
        if (!folders.isInside(realRoot, await fs.promises.realpath(p))) throw new Error('Something in that archive points outside its folder; nothing was extracted.');
        dirs++;
        pending.push(p);
      } else {
        files++;
        bytes += st.size;
      }
    }
  }
  return { files, folders: dirs, bytes };
}

// 7-Zip's own refusals, by name: links it would not make ("Dangerous link path was ignored :
// name : target"), hard links it could not ("Cannot create hard link : errno=… : … : /out/content/name : …").
function refusedByEngine(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const dangerous = /Dangerous link path was ignored : (.+?) : /.exec(line);
    const cannot = /Cannot create (?:symbolic |hard )?link : .*?\/out\/(?:content|inner)\/(.+?)(?: : |$)/.exec(line);
    if (dangerous || cannot) out.push((dangerous ?? cannot)[1].trim());
  }
  return out;
}
// A path the jail named (relative to /out): as it is inside the archive.
const inArchive = (rel) => String(rel).replace(/^(content|inner)(\/|$)/, '');

/** Moves `sources` (the staged top entries) into `dir`: names there already are replaced, kept both ("name (2)") or skipped, as copies are. */
async function placeInto(sources, dir, onExists, { trash }) {
  const placed = [];
  const skipped = [];
  let replaced = 0;
  for (const source of sources) {
    const name = path.basename(source);
    const target = path.join(dir, name);
    let taken = false;
    try {
      fs.lstatSync(target);
      taken = true;
    } catch {
      // free
    }
    if (taken && onExists === 'skip') {
      skipped.push(name);
      continue;
    }
    const to = folders.freePath(dir, name);
    folders.moveEntry(source, to);
    if (taken && onExists === 'replace') {
      // Never deleted first: the new one is there under a free name before the old one goes.
      try {
        await trash(target);
        fs.renameSync(to, target);
        placed.push(target);
        replaced++;
        continue;
      } catch {
        // kept beside it
      }
    }
    placed.push(to);
  }
  return { placed, skipped, replaced };
}

const tooBigError = () => new Error('That archive expands to far more than its size; it was not extracted.');
const tooManyError = () => new Error(`That archive has too many files (more than ${String(MAX_ENTRIES).replace(/\B(?=(\d{3})+$)/g, ',')}).`);

/**
 * Extracts `file`: `to` 'folder' (a new folder beside it, named `name` or after the archive,
 * "(2)" when taken) or 'here' (into its own folder; names there already as `onExists` says:
 * 'replace', 'keep' or 'skip'; `trash(path)` takes a replaced one). Goes through a hidden
 * staging folder in the archive's folder, removed at the end whatever happens. Returns
 * { made: [paths], folder?, files, folders, bytes, skipped: [names], links: [names], replaced }
 * or { needsPassword, wrong }.
 */
async function extractArchive(file, { to = 'folder', name = '', password = '', onExists = 'keep', trash, signal, onProgress, maxEntries = MAX_ENTRIES, maxBytes, windows } = {}) {
  const given = checkPassword(password);
  const dir = path.dirname(file);
  const listing = await listArchive(file, { password: given, signal, deep: false });
  if (listing.needsPassword) return listing;
  if (listing.encrypted && !given) return { needsPassword: true, wrong: false };
  const size = archiveSize(file);
  const cap = maxBytes ?? expandCap(size);
  if (listing.count > maxEntries) throw tooManyError();
  if (listing.size > cap) throw tooBigError();
  const folderName = to === 'folder' ? folders.checkName(name || stemOf(path.basename(file))) : '';
  const staging = fs.mkdtempSync(path.join(dir, `.${stemOf(path.basename(file)).slice(0, 60)}.part-`));
  const content = path.join(staging, 'content');
  fs.mkdirSync(content);
  const { mount, inside } = mountOfFile(file);
  const out = { at: '/out', host: staging, write: true };
  const pw = given || noPassword();
  const links = [];
  const refused = [];
  let done = 0;
  // A tar in a compressor is written twice: the tar, then what it holds.
  const total = Math.max(1, listing.size * (listing.tarInside ? 2 : 1));
  const report = (base) => (p) => onProgress?.({ done: base + p.written, total: Math.max(total, base + p.written) });
  const check = (r) => {
    if (r.over === 'bytes') throw tooBigError();
    if (r.over === 'entries') throw tooManyError();
    // 7-Zip stopped on an error of its own: with encrypted files and a password given, most likely a wrong one.
    if (r.crash) {
      if (given && (listing.encrypted || hiddenNames(file))) return 'password';
      throw new Error(MESSAGES.unreadable);
    }
    links.push(...r.links.map(inArchive), ...refusedByEngine(r.text));
    refused.push(...r.refused.map(inArchive).filter((x) => x));
    const problem = problemOf(r.text, r.code);
    if (problem === 'password') return 'password';
    if (problem) throw new Error(MESSAGES[problem]);
    // Errors other than the names refused here and the links left out: the archive is not right.
    if (r.code >= 2 && !refused.length && !links.length) throw new Error(MESSAGES.damaged);
    return null;
  };
  try {
    let r = await runStep({ args: extractArgs(inside, listing.inner && listing.tarInside ? '/out/inner' : '/out/content', pw), mounts: [mount, out], cwd: '/src', cap, maxEntries: maxEntries + 1, windows }, { signal, onProgress: report(0) });
    if (check(r) === 'password') return { needsPassword: true, wrong: Boolean(given) };
    done = r.written;
    if (listing.tarInside) {
      // The tar out of its compressor, then what it holds.
      const innerDir = path.join(staging, 'inner');
      const tarName = fs.readdirSync(innerDir).find((n) => fs.lstatSync(path.join(innerDir, n)).isFile());
      if (!tarName) throw new Error(MESSAGES.damaged);
      r = await runStep({ args: extractArgs(`/out/inner/${tarName}`, '/out/content', noPassword(), 'tar'), mounts: [out], cwd: '/out', cap: Math.max(0, cap - done), maxEntries: maxEntries + 1, windows }, { signal, onProgress: report(done) });
      check(r);
      fs.rmSync(innerDir, { recursive: true, force: true });
    }
    const counts = await sweep(content, links);
    const tops = fs.readdirSync(content).map((n) => path.join(content, n));
    let result;
    if (to === 'folder') {
      const dest = folders.freePath(dir, folderName);
      folders.moveEntry(content, dest);
      result = { made: [dest], folder: dest, skipped: [], replaced: 0 };
    } else {
      if (!tops.length) throw new Error('There was nothing in that archive to extract.');
      const placed = await placeInto(tops, dir, onExists, { trash: trash ?? (async (p) => fs.rmSync(p, { recursive: true, force: true })) });
      result = { made: placed.placed, skipped: placed.skipped, replaced: placed.replaced };
    }
    return { ...result, ...counts, refused: [...new Set(refused)], links: [...new Set(links)] };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

// ---- Compressing ----------------------------------------------------------------------------

/** The names the chosen groups leave out: { dirs, files, prefixes }. */
function excludeNames(groups) {
  const out = { dirs: [], files: [], prefixes: [] };
  for (const g of groups) {
    const spec = EXCLUDE_GROUPS[g];
    out.dirs.push(...(spec.dirs ?? []));
    out.files.push(...(spec.files ?? []));
    if (spec.prefix) out.prefixes.push(spec.prefix);
  }
  return out;
}

/** A free name for `stem` + `ext` in `dir`, with its volumes (`count`: .001…): "name (2).7z" when taken. */
function freeArchiveName(dir, stem, ext, count = 0) {
  const names = (s) => (count ? Array.from({ length: count }, (_, i) => `${s}${ext}.${String(i + 1).padStart(3, '0')}`) : [`${s}${ext}`]);
  for (let n = 1; n < 10000; n++) {
    const s = n > 1 ? `${stem} (${n})` : stem;
    // A plain one and the volumes of one with that name both count as taken.
    if (![...names(s), `${s}${ext}`, `${s}${ext}.001`].some((x) => fs.existsSync(path.join(dir, x)))) return names(s).map((x) => path.join(dir, x));
  }
  throw new Error(`No free name for ${stem}${ext}.`);
}

/**
 * Compresses `sources` (files and folders on this computer) into a new archive in `dir`,
 * named `name` + the format's extension ("(2)" when taken). `options`: compressChoices'.
 * Links are left out; so are the names of the `exclude` groups inside folders (never what was
 * picked itself). Returns { made: [paths] (the volumes, in order), files, bytes, size, leftOut }.
 */
async function compressPaths(sources, dir, name, options = {}, { signal, onProgress } = {}) {
  const choices = compressChoices(options);
  const stem = folders.checkName(name);
  const exclude = excludeNames(choices.exclude);
  const picked = sources.filter((s) => !fs.lstatSync(s).isSymbolicLink());
  if (!picked.length) throw new Error('Nothing to compress: links are left out.');
  // The archive is made beside them, never inside one of them (it would hold itself).
  if (picked.some((s) => folders.isInside(path.resolve(s), path.resolve(dir)))) throw new Error('The archive cannot go inside a folder being compressed.');
  // Each folder the sources are in, mounted read-only on its own.
  const parents = [...new Set(picked.map((s) => path.dirname(s)))];
  const mounts = parents.map((host, i) => ({ at: `/s${i}`, host }));
  const inside = picked.map((s) => `/s${parents.indexOf(path.dirname(s))}/${path.basename(s)}`);
  const staging = fs.mkdtempSync(path.join(dir, `.${stem.slice(0, 60)}.part-`));
  const steps = compressArgs(choices, inside);
  const leftOut = [];
  let measured = { bytes: 0, files: 0 };
  // Progress: the bytes read of what was measured (a tar then compressed reads it twice).
  const total = () => Math.max(1, measured.bytes * steps.length);
  try {
    let base = 0;
    for (const [i, args] of steps.entries()) {
      const r = await runStep(
        { args, mounts: [...mounts, { at: '/out', host: staging, write: true }], cwd: '/out', exclude: i === 0 ? exclude : null, measure: i === 0 ? picked : null },
        {
          signal,
          onProgress: (p) => {
            if (p.type === 'measured') measured = p;
            else onProgress?.({ done: Math.min(total(), base + p.read), total: total() });
          },
        },
      );
      if (r.crash) throw new Error('The archive could not be made: 7-Zip stopped on an error.');
      leftOut.push(...r.leftOut);
      const problem = problemOf(r.text, r.code);
      if (problem === 'space' || problem === 'memory') throw new Error(MESSAGES[problem]);
      // 1 is a warning (a file that could not be read: named in the output).
      if (r.code !== 0 && r.code !== 1) throw new Error(`The archive could not be made.${lastError(r.text)}`);
      if (r.code === 1) leftOut.push(...warnings(r.text));
      base = measured.bytes;
    }
    const { bytes, files } = measured;
    if (steps.length > 1) await fs.promises.rm(path.join(staging, 'archive.tar'), { force: true });
    const ext = choices.spec.ext;
    const made = fs.readdirSync(staging).filter((n) => n === `archive${ext}` || /^\.\d{3}$/.test(n.slice(`archive${ext}`.length))).sort();
    if (!made.length) throw new Error('The archive could not be made.');
    // One volume only: its plain name.
    const targets = freeArchiveName(dir, stem, ext, made.length > 1 ? made.length : 0);
    const placed = [];
    try {
      for (const [i, n] of made.entries()) {
        // The name taken first (made here, so nothing there is ever written over), then the archive moved onto it.
        fs.closeSync(fs.openSync(targets[i], 'wx'));
        placed.push(targets[i]);
        fs.renameSync(path.join(staging, n), targets[i]);
      }
    } catch (err) {
      for (const p of placed) fs.rmSync(p, { force: true });
      throw err;
    }
    return { made: placed, files, bytes, size: placed.reduce((n, p) => n + fs.statSync(p).size, 0), leftOut };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

// The last "ERROR: …" or "WARNING" line of 7-Zip's output, for a message.
function lastError(text) {
  const line = String(text).split('\n').reverse().find((l) => /ERROR|WARNING|errno=/.test(l));
  return line ? ` ${line.replace(/^.*?(ERROR|WARNING):\s*/, '').replace(/\/(?:s\d+|out)\//g, '').trim()}` : '';
}

// Files 7-Zip could not read (a warning): their names.
function warnings(text) {
  return String(text)
    .split('\n')
    .map((l) => /^\/s\d+\/(.+?) : /.exec(l))
    .filter(Boolean)
    .map((m) => ({ name: m[1], why: 'unreadable' }));
}

module.exports = {
  ARCHIVE_EXTS,
  COMPRESS_FORMATS,
  EXCLUDE_GROUPS,
  LEVELS,
  MAX_ENTRIES,
  MIN_VOLUME,
  archiveExt,
  compressArgs,
  compressChoices,
  compressPaths,
  excludeNames,
  expandCap,
  extractArchive,
  extractArgs,
  listArchive,
  listArgs,
  loadEngine,
  parseListing,
  placeInto,
  problemOf,
  runStep,
  safeName,
  sniffArchive,
  sniffFile,
  stemOf,
  topNames,
};
