// Which app the page runs in: the desktop app (Electron: `window.desktop` from its preload),
// the Android app (`window.desktop` from androidApp.js, platform 'android'), or a browser.
// Features check for the part of `window.desktop` they use; these are for what is about the
// app as a whole (desktop keys and menus, background sync, what Settings explains).
export const isAndroidApp = () => globalThis.window?.desktop?.platform === 'android';
export const isDesktopApp = () => Boolean(globalThis.window?.desktop) && !isAndroidApp();
