// Archives in Folders (pure): which files are archives, the folder one extracts to, the
// fixed choices of Compress… and how a listing and a result read. The main process
// (electron/archives.cjs) has its own copy of the lists and checks what the page sends
// against them; test/archives.test.js keeps the two equal.

// The multi-part extensions first (photos.tar.gz → photos).
export const ARCHIVE_EXTS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst', '.tar.lzma', '.tar.lz', '.tar.z', '.zip', '.7z', '.rar', '.tar', '.tgz', '.tbz2', '.tbz', '.txz', '.tlz', '.gz', '.bz2', '.xz', '.lzma', '.zst', '.z', '.cab', '.iso', '.jar', '.war', '.ear', '.apk', '.xpi', '.cpio', '.rpm', '.deb', '.wim', '.arj', '.lzh', '.vhd', '.vhdx', '.dmg'];

/** The archive's extension (".tar.gz", ".zip", a volume's ".7z.001"), or '' when the name is not an archive's. */
export function archiveExt(name) {
  const lower = String(name ?? '').toLowerCase();
  const volume = /\.\d{3}$/.exec(lower);
  const base = volume ? lower.slice(0, -4) : lower;
  const ext = ARCHIVE_EXTS.find((e) => base.endsWith(e) && base.length > e.length) ?? '';
  return ext && volume ? `${ext}${volume[0]}` : ext || (volume && /\.(zip|7z|rar|tar)$/.test(base) ? volume[0] : '');
}

/** Whether a file is an archive by its name. */
export const isArchiveName = (name) => Boolean(archiveExt(name));

/** The folder an archive extracts to: photos.tar.gz → photos, backup.7z.001 → backup. */
export function stemOf(name) {
  const base = String(name ?? '');
  const ext = archiveExt(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base.replace(/\.[^.]+$/, '');
  return stem.replace(/[. ]+$/, '') || 'Archive';
}

/** A volume after the first (name.7z.002): extracting starts from the first one. */
export const laterVolume = (name) => /\.(\d{3})$/.test(name ?? '') && !/\.001$/.test(name);

// ---- Compress… --------------------------------------------------------------------------------

/** What Compress… can make. */
export const COMPRESS_FORMATS = [
  { id: 'zip', label: 'zip', ext: '.zip', password: true, hideNames: false, levels: true, hint: 'Opens everywhere (Windows, macOS, phones). A password uses AES-256.' },
  { id: '7z', label: '7z', ext: '.7z', password: true, hideNames: true, levels: true, hint: 'Smaller, with 7-Zip or similar. AES-256, and can hide the file names.' },
  { id: 'tar', label: 'tar', ext: '.tar', password: false, hideNames: false, levels: false, hint: 'Not compressed: keeps Unix permissions.' },
  { id: 'tar.gz', label: 'tar.gz', ext: '.tar.gz', password: false, hideNames: false, levels: true, hint: 'The usual one on Linux and servers.' },
  { id: 'tar.xz', label: 'tar.xz', ext: '.tar.xz', password: false, hideNames: false, levels: true, hint: 'Smaller than tar.gz, slower.' },
  { id: 'tar.bz2', label: 'tar.bz2', ext: '.tar.bz2', password: false, hideNames: false, levels: true, hint: 'Older; between the two.' },
];
export const formatOf = (id) => COMPRESS_FORMATS.find((f) => f.id === id) ?? COMPRESS_FORMATS[0];

/** How hard it compresses (7-Zip's -mx 0, 1, 5, 7, 9). */
export const LEVELS = [
  { id: 'store', label: 'Store', mx: 0, hint: 'Not compressed: fastest' },
  { id: 'fastest', label: 'Fastest', mx: 1 },
  { id: 'normal', label: 'Normal', mx: 5 },
  { id: 'maximum', label: 'Maximum', mx: 7 },
  { id: 'ultra', label: 'Ultra', mx: 9, hint: 'Smallest, slowest, needs the most memory' },
];

/** What can be left out of the folders compressed (never what was picked itself). `on`: checked at first. */
export const EXCLUDE_GROUPS = [
  { id: 'deps', label: 'node_modules', hint: 'Installed packages: node_modules, bower_components, .venv', dirs: ['node_modules', 'bower_components', '.venv'], on: true },
  { id: 'vcs', label: '.git', hint: 'Version control: .git, .svn, .hg', dirs: ['.git', '.svn', '.hg'], on: false },
  { id: 'build', label: 'Build outputs', hint: 'dist, build, target, out, .next, .nuxt, .svelte-kit, __pycache__, .pytest_cache, .gradle', dirs: ['dist', 'build', 'target', 'out', '.next', '.nuxt', '.svelte-kit', '__pycache__', '.pytest_cache', '.gradle'], on: false },
  { id: 'junk', label: 'System junk', hint: '.DS_Store, Thumbs.db, desktop.ini, __MACOSX, ._ files', files: ['.DS_Store', 'Thumbs.db', 'desktop.ini', 'ehthumbs.db'], dirs: ['__MACOSX', '.Spotlight-V100', '.Trashes', '.fseventsd'], prefix: '._', on: true },
];
export const defaultExcludes = () => EXCLUDE_GROUPS.filter((g) => g.on).map((g) => g.id);

/** Volumes: off, a size, or the MB typed (`custom`). */
export const SPLIT_SIZES = [
  { id: 'off', label: 'Off' },
  { id: '100', label: '100 MB', mb: 100 },
  { id: '700', label: '700 MB', mb: 700, hint: 'A CD' },
  { id: '4095', label: '4 GB', mb: 4095, hint: 'Under FAT32’s limit for one file' },
  { id: 'custom', label: 'Custom…' },
];
const MB = 1024 * 1024;

/** The volume size in bytes for a choice (null: one file; NaN: a custom size that is not a number from 1 MB to 1 TB). */
export function splitBytes(id, customMb = '') {
  if (!id || id === 'off') return null;
  if (id === 'custom') {
    const n = Number(String(customMb).trim().replace(',', '.'));
    return Number.isFinite(n) && n >= 1 && n <= 1024 * 1024 ? Math.round(n * MB) : NaN;
  }
  const size = SPLIT_SIZES.find((s) => s.id === id);
  return size?.mb ? size.mb * MB : null;
}

/** The archive's name before its extension for what is picked: a folder's name, a file's without its extension, "Archive" for several. */
export function defaultStem(items) {
  if (items.length !== 1) return 'Archive';
  const [one] = items;
  return one.dir ? one.name : one.name.replace(/\.[^.]+$/, '') || one.name;
}

/** Why a name typed for the archive cannot be used, or ''. */
export function stemProblem(stem) {
  const s = String(stem ?? '').trim();
  if (!s) return 'Type a name.';
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(s)) return 'A name cannot have any of these: \\ / : * ? " < > |';
  if (/[. ]$/.test(s)) return 'A name cannot end with a dot or a space.';
  if (s.length > 200) return 'That name is too long.';
  return '';
}

/** What the main process is asked for: { format, level, password, hideNames, volume, exclude }. */
export function compressRequest({ format = 'zip', level = 'normal', password = '', hideNames = false, split = 'off', customMb = '', exclude = defaultExcludes() } = {}) {
  const spec = formatOf(format);
  return {
    format: spec.id,
    level: spec.levels ? level : 'normal',
    password: spec.password ? password : '',
    hideNames: Boolean(spec.hideNames && password && hideNames),
    volume: splitBytes(split, customMb),
    exclude,
  };
}

// ---- Listings and results ---------------------------------------------------------------------

const lower = (s) => String(s ?? '').toLowerCase();

/** The entries whose path holds every word of `query` (any case), at most `limit`: { rows, total }. */
export function filterEntries(entries, query = '', limit = 500) {
  const words = lower(query).split(/\s+/).filter(Boolean);
  const matching = words.length ? entries.filter((e) => words.every((w) => lower(e.name).includes(w))) : entries;
  return { rows: matching.slice(0, limit), total: matching.length };
}

const count = (n, what) => `${n.toLocaleString('en')} ${what}${n === 1 ? '' : 's'}`;

/** "12 files · 3 folders · zip" for a listing (sizes are the page's: `bytes(n)`). */
export function listingSummary(info, bytes = (n) => `${n} bytes`) {
  if (!info || info.needsPassword) return '';
  const parts = [count(info.files ?? 0, 'file'), info.folders ? count(info.folders, 'folder') : '', info.size ? `${bytes(info.size)}${info.packed ? ` (${bytes(info.packed)} packed)` : ''}` : '', info.type ? info.type : ''];
  return parts.filter(Boolean).join(' · ');
}

/** What the toast says after extracting. */
export function extractedMessage(result, name) {
  const what = result.files === 1 && !result.folders ? '1 file' : count(result.files ?? 0, 'file');
  const where = result.folder ? ` into ${result.folder.split(/[\\/]/).pop()}` : ' here';
  const notes = [
    result.skipped?.length ? `${count(result.skipped.length, 'name')} already there left out` : '',
    result.links?.length ? `${count(result.links.length, 'link')} not made` : '',
    result.refused?.length ? `${count(result.refused.length, 'unsafe name')} left out` : '',
  ].filter(Boolean);
  return `Extracted ${what} from ${name}${where}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

/** The names to ask about before extracting here: the archive's top entries already in the folder are `existing`. */
export const topsToAsk = (info) => (Array.isArray(info?.tops) ? info.tops.filter((n) => n && !/[\\/]/.test(n)).slice(0, 5000) : []);
