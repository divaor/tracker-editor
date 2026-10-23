// How a file is indented: tabs or spaces, and how many. Detected from the text,
// set by an .editorconfig, or chosen in the status bar. Pure: the tests use it.

/**
 * The indentation the text uses: { tabs, size } (size: the spaces per level), or
 * null when too few lines are indented to tell.
 */
export function detectIndent(text, { maxLines = 5000 } = {}) {
  let tabLines = 0;
  let spaceLines = 0;
  const steps = new Map(); // step between two indented lines → how often
  let prev = 0;
  let seen = 0;
  for (const raw of text.split('\n')) {
    if (++seen > maxLines) break;
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const lead = /^[ \t]*/.exec(line)[0];
    if (lead.startsWith('\t')) {
      tabLines++;
      prev = 0;
      continue;
    }
    // A space before "*" continues a block comment (" * text"): not indentation.
    if (/^ +\*/.test(line) && lead.length % 2 === 1) continue;
    const n = lead.length;
    if (n > 0) spaceLines++;
    const step = Math.abs(n - prev);
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    prev = n;
  }
  if (tabLines + spaceLines < 2) return null;
  if (tabLines > spaceLines) return { tabs: true, size: null };
  let best = 0;
  let count = 0;
  for (const [step, n] of steps) {
    // Prefer the smaller step when about as common (4 often appears as 2 + 2).
    if (n > count * 1.2 || (n >= count * 0.8 && step < best)) {
      best = step;
      count = n;
    }
  }
  if (!best) return null;
  return { tabs: false, size: best };
}

/** "Spaces: 2", "Tab size: 4": what the status bar says. */
export const indentLabel = (indent) => (indent.tabs ? `Tab size: ${indent.size}` : `Spaces: ${indent.size}`);

/**
 * The text with its line indentation changed to tabs (`toTabs`) or spaces, `size`
 * columns per level. Only the whitespace at line starts changes; a remainder smaller
 * than a level stays as spaces.
 */
export function convertIndent(text, { toTabs, size }) {
  return text
    .split('\n')
    .map((line) => {
      const lead = /^[ \t]*/.exec(line)[0];
      if (!lead) return line;
      let cols = 0;
      for (const c of lead) cols = c === '\t' ? cols + size - (cols % size) : cols + 1;
      const next = toTabs ? '\t'.repeat(Math.floor(cols / size)) + ' '.repeat(cols % size) : ' '.repeat(cols);
      return next + line.slice(lead.length);
    })
    .join('\n');
}

/**
 * The indentation an .editorconfig gives a file: its sections from the folder nearest
 * the file first (each { text, dir }: the file's text and the folder it is in), the
 * file's path inside the system ("/" between folders). { tabs, size } or null.
 */
export function editorConfigIndent(configs, file) {
  const props = {};
  // Nearest last, so it wins; a root = true stops the ones above it.
  const chain = [];
  for (const c of configs) {
    chain.unshift(c);
    if (/^\s*root\s*=\s*true\s*$/im.test(c.text.split(/^\s*\[/m)[0])) break;
  }
  for (const { text, dir } of chain) {
    let section = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const head = /^\[(.*)\]$/.exec(line);
      if (head) {
        section = head[1];
        continue;
      }
      if (section === null) continue;
      const kv = /^([^=:]+)[=:](.*)$/.exec(line);
      if (!kv || !globMatches(section, file, dir)) continue;
      props[kv[1].trim().toLowerCase()] = kv[2].trim().toLowerCase();
    }
  }
  const style = props.indent_style;
  // A tab is tab_width wide; indent_size is the step (or "tab": a tab's width).
  const tabWidth = Number(props.tab_width) || null;
  const step = props.indent_size === 'tab' ? tabWidth : Number(props.indent_size) || null;
  const size = (style === 'tab' ? tabWidth || step : step || tabWidth) || null;
  if (style !== 'tab' && style !== 'space' && !size) return null;
  return { tabs: style === 'tab' ? true : style === 'space' ? false : null, size };
}

// An .editorconfig section glob: "*", "*.py", "{*.js,*.ts}", "lib/**.js", "[Mm]akefile".
function globMatches(glob, file, dir) {
  const rel = file.startsWith(`${dir}/`) ? file.slice(dir.length + 1) : file;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += `(?:${glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|')})`;
        i = end;
      }
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\/]/g, '\\$&');
  }
  // Without a "/", a glob matches the name in any folder below.
  const pattern = glob.includes('/') ? `^${re.replace(/^\\\//, '')}$` : `(?:^|/)${re}$`;
  return new RegExp(pattern).test(rel);
}
