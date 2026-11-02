// Settings → Keys: every command with its keys, to change. A key is set by pressing it (Escape
// cancels, Backspace leaves the command without one); a key another command has moves to this one
// when you say so; a preset (VS Code, Notepad++) gives its keys first and your changes stay on top
// of it. Keys that work only in place (the folders view, two panes, the terminal) show as they are.
import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { COMMAND_LIST, findCommands, groupsOf, keysFor } from '../commands.js';
import { PRESETS, PRESET_IDS, assignKeys, cleanBindings, comboProblem, formatCombo, keyHolders, keysChanged, recordedCombo, resetKeys } from '../keybindings.js';
import { currentKeys, keyContext, shownKeys } from '../keys.js';
import { isLocal, saveSettings } from '../settings.js';
import { Card, ClearButton, Segmented } from './components.js';
import { Keys } from './help.js';
import { Icon } from './icons.js';

const RUNNABLE = new Set(COMMAND_LIST.filter((c) => c.run !== false).map((c) => c.id));
const labelOf = (id) => COMMAND_LIST.find((c) => c.id === id)?.label ?? id;
const PRESET_OPTIONS = PRESET_IDS.map((id) => ({ id, label: id ? PRESETS[id].label : 'This editor’s' }));

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function KeysCard({ settings }) {
  const ctx = keyContext();
  const table = currentKeys(settings);
  const overrides = settings.keyBindings ?? {};
  const preset = PRESETS[settings.keyPreset] ? settings.keyPreset : '';
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState(null); // { id, add }
  const [offer, setOffer] = useState(null); // a key another command has: { id, combo, add, holders }
  const [note, setNote] = useState(null); // { text, error }
  const file = useRef(null);
  const recorder = useRef(null);

  const save = (next, text) => {
    saveSettings({ keyBindings: next });
    setNote(text ? { text } : null);
  };
  const give = (id, combo, add) => {
    const now = table.keys.get(id) ?? [];
    const combos = add ? [...now.filter((c) => c !== combo), combo] : [combo];
    save(assignKeys(table, overrides, id, combos), `${labelOf(id)}: ${formatCombo(combo, ctx)}.`);
  };

  // While a key is being recorded: every key press is the key (the menu's shortcuts too).
  useEffect(() => {
    if (!recording) return;
    window.desktop?.terminal?.ownKeys?.(true)?.catch?.(() => {});
    recorder.current?.focus();
    const onKey = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (plain && e.key === 'Escape') return setRecording(null);
      if (plain && (e.key === 'Backspace' || e.key === 'Delete')) {
        setRecording(null);
        return save({ ...overrides, [recording.id]: [] }, `${labelOf(recording.id)}: no key.`);
      }
      const combo = recordedCombo(e, ctx);
      if (!combo) return;
      const problem = comboProblem(combo, ctx);
      if (problem) return setNote({ text: problem, error: true });
      setRecording(null);
      if ((table.keys.get(recording.id) ?? []).includes(combo) && !recording.add) return give(recording.id, combo, false);
      const holders = keyHolders(table, recording.id, combo);
      if (holders.length) return setOffer({ id: recording.id, combo, add: recording.add, holders });
      give(recording.id, combo, recording.add);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.desktop?.terminal?.ownKeys?.(false)?.catch?.(() => {});
    };
  }, [recording, table, overrides]);

  const record = (id, add = false) => {
    setOffer(null);
    setNote(null);
    setRecording({ id, add });
  };
  const removeKey = (id, combo) => save({ ...overrides, [id]: (table.keys.get(id) ?? []).filter((c) => c !== combo) }, `${labelOf(id)}: ${formatCombo(combo, ctx)} removed.`);
  const reset = (id) => save(resetKeys(overrides, id), `${labelOf(id)}: its keys again.`);
  const choosePreset = (id) => {
    saveSettings({ keyPreset: id });
    setNote({ text: id ? `${PRESETS[id].label}’s keys, with your own changes on top.` : 'This editor’s keys, with your own changes on top.' });
  };
  const exportKeys = () => {
    download('tracker-editor-keys.json', `${JSON.stringify({ app: 'Tracker Editor', keys: 1, preset, bindings: overrides }, null, 2)}\n`);
    setNote({ text: 'Saved as tracker-editor-keys.json: Import… takes it on another computer.' });
  };
  const importKeys = async (e) => {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const bindings = cleanBindings(data?.bindings ?? data, RUNNABLE, ctx);
      const nextPreset = typeof data?.preset === 'string' && PRESET_IDS.includes(data.preset) ? data.preset : preset;
      saveSettings({ keyPreset: nextPreset, keyBindings: bindings });
      setNote({ text: `Keys taken from ${f.name}: ${Object.keys(bindings).length} command${Object.keys(bindings).length === 1 ? '' : 's'} changed${nextPreset ? `, on ${PRESETS[nextPreset].label}’s` : ''}.` });
    } catch {
      setNote({ text: `${f.name} is not a keys file (one saved with Export…).`, error: true });
    }
  };

  const found = findCommands(query, { desktop: ctx.desktop, mac: ctx.mac, local: isLocal(), keysOf: (c) => shownKeys(c, settings) });
  const row = (c) => {
    const fixed = c.run === false;
    const combos = table.keys.get(c.id) ?? [];
    const mine = Object.hasOwn(overrides, c.id);
    const byPreset = !mine && preset && table.keys.has(c.id) && keysChanged(table, c.id);
    const words = !fixed && !combos.length && !mine && !keysChanged(table, c.id) ? keysFor(c, ctx) : '';
    const now = recording?.id === c.id;
    return html`<div class="keys-row ${mine ? 'mine' : ''} ${fixed ? 'fixed' : ''} ${now ? 'recording' : ''}" key=${c.id} data-command=${c.id}>
      <span class="keys-label">${c.label}${mine && html`<span class="keys-tag mine" title="You changed it">yours</span>`}${byPreset && html`<span class="keys-tag" title=${`${PRESETS[preset].label}’s keys`}>${PRESETS[preset].label}</span>`}</span>
      <span class="keys-chips">
        ${now
          ? html`<span class="keys-recorder" tabindex="-1" ref=${recorder} role="status" aria-live="polite">Press the keys… <span class="muted">Esc cancels · Backspace: no key</span></span>`
          : fixed
            ? html`<${Keys} keys=${keysFor(c, ctx)} /><span class="muted small keys-fixed">works in place</span>`
            : combos.length
              ? combos.map(
                  (combo) => html`<span class="keys-chip" key=${combo}><kbd>${formatCombo(combo, ctx)}</kbd>
                    <button type="button" class="keys-chip-x" aria-label=${`Remove ${formatCombo(combo, ctx)} from ${c.label}`} title="Remove this key" onClick=${() => removeKey(c.id, combo)}><${Icon} name="x" size=${11} /></button></span>`,
                )
              : words
                ? html`<${Keys} keys=${words} />`
                : html`<span class="muted small">No key</span>`}
      </span>
      ${!fixed &&
      html`<span class="keys-actions">
        ${now
          ? html`<button type="button" class="btn ghost xs" onClick=${() => setRecording(null)}>Cancel</button>`
          : html`<button type="button" class="btn ghost xs" title=${combos.length ? 'Press the new key: it takes the place of these' : 'Press the key to give it'} onClick=${() => record(c.id)}>${combos.length ? 'Change' : 'Set'}</button>
              ${combos.length > 0 && html`<button type="button" class="icon-btn xs" aria-label=${`Add another key to ${c.label}`} title="Add another key" onClick=${() => record(c.id, true)}><${Icon} name="plus" size=${13} /></button>`}`}
        ${mine && !now && html`<button type="button" class="btn ghost xs" title=${preset ? `Back to ${PRESETS[preset].label}’s keys` : 'Back to its own keys'} onClick=${() => reset(c.id)}>Reset</button>`}
      </span>`}
    </div>`;
  };

  const changedCount = Object.keys(overrides).length;
  return html`<${Card} title="Keys" icon="keyboard" id="keys">
    <p class="muted small keys-intro">Any command can have the keys you like: <strong>Change</strong>, then press them. Start from this editor’s keys, VS Code’s or Notepad++’s; your own changes stay on top of the one you pick. The palette (Ctrl+Shift+P), Help (F1)${ctx.desktop ? ' and the menus' : ''} show the keys you have.</p>
    <div class="keys-top">
      <${Segmented} label="Keys to start from" options=${PRESET_OPTIONS} value=${preset} onChange=${choosePreset} small />
      <span class="spacer" />
      <button type="button" class="btn ghost sm" disabled=${!changedCount} title="Every command back to the keys of the one picked on the left" onClick=${() => save({}, 'Your changes are gone: the keys are the ones picked on the left.')}>Reset all${changedCount ? ` (${changedCount})` : ''}</button>
      <button type="button" class="btn ghost sm" title="Save your keys as a file" onClick=${exportKeys}><${Icon} name="download" size=${14} />Export</button>
      <button type="button" class="btn ghost sm" title="Take keys from a file saved with Export" onClick=${() => file.current?.click()}><${Icon} name="upload" size=${14} />Import…</button>
      <input type="file" accept=".json,application/json" hidden ref=${file} onChange=${importKeys} />
    </div>
    <div class="sidebar-filter keys-search">
      <${Icon} name="search" size=${15} />
      <input value=${query} onInput=${(e) => setQuery(e.currentTarget.value)} placeholder="Find a command or a key (format, Ctrl+K…)" aria-label="Find a command or a key" />
      <${ClearButton} value=${query} onClear=${() => setQuery('')} label="Clear the search" />
    </div>
    ${note && html`<p class="notice ${note.error ? 'error' : ''} keys-note" role="status"><${Icon} name=${note.error ? 'alert' : 'check'} size=${15} /><span>${note.text}</span></p>`}
    ${offer &&
    html`<div class="notice warn keys-offer" role="alert"><${Icon} name="alert" size=${15} />
      <span><strong>${formatCombo(offer.combo, ctx)}</strong> is the key of ${offer.holders.map((h) => `“${labelOf(h)}”`).join(' and ')} now. Give it to “${labelOf(offer.id)}” instead?${table.fixed.has(offer.combo) ? ` (It also works in place for “${labelOf(table.fixed.get(offer.combo)[0])}”, which keeps it there.)` : ''}
        <span class="keys-offer-actions">
          <button type="button" class="btn primary xs" onClick=${() => (setOffer(null), give(offer.id, offer.combo, offer.add))}>Take it over</button>
          <button type="button" class="btn ghost xs" onClick=${() => setOffer(null)}>Cancel</button>
        </span></span>
    </div>`}
    <div class="keys-list">
      ${groupsOf(found, Boolean(query.trim())).map((group) => {
        const rows = found.filter((c) => c.group === group);
        return rows.length > 0 && html`<section class="keys-group" key=${group}><h3>${group}</h3>${rows.map(row)}</section>`;
      })}
      ${!found.length && html`<p class="muted small">No command or key matches.</p>`}
    </div>
  </${Card}>`;
}
