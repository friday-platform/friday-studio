<script lang="ts">
import { onMount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import { advanceStep, createAppBundleIfDarwin, installDir, runExtract } from "../lib/installer.ts";
import { store } from "../lib/store.svelte.ts";

type Phase = "extracting" | "claude";

let phase = $state<Phase>("extracting");

onMount(async () => {
  const src = store.downloadPath;
  // Single source of truth for the install path lives in Rust
  // (commands/platform.rs::install_dir → ~/.friday/local). Keep all
  // platform-specific %LOCALAPPDATA% etc. logic out of the JS side.
  const dest = await installDir();

  try {
    await runExtract(src, dest);
    // Create /Applications/Friday Studio.app so Spotlight can index
    // the launcher and the user can re-launch after they Quit.
    // Non-fatal if it fails — see createAppBundleIfDarwin.
    await createAppBundleIfDarwin(dest, store.availableVersion);
    // Make sure Claude Code is on the user's machine so the friday
    // daemon's agent SDK has a binary to invoke. ensure_claude_code
    // is idempotent: it short-circuits when claude is already
    // discoverable, and runs Anthropic's official install script
    // (~10–30s) only on a fresh machine. The launcher's
    // FRIDAY_CLAUDE_PATH discovery picks up the resulting binary at
    // its next startup. Non-fatal: friday will surface its own
    // "binary not found" error at first agent run if this fails,
    // which is at least specific enough to act on.
    phase = "claude";
    try {
      await invoke("ensure_claude_code");
    } catch (err) {
      console.warn("ensure_claude_code failed (non-fatal):", err);
    }
    // Persist the install marker so the wizard's mode detection on
    // the next run sees mode==="current" / "update" instead of
    // re-treating the install as "fresh". Without this, every run
    // re-runs the full Welcome → license → keys → download flow,
    // and the studioRunning warning never surfaces. Best-effort:
    // a marker write failure shouldn't block the user's install.
    try {
      await invoke("write_installed", { version: store.availableVersion });
    } catch (err) {
      console.warn("write_installed failed (non-fatal):", err);
    }
    advanceStep();
  } catch {
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
    {:else if phase === "claude"}
      <div class="extracting-state">
        <div class="spinner" aria-label="Installing Claude Code"></div>
        <h2>Setting up Claude Code…</h2>
        <p class="subtitle">
          Installing the Claude Code binary so Friday Studio agents have
          something to talk to. This usually takes 10–30 seconds.
        </p>
      </div>
    {:else}
      <div class="extracting-state">
        <div class="spinner" aria-label="Installing"></div>
        <h2>Installing…</h2>
        <p class="subtitle">
          {#if store.extractEntriesDone > 0}
            Unpacking… {store.extractEntriesDone.toLocaleString()} files
          {:else}
            Extracting Friday Studio files. This may take a moment.
          {/if}
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
    color: light-dark(#1a1a1a, #f0f0f0);
  }

  .subtitle {
    font-size: 14px;
    color: light-dark(#555, #777);
    max-width: 340px;
    line-height: 1.5;
  }

  .spinner {
    width: 48px;
    height: 48px;
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
    color: light-dark(#555, #888);
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
