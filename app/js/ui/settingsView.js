import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { DEFAULT_LLM_URL } from '../llm.js';
import { llmClient } from '../semantic.js';
import { startReading, stopReading } from '../reader.js';
import { isNaturalVoice, rankVoices } from '../speech.js';
import { useVoices } from './readAloud.js';
import { getSecret, getSettings, getToken, isSyncConfigured, parseSetupCode, saveSettings, setSecret, setToken } from '../settings.js';
import { createAsyncLlmClient, parseProfile, PLACEHOLDERS, PROFILE_EXAMPLE } from '../asyncLlm.js';
import { localFetch } from '../localFetch.js';
import { store } from '../store.js';
import { syncClient, syncNow } from '../syncManager.js';
import { parseData } from '../tracker-model.js';
import { timeAgo } from '../format.js';
import { APP_VERSION } from '../version.js';
import { Card, Check, Field, Segmented } from './components.js';
import { EncryptionCard } from './encryption.js';
import { TYPING_SPEEDS } from '../typing.js';
import { DICTATION_LANGUAGES } from '../dictation.js';
import { dictationSupported } from './dictation.js';
import { Icon } from './icons.js';
import { KINDS } from '../where.js';
import { looksLikeVisionModel } from '../ocr.js';

const SYNC_FIELDS = ['owner', 'repo', 'branch', 'trackerPath', 'device'];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? '']));

function SyncCard({ sync, actions }) {
  const [form, setForm] = useState(() => pick(getSettings(), SYNC_FIELDS));
  const [token, setTokenValue] = useState('');
  const [hasToken, setHasToken] = useState(null);
  const [check, setCheck] = useState(null);
  const [setupCode, setSetupCode] = useState('');
  if (hasToken === null) getToken().then((t) => setHasToken(Boolean(t)));
  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });

  const test = async () => {
    setCheck({ state: 'busy', text: 'Checking…' });
    try {
      const client = syncClient(form, token.trim() || (await getToken()));
      const repo = await client.getRepo();
      if (repo.permissions && !repo.permissions.push) throw new Error('The token can read this repository but not write to it.');
      const tracker = await client.getFile(form.trackerPath || 'tracker.json', form.branch || undefined);
      const doc = tracker ? parseData(tracker.text) : null;
      setCheck({
        state: 'ok',
        text: doc
          ? `Connected to ${repo.full_name}. Found the tracker's data: ${doc.items.length} items, ${doc.projects.filter((p) => !p.deleted).length} projects.`
          : `Connected to ${repo.full_name}. No ${form.trackerPath || 'tracker.json'} there yet; projects will appear once the tracker syncs.`,
      });
    } catch (err) {
      setCheck({ state: 'error', text: err.message });
    }
  };

  const save = async (e) => {
    e.preventDefault();
    saveSettings({ ...form, owner: form.owner.trim(), repo: form.repo.trim(), branch: form.branch.trim(), trackerPath: form.trackerPath.trim() || 'tracker.json' });
    if (token.trim()) {
      await setToken(token);
      setTokenValue('');
      setHasToken(true);
    }
    actions.toast('Sync settings saved');
    syncNow();
  };

  const applySetup = () => {
    try {
      const data = parseSetupCode(setupCode);
      setForm({ ...form, owner: data.owner, repo: data.repo, branch: data.branch, trackerPath: data.trackerPath });
      if (data.token) setTokenValue(data.token);
      setSetupCode('');
      actions.toast(data.token ? 'Setup code applied, token included. Press Save.' : 'Setup code applied. Add the token, then press Save.');
    } catch {
      actions.toast('That does not look like a setup code', { kind: 'error' });
    }
  };

  return html`<${Card} title="Sync with GitHub" icon="cloud" id="sync">
    <p class="muted">Use the same private data repository and token as the tracker. Files go to <code>editor/</code> in that repository; projects come from the tracker.</p>
    <div class="sync-status muted small">
      ${isSyncConfigured() ? html`${getSettings().owner}/${getSettings().repo} · last sync ${timeAgo(sync.lastSyncAt)}${sync.error ? html` · <span class="field-error">${sync.error}</span>` : ''}` : 'Not set up yet.'}
    </div>
    <div class="field-row setup-row">
      <input value=${setupCode} onInput=${(e) => setSetupCode(e.currentTarget.value)} placeholder="Paste the tracker's setup code (Tracker → Settings → Copy setup code)" aria-label="Setup code" autocomplete="off" />
      <button type="button" class="btn sm" disabled=${!setupCode.trim()} onClick=${applySetup}>Apply</button>
    </div>
    <form class="field-grid settings-form" onSubmit=${save}>
      <${Field} label="GitHub owner"><input value=${form.owner} onInput=${set('owner')} placeholder="your-username" autocomplete="off" autocapitalize="off" spellcheck=${false} /></${Field}>
      <${Field} label="Repository" hint="Your private data repo, e.g. tracker-data"><input value=${form.repo} onInput=${set('repo')} placeholder="tracker-data" autocomplete="off" autocapitalize="off" spellcheck=${false} /></${Field}>
      <${Field} label="Branch" hint="Blank = the repo's default branch"><input value=${form.branch} onInput=${set('branch')} placeholder="(default branch)" autocomplete="off" autocapitalize="off" spellcheck=${false} /></${Field}>
      <${Field} label="Tracker data file" hint="Where the tracker keeps projects and items"><input value=${form.trackerPath} onInput=${set('trackerPath')} placeholder="tracker.json" autocomplete="off" autocapitalize="off" spellcheck=${false} /></${Field}>
      <${Field} label="Personal access token" wide hint=${hasToken ? 'A token is saved on this device. Paste a new one to replace it.' : 'Fine-grained token with Contents: Read and write on the data repo (the tracker’s works).'}>
        <input type="password" value=${token} onInput=${(e) => setTokenValue(e.currentTarget.value)} placeholder=${hasToken ? '•••••••• (saved)' : 'github_pat_…'} autocomplete="off" />
      </${Field}>
      <${Field} label="This device's name" hint="Shown in commits and on files edited here"><input value=${form.device} onInput=${set('device')} placeholder="Work PC" /></${Field}>
      <div class="field"><span> </span><${Check} checked=${getSettings().autoSync} label="Sync automatically" hint="A few seconds after you stop typing, every few minutes and when you come back" onChange=${(v) => saveSettings({ autoSync: v })} /></div>
      <div class="form-actions span-2">
        <button type="submit" class="btn primary">Save</button>
        <button type="button" class="btn" onClick=${test}>Test connection</button>
        <button type="button" class="btn ghost" disabled=${!isSyncConfigured()} onClick=${() => syncNow()}><${Icon} name="sync" size=${15} />Sync now</button>
      </div>
      ${check && html`<p class="notice span-2 ${check.state === 'error' ? 'error' : ''}"><${Icon} name=${check.state === 'error' ? 'alert' : check.state === 'ok' ? 'check' : 'sync'} size=${15} />${check.text}</p>`}
    </form>
  </${Card}>`;
}

function EditorCard({ settings }) {
  return html`<${Card} title="Editor" icon="code">
    <div class="field-grid">
      <div class="field span-2"><span>Theme</span>
        <${Segmented} options=${[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} value=${settings.theme} onChange=${(theme) => saveSettings({ theme })} label="Theme" />
      </div>
      <${Field} label="Font size">
        <select value=${String(settings.fontSize)} onChange=${(e) => saveSettings({ fontSize: Number(e.currentTarget.value) })}>
          ${[12, 13, 14, 15, 16, 18, 20].map((n) => html`<option key=${n} value=${n}>${n} px</option>`)}
        </select>
      </${Field}>
      <${Field} label="Tab size">
        <select value=${String(settings.tabSize)} onChange=${(e) => saveSettings({ tabSize: Number(e.currentTarget.value) })}>
          ${[2, 4, 8].map((n) => html`<option key=${n} value=${n}>${n} spaces</option>`)}
        </select>
      </${Field}>
      <${Check} checked=${settings.wordWrap} label="Word wrap" hint="Alt+Z" onChange=${(v) => saveSettings({ wordWrap: v })} />
      <${Check} checked=${settings.lineNumbers} label="Line numbers and folding" onChange=${(v) => saveSettings({ lineNumbers: v })} />
      <${Check} checked=${settings.showWhitespace} label="Show spaces and trailing whitespace" onChange=${(v) => saveSettings({ showWhitespace: v })} />
      <${Check} checked=${settings.groupTabs} label="Group tabs by project" hint="Each project's tabs together, with a header that folds them"
        onChange=${(v) => saveSettings({ groupTabs: v })} />
      <${Check} checked=${settings.whereFrame} label="Frame the editor in the color of where the file lives" hint="Tabs, the file bar and the status bar always show it"
        onChange=${(v) => saveSettings({ whereFrame: v })} />
      <div class="where-legend span-2" aria-label="Where files live">
        ${Object.entries(KINDS).map(([kind, k]) => html`<span key=${kind} class="where-chip kind-${kind} tone-ok" title=${k.hint}><${Icon} name=${k.icon} size=${14} /><span class="where-label">${k.label}</span><span class="where-state">${{ synced: 'synced', doc: 'synced with the tracker', disk: 'not synced', remote: 'not synced' }[kind]}</span></span>`)}
      </div>
      <${Check} checked=${settings.autoName} label="Name new files from what is in them" hint="By the local model when it is on, otherwise from a heading on the first line"
        onChange=${(v) => saveSettings({ autoName: v })} />
      <${Check} checked=${settings.autoFile} label="File new notes under a project, with tags" hint="By the local model, from your projects and the tags you use. Undo is in the message."
        onChange=${(v) => saveSettings({ autoFile: v })} />
    </div>
  </${Card}>`;
}

// Desktop only: typing a selection or file into another window (Alt+T).
function TypingCard({ settings }) {
  const t = settings.typing;
  const set = (patch) => saveSettings({ typing: patch });
  return html`<${Card} title="Typing into other windows" icon="keyboard">
    <p class="muted small">For remote desktops and consoles that do not take pasted text: Alt+T (or Edit, Type into Another Window) types the selection, or the whole file, into the window you click into before the countdown ends. Holding Escape there, or clicking another window, stops it.</p>
    <div class="field-grid">
      <${Field} label="Time to switch windows">
        <select value=${String(t.countdown)} onChange=${(e) => set({ countdown: Number(e.currentTarget.value) })}>
          ${[3, 5, 10].map((n) => html`<option key=${n} value=${n}>${n} seconds</option>`)}
        </select>
      </${Field}>
      <${Field} label="Speed">
        <select value=${t.speed} onChange=${(e) => set({ speed: e.currentTarget.value })}>
          ${TYPING_SPEEDS.map((sp) => html`<option key=${sp.id} value=${sp.id}>${sp.label}</option>`)}
        </select>
      </${Field}>
      <${Check} checked=${t.autoIndent} label="The other editor indents new lines by itself" hint="Leaves out the spaces at the start of lines, so they are not doubled" onChange=${(v) => set({ autoIndent: v })} />
      <${Check} checked=${t.minimize} label="Minimize Tracker Editor while it types" hint="The window behind it, often the remote desktop, gets the focus" onChange=${(v) => set({ minimize: v })} />
      ${window.desktop?.platform === 'win32' && html`<${Check} checked=${t.unicode} label="Send characters instead of key presses" hint="If symbols come out wrong because this computer's keyboard layout differs from the remote one" onChange=${(v) => set({ unicode: v })} />`}
    </div>
  </${Card}>`;
}

// "CommandOrControl+Alt+N" → "Ctrl+Alt+N" (or ⌘ on a Mac).
const shortcutLabel = (accelerator) => accelerator.replace(/CommandOrControl|CmdOrCtrl/g, window.desktop?.platform === 'darwin' ? '⌘' : 'Ctrl');

/** Turns a key press into an Electron accelerator, e.g. Ctrl+Alt+N → "CommandOrControl+Alt+N" ('' while only modifiers are held). */
function acceleratorFrom(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return '';
  const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : /^F\d+$/.test(e.key) ? e.key : e.code === 'Space' ? 'Space' : '';
  if (!key) return '';
  const mods = [(e.ctrlKey || e.metaKey) && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  return mods.length ? [...mods, key].join('+') : '';
}

const CAPTURE_STATUS = {
  ok: '',
  taken: 'Another app already uses this shortcut. Pick another one.',
  invalid: 'That is not a shortcut this computer can use. Pick another one.',
};

/** A global shortcut, set by pressing it, with a button to try what it does. */
function ShortcutField({ value, problem, label, onChange, onTry }) {
  const [recording, setRecording] = useState(false);
  return html`<${Field} label="Shortcut">
    <span class="shortcut-field">
      <input readonly value=${recording ? 'Press the keys…' : shortcutLabel(value)} aria-label=${label} class=${problem ? 'invalid' : ''}
        onFocus=${() => setRecording(true)} onBlur=${() => setRecording(false)}
        onKeyDown=${(e) => {
          if (e.key === 'Tab') return;
          e.preventDefault();
          if (e.key === 'Escape') return e.currentTarget.blur();
          const accelerator = acceleratorFrom(e);
          if (!accelerator) return;
          e.currentTarget.blur();
          onChange(accelerator);
        }} />
      <button type="button" class="btn sm" onClick=${onTry}>Try it</button>
    </span>
  </${Field}>`;
}

/** Desktop: keep running in the tray, quick capture, text from a screenshot, clipboard history (the main process keeps these). */
function DesktopCard({ actions }) {
  const [prefs, setPrefs] = useState(null);
  useEffect(() => {
    window.desktop.prefs.get().then(setPrefs);
  }, []);
  if (!prefs) return null;
  const set = async (patch) => setPrefs(await window.desktop.prefs.set(patch));
  const problem = prefs.capture.enabled && CAPTURE_STATUS[prefs.capture.status];
  const snipProblem = prefs.snip.enabled && CAPTURE_STATUS[prefs.snip.status];
  return html`<${Card} title="Desktop" icon="settings">
    <div class="field-grid">
      <${Check} checked=${prefs.background} label="Keep running in the tray when the window is closed" hint="So quick capture and the clipboard history work with the window closed. Quit from the tray icon." onChange=${(v) => set({ background: v })} />
      ${prefs.background && !prefs.tray && html`<p class="notice small">This desktop has no system tray, so closing the window still quits.</p>`}
      ${prefs.shell &&
      html`<${Check} checked=${prefs.shell.enabled} label="Tracker Editor in Explorer"
        hint="In Open with for text and code files (without becoming their default program), Edit with Tracker Editor when you right-click a file (Windows 11: under Show more options), and Open in Tracker Editor on folders."
        onChange=${(v) => set({ shell: { enabled: v } })} />
      ${prefs.shell.error && html`<p class="notice small" role="alert">Windows did not take it: ${prefs.shell.error}</p>`}`}
    </div>
    <h3 class="settings-sub">Quick capture</h3>
    <p class="muted small">A shortcut that works in any app opens a small window to jot something down. Ctrl+Enter keeps it as a new note, or adds it to Inbox.md under the time.</p>
    <div class="field-grid">
      <${Check} checked=${prefs.capture.enabled} label="Quick capture" onChange=${(v) => set({ capture: { enabled: v } })} />
      <${ShortcutField} value=${prefs.capture.shortcut} problem=${problem} label="Quick capture shortcut" onChange=${(shortcut) => set({ capture: { shortcut } })} onTry=${() => window.desktop.capture.open()} />
      ${problem && html`<p class="notice small" role="alert">${problem}</p>`}
    </div>
    <h3 class="settings-sub">Text from a screenshot</h3>
    <p class="muted small">A shortcut that works in any app: drag around part of the screen and its text is read on this computer (English and Spanish), to insert, keep as a file or copy. Also in Edit, Text from a Screenshot.</p>
    <div class="field-grid">
      <${Check} checked=${prefs.snip.enabled} label="Screenshot shortcut" onChange=${(v) => set({ snip: { enabled: v } })} />
      <${ShortcutField} value=${prefs.snip.shortcut} problem=${snipProblem} label="Screenshot shortcut" onChange=${(shortcut) => set({ snip: { shortcut } })} onTry=${actions.screenshotToText} />
      ${snipProblem && html`<p class="notice small" role="alert">${snipProblem}</p>`}
    </div>
    <h3 class="settings-sub">Clipboard history</h3>
    <p class="muted small">Keeps the texts you copy in any app, to find and paste them again (Ctrl+Shift+V). They stay on this computer${prefs.clipboard.encrypted ? ', encrypted with its keychain' : ' (in memory only: there is no keychain to encrypt them)'}, and copies that password managers mark as secret are skipped. Turning it off forgets the history.</p>
    <div class="field-grid">
      <${Check} checked=${prefs.clipboard.enabled} label="Clipboard history" onChange=${(v) => set({ clipboard: { enabled: v } })} />
      <${Field} label="Keep">
        <select value=${String(prefs.clipboard.max)} disabled=${!prefs.clipboard.enabled} onChange=${(e) => set({ clipboard: { max: Number(e.currentTarget.value) } })}>
          ${[20, 50, 100, 200].map((n) => html`<option key=${n} value=${n}>The last ${n}</option>`)}
        </select>
      </${Field}>
      ${prefs.clipboard.enabled && html`<span><button type="button" class="btn sm" onClick=${actions.openClipboardHistory}>Open the history</button></span>`}
    </div>
  </${Card}>`;
}

function DictationCard({ settings }) {
  return html`<${Card} title="Voice notes" icon="mic">
    <p class="muted small">The microphone button at the top dictates into the open file, or a new note. Your browser's speech service turns speech into text (on Android, Google's). Say “new line” or “new paragraph” (“nueva línea”, “nuevo párrafo”, “punto y aparte” in Spanish) for line breaks.</p>
    <div class="field-grid">
      <${Field} label="Language">
        <select value=${settings.dictationLang} onChange=${(e) => saveSettings({ dictationLang: e.currentTarget.value })}>
          ${DICTATION_LANGUAGES.map((l) => html`<option key=${l.id} value=${l.id}>${l.label}</option>`)}
        </select>
      </${Field}>
    </div>
  </${Card}>`;
}

const PRESETS = [
  { id: 'ollama', label: 'Ollama', url: DEFAULT_LLM_URL },
  { id: 'lmstudio', label: 'LM Studio', url: 'http://localhost:1234/v1' },
];

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI-compatible server' },
  { id: 'async', label: 'Service that answers later' },
];

function ModelCard({ settings, actions }) {
  const [provider, setProvider] = useState(settings.llm.provider || 'openai');
  return html`<${Card} title="Model" icon="sparkle" id="model">
    <div class="field span-2 provider-choice"><span>Connection</span>
      <${Segmented} options=${PROVIDERS} value=${provider} onChange=${setProvider} label="Connection" />
    </div>
    ${provider === 'async' ? html`<${AsyncModelForm} settings=${settings} actions=${actions} />` : html`<${OpenAiModelForm} settings=${settings} actions=${actions} />`}
    <div class="field-grid">
      <${Check} checked=${settings.assistBubble} label="Model button at the bottom right of the editor" hint="Help with the selection, or the whole file: fix, convert, check the syntax, translate, ask. Ctrl+K opens it too." onChange=${(v) => saveSettings({ assistBubble: v })} />
    </div>
  </${Card}>`;
}

// A model service that takes a request, answers with a task id, and gives the
// answer later (asyncLlm.js). Everything about the service is in the profile.
function AsyncModelForm({ settings, actions }) {
  const { llm } = settings;
  const [profileText, setProfileText] = useState(llm.profile);
  const [model, setModel] = useState(llm.provider === 'async' ? llm.chatModel : '');
  const [apiKey, setApiKey] = useState('');
  const [hookSecret, setHookSecret] = useState('');
  const [hook, setHook] = useState(llm.webhook);
  const [check, setCheck] = useState(null);
  const [saved, setSaved] = useState({ key: false, secret: false });
  useEffect(() => {
    Promise.all([getSecret('llm-api-key'), getSecret('llm-webhook-secret')]).then(([k, sec]) => setSaved({ key: Boolean(k), secret: Boolean(sec) }));
  }, []);
  const parsed = profileText.trim() ? parseProfile(profileText) : { error: 'Paste the connection profile for your service, or start from the example.' };
  const setHookField = (patch) => setHook({ ...hook, ...patch });
  const storeSecrets = async () => {
    if (apiKey) await setSecret('llm-api-key', apiKey);
    if (hookSecret) await setSecret('llm-webhook-secret', hookSecret);
    setSaved({ key: saved.key || Boolean(apiKey), secret: saved.secret || Boolean(hookSecret) });
    setApiKey('');
    setHookSecret('');
  };
  const test = async () => {
    if (parsed.error) return setCheck({ state: 'error', text: parsed.error });
    setCheck({ state: 'busy', text: 'Sending a test question…' });
    try {
      const client = createAsyncLlmClient({ profile: parsed.profile, apiKey: apiKey || (await getSecret('llm-api-key')), fetchImpl: localFetch });
      const started = Date.now();
      const answer = await client.chat({
        model,
        purpose: 'test',
        messages: [{ role: 'user', content: 'Reply with one short sentence: say that the connection works.' }],
        onState: (state) => setCheck({ state: 'busy', text: `Task ${state || 'sent'}… (${Math.round((Date.now() - started) / 1000)} s)` }),
      });
      setCheck({ state: 'ok', text: `It answered in ${Math.round((Date.now() - started) / 1000)} s: ${answer.slice(0, 300)}` });
    } catch (err) {
      setCheck({ state: 'error', text: err.message });
    }
  };
  const save = async () => {
    if (parsed.error) return setCheck({ state: 'error', text: parsed.error });
    await storeSecrets();
    saveSettings({ llm: { enabled: true, provider: 'async', profile: profileText, chatModel: model || 'default', embedModel: '', webhook: hook } });
    actions.toast('Model service saved. Open it with the ✦ button or Ctrl+Shift+A.');
  };
  return html`<p class="muted">For a model service that answers later: a request gives back a task id, and the answer comes from a status address, or by webhook to this computer. You describe the service in a connection profile; the API key is stored ${window.desktop ? 'in this computer’s keychain' : 'in this browser'}, not in the profile.</p>
    ${!window.desktop && html`<p class="notice"><${Icon} name="alert" size=${15} />In a browser the service must allow requests from this page (CORS), and webhooks are not available. The desktop app needs neither.</p>`}
    <div class="field-grid">
      <label class="field span-2"><span>Connection profile (JSON)</span>
        <textarea class="profile-input" rows="14" spellcheck=${false} value=${profileText} onInput=${(e) => setProfileText(e.currentTarget.value)} placeholder="{ &quot;submit&quot;: { … }, &quot;status&quot;: { … } }" />
      </label>
      <div class="form-actions span-2">
        <button type="button" class="btn sm" onClick=${() => setProfileText(JSON.stringify(PROFILE_EXAMPLE, null, 2))}>Start from the example</button>
        <span class="muted small ${parsed.error ? 'error-text' : ''}">${parsed.error ?? 'The profile looks right.'}</span>
      </div>
      <${Field} label="Model or agent name" hint="Fills {{model}} in the profile"><input value=${model} onInput=${(e) => setModel(e.currentTarget.value)} spellcheck=${false} /></${Field}>
      <${Field} label="API key" hint=${saved.key ? 'Saved. Type a new one to replace it.' : 'Sent in the header the profile names'}><input type="password" value=${apiKey} onInput=${(e) => setApiKey(e.currentTarget.value)} placeholder=${saved.key ? '••••••••' : ''} autocomplete="off" /></${Field}>
      ${window.desktop?.webhook &&
      html`<${Check} checked=${hook.enabled} label="Receive answers by webhook" hint="The service calls this computer when a task ends; the app still checks the status now and then, since deliveries can be lost" onChange=${(v) => setHookField({ enabled: v })} />
        ${hook.enabled &&
        html`<${Field} label="Port"><input type="number" min="1024" max="65535" value=${hook.port} onInput=${(e) => setHookField({ port: Number(e.currentTarget.value) })} /></${Field}>
          <${Field} label="Path"><input value=${hook.path} onInput=${(e) => setHookField({ path: e.currentTarget.value })} spellcheck=${false} /></${Field}>
          <${Field} label="Address the service calls" wide hint="Fills {{webhook_url}}: this computer's name or IP as the service reaches it, e.g. http://my-pc.example.com:${hook.port}${hook.path}"><input value=${hook.publicUrl} onInput=${(e) => setHookField({ publicUrl: e.currentTarget.value.trim() })} spellcheck=${false} /></${Field}>
          <${Field} label="Webhook secret" wide hint=${saved.secret ? 'Saved. Events must be signed with it (HMAC-SHA256).' : 'Strongly advised: without it, anything on your network could send answers.'}><input type="password" value=${hookSecret} onInput=${(e) => setHookSecret(e.currentTarget.value)} placeholder=${saved.secret ? '••••••••' : ''} autocomplete="off" /></${Field}>`}`}
      <div class="form-actions span-2">
        <button type="button" class="btn primary" disabled=${Boolean(parsed.error)} onClick=${save}>Save and turn on</button>
        <button type="button" class="btn" disabled=${check?.state === 'busy'} onClick=${test}>Send a test question</button>
        ${llm.enabled && llm.provider === 'async' && html`<button type="button" class="btn ghost" onClick=${() => saveSettings({ llm: { enabled: false } })}>Turn off</button>`}
      </div>
      ${check && html`<p class="notice span-2 ${check.state === 'error' ? 'error' : ''}"><${Icon} name=${check.state === 'error' ? 'alert' : check.state === 'ok' ? 'check' : 'sync'} size=${15} />${check.text}</p>`}
    </div>
    <details class="help"><summary>How do I write the profile?</summary>
      <ul>
        <li><code>submit</code>: the address (<code>url</code>), <code>method</code> and JSON <code>body</code> that send a question, and <code>taskId</code>, where the task id is in the answer (e.g. <code>data.0.id</code>).</li>
        <li><code>status</code>: the address and body that ask how the task is going; <code>state</code>, <code>answer</code> and <code>error</code> say where those are in its answer, <code>done</code> and <code>failed</code> list the states that end it. With <code>rev</code> (where a revision is), the next call sends it as <code>{{rev}}</code> and the service can hold the call open until the task changes; otherwise the app asks every <code>interval</code> seconds.</li>
        <li>Optional: <code>status.sources</code> (a list of sources to add under the answer), <code>auth</code> (<code>header</code> and <code>prefix</code> for the API key), <code>headers</code>, <code>ok</code> (a field that must be true in every answer), <code>errorMessage</code>, <code>timeout</code> (seconds), and <code>webhook</code> (<code>taskId</code>, <code>state</code>, <code>answer</code>, <code>error</code> and <code>signatureHeader</code> for the events it posts).</li>
        <li>Placeholders: ${PLACEHOLDERS.map((p, i) => html`${i ? ', ' : ''}<code>{{${p}}}</code>`)}. A value that is only a placeholder keeps its type, and is left out when empty.</li>
      </ul>
    </details>`;
}

function OpenAiModelForm({ settings, actions }) {
  const { llm } = settings;
  const [form, setForm] = useState(llm);
  const [models, setModels] = useState(null);
  const [check, setCheck] = useState(null);
  const set = (patch) => setForm({ ...form, ...patch });
  const test = async () => {
    setCheck({ state: 'busy', text: 'Connecting…' });
    try {
      const list = await llmClient({ llm: { ...form, provider: 'openai' } }).listModels();
      setModels(list);
      const guessEmbed = list.find((m) => /embed|bge|e5|minilm|nomic/i.test(m)) ?? '';
      const guessChat = list.find((m) => !/embed|bge|e5|minilm|nomic/i.test(m)) ?? '';
      setForm((f) => ({ ...f, chatModel: f.chatModel || guessChat, embedModel: f.embedModel || guessEmbed, visionModel: f.visionModel || (list.find(looksLikeVisionModel) ?? '') }));
      setCheck({ state: 'ok', text: list.length ? `Connected. ${list.length} model${list.length === 1 ? '' : 's'} available.` : 'Connected, but no models are downloaded yet (for Ollama: ollama pull llama3.2).' });
    } catch (err) {
      setCheck({ state: 'error', text: err.message });
    }
  };
  const save = () => {
    saveSettings({ llm: { ...form, provider: 'openai', webhook: llm.webhook, enabled: true } });
    actions.toast('Local model saved. Open it with the ✦ button or Ctrl+Shift+A.');
  };
  const options = (current) => [...new Set([current, ...(models ?? [])].filter(Boolean))];
  return html`
    <p class="muted">Summarize files, ask questions about them and find things by meaning with a model running on this computer. Nothing leaves your machine. Works with <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>, <a href="https://lmstudio.ai" target="_blank" rel="noopener">LM Studio</a> and other servers with an OpenAI-compatible API.</p>
    ${!window.desktop && html`<p class="notice"><${Icon} name="alert" size=${15} />In a browser this only reaches the model if the page runs on the same computer and the server allows it. The desktop app needs no extra setup.</p>`}
    <div class="field-grid">
      <div class="field span-2"><span>Server</span>
        <div class="input-row">
          <input value=${form.baseUrl} onInput=${(e) => set({ baseUrl: e.currentTarget.value })} placeholder=${DEFAULT_LLM_URL} spellcheck=${false} />
          ${PRESETS.map((p) => html`<button type="button" key=${p.id} class="btn sm ${form.baseUrl === p.url ? 'primary' : ''}" onClick=${() => set({ baseUrl: p.url })}>${p.label}</button>`)}
        </div>
      </div>
      <${Field} label="Chat model" hint="For summaries and answers, e.g. llama3.2, qwen2.5, mistral">
        ${models ? html`<select value=${form.chatModel} onChange=${(e) => set({ chatModel: e.currentTarget.value })}><option value="">Choose…</option>${options(form.chatModel).map((m) => html`<option key=${m} value=${m}>${m}</option>`)}</select>`
        : html`<input value=${form.chatModel} onInput=${(e) => set({ chatModel: e.currentTarget.value })} placeholder="llama3.2" spellcheck=${false} />`}
      </${Field}>
      <${Field} label="Embedding model" hint="For finding by meaning, e.g. nomic-embed-text. Optional.">
        ${models ? html`<select value=${form.embedModel} onChange=${(e) => set({ embedModel: e.currentTarget.value })}><option value="">None (keyword search)</option>${options(form.embedModel).map((m) => html`<option key=${m} value=${m}>${m}</option>`)}</select>`
        : html`<input value=${form.embedModel} onInput=${(e) => set({ embedModel: e.currentTarget.value })} placeholder="nomic-embed-text" spellcheck=${false} />`}
      </${Field}>
      <${Field} label="Model for images" hint="Reads text from images when you choose it in Text from an image, e.g. llama3.2-vision, qwen2.5vl, gemma3. Blank: the chat model.">
        ${models ? html`<select value=${form.visionModel ?? ''} onChange=${(e) => set({ visionModel: e.currentTarget.value })}><option value="">The chat model</option>${options(form.visionModel).map((m) => html`<option key=${m} value=${m}>${m}</option>`)}</select>`
        : html`<input value=${form.visionModel ?? ''} onInput=${(e) => set({ visionModel: e.currentTarget.value })} placeholder="llama3.2-vision" spellcheck=${false} />`}
      </${Field}>
      <${Field} label="API key" hint="Only if your server needs one"><input type="password" value=${form.apiKey} onInput=${(e) => set({ apiKey: e.currentTarget.value })} autocomplete="off" /></${Field}>
      <div class="form-actions span-2">
        <button type="button" class="btn primary" disabled=${!form.chatModel} onClick=${save}>Save and turn on</button>
        <button type="button" class="btn" onClick=${test}>Test and list models</button>
        ${llm.enabled && llm.provider !== 'async' && html`<button type="button" class="btn ghost" onClick=${() => saveSettings({ llm: { enabled: false } })}>Turn off</button>`}
      </div>
      ${check && html`<p class="notice span-2 ${check.state === 'error' ? 'error' : ''}"><${Icon} name=${check.state === 'error' ? 'alert' : check.state === 'ok' ? 'check' : 'sync'} size=${15} />${check.text}</p>`}
    </div>
    <details class="help"><summary>How do I set up Ollama?</summary>
      <ol>
        <li>Install Ollama from ollama.com and start it.</li>
        <li>In a terminal: <code>ollama pull llama3.2</code> (chat) and <code>ollama pull nomic-embed-text</code> (finding by meaning).</li>
        <li>Press <strong>Ollama</strong>, then <strong>Test and list models</strong>, pick the models and press <strong>Save and turn on</strong>.</li>
        ${!window.desktop &&
        html`<li>In the browser, Ollama must also allow this site: set the environment variable <code>OLLAMA_ORIGINS=${location.origin}</code> and restart it (LM Studio: turn on CORS in its server settings). The desktop app needs none of this.</li>`}
      </ol>
    </details>`;
}

const SPEECH_PRESETS = [
  {
    id: 'kokoro',
    label: 'Kokoro (this computer)',
    server: { baseUrl: 'http://localhost:8880/v1', model: 'kokoro', voice: 'af_heart', otherVoices: 'es=ef_dora, pt=pf_dora', instructions: '' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    server: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      otherVoices: '',
      instructions: 'Read like a warm, engaging audiobook narrator: natural pacing, clear enunciation, and short pauses between ideas.',
    },
  },
];
const SAMPLE = {
  en: 'Hi! This is how I sound when I read your files. I take a short breath between sentences, and a longer one between paragraphs.',
  es: 'Hola. Así sueno cuando leo tus archivos. Hago una pausa corta entre frases, y una más larga entre párrafos.',
  pt: 'Olá! É assim que eu soo quando leio os seus arquivos. Faço uma pausa curta entre as frases e uma mais longa entre os parágrafos.',
};

function ReadAloudCard({ settings, actions }) {
  const { tts } = settings;
  const [server, setServer] = useState(tts.server);
  const [sampleLang, setSampleLang] = useState(() => (Object.hasOwn(SAMPLE, navigator.language.slice(0, 2)) ? navigator.language.slice(0, 2) : 'en'));
  const list = useVoices();
  const ranked = rankVoices(list, sampleLang);
  const natural = list.filter(isNaturalVoice).length;
  const set = (patch) => setServer({ ...server, ...patch });
  const sample = () => {
    try {
      stopReading();
      startReading({ key: null, name: 'Voice sample', text: SAMPLE[sampleLang], lang: sampleLang });
    } catch (err) {
      actions.toast(err.message, { kind: 'error' });
    }
  };
  const field = (key, label, hint, extra = {}) => html`<${Field} label=${label} hint=${hint} wide=${extra.wide}>
    <input type=${extra.type ?? 'text'} value=${server[key]} onInput=${(e) => set({ [key]: e.currentTarget.value })} placeholder=${extra.placeholder ?? ''} spellcheck=${false} autocomplete="off" />
  </${Field}>`;
  return html`<${Card} title="Read aloud" icon="volume" id="read-aloud">
    <p class="muted">Listen (or Alt+R) reads the file from the cursor, with a reader's pauses after sentences, paragraphs and headings. How human it sounds depends mostly on the voice.</p>
    <${Segmented} label="Voices" value=${tts.engine} onChange=${(engine) => saveSettings({ tts: { engine } })}
      options=${[{ id: 'device', label: 'This device' }, { id: 'server', label: 'Speech server' }]} />
    ${tts.engine === 'device'
      ? html`<div class="field-grid">
          <${Field} label="Voice" hint=${list.length ? `${list.length} voices on this device${natural ? `, ${natural} of them natural-sounding (★)` : ''}` : 'This device lists no voices.'} wide>
            <select value=${tts.voice} onChange=${(e) => saveSettings({ tts: { voice: e.currentTarget.value } })}>
              <option value="">Automatic: the most natural voice for the text's language</option>
              ${ranked.map((v) => html`<option key=${v.voiceURI} value=${v.voiceURI}>${isNaturalVoice(v) ? '★ ' : ''}${v.name} (${v.lang})</option>`)}
            </select>
          </${Field}>
        </div>
        <details class="help"><summary>How do I get more natural voices?</summary>
          <ul>
            <li><strong>Android:</strong> in Settings, search for <em>Text-to-speech output</em>, choose <em>Speech Services by Google</em>, open its settings, then <em>Install voice data</em>, pick your language and try its voices. The one you pick is used here.</li>
            <li><strong>iPhone and Mac:</strong> Settings → Accessibility → Spoken Content → Voices, and download an <em>Enhanced</em> or <em>Premium</em> voice.</li>
            <li><strong>Windows:</strong> in Microsoft Edge, the voices named <em>Online (Natural)</em> sound the most human; in Chrome, the <em>Google</em> voices. The desktop app only has the voices installed in Windows, so use a speech server there.</li>
          </ul>
        </details>`
      : html`<div class="field-grid">
          <div class="field span-2"><span>Server</span>
            <div class="input-row">
              <input value=${server.baseUrl} onInput=${(e) => set({ baseUrl: e.currentTarget.value })} placeholder="http://localhost:8880/v1" spellcheck=${false} />
              ${SPEECH_PRESETS.map((p) => html`<button type="button" key=${p.id} class="btn sm ${server.baseUrl === p.server.baseUrl ? 'primary' : ''}" onClick=${() => set({ ...p.server, apiKey: p.id === 'openai' ? server.apiKey : '' })}>${p.label}</button>`)}
            </div>
          </div>
          ${field('model', 'Model', 'kokoro, gpt-4o-mini-tts, tts-1-hd…')}
          ${field('voice', 'Voice', 'Kokoro: af_heart, af_bella, am_michael, bf_emma… OpenAI: coral, sage, nova, onyx…')}
          ${field('otherVoices', 'Voices for other languages', 'Used when a file is in that language, e.g. es=ef_dora, pt=pf_dora', { wide: true, placeholder: 'es=ef_dora, pt=pf_dora' })}
          ${field('instructions', 'Reading style', 'OpenAI gpt-4o-mini-tts only: how to read, in your words', { wide: true })}
          ${field('apiKey', 'API key', 'Only if the server needs one (OpenAI). Kept on this device.', { type: 'password' })}
          <div class="form-actions span-2">
            <button type="button" class="btn primary" onClick=${() => {
              saveSettings({ tts: { server, engine: 'server' } });
              actions.toast('Speech server saved');
            }}>Save</button>
          </div>
        </div>
        ${server.baseUrl.includes('localhost') && html`<p class="notice"><${Icon} name="alert" size=${15} />A server at localhost is only reachable from the computer it runs on. On your phone, use one with an https address, such as OpenAI.</p>`}
        <details class="help"><summary>How do I run Kokoro on my computer?</summary>
          <ol>
            <li>Install Docker Desktop, then run <code>docker run -d -p 8880:8880 --restart unless-stopped ghcr.io/remsky/kokoro-fastapi-cpu:latest</code> (with an NVIDIA graphics card, <code>kokoro-fastapi-gpu</code> is faster).</li>
            <li>Press <strong>Kokoro (this computer)</strong>, then <strong>Save</strong> and <strong>Hear a sample</strong>. It is free and nothing leaves your computer.</li>
            <li>Voices starting with <code>a</code> are American English, <code>b</code> British, <code>e</code> Spanish and <code>p</code> Portuguese; <code>f</code>/<code>m</code> is female or male.</li>
          </ol>
        </details>`}
    <div class="form-actions">
      <button type="button" class="btn" onClick=${sample}><${Icon} name="volume" size=${15} />Hear a sample</button>
      <select class="sample-lang" aria-label="Sample language" value=${sampleLang} onChange=${(e) => setSampleLang(e.currentTarget.value)}>
        <option value="en">English</option><option value="es">Español</option><option value="pt">Português</option>
      </select>
    </div>
  </${Card}>`;
}

function DataCard({ actions }) {
  const files = store.live();
  return html`<${Card} title="This device" icon="folder">
    <p class="muted">${files.length} files on this device · ${store.pendingCount()} changes not synced yet.</p>
    <div class="form-actions">
      <button type="button" class="btn ghost danger" onClick=${() => {
        if (store.pendingCount() && !confirm('Some changes are not synced yet and would be lost. Clear this device anyway?')) return;
        if (!confirm('Remove all files from this device? They stay in GitHub and come back on the next sync.')) return;
        store.clear();
        actions.toast('This device was cleared');
        syncNow();
      }}><${Icon} name="trash" size=${15} />Clear this device</button>
    </div>
    <dl class="props">
      <div><dt>Links to files</dt><dd><input value=${getSettings().appUrl} onChange=${(e) => saveSettings({ appUrl: e.currentTarget.value.trim() })} aria-label="Editor address" /></dd></div>
      <div><dt>Tracker</dt><dd><input value=${getSettings().trackerUrl} onChange=${(e) => saveSettings({ trackerUrl: e.currentTarget.value.trim() })} aria-label="Tracker address" /></dd></div>
    </dl>
  </${Card}>`;
}

export function SettingsView({ settings, sync, actions }) {
  return html`<div class="settings">
    <div class="settings-head">
      <button type="button" class="btn ghost sm" onClick=${actions.showEditor}><${Icon} name="arrowRight" size=${15} class="flip" />Back to files</button>
    </div>
    <${SyncCard} sync=${sync} actions=${actions} />
    <${EditorCard} settings=${settings} />
    <${ModelCard} settings=${settings} actions=${actions} />
    <${ReadAloudCard} settings=${settings} actions=${actions} />
    ${window.desktop?.typing && html`<${TypingCard} settings=${settings} />`}
    ${window.desktop?.prefs && html`<${DesktopCard} actions=${actions} />`}
    ${dictationSupported() && html`<${DictationCard} settings=${settings} />`}
    <${EncryptionCard} actions=${actions} />
    <${DataCard} actions=${actions} />
    <p class="muted small about">Tracker Editor ${APP_VERSION} · ${window.desktop ? `Desktop app (Electron ${window.desktop.versions?.electron ?? ''})` : 'Web app'} · <a href="https://github.com/divaor/tracker-editor" target="_blank" rel="noopener">Source</a></p>
  </div>`;
}
