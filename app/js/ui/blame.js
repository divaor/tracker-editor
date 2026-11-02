import { html, useEffect, useLayoutEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { blameAgo, blameWho } from '../gitStatus.js';
import { formatBytes } from '../format.js';
import { Icon } from './icons.js';

const GIT_WORDS = { A: 'Added', M: 'Changed', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed' };
const initials = (name) =>
  String(name ?? '')
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';
// One hue per name, so the same person looks the same in every card.
const hueOf = (text) => [...String(text ?? '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/**
 * The card of a line's commit (blame): who (the mail as its title), when (how long ago and the
 * date), the short hash with Copy, the summary and the rest of the message, the files it changed;
 * Show this commit (this file before and after it) and Blame the whole file (the column). A line
 * not committed yet, or a file too large to blame, says so. `card`: { key, line, from ('inline'
 * or 'column'), mode ('hover': it goes when the pointer leaves; 'pin': a click put it there), rect
 * (what it is next to), info (editor blameAt), column (the tab shows the column), name, id }.
 */
export function BlameCard({ card, actions, onEnter, onLeave, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [details, setDetails] = useState(null);
  const { info } = card;
  const commit = info?.commit ?? null;
  const hash = info?.hash ?? '';
  const committed = Boolean(commit && !commit.uncommitted && hash);
  useEffect(() => {
    setDetails(null);
    if (!committed) return;
    let live = true;
    Promise.resolve(actions.gitCommitDetails(card.key, hash)).then(
      (d) => live && setDetails(d ?? { failed: true }),
      () => live && setDetails({ failed: true }),
    );
    return () => {
      live = false;
    };
  }, [card.key, hash]);
  // Next to what it is about: under the line's end (over it when there is no room below), or right of the column.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const a = card.rect ?? { left: 40, right: 40, top: 40, bottom: 40 };
    let left = card.from === 'column' ? a.right + 6 : a.left;
    let top = card.from === 'column' ? a.top : a.bottom + 4;
    if (card.from !== 'column' && top + r.height > innerHeight - 8) top = a.top - r.height - 4;
    left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
    top = Math.max(8, Math.min(top, innerHeight - r.height - 8));
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [card.id, details]);
  // Escape, a press elsewhere or a scroll (what it is next to moved) closes it.
  useEffect(() => {
    const inside = (e) => ref.current?.contains(e.target);
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose({ focus: card.mode === 'pin' });
    };
    const onDown = (e) => !inside(e) && onClose({ focus: false });
    const onScroll = (e) => !inside(e) && onClose({ focus: false });
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [card.id]);
  // Opened from the keyboard or by a click: the keys go on in it.
  useEffect(() => {
    if (card.mode === 'pin' && !card.touch) ref.current?.querySelector('button')?.focus({ preventScroll: true });
  }, [card.id]);

  const style = pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: '-9999px', top: '0px' };
  const close = () => onClose({ focus: true });
  const columnButton = html`<button type="button" class="btn sm blame-column-btn" onClick=${() => (close(), actions.toggleBlameColumn(card.key))}>
    <${Icon} name="columns" size=${14} />${card.column ? 'Hide the blame column' : 'Blame the whole file'}</button>`;
  let content;
  if (info?.status === 'big') {
    content = html`<div class="blame-card-head"><span class="blame-avatar none" aria-hidden="true"><${Icon} name="info" size=${15} /></span>
        <div class="blame-who"><strong>No blame for this file</strong><span class="blame-when">It is ${formatBytes(info.size)}: blame works for files up to ${formatBytes(info.max)}.</span></div></div>`;
  } else if (!committed) {
    content = html`<div class="blame-card-head"><span class="blame-avatar" style=${{ '--hue': hueOf(info?.me?.email ?? 'you') }} aria-hidden="true">${initials(info?.me?.name || 'You')}</span>
        <div class="blame-who"><strong title=${info?.me?.email ?? ''}>You</strong><span class="blame-when">Not committed yet</span></div></div>
      <p class="blame-subject">This line changed here since the last commit (saved or not).</p>
      <div class="blame-actions">
        <button type="button" class="btn sm primary" onClick=${() => (close(), actions.compareWithHead(card.key.slice(2)))}><${Icon} name="compare" size=${14} />Compare with the last commit</button>
        ${columnButton}
      </div>`;
  } else {
    const who = blameWho(commit, info.me);
    const when = commit.time ? new Date(commit.time * 1000) : null;
    const absolute = when ? when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const message = details?.message || commit.summary || '';
    const [subject, ...rest] = message.split('\n');
    const body = rest.join('\n').trim();
    const files = details?.files ?? null;
    const mine = (f) => f.path === commit.filename;
    content = html`<div class="blame-card-head">
        <span class="blame-avatar" style=${{ '--hue': hueOf(commit.mail || commit.author) }} aria-hidden="true">${initials(commit.author || commit.mail)}</span>
        <div class="blame-who">
          <strong class="blame-author" title=${commit.mail}>${who}${who === 'You' && commit.author ? html` <span class="muted">(${commit.author})</span>` : ''}</strong>
          <span class="blame-when" title=${absolute}>${blameAgo(commit.time)} · ${absolute}</span>
        </div>
      </div>
      <div class="blame-hash-row">
        <code class="blame-hash" title=${hash}>${hash.slice(0, 8)}</code>
        <button type="button" class="icon-btn xs blame-copy" title="Copy the commit’s hash" aria-label="Copy the commit’s hash" onClick=${() => actions.copyText(hash)}><${Icon} name="copy" size=${13} /></button>
        ${commit.boundary && html`<span class="blame-chip" title="The first commit of the history blame looked at">first commit</span>`}
      </div>
      <p class="blame-subject">${subject}</p>
      ${body && html`<div class="blame-body">${body}</div>`}
      ${files &&
      html`<div class="blame-files">
        <span class="muted small">${files.length + (details.more ?? 0)} file${files.length + (details.more ?? 0) === 1 ? '' : 's'} changed</span>
        <ul>${files.slice(0, 6).map((f) => html`<li key=${f.path} class=${mine(f) ? 'mine' : ''} title=${f.from ? `${f.from} → ${f.path}` : f.path}><span class="blame-file-status s-${f.status}" title=${GIT_WORDS[f.status] ?? f.status}>${f.status}</span><bdi>${f.path}</bdi></li>`)}</ul>
        ${files.length + (details.more ?? 0) > 6 && html`<span class="muted small">…and ${files.length + (details.more ?? 0) - 6} more</span>`}
      </div>`}
      <div class="blame-actions">
        <button type="button" class="btn sm primary blame-show" onClick=${() => (close(), actions.showBlameCommit(card.key, hash))}><${Icon} name="compare" size=${14} />Show this commit</button>
        ${columnButton}
      </div>`;
  }
  return html`<div class="blame-card ${card.mode}" role="dialog" aria-label=${committed ? `Commit ${hash.slice(0, 8)}` : 'Blame'} ref=${ref} style=${style}
    onMouseEnter=${onEnter} onMouseLeave=${onLeave}>
    ${content}
  </div>`;
}
