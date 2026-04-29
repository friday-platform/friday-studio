<script lang="ts">
import { advanceStep, stopRunningLauncher } from "../lib/installer.ts";
import { type InstallMode, store } from "../lib/store.svelte.ts";

interface Props {
  mode: InstallMode;
  installedVersion: string | null;
  availableVersion: string;
  studioRunning: boolean;
}

const { mode, installedVersion, availableVersion, studioRunning }: Props = $props();

let stopping = $state(false);
let stopError = $state<string | null>(null);

async function openStudio(): Promise<void> {
  // Tauri 2 plugin-opener exports openUrl, not a default `open()`.
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl("http://localhost:5200");
}

// Update / re-install path: if the previous launcher is still
// running we need to shut it down before download + extract +
// launch, otherwise:
//   - the new launcher's port 5199 bind will collide and surface
//     the port-in-use dialog
//   - extract may fail to overwrite a running binary on Windows
//
// We do this BEFORE download (not before launch) so the user isn't
// waiting through a 500MB tarball just to find out we couldn't free
// the port. The "Friday Studio is currently running" warning above
// the button is the consent — by clicking the button the user has
// already opted in.
//
// `forceFullInstall` forces the wizard into the download path even
// when mode === "current" (the user clicked "Reinstall" — they want
// a full re-run, not the relaunch-existing-install shortcut that
// advanceStep("welcome") routes to). For mode === "update" /
// "fresh", advanceStep already routes through download, so we leave
// the default behaviour alone.
async function stopThenAdvance(forceFullInstall = false): Promise<void> {
  stopError = null;
  if (studioRunning) {
    stopping = true;
    try {
      await stopRunningLauncher();
    } catch (err) {
      stopError = err instanceof Error ? err.message : String(err);
      stopping = false;
      return;
    }
    stopping = false;
  }
  if (forceFullInstall) {
    // Skip welcome's "current → launch" shortcut; go straight to
    // download. License/API keys are already on disk from the
    // previous install, so we follow the update-flow elision and
    // skip them too.
    store.step = "download";
  } else {
    advanceStep();
  }
}

function reinstall(): void {
  // mode === "current" + studio NOT running: nothing to stop, just
  // jump into the download flow. Same shortcut as stopThenAdvance's
  // forceFullInstall branch, without the stop-launcher detour.
  store.step = "download";
}
</script>

<div class="screen">
  <div class="hero">
    <svg class="logo" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
      <path d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z" fill="#1171DF"/>
    </svg>

    {#if mode === "fresh"}
      <h1>Welcome to Friday Studio</h1>
      <p class="subtitle">
        Orchestrate agentic workflows from a single config file.<br />Versionable, shareable, repeatable.
      </p>
      {#if studioRunning}
        <!--
          studioRunning + mode==="fresh" means the install marker
          (~/.friday/local/.installed) is missing while a launcher
          is alive — typically a previous install from before the
          marker was written, or the file was wiped. Treat this the
          same as the update path so we don't blunder into a port
          collision later. Same warning, same stop button.
        -->
        <div class="warning">
          <span class="warning-icon" aria-hidden="true">⚠</span>
          A previous Friday Studio is currently running. Installing will stop it briefly.
        </div>
        {#if stopError !== null}
          <div class="warning">
            <span class="warning-icon" aria-hidden="true">⚠</span>
            Could not stop the running Studio: {stopError}
          </div>
        {/if}
        <div class="actions">
          <button class="primary" onclick={stopThenAdvance} disabled={stopping}>
            {stopping ? "Stopping Studio…" : "Install"}
          </button>
        </div>
      {:else}
        <div class="actions">
          <button class="primary" onclick={advanceStep}>Install</button>
        </div>
      {/if}
    {:else if mode === "update"}
      <h1>Update Available</h1>
      <p class="version-badge">
        v{installedVersion} → v{availableVersion}
      </p>
      {#if studioRunning}
        <div class="warning">
          <span class="warning-icon" aria-hidden="true">⚠</span>
          Friday Studio is currently running. The update will stop it briefly.
        </div>
        {#if stopError !== null}
          <div class="warning">
            <span class="warning-icon" aria-hidden="true">⚠</span>
            Could not stop the running Studio: {stopError}
          </div>
        {/if}
        <div class="actions">
          <button class="primary" onclick={stopThenAdvance} disabled={stopping}>
            {stopping ? "Stopping Studio…" : "Update Studio"}
          </button>
          <button class="secondary" onclick={openStudio} disabled={stopping}>
            Open Studio
          </button>
        </div>
      {:else}
        <p class="subtitle">
          A new version of Friday Studio is ready to install.
        </p>
        <div class="actions">
          <button class="primary" onclick={advanceStep}>Update Studio</button>
        </div>
      {/if}
    {:else if mode === "current"}
      <h1>You're up to date</h1>
      <p class="version-badge">v{installedVersion ?? availableVersion}</p>
      <p class="subtitle">Friday Studio is already at the latest version.</p>
      {#if studioRunning}
        <div class="warning">
          <span class="warning-icon" aria-hidden="true">⚠</span>
          Friday Studio is currently running. Reinstalling will stop it briefly.
        </div>
        {#if stopError !== null}
          <div class="warning">
            <span class="warning-icon" aria-hidden="true">⚠</span>
            Could not stop the running Studio: {stopError}
          </div>
        {/if}
        <div class="actions">
          <!--
            Both buttons remain available even when the version is
            current. Reinstall is the primary path because that's what
            most people opening an installer.dmg actually want to do
            ("I'm running the installer, install something"). Open
            Studio stays as the no-op shortcut for users who only
            wanted to relaunch from a fresh window.
          -->
          <button
            class="primary"
            onclick={() => stopThenAdvance(true)}
            disabled={stopping}
          >
            {stopping ? "Stopping Studio…" : "Reinstall"}
          </button>
          <button class="secondary" onclick={openStudio} disabled={stopping}>
            Open Studio
          </button>
        </div>
      {:else}
        <div class="actions">
          <button class="primary" onclick={reinstall}>Reinstall</button>
          <button class="secondary" onclick={advanceStep}>Launch Studio</button>
        </div>
      {/if}
    {/if}
  </div>

  <div class="step-dots" aria-hidden="true">
    <span class="dot active"></span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
    <span class="dot"></span>
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 48px 60px 40px;
  }

  .hero {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 14px;
  }

  .logo {
    width: 52px;
    height: 52px;
    margin-bottom: 8px;
  }

  h1 {
    font-size: 26px;
    font-weight: 700;
    color: light-dark(#111, #f0f0f0);
    letter-spacing: -0.5px;
  }

  .subtitle {
    font-size: 14px;
    color: light-dark(#666, #888);
    max-width: 380px;
    line-height: 1.6;
    text-align: center;
  }

  .version-badge {
    font-size: 13px;
    color: var(--color-primary);
    background: rgba(107, 114, 240, 0.12);
    padding: 4px 12px;
    border-radius: 20px;
    font-family: monospace;
  }

  .warning {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--color-warning);
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.25);
    border-radius: 8px;
    padding: 10px 16px;
    max-width: 380px;
  }

  .warning-icon {
    font-size: 16px;
    flex-shrink: 0;
  }

  .actions {
    display: flex;
    gap: 12px;
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
    background: var(--color-primary);
    color: var(--color-primary-text);
  }

  .primary:hover {
    background: var(--color-primary); opacity: 0.9;
  }

  .secondary {
    background: var(--color-surface-3);
    color: var(--color-text);
    border: 1px solid var(--color-border-1);
  }

  .secondary:hover {
    opacity: 0.85;
  }

  .step-dots {
    display: flex;
    justify-content: center;
    gap: 6px;
    padding-top: 16px;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: light-dark(#ccc, #333);
  }

  .dot.active {
    background: var(--color-primary);
  }
</style>
