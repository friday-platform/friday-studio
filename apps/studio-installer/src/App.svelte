<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "./lib/store.svelte.ts";
  import { detectInstallState } from "./lib/installer.ts";

  import Welcome from "./steps/Welcome.svelte";
  import License from "./steps/License.svelte";
  import ApiKeys from "./steps/ApiKeys.svelte";
  import Download from "./steps/Download.svelte";
  import Extract from "./steps/Extract.svelte";
  import Launch from "./steps/Launch.svelte";

  let detecting = $state(true);
  let detectError = $state<string | null>(null);

  onMount(async () => {
    try {
      await detectInstallState();
    } catch (err) {
      detectError = err instanceof Error ? err.message : String(err);
    } finally {
      detecting = false;
    }
  });
</script>

<main class="installer">
  {#if detecting}
    <div class="loading">
      <div class="spinner" aria-label="Detecting install state"></div>
      <p>Checking installation…</p>
    </div>
  {:else if detectError !== null}
    <div class="error-screen">
      <h2>Could not check for updates</h2>
      <p class="error-detail">{detectError}</p>
      <p>You can continue with a fresh installation.</p>
      <button
        onclick={() => {
          detectError = null;
          store.mode = "fresh";
        }}
      >
        Continue Anyway
      </button>
    </div>
  {:else if store.step === "welcome"}
    <Welcome
      mode={store.mode}
      installedVersion={store.installedVersion}
      availableVersion={store.availableVersion}
      studioRunning={store.studioRunning}
    />
  {:else if store.step === "license"}
    <License />
  {:else if store.step === "api-keys"}
    <ApiKeys />
  {:else if store.step === "download"}
    <Download />
  {:else if store.step === "extract"}
    <Extract />
  {:else if store.step === "launch"}
    <Launch />
  {:else if store.step === "done"}
    <div class="done-screen">
      <h2>All done!</h2>
      <p>Friday Studio is running. You can close this window.</p>
    </div>
  {/if}
</main>

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(html) {
    height: 100%;
    color-scheme: light dark;
  }

  :global(body) {
    height: 100%;
    font-family:
      -apple-system,
      BlinkMacSystemFont,
      "Segoe UI",
      Roboto,
      sans-serif;
    font-size: 15px;
    background: light-dark(#f5f5f5, #0f0f0f);
    color: light-dark(#1a1a1a, #e8e8e8);
    overflow: hidden;
    user-select: none;
  }

  .installer {
    width: 100%;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .loading {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: light-dark(#888, #999);
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid light-dark(#ddd, #333);
    border-top-color: #6b72f0;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-screen,
  .done-screen {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 40px;
    text-align: center;
  }

  .error-screen h2 {
    font-size: 20px;
    color: #f87171;
  }

  .error-detail {
    font-size: 13px;
    color: #888;
    max-width: 400px;
    word-break: break-word;
  }

  .done-screen h2 {
    font-size: 22px;
    color: #6b72f0;
  }

  button {
    margin-top: 8px;
    padding: 10px 24px;
    background: #6b72f0;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s;
  }

  button:hover {
    background: #5a62e0;
  }
</style>
