// Archives in Folders: what one holds (the preview and the viewer), Extract…, Compress… and the
// password asked for one. The work is the main process's (electron/archives.cjs, 7-Zip); the
// choices are app/js/archives.js's fixed lists. A password typed here lives only in the dialog's
// state and the one call it goes with: it is never kept or logged.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { COMPRESS_FORMATS, EXCLUDE_GROUPS, LEVELS, SPLIT_SIZES, compressRequest, defaultExcludes, defaultStem, filterEntries, formatOf, laterVolume, listingSummary, splitBytes, stemOf, stemProblem } from '../archives.js';
import { formatBytes } from '../format.js';
import { ClearButton, Modal, Segmented } from './components.js';
import { Icon } from './icons.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

// Files found to be archives by what they hold (a zip under another name): the menus offer to extract them too.
const knownArchives = new Set();
export const markArchive = (path) => knownArchives.add(path);
export const isKnownArchive = (path) => knownArchives.has(path);

const ASCII = /^[\x20-\x7e]*$/;

/** A password field with an eye that shows or hides it. */
export function PasswordField({ value, onInput, label = 'Password', shown, onShown, autoFocus = false, placeholder = '', id }) {
  const input = useRef(null);
  useEffect(() => {
    if (autoFocus) setTimeout(() => input.current?.focus(), 0);
  }, []);
  return html`<div class="row-input password-field">
    <input ref=${input} id=${id} type=${shown ? 'text' : 'password'} value=${value} aria-label=${label} placeholder=${placeholder} autocomplete="off" spellcheck="false"
      onInput=${(e) => onInput(e.currentTarget.value)} />
    <button type="button" class="icon-btn sm" aria-pressed=${Boolean(shown)} aria-label=${shown ? 'Hide the password' : 'Show the password'} title=${shown ? 'Hide the password' : 'Show the password'}
      onMouseDown=${(e) => e.preventDefault()} onClick=${() => onShown(!shown)}><${Icon} name=${shown ? 'eyeOff' : 'eye'} size=${15} /></button>
  </div>`;
}

/** An archive needs its password: asked here, tried again; a wrong one says so. */
export function ArchivePasswordDialog({ name, wrong, verb = 'Extract', onSubmit, onClose }) {
  const [value, setValue] = useState('');
  const [shown, setShown] = useState(false);
  const submit = (e) => {
    e?.preventDefault();
    if (value) onSubmit(value);
  };
  return html`<${Modal} title="Password" onClose=${onClose} className="archive-password"
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${!value} onClick=${submit}><${Icon} name="unlock" size=${15} />${verb}</button>`}>
    <form onSubmit=${submit}>
      <p><strong>${name}</strong> is protected by a password.</p>
      <${PasswordField} value=${value} onInput=${setValue} shown=${shown} onShown=${setShown} autoFocus />
      ${wrong && !value && html`<p class="field-error" role="alert">That password is not right. Check it (the eye shows it) and try again.</p>`}
      <p class="muted small">It is used for this archive only, and not kept.</p>
    </form>
  </${Modal}>`;
}

/**
 * Extract…: into the archive's folder (`folderName`) or a new folder beside it (named after the
 * archive, or as typed), with its password when it has one. `onExtract({ to, name, password })`.
 */
export function ExtractDialog({ entry, folderName, onExtract, onClose }) {
  const [info, setInfo] = useState(null);
  const [to, setTo] = useState('folder');
  const [name, setName] = useState(stemOf(entry.name));
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  useEffect(() => {
    let stale = false;
    window.desktop.folders.archiveList(entry.path).then(
      (got) => !stale && setInfo(got),
      (err) => !stale && setInfo({ error: message(err) }),
    );
    return () => {
      stale = true;
    };
  }, [entry.path]);
  const locked = info?.needsPassword || info?.encrypted > 0;
  const problem = to === 'folder' ? stemProblem(name) : '';
  const go = (e) => {
    e?.preventDefault();
    if (problem || info?.error) return;
    onExtract({ to, name: name.trim(), password: locked || askPassword ? password : '' });
  };
  return html`<${Modal} title=${`Extract ${entry.name}`} onClose=${onClose} className="archive-dialog"
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${Boolean(problem || info?.error || ((locked || askPassword) && !password))} onClick=${go}><${Icon} name="archive" size=${15} />Extract</button>`}>
    <form class="field-grid" onSubmit=${go}>
      <p class="muted small span-2 archive-summary">${!info ? 'Reading what it holds…' : info.error ? html`<span class="error-text">${info.error}</span>` : info.needsPassword ? 'Its names are hidden by a password.' : listingSummary(info, formatBytes)}</p>
      ${laterVolume(entry.name) && html`<p class="notice warn span-2"><${Icon} name="alert" size=${15} /><span>This is a later part: extracting starts from the first one (<code>.001</code>), with all its parts in the same folder.</span></p>`}
      <div class="field span-2"><span>Where</span>
        <${Segmented} label="Where" value=${to} onChange=${setTo} options=${[
          { id: 'here', label: `Here, in ${folderName}` },
          { id: 'folder', label: 'In a new folder' },
        ]} />
        <small>${to === 'here' ? 'Names already there are asked about: replace, keep both or skip.' : 'Beside the archive; “(2)” is added when the name is taken.'}</small>
      </div>
      ${to === 'folder' && html`<label class="field span-2"><span>Folder name</span>
        <input value=${name} spellcheck="false" onInput=${(e) => setName(e.currentTarget.value)} />
        ${problem && html`<small class="error-text">${problem}</small>`}
      </label>`}
      ${locked || askPassword
        ? html`<div class="field span-2"><span>Password</span>
            <${PasswordField} value=${password} onInput=${setPassword} shown=${shown} onShown=${setShown} autoFocus=${locked} />
            <small>${locked ? (info?.needsPassword ? 'Needed to see and extract its files.' : `${info.encrypted} of its files are encrypted.`) : 'Used for this archive only, and not kept.'}</small>
          </div>`
        : info && !info.error && html`<p class="span-2 small"><button type="button" class="btn link" onClick=${() => setAskPassword(true)}>It has a password…</button></p>`}
      ${info?.links > 0 && html`<p class="notice span-2"><${Icon} name="info" size=${15} /><span>${info.links === 1 ? 'A link' : `${info.links} links`} in it will not be made (links can point outside the folder).</span></p>`}
      <button type="submit" hidden />
    </form>
  </${Modal}>`;
}

const LEAVE_OUT = { deps: 'node_modules', vcs: '.git', build: 'Build outputs', junk: 'System junk' };

/**
 * Compress…: the archive's name, format, level, password (AES-256; 7z can hide the names too),
 * volumes and what to leave out of folders. `onCompress({ name, ...compressRequest })`.
 */
export function CompressDialog({ items, folderName, onCompress, onClose }) {
  const [name, setName] = useState(defaultStem(items));
  const [format, setFormat] = useState('zip');
  const [level, setLevel] = useState('normal');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [shown, setShown] = useState(false);
  const [hideNames, setHideNames] = useState(true);
  const [split, setSplit] = useState('off');
  const [customMb, setCustomMb] = useState('');
  const [exclude, setExclude] = useState(defaultExcludes);
  const spec = formatOf(format);
  const folders = items.some((e) => e.dir);
  const nameProblem = stemProblem(name);
  const pwProblem = !spec.password || !password ? '' : format === 'zip' && !ASCII.test(password) ? 'A zip’s password can have only letters a–z, digits, spaces and the usual symbols (no accents). Choose 7z for any password.' : !shown && again !== password ? 'The two passwords are not the same.' : '';
  const volume = splitBytes(split, customMb);
  const splitProblem = Number.isNaN(volume) ? 'Type a size in MB (1 or more).' : '';
  const problem = nameProblem || pwProblem || splitProblem;
  const what = items.length === 1 ? items[0].name : `${items.length} items`;
  const go = (e) => {
    e?.preventDefault();
    if (problem) return;
    onCompress({ name: name.trim(), ...compressRequest({ format, level, password, hideNames, split, customMb, exclude }) });
  };
  const toggle = (id, on) => setExclude((list) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id)));
  return html`<${Modal} title=${`Compress ${what}`} onClose=${onClose} className="archive-dialog compress-dialog"
    footer=${html`<span class="spacer" /><button type="button" class="btn" onClick=${onClose}>Cancel</button>
      <button type="button" class="btn primary" disabled=${Boolean(problem)} onClick=${go}><${Icon} name="archive" size=${15} />Compress</button>`}>
    <form class="field-grid" onSubmit=${go}>
      <label class="field span-2"><span>Name</span>
        <div class="row-input archive-name"><input value=${name} spellcheck="false" onInput=${(e) => setName(e.currentTarget.value)} aria-describedby="archive-ext" /><span class="muted" id="archive-ext">${spec.ext}${volume ? '.001…' : ''}</span></div>
        ${nameProblem ? html`<small class="error-text">${nameProblem}</small>` : html`<small>In ${folderName}; “(2)” is added when the name is taken.</small>`}
      </label>
      <div class="field span-2"><span>Format</span>
        <${Segmented} label="Format" value=${format} onChange=${setFormat} small options=${COMPRESS_FORMATS.map((f) => ({ id: f.id, label: f.label }))} />
        <small>${spec.hint}</small>
      </div>
      <div class="field span-2"><span>Level</span>
        ${spec.levels
          ? html`<${Segmented} label="Level" value=${level} onChange=${setLevel} small options=${LEVELS.map((l) => ({ id: l.id, label: l.label }))} />
            <small>${LEVELS.find((l) => l.id === level)?.hint ?? (level === 'normal' ? 'Good for most things. Files already compressed (photos, videos, zips) are stored as they are.' : '')}</small>`
          : html`<small>A tar keeps files as they are, without compressing them.</small>`}
      </div>
      <div class="field span-2"><span>Password</span>
        ${spec.password
          ? html`<${PasswordField} value=${password} onInput=${setPassword} shown=${shown} onShown=${setShown} placeholder="None" />
            ${password && !shown && html`<input type="password" class="password-again" value=${again} aria-label="The same password again" placeholder="The same again" autocomplete="off" onInput=${(e) => setAgain(e.currentTarget.value)} />`}
            ${pwProblem ? html`<small class="error-text">${pwProblem}</small>` : password ? html`<small>AES-256. ${format === 'zip' ? 'Open it with 7-Zip, WinRAR, Keka or this app (Windows’ own zip folders cannot).' : 'Without it, nothing in it can be read.'}</small>` : ''}
            ${spec.hideNames && password && html`<label class="field checkbox"><input type="checkbox" checked=${hideNames} onChange=${(e) => setHideNames(e.currentTarget.checked)} /><span>Hide the file names too<small>Without the password, not even the list of files shows.</small></span></label>`}`
          : html`<small>A ${spec.label} has no password: choose zip or 7z for one.</small>`}
      </div>
      <label class="field"><span>Split into volumes</span>
        <select value=${split} onChange=${(e) => setSplit(e.currentTarget.value)}>
          ${SPLIT_SIZES.map((s) => html`<option value=${s.id}>${s.label}${s.hint ? ` (${s.hint})` : ''}</option>`)}
        </select>
      </label>
      ${split === 'custom'
        ? html`<label class="field"><span>Size of each (MB)</span><input value=${customMb} inputmode="decimal" placeholder="250" onInput=${(e) => setCustomMb(e.currentTarget.value)} />${splitProblem && html`<small class="error-text">${splitProblem}</small>`}</label>`
        : html`<span />`}
      ${folders &&
      html`<fieldset class="field span-2 archive-leave-out"><legend>Leave out of the folders</legend>
        ${EXCLUDE_GROUPS.map(
          (g) => html`<label class="field checkbox" key=${g.id} title=${g.hint}><input type="checkbox" checked=${exclude.includes(g.id)} onChange=${(e) => toggle(g.id, e.currentTarget.checked)} /><span>${LEAVE_OUT[g.id] ?? g.label}<small>${g.hint}</small></span></label>`,
        )}
        <small>Links are always left out. What you picked yourself is never left out.</small>
      </fieldset>`}
      <button type="submit" hidden />
    </form>
  </${Modal}>`;
}

const shortDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

/**
 * What an archive holds, without extracting it (the preview pane; `big` in the viewer): its
 * entries with a filter, or its password asked when the names are hidden. `onExtract(entry)`
 * offers Extract….
 */
export function ArchivePeek({ entry, big = false, onExtract }) {
  const [info, setInfo] = useState(null);
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [shown, setShown] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let stale = false;
    setInfo(null);
    window.desktop.folders.archiveList(entry.path, password ? { password } : undefined).then(
      (got) => !stale && setInfo(got),
      (err) => !stale && setInfo({ error: message(err) }),
    );
    return () => {
      stale = true;
    };
  }, [entry.path, entry.mtimeMs, password]);
  if (!info) return html`<div class="peek-empty muted small">Reading what ${entry.name} holds…</div>`;
  if (info.error) {
    return html`<div class="peek-card"><${Icon} name="archive" size=${big ? 64 : 36} /><strong class="peek-name">${entry.name}</strong><p class="muted small">${info.error}</p></div>`;
  }
  if (info.needsPassword) {
    return html`<form class="peek-card archive-locked" onSubmit=${(e) => (e.preventDefault(), typed && setPassword(typed))}>
      <${Icon} name="lock" size=${big ? 48 : 32} />
      <p>${info.wrong ? 'That password is not right. Try again:' : html`The names in <strong>${entry.name}</strong> are hidden by a password.`}</p>
      <${PasswordField} value=${typed} onInput=${setTyped} shown=${shown} onShown=${setShown} />
      <button type="submit" class="btn sm primary" disabled=${!typed}>Show what it holds</button>
    </form>`;
  }
  const { rows, total } = filterEntries(info.entries, query, big ? 2000 : 400);
  return html`<div class="archive-peek ${big ? 'big' : ''}">
    <div class="archive-peek-head">
      <span class="muted small archive-summary">${listingSummary(info, formatBytes)}${info.encrypted ? html` · <${Icon} name="lock" size=${12} /> ${info.encrypted === info.files ? 'encrypted' : `${info.encrypted} encrypted`}` : ''}</span>
      ${onExtract && html`<button type="button" class="btn sm" onClick=${() => onExtract(entry)}><${Icon} name="archive" size=${14} />Extract…</button>`}
    </div>
    <div class="sidebar-filter archive-filter">
      <${Icon} name="search" size=${14} />
      <input value=${query} placeholder=${`Filter the ${info.count.toLocaleString()} names`} aria-label="Filter the names in the archive" onInput=${(e) => setQuery(e.currentTarget.value)}
        onKeyDown=${(e) => e.key === 'Escape' && query && (e.preventDefault(), e.stopPropagation(), setQuery(''))} />
      <${ClearButton} value=${query} onClear=${() => setQuery('')} label="Clear the filter" />
    </div>
    <ul class="archive-entries" role="list" aria-label=${`What ${entry.name} holds`}>
      ${rows.map(
        (e) => html`<li key=${e.name} class=${e.dir ? 'dir' : ''} title=${e.name}>
          <${Icon} name=${e.dir ? 'folder' : e.link ? 'link' : 'file'} size=${14} />
          <span class="archive-entry-name">${e.name}</span>
          ${e.encrypted && html`<span class="archive-lock" title="Encrypted"><${Icon} name="lock" size=${12} /></span>`}
          <span class="muted archive-entry-size">${e.dir ? '' : formatBytes(e.size)}</span>
          ${big && html`<span class="muted archive-entry-packed" title="Packed">${e.dir ? '' : formatBytes(e.packed)}</span><span class="muted archive-entry-date">${shortDate(e.mtime)}</span>`}
        </li>`,
      )}
    </ul>
    ${(total > rows.length || info.truncated) && html`<p class="muted small peek-more">${total > rows.length ? `${rows.length.toLocaleString()} of ${total.toLocaleString()} shown: filter to find others.` : `The first ${info.entries.length.toLocaleString()} of ${info.count.toLocaleString()}.`}</p>`}
    ${!rows.length && html`<p class="muted small peek-more">${query ? 'No name matches.' : 'It is empty.'}</p>`}
  </div>`;
}
