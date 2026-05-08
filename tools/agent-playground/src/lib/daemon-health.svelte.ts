/**
 * Reactive daemon health state.
 *
 * Polls the daemon health endpoint every 5 seconds. The reactive `daemonHealth`
 * export drives the sidebar status dot and cockpit disconnected states.
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
let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: AbortController | null = null;
let consecutiveFailures = 0;
let lastSuccessAt = 0;

const HEALTH_TIMEOUT_MS = 4_500;
const CONNECTED_FAILURE_THRESHOLD = 2;
const CONNECTED_FAILURE_GRACE_MS = 12_000;

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

/**
 * Begin polling daemon health. Safe to call multiple times — only starts once.
 * Returns a cleanup callback for HMR/component teardown.
 */
export function startHealthPolling(): () => void {
  if (polling) return stopHealthPolling;
  polling = true;
  void check();
  interval = setInterval(() => void check(), 5_000);
  return stopHealthPolling;
}

export function stopHealthPolling(): void {
  if (interval !== null) {
    clearInterval(interval);
    interval = null;
  }
  polling = false;
  inFlight?.abort();
  inFlight = null;
}

/** Trigger an immediate health check (used by retry buttons). */
export { check as checkDaemonHealth };

/** Reactive daemon health — read `daemonHealth.connected` from any component. */
export const daemonHealth: DaemonHealthState = state;
