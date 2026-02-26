/**
 * Bot gate — blocks email link scanners from clicking auth confirmation buttons.
 *
 * Gmail (and other providers) run headless browsers that follow magic links,
 * render the page, and click buttons — consuming single-use tokens before the
 * real user arrives. This gate requires two conditions before the button enables:
 *
 * 1. A genuine human interaction event (mousemove, touchstart, keydown, scroll).
 *    Headless browsers don't generate these during automated navigation.
 * 2. A minimum time delay (3s). Link scanners have tight time budgets (~5-10s)
 *    and won't wait long enough for the gate to open.
 *
 * Additionally, `navigator.webdriver` (set by WebDriver/Puppeteer/Playwright)
 * prevents the gate from ever opening.
 */

// Must match botGateMinAge in apps/bounce/service/session.go
const GATE_DELAY_MS = 3_000;

/**
 * Events that indicate genuine human presence. Notably excludes `pointerdown`
 * and `click` because Puppeteer's `page.click()` simulates those in sequence.
 * `mousemove` and `touchstart` require actual cursor/finger movement.
 * `pointerover` covers voice-control tools that emit clicks without mousemove.
 *
 * `focusin` is intentionally excluded — `element.focus()` produces trusted
 * focusin events, making it bypassable with plain JS (no CDP needed).
 */
const INTERACTION_EVENTS = ["mousemove", "pointerover", "touchstart", "keydown", "scroll"] as const;

export function createBotGate() {
  let humanDetected = $state(false);
  let timerDone = $state(false);
  let blocked = $state(false);

  $effect(() => {
    if (navigator.webdriver) {
      blocked = true;
      return;
    }

    const timer = setTimeout(() => {
      timerDone = true;
    }, GATE_DELAY_MS);

    function onInteraction(e: Event) {
      if (!e.isTrusted) return;
      humanDetected = true;
      removeListeners();
    }

    function removeListeners() {
      for (const evt of INTERACTION_EVENTS) {
        document.removeEventListener(evt, onInteraction);
      }
    }

    for (const evt of INTERACTION_EVENTS) {
      document.addEventListener(evt, onInteraction, { passive: true });
    }

    return () => {
      clearTimeout(timer);
      removeListeners();
    };
  });

  return {
    get ready() {
      return humanDetected && timerDone;
    },
    get blocked() {
      return blocked;
    },
  };
}
