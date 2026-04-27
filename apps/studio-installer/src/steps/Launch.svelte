<script lang="ts">
import { onMount } from "svelte";
import { store } from "../lib/store.svelte.ts";
import { runLaunch, installDir } from "../lib/installer.ts";

let launching = $state(true);
let launched = $state(false);

onMount(async () => {
  try {
    // installDir() resolves to ~/.friday/local on every supported platform —
    // that's where Extract.svelte just unpacked the binaries.
    const dir = await installDir();
    await runLaunch(dir);
    launching = false;
    launched = true;
  } catch {
    launching = false;
    // store.error is set by runLaunch
  }
});

async function openStudio(): Promise<void> {
  // Tauri 2 plugin-opener exports openUrl, not a default-export
  // `open()` method. The previous `opener.open(...)` call was
  // resolving to `undefined` and silently no-op'ing.
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl("http://localhost:5200");
}
</script>

<div class="screen">
  <div class="content">
    {#if store.error !== null}
      <div class="error-state">
        <div class="error-icon" aria-hidden="true">✕</div>
        <h2>Could not start Studio</h2>
        <p class="error-detail">{store.error}</p>
        <button class="primary" onclick={openStudio}>Try Opening Browser</button>
      </div>
    {:else if launched}
      <div class="success-state">
        <div class="check-icon" aria-hidden="true">✓</div>
        <h2>Studio is open in your browser!</h2>
        <p class="subtitle">
          Friday Studio is running at
          <a href="http://localhost:5200" target="_blank" rel="noreferrer"
            >localhost:5200</a
          >
        </p>
        <button class="secondary" onclick={openStudio}>
          Open in Browser
        </button>
      </div>
    {:else}
      <div class="launching-state">
        <div class="spinner" aria-label="Starting Studio"></div>
        <h2>Starting Studio…</h2>
        <p class="subtitle">
          Launching backends and checking health. This may take up to 30 seconds.
        </p>
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

  .subtitle a {
    color: #6b72f0;
    text-decoration: none;
  }

  .subtitle a:hover {
    text-decoration: underline;
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
  .error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
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

  button {
    padding: 10px 28px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    margin-top: 8px;
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
