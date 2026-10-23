import { html, useMemo } from '../../vendor/preact-htm.js';
import { Modal, toast } from './components.js';
import { Icon } from './icons.js';
import { isLocal } from '../settings.js';

// Text up to this length goes into an email or WhatsApp link; longer text is
// put on the clipboard to paste, because links that long get cut off.
const MAX_LINK_TEXT = 1800;

const MIME = { md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', json: 'application/json', csv: 'text/csv', xml: 'application/xml', svg: 'image/svg+xml' };
const mimeFor = (name) => MIME[/\.([^.]+)$/.exec(name)?.[1]?.toLowerCase()] ?? 'text/plain';

// Through a link, as if clicked: mailto: goes to the email app (the desktop app
// hands it over), web links open in a new window.
function openLink(url) {
  const a = document.createElement('a');
  a.href = url;
  if (!url.startsWith('mailto:')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * Sharing a file: the system share sheet where there is one (phones, Chrome
 * and Edge), and on every device email, WhatsApp, Teams, copy and save.
 */
export function ShareDialog({ name, text, link, actions, onClose }) {
  const file = useMemo(() => new File([text], name, { type: mimeFor(name) }), [name, text]);
  const canShare = typeof navigator.share === 'function';
  const canShareFile = canShare && Boolean(navigator.canShare?.({ files: [file] }));
  const run = async (fn) => {
    try {
      await fn();
      onClose();
    } catch (err) {
      if (err?.name !== 'AbortError') toast(err?.message || 'Could not share', { kind: 'error' });
    }
  };
  const copy = (value) => navigator.clipboard.writeText(value);
  // Short text goes in the link; long text on the clipboard, with the app opened to paste it.
  const viaLink = (makeUrl, where) =>
    run(async () => {
      if (text.length <= MAX_LINK_TEXT) return openLink(makeUrl(text));
      await copy(text);
      toast(`The text is on the clipboard: paste it into ${where}.`, { timeout: 9000 });
      openLink(makeUrl(''));
    });
  const options = [
    canShare && {
      id: 'system',
      icon: 'share',
      label: 'Share…',
      hint: 'WhatsApp, Teams, email, Quick Share and the other apps on this device',
      run: () => run(() => navigator.share({ title: name, text })),
    },
    canShareFile && { id: 'file', icon: 'paperclip', label: 'Share as a file…', hint: `Sends ${name} as an attachment`, run: () => run(() => navigator.share({ files: [file], title: name })) },
    { id: 'email', icon: 'mail', label: 'Email', hint: 'Opens your email app with the text', run: () => viaLink((t) => `mailto:?subject=${encodeURIComponent(name)}${t ? `&body=${encodeURIComponent(t)}` : ''}`, 'the email') },
    { id: 'whatsapp', icon: 'chat', label: 'WhatsApp', hint: 'Pick the chat, then send', run: () => viaLink((t) => `https://wa.me/${t ? `?text=${encodeURIComponent(t)}` : ''}`, 'the chat') },
    {
      id: 'teams',
      icon: 'chat',
      label: 'Teams',
      hint: 'Copies the text and opens Teams, to paste it in a chat',
      run: () =>
        run(async () => {
          await copy(text);
          toast('The text is on the clipboard: paste it into a Teams chat.', { timeout: 9000 });
          openLink('https://teams.microsoft.com/');
        }),
    },
    { id: 'copy', icon: 'copy', label: 'Copy text', hint: 'To paste anywhere', run: () => run(async () => (await copy(text), toast('Copied'))) },
    link && { id: 'link', icon: 'link', label: 'Copy link', hint: 'Opens this file in Tracker Editor on your other devices', run: () => run(async () => (await copy(link), toast('Link copied'))) },
    { id: 'save', icon: 'download', label: 'Save a copy', hint: 'As a file on this device', run: () => run(() => actions.saveCopy()) },
  ].filter(Boolean);
  return html`<${Modal} title=${`Share ${name}`} onClose=${onClose} className="share-dialog">
    <div class="share-options">
      ${options.map(
        (o) => html`<button type="button" key=${o.id} class="share-option" data-share=${o.id} onClick=${o.run}>
          <${Icon} name=${o.icon} size=${20} /><span><strong>${o.label}</strong><small>${o.hint}</small></span>
        </button>`,
      )}
    </div>
    ${!isLocal() && html`<p class="muted small share-note">Sending it to yourself? It is already on your other devices: everything syncs through GitHub.</p>`}
  </${Modal}>`;
}
