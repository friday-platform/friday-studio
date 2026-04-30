<script lang="ts">
import { onMount, tick } from "svelte";
import {
  advanceStep,
  currentPlatform,
  fetchManifest,
  retryDownload,
  startDownload,
  verifyDownload,
} from "../lib/installer.ts";
import { store } from "../lib/store.svelte.ts";

// Phase the wizard moves through so the body text matches the actual work
// happening. Without explicit phases the user saw "99% ETA 0s" linger for
// 10s+ while SHA verify ran, with no indication that download had finished
// and we'd moved on to checksum.
type Phase = "downloading" | "verifying" | "verified";

let platform = $state("");
let downloadUrl = $state("");
let sha256 = $state("");
let resolveError = $state<string | null>(null);
let phase = $state<Phase>("downloading");

onMount(async () => {
  try {
    // current_platform() returns the manifest key matching the binary's
    // compile target ("macos-arm" / "macos-intel" / "windows") — must agree
    // with the keys studio-build.yml emits, otherwise the wizard pulls
    // binaries for the wrong arch.
    platform = await currentPlatform();
    if (platform === "unsupported") {
      resolveError = "This OS/architecture is not supported by Friday Studio.";
      return;
    }

    const manifest = await fetchManifest();
    const entry = manifest.platforms[platform];
    if (!entry) {
      resolveError = `No download available for platform: ${platform}`;
      return;
    }
    downloadUrl = entry.url;
    sha256 = entry.sha256;
    store.totalBytes = entry.size;

    await startDownload(downloadUrl, sha256, platform);
    if (store.downloadError !== null) return;

    // SHA-256 verification before extract — refuse to advance on mismatch.
    // Without this a corrupted or tampered archive would be unpacked silently
    // and break in confusing ways at first launch.
    //
    // `await tick()` between the phase flip and the verify call forces
    // Svelte to commit the "Verifying download integrity…" subtitle
    // BEFORE the synchronous prelude of invoke() blocks the JS event
    // loop. Without it, on fast machines the verify call resolves so
    // quickly that the verifying-state subtitle never paints — the
    // user sees the downloading subtitle linger and then jumps
    // straight to extract with no verify feedback (Decision #6
    // companion: "subtitle flip-order fix").
    phase = "verifying";
    await tick();
    const ok = await verifyDownload(store.downloadPath, sha256);
    if (!ok) {
      store.downloadError = "Downloaded file is corrupted (checksum mismatch). Please try again.";
      return;
    }

    phase = "verified";
    // Hand off to extract only after verify passes — otherwise the user
    // saw the wizard advance the moment progress hit 100%, with verify
    // racing in the background against extract.
    advanceStep();
  } catch (err) {
    store.downloadError = err instanceof Error ? err.message : String(err);
  }
});

async function handleRetry() {
  resolveError = null;
  phase = "downloading";
  await retryDownload();
}

function friendlyError(msg: string | null): string {
  if (!msg) return "";
  return msg
    .replace(/^Download failed after \d+ attempts:\s*/, "")
    .replace(/^HTTP request failed:\s*/, "")
    .replace(/^builder error$/, "Could not connect to the download server.");
}
</script>

<div class="screen">
  <div class="header">
    <h2>Downloading Friday Studio</h2>
    <p class="subtitle">
      {#if store.downloadError !== null || resolveError !== null}
        Download failed. Check your connection and try again.
      {:else if phase === "verifying"}
        Verifying download integrity…
      {:else if phase === "verified"}
        Download verified.
      {:else if store.availableVersion}
        Downloading version {store.availableVersion}…
      {:else}
        Resolving latest version…
      {/if}
    </p>
  </div>

  <div class="body">
    {#if resolveError !== null}
      <div class="error-box">
        <p class="error-title">Could not resolve download</p>
        <p class="error-detail">{resolveError}</p>
      </div>
    {:else if store.downloadError !== null}
      <div class="error-box">
        <p class="error-title">Download failed</p>
        <p class="error-detail">{friendlyError(store.downloadError)}</p>
      </div>
    {:else}
      {@const displayPercent = phase === "downloading" ? store.progressPercent : 100}
      <div class="progress-container" role="progressbar" aria-valuenow={displayPercent} aria-valuemin={0} aria-valuemax={100}>
        <div class="progress-bar" style:width="{displayPercent}%"></div>
      </div>

      {#if phase !== "downloading"}
        <div class="stats">
          <span class="percent">{phase === "verifying" ? "Verifying checksum…" : "Verified ✓"}</span>
        </div>
      {:else if store.isRetrying}
        <div class="retry-banner">
          <span class="retry-label">Attempt {store.retryAttempt} of {store.retryMax} failed — retrying in {store.retryDelaySecs}s</span>
        </div>
      {:else}
        <div class="stats">
          <span class="percent">{store.progressPercent}%</span>
          <span class="separator">·</span>
          <span class="speed">{store.speedStr}</span>
          <span class="separator">·</span>
          <span class="eta">ETA {store.etaStr}</span>
        </div>
      {/if}
    {/if}
  </div>

  <div class="footer">
    {#if store.downloadError !== null || resolveError !== null}
      <button class="primary" onclick={handleRetry}>Try Again</button>
    {/if}
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 48px 60px 32px;
    gap: 32px;
  }

  h2 {
    font-size: 20px;
    font-weight: 700;
    color: var(--color-text);
    margin-bottom: 6px;
  }

  .subtitle {
    font-size: 13px;
    color: var(--color-text-muted);
  }

  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 16px;
  }

  .progress-container {
    background: var(--color-surface-3);
    border-radius: 8px;
    height: 10px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #6b72f0, #9b74f8);
    border-radius: 8px;
    transition: width 0.3s ease;
  }

  .stats {
    display: flex;
    gap: 10px;
    font-size: 13px;
    color: var(--color-text-muted);
    align-items: center;
  }

  .percent {
    color: var(--color-text);
    font-weight: 500;
  }

  .separator {
    color: var(--color-border-1);
  }

  .retry-banner {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .retry-label {
    font-size: 13px;
    color: var(--color-warning);
  }

  .error-box {
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.2);
    border-radius: 10px;
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .error-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-error);
  }

  .error-detail {
    font-size: 12px;
    color: var(--color-text-muted);
    word-break: break-word;
  }

  .footer {
    min-height: 44px;
    display: flex;
    align-items: center;
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
</style>
