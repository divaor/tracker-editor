import { html, useEffect, useState } from '../../vendor/preact-htm.js';
import { clampFont, DEFAULT_FONT } from '../textSize.js';
import { DEFAULT_LLM_URL } from '../llm.js';
import { API_PROVIDERS, connectionOf, createModelClient, keySecret, providerOf } from '../providers.js';
import { RUN_COMMANDS } from '../runFile.js';
import { setVoiceEngine, startReading, stopReading, voiceEngines } from '../reader.js';
import { isNaturalVoice, languageName } from '../speech.js';
import { useVoices } from './readAloud.js';
import { VoicePicker } from './voicePicker.js';
import { TTS_KEY_SECRET, getSecret, getSettings, getToken, isLocal, isSyncConfigured, originOf, parseSetupCode, saveSettings, setSecret, setToken } from '../settings.js';
import { createAsyncLlmClient, parseProfile, PLACEHOLDERS, PROFILE_EXAMPLE } from '../asyncLlm.js';
import { localFetch } from '../localFetch.js';
import { store } from '../store.js';
import { switchStorage, syncClient, syncNow } from '../syncManager.js';
import { localDataInfo } from '../localData.js';
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
import { COLOR_MODES } from './tabViews.js';
import { looksLikeVisionModel } from '../ocr.js';
import { isAndroidApp, isDesktopApp } from '../platform.js';

const SYNC_FIELDS = ['owner', 'repo', 'branch', 'trackerPath', 'device'];
const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k] ?? '']));

function SyncCard({ sync, actions }) {
  const local = isLocal();
  const [form, setForm] = useState(() => pick(getSettings(), SYNC_FIELDS));
  const [token, setTokenValue] = useState('');
  const [hasToken, setHasToken] = useState(null);
  const [check, setCheck] = useState(null);
  const [setupCode, setSetupCode] = useState('');
  // Local mode: the GitHub form opens on request; where the data is kept.
  const [githubOpen, setGithubOpen] = useState(!local || Boolean(getSettings().owner));
  const [where, setWhere] = useState(null);
  const [moving, setMoving] = useState('');
  if (hasToken === null) getToken().then((t) => setHasToken(Boolean(t)));
  useEffect(() => {
    localDataInfo().then(setWhere, () => setWhere({ browser: true }));
  }, []);
  const set = (key) => (e) => setForm({ ...form, [key]: e.currentTarget.value });
  const cleaned = () => ({ ...form, owner: form.owner.trim(), repo: form.repo.trim(), branch: form.branch.trim(), trackerPath: form.trackerPath.trim() || 'tracker.json' });

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
    const patch = cleaned();
    if (token.trim()) {
      await setToken(token);
      setTokenValue('');
      setHasToken(true);
    }
    if (isLocal()) {
      // From this computer to GitHub: everything here is copied there first, nothing is lost.
      if (!isSyncConfigured(patch) || !(await getToken())) return actions.toast('Fill in the owner, the repository and a token first', { kind: 'error' });
      setMoving('Copying your data to GitHub…');
      try {
        const moved = await switchStorage('github', patch);
        actions.toast(`Your data is on GitHub now (${patch.owner}/${patch.repo}${moved.copied ? `, ${moved.copied} files copied` : ''}). Connect the tracker too, with the same token.`, { timeout: 10000 });
      } catch (err) {
        actions.toast(`Your data stays on this computer: ${err.message}`, { kind: 'error', timeout: 10000 });
      } finally {
        setMoving('');
      }
      return;
    }
    saveSettings(patch);
    actions.toast('Sync settings saved');
    syncNow();
  };

  // Back to this computer: GitHub's copy comes here first; the repo keeps everything.
  const keepHere = async () => {
    if (!confirm('Stop syncing with GitHub? Everything is kept on this computer (what is only on GitHub is copied here first), and the repository keeps its copy.')) return;
    setMoving('Copying your data to this computer…');
    try {
      await switchStorage('local');
      setGithubOpen(false);
      actions.toast('Your data is kept on this computer now. The tracker here uses it too once it stops syncing with GitHub.', { timeout: 10000 });
    } catch (err) {
      actions.toast(`Still syncing with GitHub: ${err.message}`, { kind: 'error', timeout: 10000 });
    } finally {
      setMoving('');
    }
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

  const githubForm = html`
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
      ${!local && html`<div class="field"><span> </span><${Check} checked=${getSettings().autoSync} label="Sync automatically" hint="A few seconds after you stop typing, every few minutes and when you come back" onChange=${(v) => saveSettings({ autoSync: v })} /></div>`}
      <div class="form-actions span-2">
        <button type="submit" class="btn primary" disabled=${Boolean(moving)}>${local ? 'Copy my data to GitHub and sync' : 'Save'}</button>
        <button type="button" class="btn" onClick=${test}>Test connection</button>
        ${!local && html`<button type="button" class="btn ghost" disabled=${!isSyncConfigured()} onClick=${() => syncNow()}><${Icon} name="sync" size=${15} />Sync now</button>`}
      </div>
      ${check && html`<p class="notice span-2 ${check.state === 'error' ? 'error' : ''}"><${Icon} name=${check.state === 'error' ? 'alert' : check.state === 'ok' ? 'check' : 'sync'} size=${15} />${check.text}</p>`}
    </form>`;

  if (local) {
    return html`<${Card} title="Where your data is" icon="disk" id="sync">
      <p class="muted">
        ${where?.dir
          ? html`Kept on this computer, in <code>${where.dir}</code>. Tracker on this computer uses the same folder: your projects, tags and tracker documents show in both, and Send to tracker reaches it.`
          : 'Kept in this browser, on this device. The tracker opened in this browser (or installed from it) shares it.'}
      </p>
      ${where?.dir && html`<div class="form-actions"><button type="button" class="btn sm" onClick=${() => window.desktop.data.show()}><${Icon} name="folderOpen" size=${15} />Show the folder</button></div>`}
      ${moving && html`<p class="notice"><${Icon} name="sync" size=${15} />${moving}</p>`}
      ${githubOpen
        ? html`<h3 class="card-subtitle">Sync across your devices with GitHub</h3>
            <p class="muted small">Everything here is copied to your private data repository first, so nothing is lost; then this app syncs with it (and so can your other devices and the tracker). Use the same repository and token as the tracker.</p>
            ${githubForm}`
        : html`<div class="field-grid">
              <${Field} label="This device's name" hint="Shown on files and items changed here"><input value=${form.device} onInput=${set('device')} onChange=${() => saveSettings({ device: form.device })} placeholder="Work PC" /></${Field}>
            </div>
            <button type="button" class="btn link" onClick=${() => setGithubOpen(true)}>Sync across your devices with GitHub…</button>`}
    </${Card}>`;
  }

  return html`<${Card} title="Sync with GitHub" icon="cloud" id="sync">
    <p class="muted">Use the same private data repository and token as the tracker. Files go to <code>editor/</code> in that repository; projects come from the tracker.</p>
    <div class="sync-status muted small">
      ${isSyncConfigured() ? html`${getSettings().owner}/${getSettings().repo} · last sync ${timeAgo(sync.lastSyncAt)}${sync.error ? html` · <span class="field-error">${sync.error}</span>` : ''}` : 'Not set up yet.'}
    </div>
    ${moving && html`<p class="notice"><${Icon} name="sync" size=${15} />${moving}</p>`}
    ${githubForm}
    <button type="button" class="btn link" disabled=${Boolean(moving)} onClick=${keepHere}>Stop syncing with GitHub and keep everything on this computer…</button>
  </${Card}>`;
}

function EditorCard({ settings }) {
  return html`<${Card} title="Editor" icon="code">
    <div class="field-grid">
      <div class="field span-2"><span>Theme</span>
        <${Segmented} options=${[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} value=${settings.theme} onChange=${(theme) => saveSettings({ theme })} label="Theme" />
      </div>
      <${Field} label="Text size" hint="On this device. Also Ctrl+= / Ctrl+- (Ctrl+0 the usual size), Ctrl+wheel, a pinch on a phone, or Aa in the status bar">
        <select value=${String(clampFont(settings.fontSize))} onChange=${(e) => saveSettings({ fontSize: Number(e.currentTarget.value) })}>
          ${[...new Set([10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, clampFont(settings.fontSize)])].sort((a, b) => a - b).map((n) => html`<option key=${n} value=${n}>${n} px${n === DEFAULT_FONT ? ' (usual)' : ''}</option>`)}
        </select>
      </${Field}>
      <${Field} label="Indentation" hint="For files whose text or .editorconfig does not say">
        <select value=${String(settings.tabSize)} onChange=${(e) => saveSettings({ tabSize: Number(e.currentTarget.value) })}>
          ${[2, 4, 8].map((n) => html`<option key=${n} value=${n}>${n} spaces</option>`)}
        </select>
      </${Field}>
      <${Check} checked=${settings.detectIndent !== false} label="Each file's indentation from its text or its .editorconfig" hint="Tabs or spaces, and how many: the status bar shows it and changes it"
        onChange=${(v) => saveSettings({ detectIndent: v })} />
      <${Check} checked=${settings.problems !== false} label="Show problems as you type" hint="JSON, YAML, XML, HTML, CSS and code: Ctrl+Shift+M lists them, F8 goes to the next"
        onChange=${(v) => saveSettings({ problems: v })} />
      <${Check} checked=${settings.emmet !== false} label="Emmet: Tab expands abbreviations in HTML, XML and JSX" hint="ul>li*3, div.card, a[href], ! for a page"
        onChange=${(v) => saveSettings({ emmet: v })} />
      <${Check} checked=${settings.linkedTags !== false} label="Renaming a tag renames its other end" onChange=${(v) => saveSettings({ linkedTags: v })} />
      <${Check} checked=${Boolean(settings.inlineSuggest)} label="Suggest the rest as you type (the model)"
        hint=${settings.llm.enabled && settings.llm.provider !== 'async' ? 'Grey text after the cursor: Tab takes it, Ctrl+→ one word, Esc drops it. A code model (Settings → Model → Model for suggestions) works best.' : 'Needs a model on this computer or a server that answers at once: set it up under Model.'}
        onChange=${(v) => saveSettings({ inlineSuggest: v })} />
      <${Check} checked=${settings.indentGuides !== false} label="Indentation guides" onChange=${(v) => saveSettings({ indentGuides: v })} />
      <${Check} checked=${settings.bracketColors !== false} label="Color bracket pairs by depth" onChange=${(v) => saveSettings({ bracketColors: v })} />
      <${Check} checked=${settings.stickyScroll !== false} label="Sticky scroll" hint="The lines that start the function or section you are in stay at the top"
        onChange=${(v) => saveSettings({ stickyScroll: v })} />
      <${Check} checked=${settings.fileIcons !== false} label="File type icons" hint="In My files and Folders, an icon in the color of each kind of file (JSON, Python, pictures…)"
        onChange=${(v) => saveSettings({ fileIcons: v })} />
      <${Check} checked=${settings.wordWrap} label="Word wrap" hint="Alt+Z" onChange=${(v) => saveSettings({ wordWrap: v })} />
      <${Check} checked=${settings.lineNumbers} label="Line numbers and folding" hint="A tap or click on a line number selects the line and offers Copy, Cut, Paste and Select all"
        onChange=${(v) => saveSettings({ lineNumbers: v })} />
      <${Check} checked=${settings.editBar !== false} label="Edit bar while typing on a touch screen" hint="In the status bar's place: Tab, Ctrl, Select, arrows, Undo; { } for symbols, ⋯ for copy, paste, lines, find, save"
        onChange=${(v) => saveSettings({ editBar: v })} />
      <${Check} checked=${settings.showWhitespace} label="Show spaces and trailing whitespace" onChange=${(v) => saveSettings({ showWhitespace: v })} />
      <${Check} checked=${settings.groupTabs} label="Group headers in the tab bar" hint="Each project's or folder's tabs together, with a header that folds them"
        onChange=${(v) => saveSettings({ groupTabs: v })} />
      <${Check} checked=${settings.pinnedEverywhere !== false} label="Pinned tabs in every view" hint="When the tab bar shows one project or folder (Alt+V)"
        onChange=${(v) => saveSettings({ pinnedEverywhere: v })} />
      <${Field} label="Color tabs by project or folder" hint="A line in the group's color under each tab">
        <select value=${settings.tabColors ?? 'auto'} onChange=${(e) => saveSettings({ tabColors: e.currentTarget.value })}>
          ${COLOR_MODES.map(([value, label]) => html`<option key=${value} value=${value}>${label}</option>`)}
        </select>
      </${Field}>
      <${Check} checked=${settings.whereFrame} label="Frame the editor in the color of where the file lives" hint="Tabs, the file bar and the status bar always show it"
        onChange=${(v) => saveSettings({ whereFrame: v })} />
      <div class="where-legend span-2" aria-label="Where files live">
        ${Object.entries(KINDS).map(([kind, k]) => html`<span key=${kind} class="where-chip kind-${kind} tone-ok" title=${k.hint}><${Icon} name=${k.icon} size=${14} /><span class="where-label">${k.label}</span><span class="where-state">${{ synced: 'synced', doc: 'synced with the tracker', disk: 'not synced', remote: 'not synced' }[kind]}</span></span>`)}
      </div>
      <${Check} checked=${settings.autoName} label="Name new files from what is in them" hint="By the model when it is on, otherwise from a heading on the first line"
        onChange=${(v) => saveSettings({ autoName: v })} />
      <${Check} checked=${settings.autoFile} label="File new notes under a project, with tags" hint="By the model, from your projects and the tags you use. Undo is in the message."
        onChange=${(v) => saveSettings({ autoFile: v })} />
      ${isDesktopApp() &&
      html`<${Field} label="Run commands (F5)" wide hint=${`One "type: command" per line, to change or add to the built-in ones (${Object.keys(RUN_COMMANDS).filter((e) => RUN_COMMANDS[e]).slice(0, 8).join(', ')}…). {file} is the file, {dir} its folder, {name} its name; an empty command turns a type off.`}>
        <textarea class="run-commands" rows="3" spellcheck=${false} value=${settings.runCommands ?? ''} placeholder=${'py: uv run {file}\nts: bun {file}'} onInput=${(e) => saveSettings({ runCommands: e.currentTarget.value })} />
      </${Field}>`}
    </div>
  </${Card}>`;
}

// Desktop only: typing a selection or file into another window (Alt+T).
const BUILT_IN_SERVERS = 'TypeScript and JavaScript, Python, Go, Rust, C and C++, Java, C#, JSON, CSS, HTML, YAML and Bash';
const quoteArg = (a) => (/[\s"']/.test(a) || !a ? `"${a.replace(/"/g, '\\"')}"` : a);
const ipcMessage = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/**
 * Each language (setting `lspLanguages`): on or off, which server when there are two, and which
 * formatter goes first. Rows come from the main process's catalog (your own servers first).
 */
function LanguageRows({ settings, rows }) {
  const per = settings.lspLanguages ?? {};
  const set = (id, patch) => {
    const next = { ...per[id], ...patch };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    const all = { ...getSettings().lspLanguages };
    if (Object.keys(next).length) all[id] = next;
    else delete all[id];
    saveSettings({ lspLanguages: all });
  };
  const general = settings.formatter === 'builtin' ? 'Prettier and the editor’s own' : 'the language server';
  return html`<details class="lang-settings">
    <summary>Each language: on or off, its server, its formatter</summary>
    <div class="lang-rows" role="table" aria-label="Language servers by language">
      ${rows.map((r) => {
        const v = per[r.id] ?? {};
        return html`<div class=${`lang-row${v.off ? ' off' : ''}`} role="row" key=${r.id}>
          <label class="lang-name" role="cell" title=${r.exts.join(' ')}>
            <input type="checkbox" checked=${!v.off} onChange=${(e) => set(r.id, { off: !e.currentTarget.checked })} />
            <span><strong>${r.label}</strong> <span class="muted small">${r.exts.slice(0, 4).join(' ')}${r.exts.length > 4 ? ' …' : ''}</span></span>
          </label>
          <span class="lang-pick" role="cell">
            ${r.choices.length > 1 &&
            html`<select value=${v.server ?? ''} disabled=${v.off} aria-label=${`${r.label}: server`} onChange=${(e) => set(r.id, { server: e.currentTarget.value })}>
              <option value="">Usual server</option>
              ${r.choices.map((c) => html`<option key=${c.id} value=${c.id}>${c.label}</option>`)}
            </select>`}
            <select value=${v.formatter ?? ''} disabled=${v.off} aria-label=${`${r.label}: formatter`} title=${`Format document: as above is ${general}; Prettier first means Prettier and the editor’s own formatters, then the server`} onChange=${(e) => set(r.id, { formatter: e.currentTarget.value })}>
              <option value="">Format: as above</option>
              <option value="server">Format: server first</option>
              <option value="builtin">Format: Prettier first</option>
            </select>
          </span>
        </div>`;
      })}
    </div>
    <small class="muted">A language turned off gets no server (its files keep the editor’s own problems and F12). A server chosen is used when it is installed, else the other one. Changes apply to the open files at once.</small>
  </details>`;
}

/**
 * Language servers (desktop): on or off, which formatter goes first (also per language), and
 * servers of your own for other languages (the main process asks you to confirm the exact
 * program before keeping one).
 */
function LanguageServersCard({ settings, actions }) {
  const bridge = window.desktop.lsp;
  const [list, setList] = useState(null);
  const [rows, setRows] = useState([]); // one per language, for LanguageRows
  const [draft, setDraft] = useState(null); // the server being added or changed
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    bridge.customList().then(setList, () => setList([]));
  }, []);
  useEffect(() => {
    bridge.catalog?.().then(setRows, () => setRows([]));
  }, [list]);
  // The open tabs look for their server again.
  const changed = (next) => {
    setList(next);
    window.dispatchEvent(new CustomEvent('lsp:servers-changed'));
  };
  const set = (name) => (e) => setDraft({ ...draft, [name]: e.currentTarget.value });
  const save = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await bridge.customSave(draft);
      if (r.cancelled) return;
      changed(r.list);
      actions.toast(`${draft.label.trim()} is set up: it starts when you open one of its files from Folders.`, { timeout: 8000 });
      setDraft(null);
    } catch (err) {
      setError(ipcMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const edit = (c) => setDraft({ id: c.id, label: c.label, exts: c.exts.join(', '), command: c.command, args: c.args.map(quoteArg).join(' '), markers: c.markers.join(', ') });
  return html`<${Card} title="Language servers" icon="code" id="language-servers">
    <${Check} checked=${settings.languageServers !== false} label="Language servers for code"
      hint=${`Type errors, completion with types, hover, quick fixes (Ctrl+.) and F12 / Shift+F12 / F2 across the project, for files opened from Folders. Built in: ${BUILT_IN_SERVERS}, each once installed on this computer (the status bar offers Set up… when one is missing).`}
      onChange=${(v) => saveSettings({ languageServers: v })} />
    ${settings.languageServers !== false &&
    html`<${Check} checked=${settings.languageServersRemote !== false} label="Also for files on SSH servers"
        hint="The server runs on that server, over the same connection, when it is installed there (Set up… types the command into its terminal). Not on Windows servers or over FTP."
        onChange=${(v) => saveSettings({ languageServersRemote: v })} />
      <${Check} checked=${settings.languageServersNotes !== false} label="Also for my files and tracker documents"
        hint="Each one on its own (no project around it), with the servers on this computer. Encrypted files never go to one."
        onChange=${(v) => saveSettings({ languageServersNotes: v })} />`}
    <div class="field-grid">
      <div class="field span-2"><span>Format document (Shift+Alt+F) uses first</span>
        <${Segmented} small label="Formatter" value=${settings.formatter === 'builtin' ? 'builtin' : 'server'} onChange=${(formatter) => saveSettings({ formatter })}
          options=${[{ id: 'server', label: 'The language server' }, { id: 'builtin', label: 'Prettier and the editor’s own' }]} />
        <small>When that one cannot format a file, the other does.</small>
      </div>
    </div>
    ${settings.languageServers !== false && rows.length > 0 && html`<${LanguageRows} settings=${settings} rows=${rows} />`}
    <h3 class="settings-sub">Servers of your own</h3>
    <p class="muted small">For another language (Lua, Ruby, PHP, Kotlin…): the program and the files it is for. Before it is kept, the app shows you the exact program it found and asks.</p>
    ${list?.map(
      (c) => html`<div class="custom-server" key=${c.id}>
        <div class="custom-server-text">
          <strong>${c.label}</strong> <span class="muted small">${c.exts.join(', ')}</span>
          <code class="small" title=${[c.command, ...c.args].join(' ')}>${[c.command, ...c.args.map(quoteArg)].join(' ')}</code>
        </div>
        <span class="spacer" />
        <button type="button" class="btn ghost sm" onClick=${() => edit(c)}>Change</button>
        <button type="button" class="btn ghost sm danger" onClick=${async () => changed(await bridge.customRemove(c.id))}>Remove</button>
      </div>`,
    )}
    ${draft
      ? html`<form class="field-grid settings-form custom-server-form" onSubmit=${save}>
          <${Field} label="Name"><input value=${draft.label} onInput=${set('label')} placeholder="Lua" autocomplete="off" /></${Field}>
          <${Field} label="File extensions"><input value=${draft.exts} onInput=${set('exts')} placeholder=".lua, .luau" autocomplete="off" spellcheck=${false} /></${Field}>
          <${Field} label="Program" hint="Its name, found on this computer's PATH, or its full path"><input value=${draft.command} onInput=${set('command')} placeholder="lua-language-server" autocomplete="off" spellcheck=${false} /></${Field}>
          <${Field} label="Arguments" hint="As you would type them; most servers want --stdio"><input value=${draft.args} onInput=${set('args')} placeholder="--stdio" autocomplete="off" spellcheck=${false} /></${Field}>
          <${Field} label="Project files (optional)" wide hint="The nearest folder up with one of these is the project (.luarc.json, Gemfile…); without them, the folder you opened"><input value=${draft.markers} onInput=${set('markers')} placeholder=".luarc.json" autocomplete="off" spellcheck=${false} /></${Field}>
          ${error && html`<p class="small error-text span-2" role="alert">${error}</p>`}
          <div class="field-row span-2">
            <button type="submit" class="btn primary sm" disabled=${busy || !draft.label.trim() || !draft.exts.trim() || !draft.command.trim()}>${draft.id ? 'Save' : 'Add it'}</button>
            <button type="button" class="btn ghost sm" onClick=${() => (setDraft(null), setError(''))}>Cancel</button>
          </div>
        </form>`
      : html`<div class="field-row"><button type="button" class="btn sm" onClick=${() => setDraft({ label: '', exts: '', command: '', args: '--stdio', markers: '' })}><${Icon} name="plus" size=${14} />Add a server…</button></div>`}
  </${Card}>`;
}

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
      <${Check} checked=${t.autoIndent} label="The other editor indents new lines by itself" hint="After each new line, the indentation it adds is replaced by the text's own, so YAML, Python and code keep theirs" onChange=${(v) => set({ autoIndent: v })} />
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
function DesktopCard({ settings, actions }) {
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
    <h3 class="settings-sub">Folders</h3>
    <div class="field-grid">
      <${Field} label="Opening a picture or a document (PDF, e-book, Word…)" hint="Double-click or Enter. Space always shows it large, and right-click has the other way.">
        <select value=${settings.folderMediaOpens} onChange=${(e) => saveSettings({ folderMediaOpens: e.currentTarget.value })}>
          <option value="viewer">Shows it here (documents in a tab)</option>
          <option value="program">Opens it with its program</option>
        </select>
      </${Field}>
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

const CONNECTIONS = [
  { id: 'local', label: isAndroidApp() ? 'Your own server' : 'This computer' },
  { id: 'api', label: 'AI provider' },
  { id: 'async', label: 'Answers later' },
];

function ModelCard({ settings, actions }) {
  const [connection, setConnection] = useState(connectionOf(settings.llm));
  return html`<${Card} title="Model" icon="sparkle" id="model">
    <div class="field span-2 provider-choice"><span>Connection</span>
      <${Segmented} options=${CONNECTIONS} value=${connection} onChange=${setConnection} label="Connection" />
    </div>
    ${connection === 'async' ? html`<${AsyncModelForm} settings=${settings} actions=${actions} />`
    : connection === 'api' ? html`<${ApiModelForm} settings=${settings} actions=${actions} />`
    : html`<${OpenAiModelForm} settings=${settings} actions=${actions} />`}
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
  return html`<p class="muted">For a model service that answers later: a request gives back a task id, and the answer comes from a status address, or by webhook to this computer. You describe the service in a connection profile; the API key is stored ${isDesktopApp() ? 'in this computer’s keychain' : isAndroidApp() ? 'on this device, encrypted' : 'in this browser'}, not in the profile.</p>
    ${!window.desktop?.webhook && html`<p class="notice"><${Icon} name="alert" size=${15} />${window.desktop?.llm ? 'Webhooks are for the desktop app: here the app checks the status now and then.' : 'In a browser the service must allow requests from this page (CORS), and webhooks are not available. The desktop app needs neither.'}</p>`}
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

/** Whether a key is saved for a connection (the field then says so instead of showing it). */
function useSavedKey(service) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let current = true;
    getSecret(keySecret(service)).then((k) => current && setSaved(Boolean(k)), () => {});
    return () => {
      current = false;
    };
  }, [service]);
  return [saved, setSaved];
}

/** The model pickers: a list once the connection was tested, else free text with an example. */
function ModelFields({ form, set, models, examples, embeddings = true }) {
  const options = (current) => [...new Set([current, ...(models ?? [])].filter(Boolean))];
  const pick = (field, blank, example) =>
    models
      ? html`<select value=${form[field] ?? ''} onChange=${(e) => set({ [field]: e.currentTarget.value })}><option value="">${blank}</option>${options(form[field]).map((m) => html`<option key=${m} value=${m}>${m}</option>`)}</select>`
      : html`<input value=${form[field] ?? ''} onInput=${(e) => set({ [field]: e.currentTarget.value })} placeholder=${example} spellcheck=${false} />`;
  return html`
    <${Field} label="Chat model" hint=${`For answers, fixes and summaries, e.g. ${examples.chat}`}>${pick('chatModel', 'Choose…', examples.chat.split(',')[0])}</${Field}>
    ${embeddings && html`<${Field} label="Embedding model" hint=${`For finding by meaning, e.g. ${examples.embed}. Optional.`}>${pick('embedModel', 'None (keyword search)', examples.embed.split(',')[0])}</${Field}>`}
    <${Field} label="Model for images" hint=${`Reads text from images when you choose it in Text from an image, e.g. ${examples.vision}. Blank: the chat model.`}>${pick('visionModel', 'The chat model', examples.vision.split(',')[0])}</${Field}>
    <${Field} label="Model for suggestions" hint=${`For Suggest the rest as you type (Settings → Editor). ${examples.suggest} Blank: the chat model.`}>${pick('completeModel', 'The chat model', examples.suggestOne)}</${Field}>`;
}

const checkNotice = (check) =>
  check && html`<p class="notice span-2 ${check.state === 'error' ? 'error' : ''}"><${Icon} name=${check.state === 'error' ? 'alert' : check.state === 'ok' ? 'check' : 'sync'} size=${15} />${check.text}</p>`;

// A model server on this computer (Ollama, LM Studio…): the OpenAI API at localhost.
function OpenAiModelForm({ settings, actions }) {
  const { llm } = settings;
  const [form, setForm] = useState(() => ({ ...llm, ...(connectionOf(llm) === 'local' ? {} : { baseUrl: DEFAULT_LLM_URL, chatModel: '', embedModel: '', visionModel: '', completeModel: '' }) }));
  const [key, setKey] = useState('');
  const [savedKey, setSavedKey] = useSavedKey('local');
  const [models, setModels] = useState(null);
  const [check, setCheck] = useState(null);
  const set = (patch) => setForm({ ...form, ...patch });
  const target = { ...form, provider: 'openai', service: 'local' };
  const test = async () => {
    setCheck({ state: 'busy', text: 'Connecting…' });
    try {
      const list = await createModelClient(target, { getSecret, fetchImpl: localFetch, apiKey: key.trim() }).listModels();
      setModels(list);
      const guessEmbed = list.find((m) => /embed|bge|e5|minilm|nomic/i.test(m)) ?? '';
      const guessChat = list.find((m) => !/embed|bge|e5|minilm|nomic/i.test(m)) ?? '';
      setForm((f) => ({ ...f, chatModel: f.chatModel || guessChat, embedModel: f.embedModel || guessEmbed, visionModel: f.visionModel || (list.find(looksLikeVisionModel) ?? '') }));
      setCheck({ state: 'ok', text: list.length ? `Connected. ${list.length} model${list.length === 1 ? '' : 's'} available.` : 'Connected, but no models are downloaded yet (for Ollama: ollama pull llama3.2).' });
    } catch (err) {
      setCheck({ state: 'error', text: err.message });
    }
  };
  const save = async () => {
    if (key.trim()) {
      await setSecret(keySecret('local'), key.trim());
      setSavedKey(true);
      setKey('');
    }
    const { apiKey: _old, ...rest } = target;
    saveSettings({ llm: { ...rest, apiKey: '', webhook: llm.webhook, enabled: true } });
    actions.toast('Model saved. Open it with the ✦ button or Ctrl+Shift+A.');
  };
  return html`
    <p class="muted">Summarize files, ask questions about them and find things by meaning with a model ${isAndroidApp() ? 'you run on a computer of yours. Nothing goes to an outside service' : 'running on this computer. Nothing leaves your machine'}. Works with <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>, <a href="https://lmstudio.ai" target="_blank" rel="noopener">LM Studio</a> and other servers with an OpenAI-compatible API.</p>
    ${isAndroidApp() ? html`<p class="notice"><${Icon} name="alert" size=${15} /><span>On the phone: a server on a computer on the same network, by its address (<code>http://192.168.1.20:11434/v1</code>). Ollama must listen on the network for that (<code>OLLAMA_HOST=0.0.0.0</code>); LM Studio: <strong>Serve on Local Network</strong>.</span></p>` : !isDesktopApp() && html`<p class="notice"><${Icon} name="alert" size=${15} />In a browser this only reaches the model if the page runs on the same computer and the server allows it. The desktop app needs no extra setup.</p>`}
    <div class="field-grid">
      <div class="field span-2"><span>Server</span>
        <div class="input-row">
          <input value=${form.baseUrl} onInput=${(e) => set({ baseUrl: e.currentTarget.value })} placeholder=${DEFAULT_LLM_URL} spellcheck=${false} />
          ${PRESETS.map((p) => html`<button type="button" key=${p.id} class="btn sm ${form.baseUrl === p.url ? 'primary' : ''}" onClick=${() => set({ baseUrl: p.url })}>${p.label}</button>`)}
        </div>
      </div>
      <${ModelFields} form=${form} set=${set} models=${models}
        examples=${{ chat: 'llama3.2, qwen2.5, mistral', embed: 'nomic-embed-text', vision: 'llama3.2-vision, qwen2.5vl, gemma3', suggest: 'A code model that fills in the middle answers best, e.g. qwen2.5-coder:1.5b, starcoder2, codegemma.', suggestOne: 'qwen2.5-coder:1.5b' }} />
      <${Field} label="API key" hint="Only if your server needs one. Kept on this device (the keychain in the desktop app), never in the settings.">
        <input type="password" value=${key} onInput=${(e) => setKey(e.currentTarget.value)} autocomplete="off" placeholder=${savedKey ? 'Saved on this device (type to replace)' : ''} />
      </${Field}>
      <div class="form-actions span-2">
        <button type="button" class="btn primary" disabled=${!form.chatModel} onClick=${save}>Save and turn on</button>
        <button type="button" class="btn" onClick=${test}>Test and list models</button>
        ${llm.enabled && connectionOf(llm) === 'local' && html`<button type="button" class="btn ghost" onClick=${() => saveSettings({ llm: { enabled: false } })}>Turn off</button>`}
      </div>
      ${checkNotice(check)}
    </div>
    <details class="help"><summary>How do I set up Ollama?</summary>
      <ol>
        <li>Install Ollama from ollama.com and start it.</li>
        <li>In a terminal: <code>ollama pull llama3.2</code> (chat) and <code>ollama pull nomic-embed-text</code> (finding by meaning).</li>
        <li>Press <strong>Ollama</strong>, then <strong>Test and list models</strong>, pick the models and press <strong>Save and turn on</strong>.</li>
        ${!window.desktop?.llm &&
        html`<li>In the browser, Ollama must also allow this site: set the environment variable <code>OLLAMA_ORIGINS=${location.origin}</code> and restart it (LM Studio: turn on CORS in its server settings). The desktop app needs none of this.</li>`}
      </ol>
    </details>`;
}

// An AI provider reached with your own API key (providers.js): Claude through its SDK, the
// others through their OpenAI-compatible API. The key stays on this device.
function ApiModelForm({ settings, actions }) {
  const { llm } = settings;
  const mine = connectionOf(llm) === 'api';
  const [service, setService] = useState(mine ? (llm.provider === 'anthropic' ? 'anthropic' : llm.service) : 'anthropic');
  const provider = providerOf(service) ?? API_PROVIDERS[0];
  const fresh = (p) => ({ baseUrl: p.baseUrl ?? '', chatModel: p.model ?? '', embedModel: '', visionModel: '', completeModel: '' });
  const [form, setForm] = useState(() => (mine ? { ...llm } : fresh(provider)));
  const [key, setKey] = useState('');
  const [savedKey, setSavedKey] = useSavedKey(service);
  const [models, setModels] = useState(null);
  const [check, setCheck] = useState(null);
  const set = (patch) => setForm({ ...form, ...patch });
  const claude = provider.kind === 'anthropic';
  const choose = (id) => {
    const next = providerOf(id);
    setService(id);
    setForm(mine && (llm.provider === 'anthropic' ? 'anthropic' : llm.service) === id ? { ...llm } : fresh(next));
    setModels(null);
    setCheck(null);
    setKey('');
  };
  const target = { ...form, provider: claude ? 'anthropic' : 'openai', service, baseUrl: claude ? '' : provider.id === 'custom' ? form.baseUrl : provider.baseUrl };
  const test = async () => {
    setCheck({ state: 'busy', text: 'Connecting…' });
    try {
      const list = await createModelClient(target, { getSecret, fetchImpl: localFetch, apiKey: key.trim() }).listModels();
      setModels(list);
      setForm((f) => ({ ...f, chatModel: f.chatModel || list.find((m) => !/embed/i.test(m)) || '', embedModel: provider.embeddings === false ? '' : f.embedModel || (list.find((m) => /embed/i.test(m)) ?? '') }));
      setCheck({ state: 'ok', text: `Connected to ${provider.label}. ${list.length} model${list.length === 1 ? '' : 's'} available.` });
    } catch (err) {
      setCheck({ state: 'error', text: err.message });
    }
  };
  const save = async () => {
    if (key.trim()) {
      await setSecret(keySecret(service), key.trim());
      setSavedKey(true);
      setKey('');
    } else if (!savedKey) return setCheck({ state: 'error', text: `Paste your ${provider.label} API key first.` });
    const { apiKey: _old, ...rest } = target;
    saveSettings({ llm: { ...rest, apiKey: '', embedModel: provider.embeddings === false ? '' : rest.embedModel, webhook: llm.webhook, enabled: true } });
    actions.toast(`${provider.label} saved. Open it with the ✦ button or Ctrl+Shift+A.`);
  };
  const forget = async () => {
    await setSecret(keySecret(service), '');
    setSavedKey(false);
    if (mine && llm.enabled) saveSettings({ llm: { enabled: false } });
    actions.toast('The key is gone from this device.');
  };
  const examples = claude
    ? { chat: 'claude-opus-5-5, claude-sonnet-5-5', embed: '', vision: 'claude-opus-5-5', suggest: 'A faster model answers sooner and costs less, e.g. claude-haiku-5-5. Claude is asked like a chat (it does not fill in the middle).', suggestOne: 'claude-haiku-5-5' }
    : { chat: 'a model from the list (Test and list models)', embed: 'an embedding model from the list', vision: 'a model that reads images', suggest: 'A small, fast model answers sooner and costs less.', suggestOne: '' };
  return html`
    <p class="muted">Use a model at an AI provider with your own API key: Claude, OpenAI, Gemini, OpenRouter (many models with one key), Mistral, Groq or another service with an OpenAI-compatible API. What you ask about (the selection or the file) is sent to that provider, and it bills your account for what you use. The key is kept on this device: the keychain in the desktop app, this browser's storage on the web and on phones. It is never synced or put in the settings.</p>
    <div class="field-grid">
      <${Field} label="Provider">
        <select value=${service} onChange=${(e) => choose(e.currentTarget.value)}>${API_PROVIDERS.map((p) => html`<option key=${p.id} value=${p.id}>${p.label}</option>`)}</select>
      </${Field}>
      <${Field} label="API key" hint=${html`${provider.keyUrl ? html`<a href=${provider.keyUrl} target="_blank" rel="noopener">Get a key</a>. ` : ''}Stays on this device.`}>
        <input type="password" value=${key} onInput=${(e) => setKey(e.currentTarget.value)} autocomplete="off" placeholder=${savedKey ? 'Saved on this device (type to replace)' : 'Paste it here'} />
      </${Field}>
      ${provider.id === 'custom' && html`<${Field} label="Address" wide hint="The API's base address, ending before /chat/completions, e.g. https://api.example.com/v1"><input value=${form.baseUrl} onInput=${(e) => set({ baseUrl: e.currentTarget.value })} placeholder="https://…/v1" spellcheck=${false} /></${Field}>`}
      <${ModelFields} form=${form} set=${set} models=${models} examples=${examples} embeddings=${provider.embeddings !== false} />
      <div class="form-actions span-2">
        <button type="button" class="btn primary" disabled=${!form.chatModel || (provider.id === 'custom' && !form.baseUrl)} onClick=${save}>Save and turn on</button>
        <button type="button" class="btn" disabled=${!key.trim() && !savedKey} onClick=${test}>Test and list models</button>
        ${savedKey && html`<button type="button" class="btn ghost" onClick=${forget}>Forget the key</button>`}
        ${llm.enabled && mine && html`<button type="button" class="btn ghost" onClick=${() => saveSettings({ llm: { enabled: false } })}>Turn off</button>`}
      </div>
      ${checkNotice(check)}
    </div>
    ${claude &&
    html`<details class="help"><summary>Claude: an API key, not your Claude subscription</summary>
      <p>The Claude API is paid per use with a key from the <a href="https://platform.claude.com/" target="_blank" rel="noopener">Claude Console</a>. A Claude Pro or Max subscription cannot be connected here: Anthropic allows its sign-in only in its own apps. To use your subscription, the ✦ panel has <strong>Ask in the Claude app</strong>, which opens Claude with the question ready; with the Tracker connector in Claude, it can read your files and save fixes back.</p>
    </details>`}`;
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

// Where a speech server can be reached from here, when the address will not work as it is.
function serverReach(url) {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url.trim());
  if (isDesktopApp()) return null;
  if (isAndroidApp()) return local ? 'localhost is this phone. For Kokoro on your computer, use the computer’s address on your network instead, such as http://192.168.1.20:8880/v1 (both on the same Wi-Fi).' : null;
  if (/^http:/i.test(url.trim()) && !local) return 'A browser reaches a speech server only on this device (localhost) or at an https address. The desktop and Android apps also reach one elsewhere on your network.';
  return local ? 'A server at localhost is only reachable from the device it runs on. On a phone, use the Android app with your computer’s address, or a server with an https address, such as OpenAI.' : null;
}

function ReadAloudCard({ settings, actions }) {
  const { tts } = settings;
  const [server, setServer] = useState(tts.server);
  // The key is a secret: typed here, saved for this server's origin only.
  const [key, setKey] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  useEffect(() => {
    getSecret(TTS_KEY_SECRET).then((v) => setKeySaved(Boolean(v)), () => {});
  }, []);
  const keyHost = (() => {
    try {
      return tts.server.keyOrigin ? new URL(tts.server.keyOrigin).host : '';
    } catch {
      return '';
    }
  })();
  const keyHere = keySaved && tts.server.keyOrigin && tts.server.keyOrigin === originOf(server.baseUrl);
  const saveServer = async () => {
    const { apiKey: _old, ...rest } = server;
    let keyOrigin = tts.server.keyOrigin;
    try {
      if (key.trim()) {
        await setSecret(TTS_KEY_SECRET, key);
        keyOrigin = originOf(server.baseUrl);
        setKeySaved(true);
        setKey('');
      }
    } catch (err) {
      return actions.toast(`The key could not be saved: ${err.message}`, { kind: 'error' });
    }
    saveSettings({ tts: { server: { ...rest, apiKey: '', keyOrigin }, engine: 'server' } });
    actions.toast('Speech server saved');
  };
  const forgetKey = async () => {
    await setSecret(TTS_KEY_SECRET, '').catch(() => {});
    setKeySaved(false);
    saveSettings({ tts: { server: { keyOrigin: '' } } });
    actions.toast('The speech server’s key was removed from this device');
  };
  const reach = serverReach(server.baseUrl);
  const [sampleLang, setSampleLang] = useState(() => (Object.hasOwn(SAMPLE, navigator.language.slice(0, 2)) ? navigator.language.slice(0, 2) : 'en'));
  const list = useVoices();
  const natural = list.filter(isNaturalVoice).length;
  const engines = voiceEngines();
  const engineLabel = engines?.engines?.find((e) => e.name === engines.engine)?.label;
  const set = (patch) => setServer({ ...server, ...patch });
  // A sample in the chosen voice, or in `voice` (heard from the list) in its own language when there is a sample for it.
  const sample = (voice = null) => {
    const own = voice?.lang?.slice(0, 2).toLowerCase();
    const lang = voice && Object.hasOwn(SAMPLE, own) ? own : sampleLang;
    try {
      stopReading();
      startReading({ key: null, name: 'Voice sample', text: SAMPLE[lang], lang, voice: voice?.voiceURI ?? '' });
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
          <div class="field span-2"><span>Voice</span>
            <${VoicePicker} className="wide" voices=${list} value=${tts.voice} lang=${sampleLang} onChange=${(voice) => saveSettings({ tts: { voice } })}
              engines=${engines} onEngine=${setVoiceEngine} onSample=${sample} />
            <small class="hint">${list.length ? `${list.length} voices${engineLabel ? ` from ${engineLabel}` : ' on this device'}${natural ? `, ${natural} of them natural-sounding (★)` : ''}. The list shows ${languageName(sampleLang)} first; ▶ plays one.` : 'This device lists no voices.'}</small>
          </div>
        </div>
        <details class="help"><summary>How do I get more natural voices?</summary>
          <ul>
            <li><strong>Android:</strong> in Settings, search for <em>Text-to-speech output</em>, choose <em>Speech Services by Google</em>, open its settings, then <em>Install voice data</em>, pick your language and try its voices. In the app, another engine you install (VoxSherpa, with Kokoro and Piper voices that work offline) shows under <em>Engine</em> in the voice list: choose it there, or make it the phone's preferred engine.</li>
            <li><strong>iPhone and Mac:</strong> Settings → Accessibility → Spoken Content → Voices, and download an <em>Enhanced</em> or <em>Premium</em> voice.</li>
            <li><strong>Windows:</strong> in Microsoft Edge, the voices named <em>Online (Natural)</em> sound the most human; in Chrome, the <em>Google</em> voices. The desktop app only has the voices installed in Windows, so use a speech server there.</li>
          </ul>
        </details>`
      : html`<div class="field-grid">
          <div class="field span-2"><span>Server</span>
            <div class="input-row">
              <input value=${server.baseUrl} onInput=${(e) => set({ baseUrl: e.currentTarget.value })} placeholder="http://localhost:8880/v1" spellcheck=${false} />
              ${SPEECH_PRESETS.map((p) => html`<button type="button" key=${p.id} class="btn sm ${server.baseUrl === p.server.baseUrl ? 'primary' : ''}" onClick=${() => set({ ...p.server })}>${p.label}</button>`)}
            </div>
          </div>
          ${field('model', 'Model', 'kokoro, gpt-4o-mini-tts, tts-1-hd…')}
          ${field('voice', 'Voice', 'Kokoro: af_heart, af_bella, am_michael, bf_emma… OpenAI: coral, sage, nova, onyx…')}
          ${field('otherVoices', 'Voices for other languages', 'Used when a file is in that language, e.g. es=ef_dora, pt=pf_dora', { wide: true, placeholder: 'es=ef_dora, pt=pf_dora' })}
          ${field('instructions', 'Reading style', 'OpenAI gpt-4o-mini-tts only: how to read, in your words', { wide: true })}
          <${Field} label="API key"
            hint=${keyHere ? `Saved for ${keyHost}. Type a new one to replace it.` : keySaved && keyHost ? `The saved key is for ${keyHost}, so it is not sent to this server. Type one if this server needs it.` : 'Only if the server needs one (OpenAI). Kept in this device’s secure storage and sent only to this server.'}>
            <input type="password" value=${key} onInput=${(e) => setKey(e.currentTarget.value)} placeholder=${keyHere ? '••••••••' : ''} autocomplete="off" spellcheck=${false} />
          </${Field}>
          <div class="form-actions span-2">
            <button type="button" class="btn primary" onClick=${saveServer}>Save</button>
            ${keySaved && html`<button type="button" class="btn ghost" onClick=${forgetKey}>Remove the key</button>`}
          </div>
        </div>
        ${reach && html`<p class="notice"><${Icon} name="alert" size=${15} /><span>${reach}</span></p>`}
        <details class="help"><summary>How do I run Kokoro on my computer?</summary>
          <ol>
            <li>Install Docker Desktop, then run <code>docker run -d -p 8880:8880 --restart unless-stopped ghcr.io/remsky/kokoro-fastapi-cpu:latest</code> (with an NVIDIA graphics card, <code>kokoro-fastapi-gpu</code> is faster).</li>
            <li>Press <strong>Kokoro (this computer)</strong>, then <strong>Save</strong> and <strong>Hear a sample</strong>. It is free and nothing leaves your computer.</li>
            <li>Voices starting with <code>a</code> are American English, <code>b</code> British, <code>e</code> Spanish and <code>p</code> Portuguese; <code>f</code>/<code>m</code> is female or male.</li>
            <li>On your phone, in the Android app: the same server at the computer’s address on your network, such as <code>http://192.168.1.20:8880/v1</code> (the computer on, both on the same Wi-Fi; away from home, a VPN like Tailscale reaches it).</li>
          </ol>
        </details>`}
    <div class="form-actions">
      <button type="button" class="btn" onClick=${() => sample()}><${Icon} name="volume" size=${15} />Hear a sample</button>
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
    ${window.desktop?.lsp && html`<${LanguageServersCard} settings=${settings} actions=${actions} />`}
    <${ModelCard} settings=${settings} actions=${actions} />
    <${ReadAloudCard} settings=${settings} actions=${actions} />
    ${window.desktop?.typing && html`<${TypingCard} settings=${settings} />`}
    ${window.desktop?.prefs && html`<${DesktopCard} settings=${settings} actions=${actions} />`}
    ${dictationSupported() && html`<${DictationCard} settings=${settings} />`}
    <${EncryptionCard} actions=${actions} />
    <${DataCard} actions=${actions} />
    <p class="muted small about">Tracker Editor ${APP_VERSION} · ${isAndroidApp() ? 'Android app' : window.desktop ? `Desktop app (Electron ${window.desktop.versions?.electron ?? ''})` : 'Web app'} · <a href="https://github.com/divaor/tracker-editor" target="_blank" rel="noopener">Source</a></p>
    ${window.desktop?.android?.sendLog &&
    html`<p class="muted small about">Something not working? <button type="button" class="btn link" onClick=${() => window.desktop.android.sendLog().catch((err) => actions.toast(err.message, { kind: 'error' }))}>Send a log</button> (also in the app icon's long-press menu). It has file paths and server names, never passwords or the text of your files.</p>`}
  </div>`;
}
