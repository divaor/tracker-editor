// Handlers that are different on a phone, registered over the desktop's (electron/main.cjs).
module.exports = function androidHandlers(bridge, config) {
  const paths = config.paths ?? {};
  // Where the folder picker and the side-by-side dialog start: the phone's storage.
  bridge.handle('folder:places', () => ({ home: paths.home, desktop: paths.home, documents: paths.documents, downloads: paths.downloads }));
  // There is no terminal app to start: the terminal panel is the way.
  bridge.handle('folder:terminal', () => {
    throw new Error('Use the terminal panel (the status bar’s Terminal).');
  });
  // For Settings → About and when something goes wrong.
  bridge.handle('app:info', () => ({ node: process.version, platform: process.platform, arch: process.arch, uptime: Math.round(process.uptime()) }));
};
