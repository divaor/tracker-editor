// New text files, and texts written out (Save a copy, a tab dragged out), with the line endings of
// their place and kind: lineEndings.js decides, from the setting `lineEndings`, the system of the
// place (this computer's; a server's as it said when it last connected; Docker and WSL are Linux)
// and the .editorconfig above the file (asked of the main process, which gives only that).
import { getSettings } from './settings.js';
import { server } from './servers.js';
import { newFileEol, placeEol, systemOf } from './lineEndings.js';
import { isRemotePath, remoteParts } from './where.js';

const desktop = () => globalThis.window?.desktop;
// The web app knows only what the browser says it runs on.
const browserWindows = () => {
  const nav = globalThis.navigator;
  return /windows/i.test(nav?.userAgentData?.platform ?? '') || /^win/i.test(nav?.platform ?? '');
};

/** 'windows' or 'unix': the system of the place `path` is in ('' for this computer or phone). */
export function systemAt(path = '') {
  return systemOf(path, { platform: desktop()?.platform ?? '', conn: isRemotePath(path) ? server(remoteParts(path).id) : null, browserWindows: browserWindows() });
}

/** This computer's (or phone's) line endings by the setting: for copies saved or dragged out here. */
export const hereEol = () => placeEol(getSettings().lineEndings, systemAt(''));

/** The line endings a new file at `path` gets, its .editorconfig left aside: { eol, why }. */
export const defaultEol = (path, text = '') => newFileEol({ name: String(path ?? '').split(/[\\/]/).pop(), text, setting: getSettings().lineEndings, system: systemAt(path) });

/** With the .editorconfig above it too (the file need not exist yet): { eol, why }. */
export async function eolForNew(path, text = '') {
  const config = await Promise.resolve(desktop()?.disk?.editorConfig?.(path)).catch(() => null);
  return newFileEol({ name: String(path ?? '').split(/[\\/]/).pop(), text, setting: getSettings().lineEndings, system: systemAt(path), editorconfig: config?.eol ?? null });
}

/** `name` in folder `dir`, with the folder's own separator. */
export function childOf(dir, name) {
  const sep = !isRemotePath(dir) && dir.includes('\\') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/**
 * Makes a text file in `dir` (folders.newFile: `unique` picks a free name) with the line endings
 * its place and kind call for (the text's \n become them). Returns its path.
 */
export async function newTextFile(dir, name, { text = '', unique = false } = {}) {
  const { eol } = await eolForNew(childOf(dir, name), text);
  return desktop().folders.newFile(dir, name, { text, unique, eol });
}
