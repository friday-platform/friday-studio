<script lang="ts">
import { onMount } from "svelte";
import { detectInstallState } from "./lib/installer.ts";
import { store } from "./lib/store.svelte.ts";
import ApiKeys from "./steps/ApiKeys.svelte";
import Download from "./steps/Download.svelte";
import Extract from "./steps/Extract.svelte";
import Launch from "./steps/Launch.svelte";
import License from "./steps/License.svelte";
import Welcome from "./steps/Welcome.svelte";

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

  :global(:root) {
    color-scheme: light dark;

    /*
      Color tokens — mirror @atlas/ui/tokens.css so the installer
      shares the same palette as the agent-playground (and any other
      surface in the monorepo that consumes those tokens). Same
      light-dark() pattern, same semantic naming. Inlined here
      rather than imported because the installer is a leaf Tauri
      app with no @atlas/* deps; if we ever pull in @atlas/ui we
      should drop these and import tokens.css instead.
    */
    --color-text: light-dark(hsl(230 32% 14%), hsl(40 12% 95%));
    --color-text-muted: light-dark(hsl(230 12% 40%), hsl(40 6% 65%));
    --color-text-subtle: light-dark(hsl(230 8% 55%), hsl(40 4% 50%));
    --color-surface-1: light-dark(hsl(0 0% 100%), hsl(228 2% 7%));
    --color-surface-2: light-dark(hsl(240 12% 95%), hsl(228 2% 9%));
    --color-surface-3: light-dark(hsl(220 16% 93%), hsl(228 4% 16%));
    --color-border-1: light-dark(hsl(220 24% 90%), hsl(230 10% 24%));
    --color-border-2: light-dark(hsl(240 3% 94%), hsl(230 10% 18%));
    --color-primary: light-dark(hsl(212 97% 40%), hsl(212 80% 55%));
    --color-primary-text: hsl(0 0% 100%);
    --color-error: light-dark(hsl(10 100% 38%), hsl(10 100% 65%));
    --color-success: light-dark(hsl(142 71% 35%), hsl(142 71% 55%));
    --color-warning: light-dark(hsl(38 92% 40%), hsl(38 92% 55%));
  }

  :global(html) {
    height: 100%;
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
    background: var(--color-surface-2);
    color: var(--color-text);
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
    color: var(--color-text-muted);
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--color-border-1);
    border-top-color: var(--color-primary);
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
    color: var(--color-error);
  }

  .error-detail {
    font-size: 13px;
    color: var(--color-text-muted);
    max-width: 400px;
    word-break: break-word;
  }

  .done-screen h2 {
    font-size: 22px;
    color: var(--color-primary);
  }

  button {
    margin-top: 8px;
    padding: 10px 24px;
    background: var(--color-primary);
    color: var(--color-primary-text);
    border: none;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }

  button:hover {
    opacity: 0.9;
  }
</style>
