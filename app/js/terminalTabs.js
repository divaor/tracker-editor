// The terminal panel's tabs (terminals.js keeps the sessions): their order, the one in use,
// and the panel split in two, a terminal on each side. Pure, so the Node tests can import it.
// State: { order: [key], active: key | null, split: { left: key, right: key } | null }.

export const EMPTY_TABS = { order: [], active: null, split: null };

const otherSide = (side) => (side === 'left' ? 'right' : 'left');

/** The side a tab shows on while the panel is split ('left', 'right'), or null. */
export function sideOf(state, key) {
  if (!state.split || !key) return null;
  return state.split.left === key ? 'left' : state.split.right === key ? 'right' : null;
}

/** Whether a tab's screen shows: on its side when split, else when it is the one in use. */
export const shown = (state, key) => (state.split ? Boolean(sideOf(state, key)) : state.active === key);

// The tab next to `key` (the one after it, else the one before), leaving out `skip`.
function neighbor(order, key, skip = null) {
  const at = order.indexOf(key);
  return [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0)).reverse()].find((k) => k !== key && k !== skip) ?? null;
}

/** A new tab, at the end, in use (when split, on the side of the one in use before). */
export function addTab(state, key) {
  if (state.order.includes(key)) return useTab(state, key);
  return useTab({ ...state, order: [...state.order, key] }, key);
}

/** `key` in use. When split and it is not shown, it takes the place of the one in use. */
export function useTab(state, key) {
  if (!state.order.includes(key)) return state;
  if (!state.split || sideOf(state, key)) return { ...state, active: key };
  const side = sideOf(state, state.active) ?? 'left';
  return { ...state, active: key, split: { ...state.split, [side]: key } };
}

/** `key` moved to `index` among the other tabs (what a drop between two tabs gives). */
export function moveTab(state, key, index) {
  const rest = state.order.filter((k) => k !== key);
  if (rest.length === state.order.length) return state;
  const at = Math.max(0, Math.min(rest.length, index));
  return { ...state, order: [...rest.slice(0, at), key, ...rest.slice(at)] };
}

/**
 * `key` shown on `side`, the panel split: the other side keeps what it showed (moving it
 * there from the other side swaps the two), else the one in use, else the tab next to it.
 * Nothing changes with a single tab.
 */
export function splitTab(state, key, side) {
  if (!state.order.includes(key) || state.order.length < 2) return state;
  const other = otherSide(side);
  let keep;
  if (state.split) keep = state.split[other] === key ? state.split[side] : state.split[other];
  else keep = state.active && state.active !== key ? state.active : neighbor(state.order, key);
  if (!keep || keep === key) return state;
  return { ...state, active: key, split: { [side]: key, [other]: keep } };
}

/** One terminal again: `keep` (by default the one in use) shows alone. */
export function unsplit(state, keep = state.active) {
  return { ...state, split: null, active: state.order.includes(keep) ? keep : state.active };
}

/**
 * After `key` closes: the tab next to it takes its place (in use when it was), and on its
 * side when split (the next tab not on the other side); with nothing to put there, the panel
 * is one terminal again.
 */
export function closeTab(state, key) {
  const at = state.order.indexOf(key);
  if (at === -1) return state;
  const order = state.order.filter((k) => k !== key);
  const side = sideOf(state, key);
  if (side) {
    const kept = state.split[otherSide(side)];
    const spare = neighbor(state.order, key, kept);
    const split = spare ? { [side]: spare, [otherSide(side)]: kept } : null;
    return { order, split, active: state.active === key ? (spare ?? kept) : state.active };
  }
  const active = state.active === key ? (order[Math.min(at, order.length - 1)] ?? null) : state.active;
  return { order, split: state.split, active };
}

/** A tab's name in the panel: the one given (Rename), else what it is and where it opened. */
export function tabName({ name = '', runner = false, place = '', folder = '' }) {
  if (name.trim()) return name.trim();
  return `${runner ? 'Run · ' : ''}${place}${folder ? ` · ${folder}` : ''}`;
}

/** Where a drop over the tab strip goes: the index among the other tabs, by the pointer and the tabs' middles. */
export function dropIndex(middles, x, draggedAt = -1) {
  let index = middles.filter((m) => m < x).length;
  // The dragged tab itself does not count as one to pass.
  if (draggedAt !== -1 && draggedAt < index) index -= 1;
  return index;
}

/**
 * The folder a shell says it is in, from an escape sequence it printed: OSC 7
 * ("file://host/path", percent-encoded), OSC 9;9 ("9;"C:\path"", PowerShell and cmd, as in
 * ConEmu and Windows Terminal) or OSC 633 ("P;Cwd=path", VS Code's). `ident` is the OSC number,
 * `data` what follows it. `windows`: paths on this computer are Windows paths (C:/x → C:\x).
 * null when it says nothing usable (a relative path, nonsense, something too long).
 */
export function oscCwd(ident, data, { windows = false } = {}) {
  let p = null;
  const text = String(data ?? '');
  if (text.length > 4096) return null;
  if (ident === 7) {
    const m = /^file:\/\/[^/]*(\/.*)$/i.exec(text);
    if (!m) return null;
    try {
      p = decodeURIComponent(m[1]);
    } catch {
      p = m[1];
    }
    // file:///C:/x on Windows.
    if (/^\/[A-Za-z]:([/\\]|$)/.test(p)) p = p.slice(1);
  } else if (ident === 9) {
    const m = /^9;(?:"([^"]*)"|(.*))$/.exec(text);
    if (!m) return null;
    p = m[1] ?? m[2];
  } else if (ident === 633) {
    const m = /^P;Cwd=(.*)$/.exec(text);
    if (!m) return null;
    p = m[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\\/g, '\\');
  } else return null;
  if (!p || /[\u0000-\u001f]/.test(p)) return null;
  const isWin = /^[A-Za-z]:([/\\]|$)/.test(p) || /^\\\\/.test(p);
  if (!isWin && !p.startsWith('/')) return null;
  if (isWin && windows) p = p.replace(/\//g, '\\').replace(/^([A-Za-z]:)$/, '$1\\');
  return p.length > 1 && !/^[A-Za-z]:\\$/.test(p) ? p.replace(/[\\/]+$/, '') : p;
}

/**
 * A folder inside WSL as Windows reaches it: /mnt/c/x → C:\x, others under
 * \\wsl.localhost\<distro> (null without a distribution's name).
 */
export function fromWsl(p, distro = '') {
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(p);
  if (m) return `${m[1].toUpperCase()}:${(m[2] ?? '\\').replace(/\//g, '\\')}`;
  return distro ? `\\\\wsl.localhost\\${distro}${p.replace(/\//g, '\\')}` : null;
}
