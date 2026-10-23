import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { getSettings, isLocal, isSyncConfigured } from '../settings.js';
import { store } from '../store.js';
import { dataClient } from '../syncManager.js';
import { fetchVault, onVault, vaultState } from '../vault.js';
import { Card } from './components.js';
import { Icon } from './icons.js';

const MIN_PASSPHRASE = 10;

export function useVault() {
  const [state, setState] = useState(vaultState);
  useEffect(() => onVault(setState), []);
  return state;
}

/** A passphrase field and its button; `run` throws to show an error. */
function PassphraseForm({ label, confirm = false, run, autoFocus = false }) {
  const [value, setValue] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (confirm && value.length < MIN_PASSPHRASE) return setError(`Use at least ${MIN_PASSPHRASE} characters: a few words you will remember.`);
    if (confirm && value !== again) return setError('The two passphrases are different.');
    setBusy(true);
    try {
      await run(value);
      setValue('');
      setAgain('');
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };
  return html`<form class="passphrase-form" onSubmit=${submit}>
    <input type="password" value=${value} onInput=${(e) => setValue(e.currentTarget.value)} placeholder="Passphrase" aria-label="Passphrase" autocomplete=${confirm ? 'new-password' : 'current-password'} ref=${(el) => autoFocus && el && setTimeout(() => el.focus(), 0)} />
    ${confirm && html`<input type="password" value=${again} onInput=${(e) => setAgain(e.currentTarget.value)} placeholder="The same passphrase again" aria-label="Passphrase again" autocomplete="new-password" />`}
    <button type="submit" class="btn primary" disabled=${busy || !value}><${Icon} name="unlock" size=${15} />${busy ? 'Working…' : label}</button>
    ${error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${error}</p>`}
  </form>`;
}

/** In place of the editor for an encrypted file this device cannot read yet. */
export function LockedFile({ file, actions }) {
  const vault = useVault();
  return html`<div class="welcome locked-file">
    <div class="welcome-card">
      <h1><${Icon} name="lock" size=${20} /> ${file.name} is encrypted</h1>
      ${vault.exists
        ? html`<p class="muted">Enter your passphrase to read and edit it on this device. It is the one you chose when you set up encryption.</p>
            <${PassphraseForm} label="Unlock" run=${actions.unlockEncryption} autoFocus />`
        : html`<p class="muted">${isLocal() ? 'The encryption settings are not on this computer.' : 'Sync this device to get your encryption settings, then unlock it with your passphrase.'}</p>`}
    </div>
  </div>`;
}

/** Settings: set the passphrase, unlock this device, or lock it. */
export function EncryptionCard({ actions }) {
  const vault = useVault();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Local mode: the vault is in the data on this computer.
  const configured = isLocal() || isSyncConfigured(getSettings());
  const count = store.live().filter((f) => f.encrypted).length;
  // Whether another device already set a passphrase.
  useEffect(() => {
    if (!configured) return;
    (async () => {
      const { client, branch } = await dataClient();
      await fetchVault(client, branch);
    })().catch((err) => setError(err.message));
  }, [configured]);
  const lockNow = async () => {
    setBusy(true);
    setError('');
    try {
      await actions.lockDevice();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };
  return html`<${Card} title="Encryption" icon="lock">
    <p class="muted small">${isLocal()
      ? 'Files you choose to encrypt are stored as ciphertext: anyone who gets the data folder sees only their names, projects and tags. Your passphrase reads them.'
      : 'Files you choose to encrypt are stored in your data repo as ciphertext: GitHub, the Claude connector and anyone with access to the repo see only their names, projects and tags. Every device needs your passphrase to read them.'}</p>
    ${!configured && html`<p class="muted small">Set up sync first: the encryption settings are kept in your data repo.</p>`}
    ${configured && !vault.exists &&
    html`<p class="notice"><${Icon} name="alert" size=${15} />There is no way to recover the files if you forget the passphrase. Write it down somewhere safe.</p>
      <${PassphraseForm} label="Set the passphrase" confirm run=${actions.setUpEncryption} />`}
    ${configured && vault.exists && !vault.unlocked &&
    html`<p class="small">A passphrase is set. Unlock this device to read and edit your encrypted files.</p>
      <${PassphraseForm} label="Unlock" run=${actions.unlockEncryption} />`}
    ${vault.unlocked &&
    html`<p class="small"><${Icon} name="unlock" size=${14} /> Unlocked on this device${count ? ` · ${count} encrypted file${count === 1 ? '' : 's'}` : ''}. To encrypt a file, open its menu (⋯) and choose Encrypt.</p>
      <p class="muted small">This device keeps the text of encrypted files so they work offline. Lock it to keep only the ciphertext here until you unlock it again.</p>
      <div class="card-actions"><button type="button" class="btn" disabled=${busy} onClick=${lockNow}><${Icon} name="lock" size=${15} />${busy ? 'Locking…' : 'Lock this device'}</button></div>`}
    ${error && html`<p class="notice error"><${Icon} name="alert" size=${15} />${error}</p>`}
  </${Card}>`;
}
