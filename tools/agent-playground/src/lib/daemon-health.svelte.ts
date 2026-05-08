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

type DaemonHealthState = { connected: boolean; loading: boolean };

// Svelte 5 $state() runes require `let` for reactivity
// deno-lint-ignore prefer-const
let state: DaemonHealthState = $state({ connected: false, loading: true });
let polling = false;
let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: AbortController | null = null;

async function check() {
  if (inFlight) return;
  const controller = new AbortController();
  inFlight = controller;
  const timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const res = await fetch("/api/daemon/health", { signal: controller.signal });
    state.connected = res.ok;
  } catch {
    state.connected = false;
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
