// What kind of file a name is, for its icon in the lists (Folders, My files): a short label,
// a color (one of the --ft-* palette names) and either a glyph (`ui/fileIcon.js` draws it)
// or a few letters. Special names first, then the extension; a name without one goes by
// the file's language (a pasted note). Pure, so the tests can import it.

// The glyphs ui/fileIcon.js draws; any other mark is letters.
export const GLYPHS = ['cup', 'angle', 'hash', 'braces', 'tree', 'gear', 'markdown', 'lines', 'log', 'table', 'database', 'terminal', 'box', 'branch', 'lock', 'key', 'image', 'archive', 'music', 'film', 'binary', 'mail', 'file'];

// [label, color, glyph or letters].
const TYPES = {
  js: ['JavaScript', 'yellow', 'JS'],
  ts: ['TypeScript', 'blue', 'TS'],
  jsx: ['React (JSX)', 'cyan', 'JSX'],
  tsx: ['React (TSX)', 'blue', 'TSX'],
  py: ['Python', 'blue', 'PY'],
  ipynb: ['Jupyter notebook', 'orange', 'NB'],
  java: ['Java', 'red', 'cup'],
  kt: ['Kotlin', 'purple', 'KT'],
  scala: ['Scala', 'red', 'SC'],
  groovy: ['Groovy', 'cyan', 'GR'],
  c: ['C', 'blue', 'C'],
  cpp: ['C++', 'blue', 'C++'],
  h: ['C/C++ header', 'purple', 'H'],
  cs: ['C#', 'purple', 'C#'],
  fs: ['F#', 'cyan', 'F#'],
  vb: ['Visual Basic', 'blue', 'VB'],
  go: ['Go', 'cyan', 'GO'],
  rs: ['Rust', 'brown', 'RS'],
  swift: ['Swift', 'orange', 'SW'],
  m: ['Objective-C', 'blue', 'OC'],
  php: ['PHP', 'indigo', 'PHP'],
  rb: ['Ruby', 'red', 'RB'],
  pl: ['Perl', 'navy', 'PL'],
  lua: ['Lua', 'navy', 'LUA'],
  r: ['R', 'blue', 'R'],
  dart: ['Dart', 'cyan', 'DT'],
  ex: ['Elixir', 'purple', 'EX'],
  erl: ['Erlang', 'red', 'ERL'],
  hs: ['Haskell', 'purple', 'HS'],
  clj: ['Clojure', 'green', 'CLJ'],
  zig: ['Zig', 'orange', 'ZIG'],
  nim: ['Nim', 'yellow', 'NIM'],
  sol: ['Solidity', 'gray', 'SOL'],
  vue: ['Vue', 'green', 'V'],
  svelte: ['Svelte', 'orange', 'S'],
  astro: ['Astro', 'orange', 'A'],
  html: ['HTML', 'red', 'angle'],
  xml: ['XML', 'orange', 'angle'],
  css: ['CSS', 'blue', 'hash'],
  scss: ['Sass', 'pink', 'hash'],
  less: ['Less', 'navy', 'hash'],
  json: ['JSON', 'yellow', 'braces'],
  yaml: ['YAML', 'purple', 'tree'],
  toml: ['TOML', 'brown', 'tree'],
  ini: ['Settings', 'gray', 'gear'],
  md: ['Markdown', 'blue', 'markdown'],
  txt: ['Text', 'gray', 'lines'],
  log: ['Log', 'navy', 'log'],
  csv: ['Table (CSV)', 'green', 'table'],
  sql: ['SQL', 'orange', 'database'],
  db: ['Database', 'gray', 'database'],
  sh: ['Shell script', 'green', 'terminal'],
  ps1: ['PowerShell', 'blue', 'terminal'],
  bat: ['Batch file', 'gray', 'terminal'],
  graphql: ['GraphQL', 'pink', 'GQL'],
  tf: ['Terraform', 'purple', 'TF'],
  proto: ['Protocol Buffers', 'teal', 'PB'],
  diff: ['Changes (diff)', 'green', '±'],
  docker: ['Docker', 'cyan', 'box'],
  make: ['Makefile', 'orange', 'gear'],
  git: ['Git', 'red', 'branch'],
  npm: ['npm package', 'red', 'box'],
  lock: ['Lock file', 'gray', 'lock'],
  env: ['Environment (secrets)', 'yellow', 'key'],
  key: ['Key or certificate', 'yellow', 'key'],
  project: ['Project file', 'purple', 'gear'],
  image: ['Picture', 'purple', 'image'],
  svg: ['SVG picture', 'orange', 'image'],
  pdf: ['PDF', 'red', 'PDF'],
  word: ['Word document', 'blue', 'W'],
  excel: ['Spreadsheet', 'green', 'X'],
  powerpoint: ['Presentation', 'orange', 'P'],
  ebook: ['E-book', 'teal', 'EB'],
  archive: ['Archive', 'brown', 'archive'],
  audio: ['Audio', 'pink', 'music'],
  video: ['Video', 'pink', 'film'],
  binary: ['Program or binary', 'gray', 'binary'],
  font: ['Font', 'gray', 'Aa'],
  mail: ['Email', 'blue', 'mail'],
  file: ['File', 'gray', 'file'],
};

const EXTENSIONS = {
  js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', mts: 'ts', cts: 'ts', jsx: 'jsx', tsx: 'tsx',
  py: 'py', pyw: 'py', pyi: 'py', ipynb: 'ipynb',
  java: 'java', class: 'java', kt: 'kt', kts: 'kt', scala: 'scala', sc: 'scala', groovy: 'groovy', gradle: 'groovy',
  c: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', h: 'h', hh: 'h', hpp: 'h', hxx: 'h',
  cs: 'cs', csx: 'cs', fs: 'fs', fsx: 'fs', vb: 'vb', go: 'go', rs: 'rs', swift: 'swift', m: 'm', mm: 'm',
  php: 'php', rb: 'rb', pl: 'pl', pm: 'pl', lua: 'lua', r: 'r', dart: 'dart', ex: 'ex', exs: 'ex', erl: 'erl', hrl: 'erl',
  hs: 'hs', clj: 'clj', cljs: 'clj', edn: 'clj', zig: 'zig', nim: 'nim', sol: 'sol', vue: 'vue', svelte: 'svelte', astro: 'astro',
  html: 'html', htm: 'html', xhtml: 'html', cshtml: 'html', razor: 'html', jsp: 'html', ejs: 'html', hbs: 'html', handlebars: 'html', twig: 'html', liquid: 'html',
  xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', xaml: 'xml', plist: 'xml', wsdl: 'xml', rss: 'xml', atom: 'xml', config: 'xml', resx: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', styl: 'less',
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', ndjson: 'json', geojson: 'json', webmanifest: 'json', har: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', editorconfig: 'ini', reg: 'ini',
  md: 'md', markdown: 'md', mdx: 'md', rst: 'txt', adoc: 'txt', txt: 'txt', text: 'txt', log: 'log', out: 'log',
  csv: 'csv', tsv: 'csv', psv: 'csv',
  sql: 'sql', psql: 'sql', pgsql: 'sql', mysql: 'sql', ddl: 'sql', dml: 'sql', db: 'db', sqlite: 'db', sqlite3: 'db', mdb: 'db', accdb: 'db',
  sh: 'sh', bash: 'sh', zsh: 'sh', fish: 'sh', ksh: 'sh', command: 'sh', ps1: 'ps1', psm1: 'ps1', psd1: 'ps1', bat: 'bat', cmd: 'bat',
  graphql: 'graphql', gql: 'graphql', tf: 'tf', tfvars: 'tf', hcl: 'tf', proto: 'proto', diff: 'diff', patch: 'diff',
  dockerfile: 'docker', mk: 'make', mak: 'make', cmake: 'make',
  lock: 'lock', env: 'env',
  pem: 'key', key: 'key', crt: 'key', cer: 'key', der: 'key', p12: 'key', pfx: 'key', pub: 'key', ppk: 'key', gpg: 'key', asc: 'key', kdbx: 'key', jks: 'key',
  sln: 'project', csproj: 'project', vbproj: 'project', fsproj: 'project', vcxproj: 'project', props: 'project', targets: 'project', xcodeproj: 'project',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', webp: 'image', ico: 'image', tif: 'image', tiff: 'image', heic: 'image', heif: 'image', avif: 'image', psd: 'image', raw: 'image', svg: 'svg',
  pdf: 'pdf', doc: 'word', docx: 'word', docm: 'word', dotx: 'word', odt: 'word', ott: 'word', rtf: 'word', xls: 'excel', xlsx: 'excel', xlsm: 'excel', xltx: 'excel', ods: 'excel', ots: 'excel',
  ppt: 'powerpoint', pptx: 'powerpoint', pptm: 'powerpoint', ppsx: 'powerpoint', potx: 'powerpoint', odp: 'powerpoint', otp: 'powerpoint', epub: 'ebook', fb2: 'ebook', mobi: 'ebook', azw3: 'ebook',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', zst: 'archive', lz: 'archive', cab: 'archive',
  jar: 'archive', war: 'archive', ear: 'archive', whl: 'archive', nupkg: 'archive', deb: 'archive', rpm: 'archive', apk: 'archive',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', wma: 'audio', opus: 'audio',
  mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video', wmv: 'video', m4v: 'video', mpg: 'video', mpeg: 'video',
  exe: 'binary', msi: 'binary', dll: 'binary', so: 'binary', dylib: 'binary', bin: 'binary', o: 'binary', obj: 'binary', a: 'binary', lib: 'binary', wasm: 'binary', dmg: 'binary', iso: 'binary', img: 'binary', appimage: 'binary', pdb: 'binary', sys: 'binary',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',
  eml: 'mail', msg: 'mail',
};

// Whole names (lower case) that say more than their extension.
const NAMES = {
  dockerfile: 'docker', containerfile: 'docker', '.dockerignore': 'docker',
  'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker', 'compose.yml': 'docker', 'compose.yaml': 'docker',
  makefile: 'make', gnumakefile: 'make', 'cmakelists.txt': 'make', rakefile: 'rb', gemfile: 'rb', procfile: 'ini', vagrantfile: 'rb',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git', '.gitkeep': 'git', '.mailmap': 'git',
  'package.json': 'npm', '.npmrc': 'ini', '.yarnrc': 'ini', '.nvmrc': 'ini', '.prettierrc': 'json', '.eslintrc': 'json', '.babelrc': 'json',
  'package-lock.json': 'lock', 'yarn.lock': 'lock', 'pnpm-lock.yaml': 'lock', 'composer.lock': 'lock', 'gemfile.lock': 'lock', 'cargo.lock': 'lock', 'poetry.lock': 'lock', 'bun.lockb': 'lock',
  '.env': 'env', '.htaccess': 'ini', '.editorconfig': 'ini', 'license': 'txt', 'copying': 'txt',
  id_rsa: 'key', id_ed25519: 'key', id_ecdsa: 'key', known_hosts: 'key', authorized_keys: 'key',
};

// The editor's language names (CodeMirror's) for files without an extension.
const LANGUAGES = {
  javascript: 'js', typescript: 'ts', jsx: 'jsx', tsx: 'tsx', python: 'py', java: 'java', kotlin: 'kt', scala: 'scala', groovy: 'groovy',
  c: 'c', 'c++': 'cpp', 'c#': 'cs', 'f#': 'fs', 'visual basic': 'vb', vb: 'vb', go: 'go', rust: 'rs', swift: 'swift', 'objective-c': 'm', 'objective-c++': 'm',
  php: 'php', ruby: 'rb', perl: 'pl', lua: 'lua', r: 'r', dart: 'dart', elixir: 'ex', erlang: 'erl', haskell: 'hs', clojure: 'clj', vue: 'vue', svelte: 'svelte',
  html: 'html', xml: 'xml', css: 'css', scss: 'scss', sass: 'scss', less: 'less', json: 'json', 'json-ld': 'json', yaml: 'yaml', toml: 'toml',
  'properties files': 'ini', markdown: 'md', sql: 'sql', postgresql: 'sql', mysql: 'sql', 'ms sql': 'sql', sqlite: 'sql', mariadb: 'sql', 'pl/sql': 'sql', cassandra: 'sql',
  shell: 'sh', powershell: 'ps1', dockerfile: 'docker', diff: 'diff', protobuf: 'proto', graphql: 'graphql', 'plain text': 'txt',
};

/** The type of a file by its name (else its language): { id, label, color, glyph } or { …, letters }. */
export function fileTypeOf(name = '', language = '') {
  const base = String(name).split(/[\\/]/).pop().toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 || (dot === 0 && !NAMES[base]) ? base.slice(dot + 1) : '';
  const id =
    NAMES[base] ??
    (base.startsWith('.env.') || base.endsWith('.env') ? 'env' : null) ??
    (/^(dockerfile|containerfile)\b/.test(base) ? 'docker' : null) ??
    (/^readme\b/.test(base) && !ext ? 'txt' : null) ??
    EXTENSIONS[ext] ??
    (!ext || !/^[a-z0-9]{1,8}$/.test(ext) ? LANGUAGES[String(language).toLowerCase()] : null) ??
    (ext ? 'file' : 'txt');
  const [label, color, mark] = TYPES[id];
  return GLYPHS.includes(mark) ? { id, label, color, glyph: mark } : { id, label, color, letters: mark };
}
