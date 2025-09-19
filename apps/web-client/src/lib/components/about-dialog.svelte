<script lang="ts">
import { onMount } from "svelte";
import logo from "$lib/assets/logo.png";
// Import build info if it exists (will be generated at build time)
// @ts-ignore - This file is generated
import { BUILD_INFO } from "$lib/build-info";

interface Props {
  open?: boolean;
  onclose?: () => void;
}

let { open = $bindable(false), onclose }: Props = $props();
let dialog: HTMLDialogElement | undefined = $state();
let version = BUILD_INFO?.version || "0.1.0";
let buildType = BUILD_INFO?.buildType || "development";
let commitHash = BUILD_INFO?.commitHash || "unknown";

onMount(async () => {
  // Get version info from Tauri if available
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const tauriVersion = await getVersion();
    if (tauriVersion) {
      version = tauriVersion;
    }
  } catch {
    // Not in Tauri context, use build info version
  }
});

$effect(() => {
  if (open && dialog) {
    dialog.showModal();
  } else if (!open && dialog) {
    dialog.close();
  }
});

function handleClose() {
  open = false;
  onclose?.();
}

function handleBackdropClick(event: MouseEvent) {
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
</script>

<dialog
  bind:this={dialog}
  class="about-dialog"
  onclick={handleBackdropClick}
>
  <div class="dialog-content" onclick={(e) => e.stopPropagation()}>
    <button class="close-button" onclick={handleClose} aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M13 1L1 13M1 1L13 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>

    <div class="app-icon">
      <img src={logo} alt="Atlas" />
    </div>

    <h1 class="app-name">Atlas Web Client</h1>

    <p class="app-description">
      Fast, native AI agent orchestration platform<br />
      pushing modern human/AI collaboration.
    </p>

    <div class="version-info">
      <div class="version-row">
        <span class="label">Version</span>
        <span class="value">{version}</span>
      </div>
      <div class="version-row">
        <span class="label">Build</span>
        <span class="value">{buildType}</span>
      </div>
      <div class="version-row">
        <span class="label">Commit</span>
        <span class="value">{commitHash}</span>
      </div>
    </div>

    <div class="actions">
      <a
        href="https://discord.com/channels/1400973996505436300/1404928095009509489"
        target="_blank"
        class="action-link"
      >
        Discord
      </a>
    </div>
  </div>
</dialog>

<style>
  .about-dialog {
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

  .app-icon {
    background: #181c2f;
    border-radius: var(--radius-4);
    block-size: var(--size-16);
    inline-size: var(--size-16);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-block-end: var(--size-2);

    img {
      block-size: var(--size-10);
      inline-size: auto;
    }
  }

  .app-name {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .app-description {
    color: var(--color-text);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: 0;
    opacity: 0.8;
  }

  .version-info {
    background: var(--color-surface-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-4);
    inline-size: 100%;
    margin-block: var(--size-2);
  }

  .version-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--font-size-1);

    .label {
      color: var(--color-text);
      opacity: 0.6;
      font-weight: var(--font-weight-4);
    }

    .value {
      font-family: var(--font-mono);
      font-weight: var(--font-weight-5);
      color: var(--color-text);
    }
  }

  .actions {
    display: flex;
    gap: var(--size-4);
    margin-block-start: var(--size-2);
  }

  .action-link {
    color: var(--color-blue);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    text-decoration: none;
    padding: var(--size-2) var(--size-4);
    border-radius: var(--radius-2);
    transition: background 150ms ease;

    &:hover {
      background: var(--color-surface-1);
      text-decoration: underline;
    }
  }
</style>