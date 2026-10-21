import { html, useState } from '../../vendor/preact-htm.js';
import { DEFAULT_LLM_URL } from '../llm.js';
import { llmClient } from '../semantic.js';
import { getSettings, getToken, isSyncConfigured, parseSetupCode, saveSettings, setToken } from '../settings.js';
import { store } from '../store.js';
import { syncClient, syncNow } from '../syncManager.js';
import { parseData } from '../tracker-model.js';
import { timeAgo } from '../format.js';
import { APP_VERSION } from '../version.js';
import { Card, Check, Field, Segmented } from './components.js';
import { Icon } from './icons.js';

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
    </div>
  </${Card}>`;
}

const PRESETS = [
  { id: 'ollama', label: 'Ollama', url: DEFAULT_LLM_URL },
  { id: 'lmstudio', label: 'LM Studio', url: 'http://localhost:1234/v1' },
];

function ModelCard({ settings, actions }) {
  const { llm } = settings;
  const [form, setForm] = useState(llm);
  const [models, setModels] = useState(null);
  const [check, setCheck] = useState(null);
  const set = (patch) => setForm({ ...form, ...patch });
  const test = async () => {
    setCheck({ state: 'busy', text: 'Connecting…' });
    try {
      const list = await llmClient({ llm: form }).listModels();
      setModels(list);
      const guessEmbed = list.find((m) => /embed|bge|e5|minilm|nomic/i.test(m)) ?? '';
      const guessChat = list.find((m) => !/embed|bge|e5|minilm|nomic/i.test(m)) ?? '';
      setForm((f) => ({ ...f, chatModel: f.chatModel || guessChat, embedModel: f.embedModel || guessEmbed }));
      setCheck({ state: 'ok', text: list.length ? `Connected. ${list.length} model${list.length === 1 ? '' : 's'} available.` : 'Connected, but no models are downloaded yet (for Ollama: ollama pull llama3.2).' });
    } catch (err) {
      setCheck({ state: 'error', text: err.message });
    }
  };
  const save = () => {
    saveSettings({ llm: { ...form, enabled: true } });
    actions.toast('Local model saved. Open it with the ✦ button or Ctrl+Shift+A.');
  };
  const options = (current) => [...new Set([current, ...(models ?? [])].filter(Boolean))];
  return html`<${Card} title="Local model" icon="sparkle" id="model">
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
      <${Field} label="API key" hint="Only if your server needs one"><input type="password" value=${form.apiKey} onInput=${(e) => set({ apiKey: e.currentTarget.value })} autocomplete="off" /></${Field}>
      <div class="form-actions span-2">
        <button type="button" class="btn primary" disabled=${!form.chatModel} onClick=${save}>Save and turn on</button>
        <button type="button" class="btn" onClick=${test}>Test and list models</button>
        ${llm.enabled && html`<button type="button" class="btn ghost" onClick=${() => saveSettings({ llm: { enabled: false } })}>Turn off</button>`}
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
    </details>
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
    <${DataCard} actions=${actions} />
    <p class="muted small about">Tracker Editor ${APP_VERSION} · ${window.desktop ? `Desktop app (Electron ${window.desktop.versions?.electron ?? ''})` : 'Web app'} · <a href="https://github.com/divaor/tracker-editor" target="_blank" rel="noopener">Source</a></p>
  </div>`;
}
