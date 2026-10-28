// Full screen for a pane (a document, the preview): the `fills-screen` class puts it over the
// whole window, inside the safe areas, under dialogs, toasts and menus; where the browser can,
// the screen itself too. Not in Android's WebView: it takes Element.requestFullscreen but the
// app's Capacitor declines to show it, which left the pane under the status bar with its
// buttons out of reach. There the system bars hide instead. Escape (one nothing else handled)
// and Back leave it.
import { useLayoutEffect, useState } from '../../vendor/preact-htm.js';
import { isAndroidApp } from '../platform.js';

/** [full, setFull] for the element in `ref`. */
export function useFullScreen(ref) {
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    if (!full) return;
    const el = ref.current;
    let real = false;
    if (!isAndroidApp() && document.fullscreenEnabled && el?.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).then(
        () => (real = true),
        () => {},
      );
    }
    window.desktop?.android?.bars?.(false);
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      setFull(false);
    };
    const onChange = () => real && !document.fullscreenElement && setFull(false);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onChange);
      if (el && document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
      window.desktop?.android?.bars?.(true);
    };
  }, [full]);
  return [full, setFull];
}
