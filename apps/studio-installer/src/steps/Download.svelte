<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/store.svelte.ts";
  import {
    startDownload,
    retryDownload,
    advanceStep,
    fetchManifest,
  } from "../lib/installer.ts";
  import { type } from "@tauri-apps/plugin-os";

  let platform = $state("");
  let downloadUrl = $state("");
  let sha256 = $state("");
  let resolveError = $state<string | null>(null);

  onMount(async () => {
    try {
      const osType = type();
      platform =
        osType === "macos" ? "macos" : osType === "windows" ? "windows" : osType;

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
    } catch (err) {
      store.downloadError = err instanceof Error ? err.message : String(err);
    }
  });

  async function handleRetry() {
    resolveError = null;
    await retryDownload();
  }

  function friendlyError(msg: string | null): string {
    if (!msg) return "";
    return msg
      .replace(/^Download failed after \d+ attempts:\s*/, "")
      .replace(/^HTTP request failed:\s*/, "")
      .replace(/^builder error$/, "Could not connect to the download server.");
  }

  // Auto-advance when download completes successfully
  $effect(() => {
    if (store.progressPercent === 100 && store.downloadError === null) {
      advanceStep();
    }
  });
</script>

<div class="screen">
  <div class="header">
    <h2>Downloading Friday Studio</h2>
    <p class="subtitle">
      {#if store.downloadError !== null || resolveError !== null}
        Download failed. Check your connection and try again.
      {:else if store.progressPercent === 100}
        Download complete!
      {:else}
        Downloading the latest version…
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
      <div class="progress-container" role="progressbar" aria-valuenow={store.progressPercent} aria-valuemin={0} aria-valuemax={100}>
        <div class="progress-bar" style:width="{store.progressPercent}%"></div>
      </div>

      {#if store.isRetrying}
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
    color: #f0f0f0;
    margin-bottom: 6px;
  }

  .subtitle {
    font-size: 13px;
    color: #777;
  }

  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 16px;
  }

  .progress-container {
    background: #1e1e1e;
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
    color: #666;
    align-items: center;
  }

  .percent {
    color: #aaa;
    font-weight: 500;
  }

  .separator {
    color: #333;
  }

  .retry-banner {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .retry-label {
    font-size: 13px;
    color: #f0a857;
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
    color: #f87171;
  }

  .error-detail {
    font-size: 12px;
    color: #888;
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
    background: #6b72f0;
    color: #fff;
  }

  .primary:hover {
    background: #5a62e0;
  }
</style>
