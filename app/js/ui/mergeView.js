// The merge view (0.49): a file in conflict in a comparison tab of its own (mode 'merge'): the
// current side (Git's :2:), the result (the file as it is in its tab or on disk, editable, with
// the editor's conflict bars) and the incoming side (:3:), and the common ancestor (:1:) when
// asked for. The sides follow the block at the result's cursor (mergeEditor.js). Save writes the
// file in its own format (actions.saveCompareSide); Mark resolved saves, stages it
// (actions.markResolved) and closes the tab. On phones one column at a time.
import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { createThreeWay } from '../mergeEditor.js';
import { conflictWords } from '../gitConflicts.js';
import { resolvedTheme } from '../settings.js';
import { parseKey } from '../store.js';
import { Icon } from './icons.js';
import { MenuButton } from './menu.js';
import { usePhoneLayout } from './phone.js';

const message = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const baseName = (p) => String(p).split(/[\\/]/).pop();

/** A merge view in its tab: `record` { left: { key } (the file), at (the block to show first), seq }. */
export function MergeTab({ id, record, settings, actions }) {
  const key = record.left?.key ?? '';
  const path = parseKey(key)?.path ?? '';
  const name = baseName(path);
  const phone = usePhoneLayout();
  const theme = resolvedTheme(settings.theme);
  const els = { ours: useRef(null), base: useRef(null), result: useRef(null), theirs: useRef(null) };
  const api = useRef(null);
  const saved = useRef(''); // the result's text as saved (or read)
  const now = useRef(null); // { from: data, text }: edits kept when the views are made again
  const asking = useRef(0);
  const [data, setData] = useState(null); // { sides: { base, ours, theirs, op, place, conflicted }, result: { text, info, readOnly, savable } } | { error }
  const [reload, setReload] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [pos, setPos] = useState({ index: -1, count: 0 });
  const [showBase, setShowBase] = useState(false);
  const [column, setColumn] = useState('result'); // phones: the one shown
  const [saving, setSaving] = useState(false);
  const [proposal, setProposal] = useState(null); // { index, asking } | { index, block, text, note }

  useEffect(() => {
    let stale = false;
    setData(null);
    Promise.all([actions.mergeSides(path), actions.readCompareSide({ key })]).then(
      ([sides, result]) => !stale && setData({ sides, result }),
      (err) => !stale && setData({ error: message(err) }),
    );
    return () => {
      stale = true;
    };
  }, [path, reload]);
  useEffect(() => actions.compareDirty(id, dirty), [dirty]);

  // The model's merge of one block, shown over the result to accept or discard.
  const askModel = async (index) => {
    const t = api.current?.conflict(index);
    if (!t) return;
    const ticket = ++asking.current;
    setProposal({ index, asking: true });
    const merged = await actions.mergeTextsWithModel(key, { ...t, op: data?.sides?.op ?? null });
    if (ticket !== asking.current) return;
    setProposal(merged ? { index, block: t.block, ...merged } : null);
  };
  const accept = () => {
    if (!api.current?.replaceConflict(proposal.index, proposal.block, proposal.text)) actions.toast('The block changed meanwhile, so it was left as it is. Ask again.', { kind: 'error' });
    setProposal(null);
    api.current?.focus();
  };

  useLayoutEffect(() => {
    if (!data || data.error || !els.result.current) return;
    if (now.current?.from !== data) {
      now.current = { from: data, text: data.result.text };
      saved.current = data.result.text;
      setDirty(false);
    }
    api.current = createThreeWay(
      { ours: els.ours.current, theirs: els.theirs.current, result: els.result.current, base: showBase ? els.base.current : null },
      {
        ours: data.sides.ours?.text ?? '',
        theirs: data.sides.theirs?.text ?? '',
        base: data.sides.base?.text ?? null,
        result: now.current.text,
        name,
        dark: theme === 'dark',
        wrap: Boolean(settings.wordWrap) || phone,
        readOnly: Boolean(data.result.readOnly),
        info: { op: data.sides.op, model: actions.conflictCanModel(key) },
        onChange: (text) => {
          now.current.text = text;
          setDirty(text !== saved.current);
        },
        onCursor: setPos,
        onAction: ({ action, index }) => action === 'model' && askModel(index),
      },
    );
    // The block in hand: the one the tab was opened at, else the first.
    if (!api.current.focusConflict(record.at ?? 0)) api.current.focusConflict(0);
    return () => {
      api.current?.destroy();
      api.current = null;
    };
  }, [data, theme, settings.wordWrap, phone, showBase]);
  // Opened again from another block (the editor's bar, the menu): that one.
  useEffect(() => {
    if (record.seq) api.current?.focusConflict(record.at ?? 0);
  }, [record.seq]);
  // A column just shown on a phone measures itself.
  useEffect(() => api.current?.measure(), [column]);

  const save = async () => {
    const text = api.current?.text();
    if (text == null || !data?.result) return false;
    setSaving(true);
    try {
      const info = await actions.saveCompareSide({ key }, text, data.result.info);
      if (!info) return false;
      data.result.info = info;
      saved.current = text;
      setDirty(false);
      return true;
    } finally {
      setSaving(false);
    }
  };
  const resolve = async () => {
    if (dirty && !(await save())) return;
    if (await actions.markResolved(path)) actions.close(`c:${id}`, { discard: true });
  };
  const readAgain = () => {
    if (dirty && !confirm('Read the file and both sides again? Your edits here that are not saved go.')) return;
    now.current = null;
    setReload((n) => n + 1);
  };

  const words = conflictWords(data?.sides?.op ?? null, {});
  const left = pos.count;
  const where = !data || data.error ? '' : left === 0 ? 'No conflict blocks left' : pos.index >= 0 ? `Conflict ${pos.index + 1} of ${left}` : `${left} conflict${left === 1 ? '' : 's'}`;
  const readOnly = Boolean(data?.result?.readOnly);
  const cols = [
    showBase && { id: 'base', label: 'Common ancestor', hint: 'What both sides changed from (Git’s :1:)', none: 'The file was not there before: both sides added it.' },
    { id: 'ours', label: 'Current', hint: words.current || 'Git’s :2:', none: 'The current side deleted this file.' },
    { id: 'result', label: 'Result', hint: name },
    { id: 'theirs', label: 'Incoming', hint: words.incoming || 'Git’s :3:', none: 'The incoming side deleted this file.' },
  ].filter(Boolean);
  const missing = (id) => id !== 'result' && data?.sides && !data.sides[id];
  const moreItems = () => [
    { label: 'Take the current side for every block', icon: 'arrowUp', disabled: readOnly || !left, run: () => api.current?.resolveAll('ours') },
    { label: 'Take the incoming side for every block', icon: 'arrowDown', disabled: readOnly || !left, run: () => api.current?.resolveAll('theirs') },
    { separator: true },
    { label: 'Read the file and both sides again', icon: 'rotate', run: readAgain },
    { label: `Open ${name} in its tab`, icon: 'file', run: () => actions.openDiskPath(path) },
  ];
  return html`<div class=${`ccmp mv ${phone ? 'phone' : ''} ${showBase ? 'with-base' : ''}`} role="region" aria-label=${`Merge ${name}`}>
    <div class="ccmp-bar mv-bar">
      <span class="muted small ccmp-count mv-count" aria-live="polite">${where}</span>
      <button type="button" class="icon-btn sm" aria-label="Previous conflict" title="Previous conflict" disabled=${!left} onClick=${() => api.current?.goto(-1)}><${Icon} name="chevronDown" size=${16} class="up" /></button>
      <button type="button" class="icon-btn sm" aria-label="Next conflict" title="Next conflict" disabled=${!left} onClick=${() => api.current?.goto(1)}><${Icon} name="chevronDown" size=${16} /></button>
      <span class="ccmp-gap" />
      <button type="button" class=${`btn ghost sm mv-base-toggle ${showBase ? 'on' : ''}`} aria-pressed=${showBase} disabled=${!data?.sides} title="Show what both sides changed from (the common ancestor)" onClick=${() => setShowBase((b) => !b)}>
        <${Icon} name="history" size=${14} /><span class="label">Ancestor</span></button>
      <span class="spacer" />
      ${data?.result?.savable &&
      html`<button type="button" class=${`btn sm ${dirty ? 'primary' : 'ghost'}`} disabled=${!dirty || saving || readOnly} title=${`Save the result to ${name}, in its own format`} onClick=${save}>
        <${Icon} name="save" size=${14} /><span class="label">${saving ? 'Saving…' : 'Save'}</span></button>`}
      <button type="button" class=${`btn sm ${!dirty && left === 0 ? 'primary' : 'ghost'} mv-resolve`} disabled=${!data?.sides || saving} title="Save the result, stage it (git add) and close: the file is resolved" onClick=${resolve}>
        <${Icon} name="check" size=${14} /><span class="label">Mark resolved</span></button>
      <${MenuButton} label="More" items=${moreItems} />
    </div>
    ${phone &&
    html`<div class="mv-switch" role="tablist" aria-label="Columns">
      ${cols.map((c) => html`<button type="button" role="tab" key=${c.id} class=${`mv-tab ${c.id} ${column === c.id ? 'on' : ''}`} aria-selected=${column === c.id} onClick=${() => setColumn(c.id)}>${c.label}</button>`)}
    </div>`}
    ${data?.error && html`<p class="notice error ccmp-note" role="alert"><${Icon} name="alert" size=${15} /><span>${data.error}</span></p>`}
    ${data?.sides && !data.sides.conflicted && html`<p class="notice ccmp-note mv-note"><${Icon} name="info" size=${15} /><span>Git does not list ${name} as in conflict now: the sides are what it last had, if anything.</span></p>`}
    ${!data && html`<p class="muted small ccmp-note">Reading the file and both sides…</p>`}
    <div class="mv-cols" style=${{ '--cols': phone ? 1 : cols.length }} hidden=${!data || Boolean(data.error)}>
      ${cols.map(
        (c) => html`<div class=${`mv-col ${c.id} ${phone && column !== c.id ? 'off' : ''}`} key=${c.id}>
          <div class="mv-head" title=${c.hint}>
            <span class="mv-name">${c.label}</span>
            ${c.id === 'result' && dirty && html`<span class="tab-dot" title="Not saved" />`}
            <span class="mv-hint">${c.hint}</span>
            ${c.id === 'result' && readOnly && html`<span class="muted small">read-only</span>`}
          </div>
          ${c.id === 'result' &&
          proposal &&
          html`<div class="mv-proposal" role="region" aria-label="The model’s merge">
            <div class="mv-proposal-head">
              <${Icon} name="sparkle" size=${14} />
              <span>${proposal.asking ? `The model is merging conflict ${proposal.index + 1}…` : `The model’s merge for conflict ${proposal.index + 1}`}</span>
              <span class="spacer" />
              ${!proposal.asking && html`<button type="button" class="btn primary sm" onClick=${accept}><${Icon} name="check" size=${14} />Accept</button>`}
              <button type="button" class="btn ghost sm" onClick=${() => ((asking.current += 1), setProposal(null))}>${proposal.asking ? 'Stop waiting' : 'Discard'}</button>
            </div>
            ${!proposal.asking && html`<pre class="mv-proposal-text">${proposal.text || '(no lines: the block goes)'}</pre>`}
            ${proposal.note && html`<p class="muted small mv-proposal-note">${proposal.note}</p>`}
          </div>`}
          ${missing(c.id) && html`<p class="muted small mv-none">${c.none}</p>`}
          <div class="mv-body" ref=${els[c.id]} />
        </div>`,
      )}
    </div>
  </div>`;
}
