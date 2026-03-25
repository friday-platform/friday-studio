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

async function check() {
  try {
    const res = await fetch("/api/daemon/health");
    state.connected = res.ok;
  } catch {
    state.connected = false;
  } finally {
    state.loading = false;
  }
}

/**
 * Begin polling daemon health. Safe to call multiple times — only starts once.
 */
export function startHealthPolling() {
  if (polling) return;
  polling = true;
  check();
  setInterval(check, 5_000);
}

/** Trigger an immediate health check (used by retry buttons). */
export { check as checkDaemonHealth };

/** Reactive daemon health — read `daemonHealth.connected` from any component. */
export const daemonHealth: DaemonHealthState = state;
