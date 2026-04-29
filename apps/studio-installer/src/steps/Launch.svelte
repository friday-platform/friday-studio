<script lang="ts">
import { onMount } from "svelte";
import {
  extendWaitDeadline,
  getPlaygroundService,
  installDir,
  openPlaygroundAndExit,
  runLaunch,
  waitForServices,
} from "../lib/installer.ts";
import { store } from "../lib/store.svelte.ts";

// Spawn the launcher (one-shot) then subscribe to its health stream.
// runLaunch returns immediately after the launcher process has been
// detached; waitForServices runs the wait-healthy step end-to-end and
// drives store.launchStage. The two are intentionally separate calls
// so a launcher-spawn failure shows a different UX than a wait-healthy
// timeout.
onMount(async () => {
  try {
    const dir = await installDir();
    await runLaunch(dir);
  } catch {
    // store.error is set by runLaunch; the early-return template
    // branch below picks it up and shows the spawn-failure state.
    return;
  }
  // The wait command itself never throws — it always emits a
  // terminal HealthEvent (ready/timeout/unreachable/shutting-down)
  // and then resolves. Errors during the SSE roundtrip surface as
  // HealthEvent::Unreachable so the user can still hit View logs.
  await waitForServices();
});

async function onWait60More(): Promise<void> {
  // Push the deadline out by 60s. The Rust side caps at 2 extensions
  // total (so max wait = 90 + 60 + 60 = 210s); on the cap, the helper
  // returns null and the button stays hidden via canExtendDeadline.
  await extendWaitDeadline();
}

async function onOpenLogs(): Promise<void> {
  // Logs live alongside the launcher binary at
  // ~/.friday/local/logs/launcher.log. plugin-opener's openPath
  // hands off to the OS file viewer (Finder / Explorer). We open
  // the log directory rather than the file so the user can see all
  // service logs at once.
  //
  // Permission: opener:allow-open-path with the logs subtree in
  // capabilities/default.json. Without it the call rejects with a
  // permission error instead of opening anything; we surface that
  // error rather than silently swallowing it (the previous catch
  // {} hid this exact bug — user clicked View logs, nothing
  // happened, no clue why).
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    const dir = await installDir();
    await openPath(`${dir}/logs`);
  } catch (err) {
    console.error("openPath failed:", err);
    store.error = `Could not open logs folder: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// "Open anyway" gate: only show when playground is healthy at the
// timeout AND nothing's outright failed. If the user's playground
// is stuck or another service is in failed state the browser would
// hit a daemon that isn't going to recover, so we'd be sending the
// user into a broken UI. Bail-out belongs to Exit instead.
let hasFailedService = $derived.by(() =>
  store.services.some((s) => s.status === "failed"),
);
let canOpenAnyway = $derived.by(() => {
  if (store.launchStage !== "timeout") return false;
  if (hasFailedService) return false;
  const playground = getPlaygroundService();
  return playground?.status === "healthy";
});

// "Wait again" gate: hide once the cap of 2 extensions is reached.
// Pre-cap the button is shown alongside View logs / Open anyway in
// the timeout state.
let canExtendDeadline = $derived(store.waitDeadlineExtensions < 2);

// Sort services alphabetically by their display name. The launcher
// emits whatever order process-compose's status map iterates, which
// is map-iteration-order, which is non-deterministic across runs.
// Without this, users see "Friday daemon" first one boot, "Message
// bus" first the next, etc. Alphabetical by display name keeps the
// list stable: Authentication → Friday daemon → Message bus →
// Studio UI → Terminal → Webhook tunnel.
let sortedServices = $derived(
  [...store.services].sort((a, b) => prettyName(a.name).localeCompare(prettyName(b.name))),
);

async function onExitInstaller(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("exit_installer");
  } catch {
    // ignore — wizard already closing or backend unreachable
  }
}

// Status pip glyph for each service row. Failed renders as ✗ in the
// timeout treatment; pending/starting both render as a spinner so
// the user sees forward motion regardless of which transient state
// the launcher reports.
function statusGlyph(status: string): string {
  if (status === "healthy") return "✓";
  if (status === "failed") return "✗";
  return "•"; // pending / starting — paired with .pip-spinner in CSS
}

function statusClass(status: string): string {
  if (status === "healthy") return "pip pip-healthy";
  if (status === "failed") return "pip pip-failed";
  return "pip pip-spinner";
}

// Pretty service name. The launcher reports "nats-server", "friday",
// "link", "pty-server", "webhook-tunnel", "playground" — we display
// each with a friendlier label so the user doesn't have to map raw
// process names to product surfaces.
function prettyName(name: string): string {
  switch (name) {
    case "nats-server":
      return "Message bus";
    case "friday":
      return "Friday daemon";
    case "link":
      return "Authentication";
    case "pty-server":
      return "Terminal";
    case "webhook-tunnel":
      return "Webhook tunnel";
    case "playground":
      return "Studio UI";
    default:
      return name;
  }
}
</script>

<div class="screen">
  <div class="content">
    {#if store.error !== null}
      <!-- Launcher spawn failed (runLaunch threw). Distinct from
           wait-healthy errors which surface via launchStage. -->
      <div class="error-state">
        <div class="error-icon" aria-hidden="true">✕</div>
        <h2>Could not start Studio</h2>
        <p class="error-detail">{store.error}</p>
        <div class="actions">
          <button class="secondary" onclick={onOpenLogs}>View logs</button>
        </div>
      </div>
    {:else if store.launchStage === "ready"}
      <div class="success-state">
        <div class="check-icon" aria-hidden="true">✓</div>
        <h2>Friday Studio is ready</h2>
        <p class="subtitle">
          All services are healthy. Click below to open Friday Studio.
        </p>
        {#each sortedServices as svc (svc.name)}
          <div class="row">
            <span class={statusClass(svc.status)} aria-hidden="true"
              >{statusGlyph(svc.status)}</span
            >
            <span class="row-name">{prettyName(svc.name)}</span>
          </div>
        {/each}
        <button class="primary" onclick={openPlaygroundAndExit}
          >Open in Browser</button
        >
      </div>
    {:else if store.launchStage === "unreachable"}
      <div class="error-state">
        <div class="error-icon" aria-hidden="true">✕</div>
        <h2>Could not connect to Studio launcher</h2>
        <p class="error-detail">
          {store.launchUnreachableReason ?? "Launcher did not start in time."}
        </p>
        <div class="actions">
          <button class="secondary" onclick={onOpenLogs}>View logs</button>
        </div>
      </div>
    {:else if store.launchStage === "shutting-down"}
      <div class="error-state">
        <div class="error-icon" aria-hidden="true">⏻</div>
        <h2>Studio is shutting down</h2>
        <p class="subtitle">
          The launcher reported a shutdown in progress. Close this wizard and
          try again once shutdown completes.
        </p>
      </div>
    {:else if store.launchStage === "timeout"}
      <div class="timeout-state">
        <h2>Some services are still starting</h2>
        <p class="subtitle">
          {#if store.stuckServices.length > 0}
            Waiting on: {store.stuckServices
              .map((n) => prettyName(n))
              .join(", ")}.
          {:else}
            Friday Studio's services are taking longer than expected to
            become ready.
          {/if}
        </p>
        {#each sortedServices as svc (svc.name)}
          <div class="row">
            <span class={statusClass(svc.status)} aria-hidden="true"
              >{statusGlyph(svc.status)}</span
            >
            <span class="row-name">{prettyName(svc.name)}</span>
          </div>
        {/each}
        <div class="actions">
          <button class="secondary" onclick={onOpenLogs}>View logs</button>
          {#if hasFailedService}
            <!--
              At least one supervised process is in a failed state
              (a real "✗", not just "starting…"). Opening the
              playground would hit a daemon that isn't going to
              recover; offering "Open anyway" would just send the
              user into a broken UI. Show Exit instead so they can
              close the wizard, fix the underlying error (usually
              a missing API key), and try again.
            -->
            <button class="primary" onclick={onExitInstaller}>Exit</button>
          {:else if canOpenAnyway}
            <button class="primary" onclick={openPlaygroundAndExit}
              >Open anyway</button
            >
          {/if}
          {#if canExtendDeadline}
            <button class="secondary" onclick={onWait60More}
              >Wait 60s more</button
            >
          {/if}
        </div>
      </div>
    {:else if store.launchStage === "long-wait"}
      <div class="launching-state">
        <div class="spinner" aria-label="Starting Studio"></div>
        <h2>Still starting up…</h2>
        <p class="subtitle">
          This is taking longer than usual — services are still booting.
        </p>
        {#each sortedServices as svc (svc.name)}
          <div class="row">
            <span class={statusClass(svc.status)} aria-hidden="true"
              >{statusGlyph(svc.status)}</span
            >
            <span class="row-name">{prettyName(svc.name)}</span>
          </div>
        {/each}
        {#if canExtendDeadline}
          <div class="actions">
            <button class="secondary" onclick={onWait60More}
              >Wait 60s more</button
            >
          </div>
        {/if}
      </div>
    {:else if store.launchStage === "connecting" || store.launchStage === "idle"}
      <div class="launching-state">
        <div class="spinner" aria-label="Starting Studio"></div>
        <h2>Starting Friday Studio…</h2>
        <p class="subtitle">
          Connecting to the launcher.
        </p>
      </div>
    {:else}
      <!-- launchStage === "waiting": SSE is live, render the live
           checklist. Each row pip is driven by the snapshot the
           launcher emits per state-change tick. -->
      <div class="launching-state">
        <div class="spinner" aria-label="Starting Studio"></div>
        <h2>Starting Friday Studio…</h2>
        <p class="subtitle">Waiting for services to report healthy.</p>
        {#each sortedServices as svc (svc.name)}
          <div class="row">
            <span class={statusClass(svc.status)} aria-hidden="true"
              >{statusGlyph(svc.status)}</span
            >
            <span class="row-name">{prettyName(svc.name)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100%;
    align-items: center;
    justify-content: center;
  }

  .content {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 16px;
    padding: 48px;
    max-width: 480px;
  }

  h2 {
    font-size: 22px;
    font-weight: 700;
    color: light-dark(#1a1a1a, #f0f0f0);
  }

  .subtitle {
    font-size: 14px;
    color: light-dark(#555, #888);
    max-width: 380px;
    line-height: 1.5;
  }

  /* Spinner ring contrast: in light mode the ring needs to be a
     darker grey than the background so the spin is visible; in
     dark mode the ring is the dark grey behind the bright top-color. */
  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid light-dark(#e0e0e0, #1e1e1e);
    border-top-color: #6b72f0;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .check-icon,
  .error-icon {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    font-size: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .check-icon {
    background: rgba(52, 211, 153, 0.15);
    color: #34d399;
  }

  .error-icon {
    background: rgba(248, 113, 113, 0.15);
    color: #f87171;
  }

  .launching-state,
  .success-state,
  .error-state,
  .timeout-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    width: 100%;
  }

  .timeout-state h2 {
    color: #fbbf24;
  }

  .error-state h2 {
    color: #f87171;
  }

  .error-detail {
    font-size: 13px;
    color: light-dark(#555, #888);
    max-width: 380px;
    word-break: break-word;
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.15);
    border-radius: 8px;
    padding: 12px 16px;
  }

  /* Per-service checklist row. Pip on the left, pretty name centered. */
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: light-dark(#333, #ccc);
    padding: 4px 12px;
    width: 100%;
    max-width: 320px;
    text-align: left;
  }

  .row-name {
    flex: 1;
  }

  .pip {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
  }

  .pip-healthy {
    background: rgba(52, 211, 153, 0.15);
    color: #34d399;
  }

  .pip-failed {
    background: rgba(248, 113, 113, 0.15);
    color: #f87171;
  }

  .pip-spinner {
    background: rgba(107, 114, 240, 0.15);
    color: #6b72f0;
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.6;
    }
    50% {
      opacity: 1;
    }
  }

  .actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: 8px;
  }

  button {
    padding: 10px 28px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .primary {
    background: #6b72f0;
    color: #fff;
  }

  .primary:hover {
    background: #5a62e0;
  }

  .secondary {
    background: #1e1e1e;
    color: #ccc;
    border: 1px solid #2e2e2e;
  }

  .secondary:hover {
    background: #252525;
  }
</style>
