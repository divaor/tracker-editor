import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { modeString, octalMode, parseMode, PERMISSION_WHAT, PERMISSION_WHO } from '../folders.js';
import { formatBytes, formatDateTime } from '../format.js';
import { server } from '../servers.js';
import { isRemotePath, protocolName, remoteAddress, remoteParts } from '../where.js';
import { Check, Modal } from './components.js';
import { Icon } from './icons.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const plural = (n, what) => `${n.toLocaleString()} ${what}${n === 1 ? '' : 's'}`;

/**
 * Properties of a file or folder in the folders view (desktop): where it is, its
 * size (a folder's on request), dates, owner and permissions, which can be
 * changed here: on servers and Mac/Linux as read/write/run for owner, group and
 * others (or as a number like 644); on Windows as "read-only".
 */
export function PropertiesDialog({ path, actions, onClose }) {
  const bridge = window.desktop.folders;
  const [info, setInfo] = useState(null); // the properties, or { error }
  const [mode, setMode] = useState(null);
  const [octal, setOctal] = useState('');
  const [recursive, setRecursive] = useState(false);
  const [size, setSize] = useState(null); // { busy } or { size, files, folders, truncated } or { error }
  const [state, setState] = useState(null); // { kind: 'busy' | 'ok' | 'error', text }
  const remote = isRemotePath(path);
  const conn = remote ? server(remoteParts(path).id) : null;

  const load = () =>
    bridge.properties(path).then(
      (p) => {
        setInfo(p);
        setMode(p.mode);
        setOctal(p.mode === null || p.mode === undefined ? '' : octalMode(p.mode));
      },
      (err) => setInfo({ error: message(err) }),
    );
  useEffect(() => {
    load();
  }, []);
  const windows = !remote && info?.platform === 'win32';
  const known = info && !info.error && mode !== null && mode !== undefined;
  const changed = known && mode !== info.mode;
  const setBits = (next) => {
    setMode(next);
    setOctal(octalMode(next));
  };
  const save = async () => {
    setState({ kind: 'busy', text: 'Changing the permissions…' });
    try {
      const count = await bridge.chmod([path], mode, { recursive: info.dir && recursive });
      await load();
      setState({ kind: 'ok', text: count > 1 ? `Permissions changed on ${plural(count, 'item')}.` : 'Permissions changed.' });
      window.dispatchEvent(new CustomEvent('folders:reload'));
    } catch (err) {
      setState({ kind: 'error', text: message(err) });
    }
  };
  const measure = () => {
    setSize({ busy: true });
    bridge.size(path).then(setSize, (err) => setSize({ error: message(err) }));
  };

  const where = remote ? remoteAddress(path, conn) : path;
  return html`<${Modal} title=${info?.name ?? 'Properties'} className="properties-dialog" onClose=${onClose}
    footer=${html`<button type="button" class="btn ghost" onClick=${() => actions.copyPath(path)}><${Icon} name="copy" size=${15} />Copy path</button>
      <span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Close</button>
      ${known && html`<button type="button" class="btn primary" disabled=${!changed || state?.kind === 'busy'} onClick=${save}>Save permissions</button>`}`}>
    ${!info && html`<p class="muted">Reading…</p>`}
    ${info?.error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${info.error}</p>`}
    ${info && !info.error &&
    html`<dl class="properties">
      <dt>Where</dt>
      <dd class="properties-where ${remote ? 'kind-remote' : 'kind-disk'}"><${Icon} name=${remote ? 'server' : 'disk'} size=${14} /><span>${where}</span></dd>
      ${remote && html`<dt>Server</dt><dd>${conn?.name ?? 'Server'} · ${protocolName(conn?.protocol)}</dd>`}
      <dt>Kind</dt>
      <dd>${info.dir ? 'Folder' : 'File'}${info.link ? ' (a link)' : ''}</dd>
      <dt>Size</dt>
      <dd>
        ${!info.dir && html`${formatBytes(info.size)} <span class="muted small">(${info.size.toLocaleString()} bytes)</span>`}
        ${info.dir && !size && html`<button type="button" class="btn sm" onClick=${measure}>Count what is inside</button>`}
        ${info.dir && size?.busy && html`<span class="muted">Counting…</span>`}
        ${info.dir && size?.error && html`<span class="error-text">${size.error}</span>`}
        ${info.dir && size && !size.busy && !size.error && html`${formatBytes(size.size)} · ${plural(size.files, 'file')}, ${plural(size.folders, 'folder')}${size.truncated ? html` <span class="muted small">(it stopped counting: very many)</span>` : ''}`}
      </dd>
      <dt>Modified</dt>
      <dd>${info.mtimeMs ? formatDateTime(new Date(info.mtimeMs).toISOString()) : '—'}</dd>
      ${info.birthtimeMs ? html`<dt>Created</dt><dd>${formatDateTime(new Date(info.birthtimeMs).toISOString())}</dd>` : ''}
      ${(info.owner || info.group) && !windows && html`<dt>Owner</dt><dd>${info.owner || '—'}${info.group ? html` <span class="muted">· group ${info.group}</span>` : ''}</dd>`}
      <dt>Permissions</dt>
      <dd>
        ${!known && html`<span class="muted">${remote ? 'This server does not say.' : 'Not known.'}</span>`}
        ${known && windows &&
        html`<${Check} checked=${!(mode & 0o200)} label="Read-only" hint=${info.dir ? 'For a folder, Windows mostly ignores it.' : 'Programs (and this editor) cannot save changes to it.'}
          onChange=${(on) => setBits(on ? mode & ~0o222 : mode | 0o200)} />`}
        ${known && !windows &&
        html`<div class="perm-grid" role="group" aria-label="Permissions">
            <span />
            ${PERMISSION_WHAT.map((w) => html`<span class="perm-head" key=${w.id}>${info.dir && w.folderLabel ? w.folderLabel : w.label}</span>`)}
            ${PERMISSION_WHO.map(
              (who) => html`<span class="perm-who" key=${who.id}>${who.label}</span>
                ${PERMISSION_WHAT.map((what) => {
                  const bit = what.bit << who.shift;
                  return html`<label class="perm-cell" key=${`${who.id}-${what.id}`}><input type="checkbox" checked=${Boolean(mode & bit)} aria-label=${`${who.label}: ${what.label}`}
                    onChange=${(e) => setBits(e.currentTarget.checked ? mode | bit : mode & ~bit)} /></label>`;
                })}`,
            )}
          </div>
          <div class="perm-octal">
            <label><span class="muted small">As a number</span>
              <input value=${octal} inputmode="numeric" maxlength="4" aria-label="Permissions as a number" spellcheck="false"
                onInput=${(e) => {
                  setOctal(e.currentTarget.value);
                  const parsed = parseMode(e.currentTarget.value);
                  if (parsed !== null) setMode(parsed);
                }} /></label>
            <code class="perm-string">${modeString(mode, info.dir)}</code>
          </div>
          ${info.dir && html`<${Check} checked=${recursive} label="Also for everything inside" hint="Folders inside can be opened wherever they can be read; files can run only if they could before." onChange=${setRecursive} />`}`}
      </dd>
    </dl>`}
    ${state && html`<p class="notice ${state.kind === 'error' ? 'error' : ''}" role="status"><${Icon} name=${state.kind === 'error' ? 'alert' : state.kind === 'ok' ? 'check' : 'sync'} size=${15} />${state.text}</p>`}
  </${Modal}>`;
}
