<script lang="ts">
import { invoke } from "@tauri-apps/api/core";
import { onMount } from "svelte";
import { advanceStep, createAppBundleIfDarwin, installDir, runExtract } from "../lib/installer.ts";
import { store } from "../lib/store.svelte.ts";

type ToolStatus = "pending" | "success" | "failed";

interface Tool {
  /** Display label rendered in the row. Matches log strings / CLI invocations
   * (e.g. "agent-browser") so users can grep when something fails. */
  display: string;
  /** Tauri command name to invoke. Each command is idempotent: short-circuits
   * on warm runs (existing claude binary / cached Chrome). Failures are
   * non-fatal — the row pip flips to ✗, the daemon surfaces a clear
   * "binary not found" at first agent run, and the user can re-run the
   * installer to retry. */
  command: string;
  status: ToolStatus;
}

type Phase = "extracting" | "tools";

let phase = $state<Phase>("extracting");
let tools = $state<Tool[]>([
  { display: "Claude Code", command: "ensure_claude_code", status: "pending" },
  { display: "agent-browser", command: "ensure_agent_browser_chrome", status: "pending" },
]);

async function runTool(idx: number): Promise<void> {
  const tool = tools[idx];
  if (!tool) return;
  try {
    await invoke(tool.command);
    tools[idx].status = "success";
  } catch (err) {
    console.warn(`${tool.command} failed (non-fatal):`, err);
    tools[idx].status = "failed";
  }
}

function pipGlyph(status: ToolStatus): string {
  if (status === "success") return "✓";
  if (status === "failed") return "✗";
  return "•"; // pending — paired with .pip-spinner pulse animation
}

function pipClass(status: ToolStatus): string {
  if (status === "success") return "pip pip-healthy";
  if (status === "failed") return "pip pip-failed";
  return "pip pip-spinner";
}

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
    // Flip to the per-tool checklist phase. Each tool runs sequentially
    // so the row pips show one-at-a-time motion the user can map to
    // network activity. Failures are non-fatal: agent-browser failing
    // only degrades the web agent's `browse` tool — `search` and
    // `fetch` (HTTP-based) keep working. Claude Code failing surfaces
    // at first agent invocation rather than blocking install.
    phase = "tools";
    for (let i = 0; i < tools.length; i++) {
      await runTool(i);
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
    {:else if phase === "tools"}
      <div class="extracting-state">
        <h2>Setting up tools…</h2>
        <p class="subtitle">
          Installing the binaries Friday agents need.
        </p>
        {#each tools as tool (tool.command)}
          <div class="row">
            <span class={pipClass(tool.status)} aria-hidden="true">
              {pipGlyph(tool.status)}
            </span>
            <span class="row-name">{tool.display}</span>
          </div>
        {/each}
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
    color: var(--color-text);
  }

  .subtitle {
    font-size: 14px;
    color: var(--color-text-muted);
    max-width: 340px;
    line-height: 1.5;
  }

  .spinner {
    width: 48px;
    height: 48px;
    border: 4px solid var(--color-border-1);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(248, 113, 113, 0.15);
    color: var(--color-error);
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
    color: var(--color-error);
  }

  .error-detail {
    font-size: 13px;
    color: var(--color-text-muted);
    max-width: 380px;
    word-break: break-word;
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.15);
    border-radius: 8px;
    padding: 12px 16px;
  }

  .error-hint {
    font-size: 12px;
    color: var(--color-text-muted);
  }

  .extracting-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  /* Per-tool checklist row. Pip on the left, display name on the right.
     Vocabulary mirrors Launch.svelte:425-477 so the visual language stays
     consistent across the wizard's "installing" and "starting" screens. */
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--color-text);
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
    color: var(--color-success);
  }

  .pip-failed {
    background: rgba(248, 113, 113, 0.15);
    color: var(--color-error);
  }

  .pip-spinner {
    background: rgba(107, 114, 240, 0.15);
    color: var(--color-primary);
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
</style>
