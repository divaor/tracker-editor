import { html, useEffect, useRef, useState } from '../../vendor/preact-htm.js';
import { isAndroidApp } from '../platform.js';
import { getSettings, saveSettings } from '../settings.js';
import { toast } from './components.js';
import { Icon } from './icons.js';

// The comparisons' and two panes' phone layouts (a phone held upright), and turning the phone
// sideways for them: two folders side by side fit then.

/** Narrow enough for the phone layouts: one text, one tree, one pane at a time. */
export const PHONE = '(max-width: 640px)';

/** Whether a media query matches, following it as it changes. */
export function useMedia(query) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

// A touch screen (some emulators' WebViews say their pointer is fine: the Android app is touch).
const touchScreen = () => isAndroidApp() || matchMedia('(pointer: coarse)').matches;
// A phone (or a small tablet): touch, and a short side a phone's. The window's size, in CSS
// pixels everywhere: older Android WebViews give `screen.width` in the device's own pixels.
const phoneScreen = () => touchScreen() && Math.min(innerWidth, innerHeight) <= 640;
// The device turned sideways (not the window's shape, which the keyboard changes too).
const deviceSideways = () => touchScreen() && Boolean(globalThis.screen?.orientation?.type?.startsWith('landscape'));

/** Whether the phone (or tablet) is turned sideways, following it as it turns. */
export function useSideways() {
  const [sideways, setSideways] = useState(deviceSideways);
  useEffect(() => {
    const onChange = () => setSideways(deviceSideways());
    onChange();
    screen.orientation?.addEventListener?.('change', onChange);
    addEventListener('resize', onChange);
    return () => {
      screen.orientation?.removeEventListener?.('change', onChange);
      removeEventListener('resize', onChange);
    };
  }, []);
  return sideways;
}

/** The phone layouts: a narrow window, unless the phone is turned sideways (both sides then). */
export function usePhoneLayout() {
  const narrow = useMedia(PHONE);
  const sideways = useSideways();
  return narrow && !sideways;
}

/**
 * Turns the app sideways (`on`) or lets it follow the phone again. The Android app asks Android
 * for landscape; a browser can only lock the orientation in full screen, so it goes full screen
 * first. Resolves whether it could.
 */
export async function turnSideways(on) {
  const android = window.desktop?.android;
  if (android?.sideways) {
    await android.sideways(on);
    return true;
  }
  try {
    if (on) {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
      await screen.orientation.lock('landscape');
    } else {
      screen.orientation?.unlock?.();
      if (document.fullscreenElement) await document.exitFullscreen();
    }
    return true;
  } catch {
    if (on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    return false;
  }
}

/**
 * "Turn sideways" in a folder comparison's or two panes' bar, on a phone held upright: the app
 * turns to landscape while the tab shows (back to the phone's own way when it goes), and does
 * so by itself next time (setting `compareSideways`) until "Upright again".
 */
// A tab turned sideways that just went (a folder comparison turning into two panes, another
// comparison tab picked): upright again a moment later, unless the next tab keeps it sideways.
let goingUpright = null;

export function SidewaysButton() {
  const portrait = !useSideways();
  const [on, setOn] = useState(false);
  const onRef = useRef(false);
  const phone = phoneScreen();
  // `asked`: pressed (remembered, and a toast when it cannot); else by itself, quietly.
  const turn = async (want, asked = true) => {
    const ok = await turnSideways(want);
    if (!ok) {
      if (want && asked) toast('Turn your phone sideways: both sides fit then.');
      return;
    }
    onRef.current = want;
    setOn(want);
    if (asked) saveSettings({ compareSideways: want });
  };
  useEffect(() => {
    if (goingUpright) {
      clearTimeout(goingUpright);
      goingUpright = null;
      onRef.current = true;
      setOn(true);
    } else if (phone && portrait && getSettings().compareSideways) turn(true, false);
    // Leaving the tab: the phone's own way again.
    return () => {
      if (!onRef.current) return;
      goingUpright = setTimeout(() => {
        goingUpright = null;
        turnSideways(false);
      }, 400);
    };
  }, []);
  if (!phone || (!on && !portrait)) return null;
  return html`<button type="button" class="btn ghost sm sideways-btn ${on ? 'on' : ''}" aria-pressed=${on}
    title=${on ? 'Back to the phone’s own way round (and not sideways by itself next time)' : 'Turn the app sideways while this tab shows: both sides fit (and next time by itself)'}
    onClick=${() => turn(!on)}><${Icon} name="rotate" size=${15} /><span class="label">${on ? 'Upright' : 'Sideways'}</span></button>`;
}
