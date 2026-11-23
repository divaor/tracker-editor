// Files locked with a password (locked.js, lockedTabs.js): the lock screen that takes the editor's
// place until the password is given, and the dialogs to make a locked file, lock one, change its
// password or take its lock off.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { LockedError, MIN_PASSWORD, passwordStrength } from '../locked.js';
import { isLocal } from '../settings.js';
import { Modal } from './components.js';
import { Icon } from './icons.js';

const FORGOTTEN = 'A forgotten password cannot be recovered: nobody, not even this app, can open the file without it.';
const messageOf = (err) => (err instanceof LockedError ? err.message : err?.message || String(err));

/** A password field with show/hide. */
function PasswordInput({ value, onInput, label, autoFocus = false, newPassword = false, shown, onShown }) {
  const ref = useRef(null);
  useEffect(() => {
    if (autoFocus) setTimeout(() => ref.current?.focus(), 0);
  }, []);
  return html`<span class="locked-password">
    <input ref=${ref} type=${shown ? 'text' : 'password'} value=${value} onInput=${(e) => onInput(e.currentTarget.value)} aria-label=${label} placeholder=${label}
      autocomplete=${newPassword ? 'new-password' : 'current-password'} spellcheck="false" autocapitalize="off" autocorrect="off" />
    ${onShown && html`<button type="button" class="icon-btn" aria-label=${shown ? 'Hide the password' : 'Show the password'} title=${shown ? 'Hide' : 'Show'} aria-pressed=${shown} onClick=${() => onShown(!shown)}><${Icon} name=${shown ? 'eyeOff' : 'eye'} size=${16} /></button>`}
  </span>`;
}

/** A new password typed twice, with how hard it is to guess. `onChange({ password, ok })`. */
function NewPassword({ onChange, autoFocus = false, label = 'Password' }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [shown, setShown] = useState(false);
  const strength = passwordStrength(password);
  const problem = !password ? '' : password.length < MIN_PASSWORD ? strength.hint : again && again !== password ? 'The two passwords are different.' : '';
  useEffect(() => onChange({ password, ok: password.length >= MIN_PASSWORD && password === again }), [password, again]);
  return html`<div class="locked-new-password">
    <label class="field"><span>${label}</span><${PasswordInput} value=${password} onInput=${setPassword} label=${label} newPassword autoFocus=${autoFocus} shown=${shown} onShown=${setShown} /></label>
    ${password && html`<div class="locked-strength s${strength.score}" aria-live="polite"><span class="bar"><span style=${{ width: `${(strength.score + 1) * 20}%` }} /></span><span>${strength.label}</span></div>`}
    <label class="field"><span>The same password again</span><${PasswordInput} value=${again} onInput=${setAgain} label="The same password again" newPassword shown=${shown} /></label>
    ${problem && html`<p class="field-error">${problem}</p>`}
    ${!problem && strength.hint && password.length >= MIN_PASSWORD && html`<p class="muted small">${strength.hint}</p>`}
  </div>`;
}

const RelockCheck = ({ checked, onChange }) => html`<label class="field checkbox">
  <input type="checkbox" checked=${checked} onChange=${(e) => onChange(e.currentTarget.checked)} />
  <span>Ask for the password each time I come back to this tab<small>Switching to another tab locks it again.</small></span>
</label>`;

/**
 * In the editor's place for a locked file not open here: its password opens it (in memory only,
 * until it locks again). `onUnlock(password, { relock })` throws to say why it did not open.
 */
export function LockScreen({ name, where, relock = false, onUnlock, onClose }) {
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [again, setAgain] = useState(relock);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await onUnlock(password, { relock: again });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };
  return html`<div class="welcome locked-file locked-screen">
    <form class="welcome-card" onSubmit=${submit} aria-label=${`${name} is locked`}>
      <h1><${Icon} name="lock" size=${20} /> ${name} is locked</h1>
      <p class="muted">${where ? html`${where}. ` : ''}Type its password to open it. The password is asked for every time the file opens.</p>
      <label class="field"><span>Password</span><${PasswordInput} value=${password} onInput=${(v) => (setPassword(v), setError(''))} label="Password" autoFocus shown=${shown} onShown=${setShown} /></label>
      <${RelockCheck} checked=${again} onChange=${setAgain} />
      ${error && html`<p class="notice error" role="alert"><${Icon} name="alert" size=${15} /><span>${error}</span></p>`}
      <div class="welcome-actions">
        <button type="submit" class="btn primary" disabled=${!password || busy}><${Icon} name="unlock" size=${15} />${busy ? 'Opening…' : 'Open'}</button>
        ${onClose && html`<button type="button" class="btn" onClick=${onClose}>Close the tab</button>`}
      </div>
      <p class="muted small">${FORGOTTEN}</p>
    </form>
  </div>`;
}

/**
 * A new locked file: its name and password (twice). `where`: 'folder' (a file "<name>.locked" in
 * `dir`, written encrypted) or 'notes' (a note in My files, synced as ciphertext).
 */
export function NewLockedDialog({ where, place, defaultName = 'notes.md', onCreate, onClose }) {
  const [name, setName] = useState(defaultName);
  const [pw, setPw] = useState({ password: '', ok: false });
  const [relock, setRelock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async (e) => {
    e?.preventDefault();
    if (!pw.ok || !name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onCreate({ name: name.trim(), password: pw.password, relock });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };
  return html`<${Modal} title="New locked file" onClose=${onClose} className="locked-dialog"
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!pw.ok || !name.trim() || busy} onClick=${create}><${Icon} name="lock" size=${15} />${busy ? 'Locking…' : 'Create'}</button>`}>
    <form class="locked-form" onSubmit=${create}>
      <p class="muted small">${where === 'folder' ? html`In <strong>${place}</strong>, as <code>${name.trim() || 'name'}.locked</code>: what is on disk is encrypted.` : html`In My files${place ? html` (${place})` : ''}: what this device keeps${isLocal() ? '' : ' and syncs'} is encrypted. Its name is not.`}</p>
      <label class="field"><span>Name</span><input value=${name} onInput=${(e) => setName(e.currentTarget.value)} spellcheck="false" ref=${(el) => el && !el.dataset.done && ((el.dataset.done = '1'), setTimeout(() => el.select(), 0))} /><small>Its type (.md, .txt…) gives its colors once open.</small></label>
      <${NewPassword} onChange=${setPw} />
      <${RelockCheck} checked=${relock} onChange=${setRelock} />
      <p class="notice warn"><${Icon} name="alert" size=${15} /><span>${FORGOTTEN}</span></p>
      ${error && html`<p class="notice error" role="alert"><${Icon} name="alert" size=${15} /><span>${error}</span></p>`}
      <button type="submit" hidden />
    </form>
  </${Modal}>`;
}

/**
 * Locking a file that is plain now. `kind` 'disk' (a file on this computer: the locked one is
 * written beside it and the plain one goes to `binName`, or for good with `forGood`) or 'note'.
 */
export function LockFileDialog({ name, kind, binName, forGood = false, onLock, onClose }) {
  const [pw, setPw] = useState({ password: '', ok: false });
  const [relock, setRelock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = async (e) => {
    e?.preventDefault();
    if (!pw.ok || busy) return;
    setBusy(true);
    setError('');
    try {
      await onLock({ password: pw.password, relock });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };
  return html`<${Modal} title=${`Lock ${name} with a password`} onClose=${onClose} className="locked-dialog"
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!pw.ok || busy} onClick=${lock}><${Icon} name="lock" size=${15} />${busy ? 'Locking…' : 'Lock it'}</button>`}>
    <form class="locked-form" onSubmit=${lock}>
      ${kind === 'disk'
        ? html`<p>The file is written again encrypted, as <code>${name}.locked</code>, and opens only with this password.
            ${forGood ? html` The plain <code>${name}</code> is <strong>deleted for good</strong>.` : html` The plain <code>${name}</code> goes to the ${binName}: empty it to remove the plain text for good.`}</p>`
        : html`<p>From now on this device keeps the note encrypted${isLocal() ? '' : ', and syncs it encrypted'}. Its name, project and tags stay as they are, readable. Earlier versions in the history stay as they were (plain).</p>`}
      <${NewPassword} onChange=${setPw} autoFocus />
      <${RelockCheck} checked=${relock} onChange=${setRelock} />
      <p class="notice warn"><${Icon} name="alert" size=${15} /><span>${FORGOTTEN}</span></p>
      ${error && html`<p class="notice error" role="alert"><${Icon} name="alert" size=${15} /><span>${error}</span></p>`}
      <button type="submit" hidden />
    </form>
  </${Modal}>`;
}

/** A new password for an open locked file: the current one first. */
export function ChangePasswordDialog({ name, onChange, onClose }) {
  const [current, setCurrent] = useState('');
  const [shown, setShown] = useState(false);
  const [pw, setPw] = useState({ password: '', ok: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async (e) => {
    e?.preventDefault();
    if (!current || !pw.ok || busy) return;
    setBusy(true);
    setError('');
    try {
      await onChange({ current, password: pw.password });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };
  return html`<${Modal} title=${`Change the password of ${name}`} onClose=${onClose} className="locked-dialog"
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!current || !pw.ok || busy} onClick=${change}><${Icon} name="lock" size=${15} />${busy ? 'Changing…' : 'Change it'}</button>`}>
    <form class="locked-form" onSubmit=${change}>
      <label class="field"><span>The password now</span><${PasswordInput} value=${current} onInput=${(v) => (setCurrent(v), setError(''))} label="The password now" autoFocus shown=${shown} onShown=${setShown} /></label>
      <${NewPassword} onChange=${setPw} label="New password" />
      <p class="muted small">Copies made before (synced versions, backups) still open with the old password.</p>
      ${error && html`<p class="notice error" role="alert"><${Icon} name="alert" size=${15} /><span>${error}</span></p>`}
      <button type="submit" hidden />
    </form>
  </${Modal}>`;
}

/** Taking the lock off: the password, then the text is stored plain again (`what` says where). */
export function RemoveLockDialog({ name, what, onRemove, onClose }) {
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async (e) => {
    e?.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError('');
    try {
      await onRemove({ password });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };
  return html`<${Modal} title=${`Remove the lock of ${name}?`} onClose=${onClose} className="locked-dialog"
    footer=${html`<button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn danger" disabled=${!password || busy} onClick=${remove}><${Icon} name="unlock" size=${15} />${busy ? 'Working…' : 'Remove the lock'}</button>`}>
    <form class="locked-form" onSubmit=${remove}>
      <p>${what}</p>
      <label class="field"><span>Its password</span><${PasswordInput} value=${password} onInput=${(v) => (setPassword(v), setError(''))} label="Its password" autoFocus shown=${shown} onShown=${setShown} /></label>
      ${error && html`<p class="notice error" role="alert"><${Icon} name="alert" size=${15} /><span>${error}</span></p>`}
      <button type="submit" hidden />
    </form>
  </${Modal}>`;
}
