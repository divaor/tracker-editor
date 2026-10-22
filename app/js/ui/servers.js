import { html, useState } from '../../vendor/preact-htm.js';
import { refreshServers } from '../servers.js';
import { protocolName } from '../where.js';
import { Check, Field, Modal, Segmented, toast } from './components.js';
import { Icon } from './icons.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const PORTS = { sftp: 22, ftps: 21, ftp: 21 };
const PROTOCOLS = [
  { id: 'sftp', label: 'SFTP (SSH)' },
  { id: 'ftps', label: 'FTPS' },
  { id: 'ftp', label: 'FTP' },
];
const AUTHS = [
  { id: 'password', label: 'Password' },
  { id: 'key', label: 'Key file' },
  { id: 'agent', label: 'SSH agent' },
];

/**
 * A server to edit files on (desktop): SFTP, FTPS or FTP. Passwords and key
 * passphrases go to this computer's keychain and are never shown again; a blank
 * field keeps the saved one.
 */
export function ServerDialog({ conn = {}, actions, onClose }) {
  const editing = Boolean(conn.id);
  const [form, setForm] = useState(() => ({ protocol: 'sftp', auth: 'password', port: '', autoSave: false, allowSelfSigned: false, ...conn, port: conn.port ? String(conn.port) : '' }));
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [check, setCheck] = useState(null); // { state: 'busy' | 'ok' | 'error', text }
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const sftp = form.protocol === 'sftp';
  const secrets = () => ({ ...(password ? { password } : {}), ...(passphrase ? { passphrase } : {}) });
  const draft = () => ({ ...form, port: Number(form.port) || PORTS[form.protocol], auth: sftp ? form.auth : 'password' });

  const test = async () => {
    setCheck({ state: 'busy', text: `Connecting to ${form.host || 'the server'}…` });
    try {
      const result = await window.desktop.remote.test(draft(), secrets());
      setCheck({ state: 'ok', text: `Connected. ${result.path} has ${result.entries} item${result.entries === 1 ? '' : 's'}.` });
    } catch (err) {
      setCheck({ state: 'error', text: message(err) });
    }
  };
  const save = async (andOpen) => {
    try {
      const saved = await window.desktop.remote.save(draft(), secrets());
      await refreshServers();
      onClose();
      if (andOpen) actions.openServer(saved.id);
      else toast(`${saved.name} is saved. Open it from Folders.`);
    } catch (err) {
      setCheck({ state: 'error', text: message(err) });
    }
  };
  const remove = async () => {
    await window.desktop.remote.delete(conn.id);
    await refreshServers();
    toast(`${conn.name} is removed, with its saved password.`);
    onClose();
  };
  const pickKey = async () => {
    const keyPath = await window.desktop.remote.pickKey();
    if (keyPath) set({ keyPath });
  };

  return html`<${Modal} title=${editing ? `Server: ${conn.name}` : 'Connect to a server'} wide className="server-dialog" onClose=${onClose}
    footer=${html`${editing && html`<button type="button" class="btn ghost danger" onClick=${remove}><${Icon} name="trash" size=${15} />Remove</button>`}
      <span class="spacer" />
      <button type="button" class="btn" disabled=${!form.host || check?.state === 'busy'} onClick=${test}>Test</button>
      <button type="button" class="btn" disabled=${!form.host} onClick=${() => save(false)}>Save</button>
      <button type="button" class="btn primary" disabled=${!form.host} onClick=${() => save(true)}><${Icon} name="server" size=${15} />Save and open</button>`}>
    <form class="field-grid" onSubmit=${(e) => (e.preventDefault(), save(true))}>
      <div class="field span-2"><span>Protocol</span>
        <${Segmented} options=${PROTOCOLS} value=${form.protocol} label="Protocol" onChange=${(protocol) => set({ protocol })} />
        ${form.protocol === 'ftp' && html`<small class="warn-text">FTP sends your password and files unencrypted. Use SFTP or FTPS when the server has them.</small>`}
      </div>
      <${Field} label="Server (host name or address)">
        <input value=${form.host ?? ''} placeholder="files.example.com" autocomplete="off" spellcheck="false" onInput=${(e) => set({ host: e.currentTarget.value })} />
      </${Field}>
      <${Field} label="Port">
        <input value=${form.port} placeholder=${String(PORTS[form.protocol])} inputmode="numeric" onInput=${(e) => set({ port: e.currentTarget.value.replace(/\D/g, '') })} />
      </${Field}>
      <${Field} label="User name">
        <input value=${form.user ?? ''} autocomplete="off" spellcheck="false" onInput=${(e) => set({ user: e.currentTarget.value })} />
      </${Field}>
      <${Field} label="Name in the editor" hint="Shown on tabs and in Folders">
        <input value=${form.name ?? ''} placeholder=${form.host || 'My server'} onInput=${(e) => set({ name: e.currentTarget.value })} />
      </${Field}>
      ${sftp &&
      html`<div class="field span-2"><span>Sign in with</span>
        <${Segmented} options=${AUTHS} value=${form.auth} label="Sign in with" onChange=${(auth) => set({ auth })} />
      </div>`}
      ${(!sftp || form.auth === 'password') &&
      html`<${Field} label="Password" hint=${editing && conn.hasPassword ? 'Saved on this computer. Type to change it.' : 'Kept in this computer’s keychain.'}>
        <input type="password" value=${password} autocomplete="new-password" placeholder=${editing && conn.hasPassword ? '••••••••' : ''} onInput=${(e) => setPassword(e.currentTarget.value)} />
      </${Field}>`}
      ${sftp && form.auth === 'key' &&
      html`<div class="field"><span>Private key</span>
          <div class="row-input">
            <input value=${form.keyPath ?? ''} readonly placeholder="Choose your key file" title=${form.keyPath ?? ''} />
            <button type="button" class="btn sm" onClick=${pickKey}>Choose…</button>
          </div>
        </div>
        <${Field} label="Key passphrase" hint=${editing && conn.hasPassphrase ? 'Saved. Type to change it.' : 'Only if the key has one.'}>
          <input type="password" value=${passphrase} autocomplete="new-password" onInput=${(e) => setPassphrase(e.currentTarget.value)} />
        </${Field}>`}
      ${sftp && form.auth === 'agent' && html`<p class="muted small span-2">Uses the keys loaded in your SSH agent (OpenSSH Authentication Agent on Windows, ssh-agent on macOS and Linux).</p>`}
      <${Field} label="Start in folder" hint="Blank: your home folder on the server" wide>
        <input value=${form.path ?? ''} placeholder="/var/www" spellcheck="false" onInput=${(e) => set({ path: e.currentTarget.value })} />
      </${Field}>
      <${Check} checked=${form.autoSave} label="Save to the server automatically" hint="A moment after you stop typing. Off: Ctrl+S saves, and the tab says when it is not saved."
        onChange=${(autoSave) => set({ autoSave })} />
      ${form.protocol === 'ftps' &&
      html`<${Check} checked=${form.allowSelfSigned} label="Allow self-signed certificates" hint="For a server with its own certificate. Less safe: anyone in between could pose as it."
        onChange=${(allowSelfSigned) => set({ allowSelfSigned })} />`}
      ${editing && sftp && html`<p class="muted small span-2">The server's key was checked the first time. If the server was reinstalled, <button type="button" class="btn link" onClick=${() => window.desktop.remote.forgetHostKey(conn.id).then(() => toast('The next connection asks about its key again.'))}>forget its key</button>.</p>`}
      ${check && html`<p class="notice span-2 ${check.state === 'error' ? 'error' : ''}" role="status"><${Icon} name=${check.state === 'error' ? 'alert' : check.state === 'ok' ? 'check' : 'sync'} size=${15} />${check.text}</p>`}
      <button type="submit" hidden />
    </form>
  </${Modal}>`;
}

/** The first connection to an SSH server, or its key changed: asks before trusting it. */
export function HostKeyDialog({ info, onAnswer }) {
  const changed = Boolean(info.previous);
  return html`<${Modal} title=${changed ? 'The server’s key changed' : 'A new server'} className="hostkey-dialog" onClose=${() => onAnswer(false)}
    footer=${html`<span class="spacer" />
      <button type="button" class=${changed ? 'btn primary' : 'btn'} onClick=${() => onAnswer(false)}>${changed ? 'Do not connect' : 'Cancel'}</button>
      <button type="button" class=${changed ? 'btn danger' : 'btn primary'} onClick=${() => onAnswer(true)}>${changed ? 'Trust the new key' : 'Trust and connect'}</button>`}>
    ${changed
      ? html`<p class="notice error"><${Icon} name="alert" size=${16} />${info.name} (${info.host}:${info.port}) answered with a different key than before. If the server was not reinstalled, someone may be in between: do not connect.</p>`
      : html`<p>This is the first connection to <strong>${info.name}</strong> (${info.host}:${info.port}) from this computer. Check that its key fingerprint is the one your server shows (<code>ssh-keygen -lf</code> on the server, or ask its administrator):</p>`}
    <p class="fingerprint"><code>${info.fingerprint}</code></p>
    ${changed && html`<p class="muted small">Before: <code>${info.previous}</code></p>`}
    <p class="muted small">${protocolName('sftp')} · trusted keys are remembered for next time.</p>
  </${Modal}>`;
}
