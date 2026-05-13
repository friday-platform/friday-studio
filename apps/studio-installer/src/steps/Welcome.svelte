<script lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { advanceStep, detectInstallState, stopRunningLauncher } from "../lib/installer.ts";
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

// ── Dev-only "install specific version" panel ──────────────────────────────
//
// Five quick clicks on the logo open a panel where a tester can pin an
// explicit studio version (e.g. "0.0.10"). The installer then fetches
// `friday-studio_<version>_<arch>.tar.zst` directly, bypassing the
// production manifest. Fetches the matching `.sha256` sibling so
// checksum verification stays on. State lives in the store (not
// localStorage), so the override evaporates on installer relaunch.
// The DEV banner above the hero makes the override state obvious to
// the tester.
//
// The 5-click pattern keeps the panel hidden from regular users without
// a discoverable keystroke (which would either be in muscle memory or
// hard to remember). Testers learn it once.
const LOGO_CLICK_THRESHOLD = 5;
const LOGO_CLICK_RESET_MS = 1500;

let logoClickCount = $state(0);
let logoClickTimer: ReturnType<typeof setTimeout> | null = null;
let devPanelOpen = $state(false);
let devVersionInput = $state("");
let devError = $state<string | null>(null);
let devApplying = $state(false);

function onLogoClick(): void {
  logoClickCount += 1;
  if (logoClickTimer !== null) clearTimeout(logoClickTimer);
  logoClickTimer = setTimeout(() => {
    logoClickCount = 0;
  }, LOGO_CLICK_RESET_MS);
  if (logoClickCount >= LOGO_CLICK_THRESHOLD) {
    logoClickCount = 0;
    if (logoClickTimer !== null) {
      clearTimeout(logoClickTimer);
      logoClickTimer = null;
    }
    devPanelOpen = true;
    devVersionInput = store.devVersionOverride ?? "";
    devError = null;
  }
}

async function applyDevOverride(): Promise<void> {
  // Permissive normalization — strip a leading "v" but otherwise
  // accept any non-empty string. The manifest URL we synthesize either
  // resolves (200 in GCS) or doesn't (404 → user retries with a
  // different version), so there's no value in client-side semver
  // validation.
  const v = devVersionInput.trim().replace(/^v/i, "");
  devError = null;
  devApplying = true;
  try {
    store.devVersionOverride = v.length > 0 ? v : null;
    // Re-run the install-state detection so `mode` /
    // `availableVersion` reflect the new target before the user
    // clicks Install. Idempotent — same path App.svelte takes on
    // startup.
    await detectInstallState();
    devPanelOpen = false;
  } catch (err) {
    devError = err instanceof Error ? err.message : String(err);
    // Roll back — don't leave the store with an override the user
    // didn't get a chance to confirm via the wizard advancing. This
    // wipes any previously-confirmed override too (e.g. tester had
    // 0.0.10 working, fat-fingers 0.99.99 on the next pass) — null
    // is safer than mid-state and the tester can re-enter. Revisit
    // if this gets painful in practice.
    store.devVersionOverride = null;
  } finally {
    devApplying = false;
  }
}

async function clearDevOverride(): Promise<void> {
  devError = null;
  devApplying = true;
  try {
    store.devVersionOverride = null;
    await detectInstallState();
    devPanelOpen = false;
  } catch (err) {
    devError = err instanceof Error ? err.message : String(err);
  } finally {
    devApplying = false;
  }
}

function cancelDevPanel(): void {
  devPanelOpen = false;
  devError = null;
}

async function openStudio(): Promise<void> {
  // Tauri 2 plugin-opener exports openUrl, not a default `open()`.
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  // studio_ui_url() resolves FRIDAY_PORT_STUDIO_UI from ~/.friday/local/.env
  // — installs with a port override land on the right URL.
  let url = "http://localhost:15200";
  try {
    url = await invoke<string>("studio_ui_url");
  } catch {
    // Fall back to the installer's default port.
  }
  await openUrl(url);
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
  {#if store.devVersionOverride !== null}
    <div class="dev-banner" role="status">
      <span class="dev-banner-tag">DEV</span>
      Installing v{store.devVersionOverride}
    </div>
  {/if}

  <div class="hero">
    <button
      type="button"
      class="logo-button"
      onclick={onLogoClick}
      aria-label="Friday Studio"
      title=""
    >
      <svg class="logo" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
        <path d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z" fill="#1171DF"/>
      </svg>
    </button>

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

  {#if devPanelOpen}
    <div class="dev-overlay" role="dialog" aria-modal="true" aria-labelledby="dev-panel-title">
      <div class="dev-panel">
        <h3 id="dev-panel-title">Install specific version</h3>
        <p class="dev-help">
          Enter a studio version like <code>0.0.10</code>. The installer will
          fetch <code>friday-studio_&lt;version&gt;_aarch64-apple-darwin.tar.zst</code>
          directly, bypassing the production manifest. Checksum verification
          stays on (the matching <code>.sha256</code> sibling is fetched
          alongside the artifact).
        </p>
        <input
          type="text"
          bind:value={devVersionInput}
          placeholder="0.0.10"
          autocomplete="off"
          spellcheck="false"
          disabled={devApplying}
        />
        {#if devError !== null}
          <p class="dev-error">{devError}</p>
        {/if}
        <div class="dev-actions">
          <button type="button" class="secondary" onclick={cancelDevPanel} disabled={devApplying}>
            Cancel
          </button>
          {#if store.devVersionOverride !== null}
            <button type="button" class="secondary" onclick={clearDevOverride} disabled={devApplying}>
              Use production
            </button>
          {/if}
          <button type="button" class="primary" onclick={applyDevOverride} disabled={devApplying}>
            {devApplying ? "Loading…" : "Install this version"}
          </button>
        </div>
      </div>
    </div>
  {/if}
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
  }

  /*
    The logo doubles as a 5-click trigger for the dev-version override
    panel. Wrap it in a button so the click handler is keyboard-accessible
    and screen-reader-labelled, but strip all button styling so the
    visual remains an unadorned mark. `pointer-events: auto` is implicit;
    the cursor stays as default to avoid hinting at the easter egg.
  */
  .logo-button {
    background: none;
    border: none;
    padding: 0;
    margin-bottom: 8px;
    cursor: default;
    appearance: none;
    -webkit-appearance: none;
  }

  .logo-button:focus {
    outline: none;
  }

  .logo-button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 4px;
    border-radius: 8px;
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

  /* Dev banner above the hero — visible reminder that the override is
     active. Yellow strip mirrors the existing `.warning` palette. */
  .dev-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 12px;
    color: var(--color-warning);
    background: rgba(251, 191, 36, 0.12);
    border-bottom: 1px solid rgba(251, 191, 36, 0.3);
    padding: 8px 16px;
    margin: -48px -60px 0;
  }

  .dev-banner-tag {
    background: rgba(251, 191, 36, 0.3);
    color: light-dark(#92400e, #fde68a);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border-radius: 3px;
  }

  /* Dev panel modal — centered overlay over the welcome screen. */
  .dev-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 24px;
  }

  .dev-panel {
    background: var(--color-surface-1, light-dark(#fff, #1a1a1a));
    border: 1px solid var(--color-border-1);
    border-radius: 12px;
    padding: 24px;
    max-width: 460px;
    width: 100%;
    box-shadow: 0 24px 48px rgba(0, 0, 0, 0.3);
  }

  .dev-panel h3 {
    font-size: 16px;
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 8px;
  }

  .dev-help {
    font-size: 12px;
    color: light-dark(#666, #888);
    line-height: 1.5;
    margin-bottom: 14px;
  }

  .dev-help code {
    font-family: monospace;
    font-size: 11px;
    background: var(--color-surface-3);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .dev-panel input {
    width: 100%;
    padding: 9px 12px;
    border: 1px solid var(--color-border-1);
    border-radius: 7px;
    background: var(--color-surface-3);
    color: var(--color-text);
    font-family: monospace;
    font-size: 13px;
    outline: none;
  }

  .dev-panel input:focus {
    border-color: var(--color-primary);
  }

  .dev-error {
    margin-top: 8px;
    font-size: 12px;
    color: var(--color-error);
  }

  .dev-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 16px;
  }

  .dev-actions button {
    padding: 8px 18px;
    font-size: 13px;
  }
</style>
