// The quick capture window (desktop): a note written anywhere, sent to the
// main window as a new note or added to the Inbox. The draft is kept when
// the window closes without saving.
const bridge = window.capture;
const form = document.getElementById('capture');
const textarea = document.getElementById('text');
const modes = [...document.querySelectorAll('[data-mode]')];
const MODE_KEY = 'tracker-editor:capture-mode';

let mode = 'new';
try {
  mode = localStorage.getItem(MODE_KEY) === 'inbox' ? 'inbox' : 'new';
} catch {
  // default
}
const showMode = () => {
  for (const b of modes) {
    b.classList.toggle('active', b.dataset.mode === mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  }
};
for (const b of modes) {
  b.addEventListener('click', () => {
    mode = b.dataset.mode;
    showMode();
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // not kept
    }
    textarea.focus();
  });
}
showMode();

let keepTimer = null;
const keepDraft = () => {
  clearTimeout(keepTimer);
  keepTimer = setTimeout(() => bridge.keepDraft(textarea.value), 250);
};
textarea.addEventListener('input', keepDraft);

const close = async () => {
  clearTimeout(keepTimer);
  await bridge.keepDraft(textarea.value);
  bridge.close();
};

const save = async (as = mode) => {
  if (!textarea.value.trim()) return close();
  clearTimeout(keepTimer);
  await bridge.submit({ text: textarea.value, mode: as });
};

form.addEventListener('submit', (e) => {
  e.preventDefault();
  save();
});
document.getElementById('cancel').addEventListener('click', close);
document.getElementById('paste').addEventListener('click', async () => {
  try {
    const clip = await navigator.clipboard.readText();
    if (clip) {
      textarea.setRangeText(clip, textarea.selectionStart, textarea.selectionEnd, 'end');
      keepDraft();
    }
  } catch {
    // the clipboard could not be read
  }
  textarea.focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    // Ctrl+Shift+Enter: the other place.
    save(e.shiftKey ? (mode === 'new' ? 'inbox' : 'new') : mode);
  }
});

bridge.draft().then((draft) => {
  if (draft && !textarea.value) textarea.value = draft;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
});
