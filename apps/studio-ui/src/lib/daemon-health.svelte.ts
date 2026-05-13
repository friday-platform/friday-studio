/**
 * Reactive daemon health state.
 *
 * Polls the daemon health endpoint on an adaptive cadence: 5s while we
 * have no confirmed connection (or are inside the disconnect-grace
 * window after probe failures), 30s once steady-connected. The reactive
 * `daemonHealth` export drives the sidebar status dot and cockpit
 * disconnected states.
 *
 * Call `startHealthPolling()` once from the root layout to begin polling.
 *
 * @module
 */

type DaemonHealthState = { connected: boolean; hasConnected: boolean; loading: boolean };

// Svelte 5 $state() runes require `let` for reactivity
// deno-lint-ignore prefer-const
let state: DaemonHealthState = $state({ connected: false, hasConnected: false, loading: true });
let polling = false;
let scheduled: ReturnType<typeof setTimeout> | null = null;
let inFlight: AbortController | null = null;
let consecutiveFailures = 0;
let lastSuccessAt = 0;

const HEALTH_TIMEOUT_MS = 4_500;
const CONNECTED_FAILURE_THRESHOLD = 2;
const CONNECTED_FAILURE_GRACE_MS = 12_000;
// Adaptive cadence: probe aggressively only while we're unsure or
// in the disconnect-grace window. Once connected and steady, back off
// to once per 30s — the daemon is a local process, not a network
// service; the failure modes are "daemon crashed / restarted" not
// "transient network blip", and a 30s detection lag is fine for that
// case. The previous flat 5s cadence cost 6x as many fetches per
// minute for no signal change once the daemon was up.
const HEALTHY_POLL_MS = 30_000;
const UNHEALTHY_POLL_MS = 5_000;

function recordHealthSuccess() {
  consecutiveFailures = 0;
  lastSuccessAt = Date.now();
  state.connected = true;
  state.hasConnected = true;
}

function recordHealthFailure() {
  consecutiveFailures++;

  // When chat/tool actions open long-lived streams, browser/dev-server
  // connection pools can delay one health probe even though the daemon is
  // still serving requests. Avoid flashing the full-page daemon gate for a
  // single transient probe miss; only mark an already-connected daemon down
  // after repeated failures across a short grace window.
  if (state.connected && consecutiveFailures < CONNECTED_FAILURE_THRESHOLD) return;
  if (state.connected && Date.now() - lastSuccessAt < CONNECTED_FAILURE_GRACE_MS) return;

  state.connected = false;
}

async function check() {
  if (inFlight) return;
  const controller = new AbortController();
  inFlight = controller;
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch("/api/daemon/health", { signal: controller.signal });
    if (res.ok) recordHealthSuccess();
    else recordHealthFailure();
  } catch {
    recordHealthFailure();
  } finally {
    clearTimeout(timeout);
    if (inFlight === controller) inFlight = null;
    state.loading = false;
  }
}

function scheduleNext(): void {
  if (!polling) return;
  const delay = state.connected && consecutiveFailures === 0 ? HEALTHY_POLL_MS : UNHEALTHY_POLL_MS;
  scheduled = setTimeout(tick, delay);
}

async function tick(): Promise<void> {
  scheduled = null;
  // Skip the probe while the tab is hidden — a backgrounded playground
  // has nothing to display anyway, and Chrome throttles network in
  // hidden tabs hard enough that a probe is more likely to time out
  // than report ground truth. We re-arm immediately so a quick toggle
  // back to visible still gets a probe at the next scheduled tick.
  if (typeof document !== "undefined" && document.visibilityState !== "visible") {
    scheduleNext();
    return;
  }
  try {
    await check();
  } finally {
    scheduleNext();
  }
}

/**
 * Begin polling daemon health. Safe to call multiple times — only starts once.
 * Returns a cleanup callback for HMR/component teardown.
 */
export function startHealthPolling(): () => void {
  if (polling) return stopHealthPolling;
  polling = true;
  void tick();
  return stopHealthPolling;
}

export function stopHealthPolling(): void {
  if (scheduled !== null) {
    clearTimeout(scheduled);
    scheduled = null;
  }
  polling = false;
  inFlight?.abort();
  inFlight = null;
}

/** Trigger an immediate health check (used by retry buttons). */
export { check as checkDaemonHealth };

/** Reactive daemon health — read `daemonHealth.connected` from any component. */
export const daemonHealth: DaemonHealthState = state;
