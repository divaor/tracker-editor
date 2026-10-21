// Applies a saved light/dark theme and font size before first paint (classic script, runs synchronously).
try {
  var saved = JSON.parse(localStorage.getItem('editor.settings.v1') || '{}');
  if (saved.theme === 'light' || saved.theme === 'dark') document.documentElement.dataset.theme = saved.theme;
  if (saved.fontSize) document.documentElement.style.setProperty('--editor-font-size', saved.fontSize + 'px');
} catch (e) {
  // ignore
}
