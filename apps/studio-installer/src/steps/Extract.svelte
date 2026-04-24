<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../lib/store.svelte.ts";
  import { runExtract, advanceStep } from "../lib/installer.ts";
  import { type } from "@tauri-apps/plugin-os"; // used for install dest path

  let extracting = $state(true);

  onMount(async () => {
    const osType = type();
    const src = store.downloadPath;

    const dest =
      osType === "macos"
        ? "/Applications/"
        : `${globalThis.location?.href ?? ""}`.includes("win")
          ? "%LOCALAPPDATA%\\Programs\\"
          : "/usr/local/";

    try {
      await runExtract(src, dest);
      extracting = false;
      advanceStep();
    } catch {
      extracting = false;
      // store.error is already set by runExtract
    }
  });
</script>

<div class="screen">
  <div class="content">
    {#if store.error !== null}
      <div class="error-state">
        <div class="error-icon" aria-hidden="true">✕</div>
        <h2>Installation failed</h2>
        <p class="error-detail">{store.error}</p>
        <p class="error-hint">
          The previous installation has been restored if it existed.
        </p>
      </div>
    {:else if extracting}
      <div class="extracting-state">
        <div class="spinner" aria-label="Installing"></div>
        <h2>Installing…</h2>
        <p class="subtitle">Extracting Friday Studio files. This may take a moment.</p>
      </div>
    {:else}
      <div class="success-state">
        <div class="check-icon" aria-hidden="true">✓</div>
        <h2>Installation complete</h2>
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
  }

  h2 {
    font-size: 22px;
    font-weight: 700;
    color: #f0f0f0;
  }

  .subtitle {
    font-size: 14px;
    color: #777;
    max-width: 340px;
    line-height: 1.5;
  }

  .spinner {
    width: 48px;
    height: 48px;
    border: 4px solid #1e1e1e;
    border-top-color: #6b72f0;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .check-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(52, 211, 153, 0.15);
    color: #34d399;
    font-size: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .error-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(248, 113, 113, 0.15);
    color: #f87171;
    font-size: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .error-state h2 {
    color: #f87171;
  }

  .error-detail {
    font-size: 13px;
    color: #888;
    max-width: 380px;
    word-break: break-word;
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.15);
    border-radius: 8px;
    padding: 12px 16px;
  }

  .error-hint {
    font-size: 12px;
    color: #555;
  }

  .extracting-state,
  .success-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }
</style>
