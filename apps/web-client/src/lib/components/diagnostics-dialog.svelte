<script lang="ts">
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onDestroy } from "svelte";

interface Props {
  open?: boolean;
  onclose?: () => void;
}

let { open = $bindable(false), onclose }: Props = $props();
let dialog: HTMLDialogElement | undefined = $state();
let status = $state<"idle" | "running" | "success" | "error">("idle");
let progressMessage = $state("Ready to collect diagnostics");
let errorMessage = $state("");
let unlistenProgress: UnlistenFn | undefined;

$effect(() => {
  if (open && dialog) {
    dialog.showModal();
    if (status === "idle") {
      runDiagnostics();
    }
  } else if (!open && dialog) {
    dialog.close();
  }
});

async function runDiagnostics() {
  status = "running";
  progressMessage = "Initializing diagnostics...";
  errorMessage = "";

  try {
    // Set up progress listener
    const { listen } = await import("@tauri-apps/api/event");
    unlistenProgress = await listen<string>("diagnostics-progress", (event) => {
      progressMessage = event.payload;
    });

    // Run the diagnostics command
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<string>("run_diagnostics");

    status = "success";
    progressMessage = "Diagnostics completed successfully!";

    // Auto-close after 2 seconds on success
    setTimeout(() => {
      handleClose();
    }, 2000);
  } catch (error) {
    status = "error";
    errorMessage = error instanceof Error ? error.message : String(error);
    progressMessage = "Diagnostics failed";
  } finally {
    // Clean up listener
    if (unlistenProgress) {
      unlistenProgress();
      unlistenProgress = undefined;
    }
  }
}

function handleClose() {
  open = false;
  // Reset state for next time
  status = "idle";
  progressMessage = "Ready to collect diagnostics";
  errorMessage = "";
  onclose?.();
}

function handleBackdropClick(event: MouseEvent) {
  // Only allow closing via backdrop if not running
  if (status !== "running") {
    const rect = dialog?.getBoundingClientRect();
    if (
      rect &&
      (event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom)
    ) {
      handleClose();
    }
  }
}

onDestroy(() => {
  if (unlistenProgress) {
    unlistenProgress();
  }
});
</script>

<dialog
  bind:this={dialog}
  class="diagnostics-dialog"
  onclick={handleBackdropClick}
>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog-content" onclick={(e) => e.stopPropagation()}>
    {#if status !== "running"}
      <button class="close-button" onclick={handleClose} aria-label="Close">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M13 1L1 13M1 1L13 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    {/if}

    <div class="icon" class:success={status === "success"} class:error={status === "error"}>
      {#if status === "running"}
        <div class="spinner"></div>
      {:else if status === "success"}
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
          <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      {:else if status === "error"}
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
          <path d="M12 9V13M12 17H12.01M12 3L2 20H22L12 3Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      {:else}
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
          <path d="M9 11L12 14L22 4M21 12V19A2 2 0 0119 21H5A2 2 0 013 19V5A2 2 0 015 3H16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      {/if}
    </div>

    <h2 class="title">
      {#if status === "running"}
        Running Diagnostics
      {:else if status === "success"}
        Diagnostics Complete
      {:else if status === "error"}
        Diagnostics Failed
      {:else}
        Run Diagnostics
      {/if}
    </h2>

    <p class="message">
      {progressMessage}
    </p>

    {#if status === "error" && errorMessage}
      <div class="error-details">
        <p>{errorMessage}</p>
      </div>
    {/if}

    {#if status === "running"}
      <div class="progress-bar">
        <div class="progress-bar-fill"></div>
      </div>
    {/if}

    {#if status === "error"}
      <div class="actions">
        <button class="retry-button" onclick={runDiagnostics}>
          Retry
        </button>
        <button class="close-button-text" onclick={handleClose}>
          Close
        </button>
      </div>
    {/if}
  </div>
</dialog>

<style>
  .diagnostics-dialog {
    background: transparent;
    border: none;
    border-radius: var(--radius-4);
    max-inline-size: 420px;
    padding: 0;
    position: fixed;
    inset: 0;
    margin: auto;
    overflow: visible;

    &::backdrop {
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
    }

    &[open] {
      animation: dialog-appear 200ms ease-out;
    }
  }

  @keyframes dialog-appear {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .dialog-content {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-4);
    box-shadow: var(--shadow-4);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--size-4);
    padding: var(--size-10) var(--size-8) var(--size-8);
    position: relative;
    text-align: center;
    min-inline-size: 320px;
  }

  .close-button {
    position: absolute;
    inset-block-start: var(--size-4);
    inset-inline-end: var(--size-4);
    background: transparent;
    border: none;
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    inline-size: var(--size-6);
    block-size: var(--size-6);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.6;
    transition: all 150ms ease;

    &:hover {
      background: var(--color-surface-1);
      opacity: 1;
    }
  }

  .icon {
    inline-size: var(--size-16);
    block-size: var(--size-16);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--color-surface-1);
    color: var(--color-text);
    margin-block-end: var(--size-2);

    &.success {
      background: color-mix(in srgb, var(--color-green) 15%, var(--color-surface-1));
      color: var(--color-green);
    }

    &.error {
      background: color-mix(in srgb, var(--color-red) 15%, var(--color-surface-1));
      color: var(--color-red);
    }
  }

  .spinner {
    inline-size: var(--size-8);
    block-size: var(--size-8);
    border: 3px solid var(--color-surface-1);
    border-block-start-color: var(--color-blue);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .title {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .message {
    color: var(--color-text);
    font-size: var(--font-size-2);
    margin: 0;
    opacity: 0.8;
    min-block-size: var(--size-8);
  }

  .error-details {
    background: var(--color-surface-1);
    border: 1px solid color-mix(in srgb, var(--color-red) 20%, transparent);
    border-radius: var(--radius-3);
    padding: var(--size-4);
    inline-size: 100%;

    p {
      color: var(--color-red);
      font-family: var(--font-mono);
      font-size: var(--font-size-1);
      margin: 0;
      text-align: left;
      word-break: break-word;
    }
  }

  .progress-bar {
    inline-size: 100%;
    block-size: var(--size-2);
    background: var(--color-surface-1);
    border-radius: var(--radius-2);
    overflow: hidden;
    margin-block: var(--size-4);
  }

  .progress-bar-fill {
    block-size: 100%;
    background: var(--color-blue);
    animation: progress 2s ease-in-out infinite;
    inline-size: 30%;
  }

  @keyframes progress {
    0% {
      transform: translateX(-100%);
    }
    50% {
      transform: translateX(200%);
    }
    100% {
      transform: translateX(400%);
    }
  }

  .actions {
    display: flex;
    gap: var(--size-4);
    margin-block-start: var(--size-2);
  }

  .retry-button, .close-button-text {
    padding: var(--size-2) var(--size-4);
    border-radius: var(--radius-2);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    cursor: pointer;
    transition: all 150ms ease;
  }

  .retry-button {
    background: var(--color-blue);
    color: white;
    border: none;

    &:hover {
      background: color-mix(in srgb, var(--color-blue) 85%, black);
    }
  }

  .close-button-text {
    background: transparent;
    color: var(--color-text);
    border: 1px solid var(--color-border-1);

    &:hover {
      background: var(--color-surface-1);
    }
  }
</style>