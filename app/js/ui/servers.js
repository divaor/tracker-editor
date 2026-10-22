import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { refreshServers, servers } from '../servers.js';
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
  const draft = () => ({ ...form, port: Number(form.port) || PORTS[form.protocol], auth: sftp ? form.auth : 'password', jump: sftp ? (form.jump ?? '') : '' });
  // Other SFTP servers, not reached through this one.
  const reachedThrough = (c, seen = new Set()) => (c.jump && !seen.has(c.id) ? c.jump === conn.id || reachedThrough(servers().find((x) => x.id === c.jump) ?? {}, seen.add(c.id)) : false);
  const jumpHosts = servers().filter((c) => c.protocol === 'sftp' && c.id !== conn.id && !(conn.id && reachedThrough(c)));

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
    try {
      await window.desktop.remote.delete(conn.id);
    } catch (err) {
      return setCheck({ state: 'error', text: message(err) });
    }
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
      ${!editing && html`<button type="button" class="btn ghost" title="Set up the hosts of ~/.ssh/config" onClick=${() => (onClose(), actions.importSshConfig())}>From SSH config…</button>`}
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
      html`<${Field} label="Password" hint=${editing && conn.hasPassword ? 'Saved on this computer. Type to change it.' : 'Kept in this computer’s keychain. Blank: asked when you connect.'}>
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
      ${sftp &&
      html`<${Field} label="Reach it through" hint="A jump host (bastion): another SFTP server set up here, connected first" wide>
        <select value=${form.jump ?? ''} onChange=${(e) => set({ jump: e.currentTarget.value })}>
          <option value="">Directly</option>
          ${jumpHosts.map((c) => html`<option key=${c.id} value=${c.id}>${c.name} (${c.user ? `${c.user}@` : ''}${c.host})</option>`)}
        </select>
      </${Field}>`}
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

/**
 * Servers from the SSH config (~/.ssh/config): its hosts, ticked to set them up
 * here. Their jump hosts (ProxyJump) and key files come along.
 */
export function SshImportDialog({ onClose }) {
  const [config, setConfig] = useState(null); // { file, hosts, missing } or { error }
  const [picked, setPicked] = useState(() => new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    window.desktop.remote.sshConfig().then(
      (c) => {
        setConfig(c);
        setPicked(new Set(c.hosts.filter((h) => !h.known).map((h) => h.alias)));
      },
      (err) => setConfig({ hosts: [], error: message(err) }),
    );
  }, []);
  const toggle = (alias) =>
    setPicked((p) => {
      const next = new Set(p);
      next.has(alias) ? next.delete(alias) : next.add(alias);
      return next;
    });
  const run = async () => {
    setBusy(true);
    try {
      const { made } = await window.desktop.remote.importSsh([...picked]);
      await refreshServers();
      onClose();
      toast(made.length ? `${made.length} server${made.length === 1 ? ' is' : 's are'} set up from your SSH config. Open them from Folders.` : 'Those servers were set up here already.');
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  };
  const hosts = config?.hosts ?? [];
  return html`<${Modal} title="Servers from your SSH config" wide className="ssh-import-dialog" onClose=${onClose}
    footer=${html`<span class="muted small">${config?.file ?? ''}</span><span class="spacer" />
      <button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!picked.size || busy} onClick=${run}><${Icon} name="server" size=${15} />Set up ${picked.size || ''}</button>`}>
    ${!config && html`<p class="muted">Reading your SSH config…</p>`}
    ${config?.error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${config.error}</p>`}
    ${config?.missing && html`<p class="muted">There is no SSH config on this computer (${config.file}). Set servers up with Connect to a server instead.</p>`}
    ${config && !config.missing && !config.error && !hosts.length && html`<p class="muted">Your SSH config has no hosts with a plain name (only patterns like *).</p>`}
    ${hosts.length > 0 &&
    html`<p class="muted small">Passwords are not in the SSH config: when a server needs one, it is asked the first time you connect. Keys are used where they are.</p>
    <ul class="ssh-hosts" role="list">
      ${hosts.map(
        (h) => html`<li key=${h.alias}>
          <label class="ssh-host ${h.known ? 'known' : ''}">
            <input type="checkbox" checked=${picked.has(h.alias)} onChange=${() => toggle(h.alias)} />
            <span class="ssh-host-main"><strong>${h.alias}</strong> <span class="muted small">${h.user ? `${h.user}@` : ''}${h.host}${h.port !== 22 ? `:${h.port}` : ''}</span></span>
            <span class="ssh-host-tags">
              ${h.key && html`<span class="chip" title="The key file it signs in with">key ${h.key}</span>`}
              ${h.proxyJump && html`<span class="chip" title="Reached through this jump host, which is set up too">through ${h.proxyJump}</span>`}
              ${h.known && html`<span class="chip">set up already</span>`}
              ${h.proxyCommand && html`<span class="chip warn" title="ProxyCommand is not run here; set a jump host for it instead">ProxyCommand not used</span>`}
            </span>
          </label>
        </li>`,
      )}
    </ul>`}
    ${error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${error}</p>`}
  </${Modal}>`;
}

/**
 * A question while signing in to a server: a password that is not saved, a key's
 * passphrase, or the server's own questions (a one-time code, a second factor).
 * Answers go to the server; a password or passphrase is kept only when asked to.
 */
export function PromptDialog({ info, onAnswer }) {
  const prompts = info.prompts?.length ? info.prompts : [{ prompt: 'Password', echo: false }];
  const [values, setValues] = useState(() => prompts.map(() => ''));
  const [remember, setRemember] = useState(false);
  const secretKind = info.kind === 'passphrase' ? 'passphrase' : 'password';
  const submit = (e) => {
    e?.preventDefault();
    onAnswer({ answers: values, remember: info.canRemember && remember });
  };
  const at = `${info.user ? `${info.user}@` : ''}${info.host}${info.port && ![21, 22].includes(info.port) ? `:${info.port}` : ''}`;
  return html`<${Modal} title=${info.title || 'Sign in'} className="prompt-dialog" onClose=${() => onAnswer(null)}
    footer=${html`<span class="spacer" />
      <button type="button" class="btn" onClick=${() => onAnswer(null)}>Cancel</button>
      <button type="button" class="btn primary" onClick=${submit}><${Icon} name="server" size=${15} />Sign in</button>`}>
    <form onSubmit=${submit}>
      <p class="muted small prompt-where"><${Icon} name="server" size=${14} /><strong>${info.name}</strong> · ${at}</p>
      ${info.instructions && html`<p class="prompt-instructions">${info.instructions}</p>`}
      ${prompts.map(
        (p, i) => html`<label class="field" key=${i}><span>${p.prompt.replace(/:\s*$/, '') || 'Answer'}</span>
          <input type=${p.echo ? 'text' : 'password'} value=${values[i]} autocomplete="off" spellcheck="false"
            onInput=${(e) => {
              const next = [...values];
              next[i] = e.currentTarget.value;
              setValues(next);
            }} />
        </label>`,
      )}
      ${info.canRemember && html`<${Check} checked=${remember} label=${`Remember the ${secretKind} on this computer`} hint="Kept in this computer’s keychain, like the ones typed in the server’s settings." onChange=${setRemember} />`}
      ${info.kind === 'interactive' && !info.canRemember && html`<p class="muted small">Sent to the server only, and not kept.</p>`}
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
