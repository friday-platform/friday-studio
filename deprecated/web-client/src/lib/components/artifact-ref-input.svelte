<script lang="ts">
  import { ALLOWED_EXTENSION_LIST } from "@atlas/core/artifacts/file-upload";
  import { IconSmall } from "$lib/components/icons/small";
  import { createUploadController } from "$lib/components/upload-controller";
  import { formatFileSize } from "$lib/utils/files.svelte";
  import { onDestroy } from "svelte";

  type Props = {
    fieldName: string;
    label?: string;
    required: boolean;
    onchange: (artifactId: string | undefined) => void;
    uploading: boolean;
  };

  let { fieldName, label, required, onchange, uploading = $bindable() }: Props = $props();

  // Reactive state synced from the plain-TS controller via onUpdate callback
  let file = $state<File | null>(null);
  let status = $state<"idle" | "uploading" | "converting" | "ready" | "error">("idle");
  let progress = $state(0);
  let errorMessage = $state<string | null>(null);

  const ctrl = createUploadController({
    onchange,
    onUpdate() {
      file = ctrl.file;
      status = ctrl.status;
      progress = ctrl.progress;
      errorMessage = ctrl.errorMessage;
    },
  });

  let dragOver = $state(false);

  $effect(() => {
    uploading = status === "uploading" || status === "converting";
  });

  let percentage = $derived(file && file.size > 0 ? Math.round((progress / file.size) * 100) : 0);
  const acceptString = ALLOWED_EXTENSION_LIST.join(",");
  const fileTypeHint = "CSV, PDF, DOCX, PPTX, images, audio";

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragOver = false;
    const droppedFile = e.dataTransfer?.files?.[0];
    if (droppedFile) {
      ctrl.handleFile(droppedFile);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  onDestroy(() => {
    ctrl.destroy();
  });
</script>

<div class="artifact-ref-input" aria-label="{fieldName} file upload" role="group">
  {#if status === "idle"}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="dropzone"
      class:drag-over={dragOver}
      ondrop={handleDrop}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
    >
      <label class="dropzone-label">
        <input
          type="file"
          class="sr-only"
          accept={acceptString}
          aria-required={required}
          onchange={(e) => {
            const selected = e.currentTarget.files?.[0];
            if (selected) {
              ctrl.handleFile(selected);
            }
          }}
        />
        {#if label}
          <span class="dropzone-text">
            Drop {label} here or
            <span class="browse-link">Browse</span>
          </span>
          {#if required}
            <span class="dropzone-hint">Required</span>
          {/if}
        {:else}
          <span class="dropzone-text">
            Drop file here or <span class="browse-link">Browse</span>
          </span>
          <span class="dropzone-hint">{fileTypeHint}</span>
        {/if}
      </label>
    </div>
  {:else if status === "uploading"}
    <div class="file-status uploading">
      <div class="file-row">
        <span class="file-icon"><IconSmall.File /></span>
        <span class="file-name">{file?.name}</span>
        <span class="file-progress">{percentage}%</span>
        <button
          type="button"
          class="cancel-button"
          aria-label="Cancel upload"
          onclick={ctrl.cancel}
        >
          <IconSmall.Close />
        </button>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style:inline-size="{percentage}%"></div>
      </div>
    </div>
  {:else if status === "converting"}
    <div class="file-status converting">
      <div class="file-row">
        <span class="file-icon spinning"><IconSmall.Progress /></span>
        <span class="file-name">{file?.name}</span>
      </div>
      <span class="converting-text">Converting...</span>
    </div>
  {:else if status === "ready"}
    <div class="file-status ready">
      <div class="file-row">
        <span class="file-icon check"><IconSmall.Check /></span>
        <span class="file-name">{file?.name}</span>
        <span class="file-size">{file ? formatFileSize(file.size) : ""}</span>
        <button type="button" class="cancel-button" aria-label="Remove file" onclick={ctrl.cancel}>
          <IconSmall.Close />
        </button>
      </div>
    </div>
  {:else if status === "error"}
    <div class="file-status error">
      <div class="file-row">
        <span class="file-icon error-icon"><IconSmall.InfoCircled /></span>
        <span class="file-name">{file?.name}</span>
        <button type="button" class="cancel-button" aria-label="Remove file" onclick={ctrl.cancel}>
          <IconSmall.Close />
        </button>
      </div>
      <span class="error-text">{errorMessage}</span>
      <button type="button" class="retry-button" onclick={ctrl.retry}>Try again</button>
    </div>
  {/if}
</div>

<style>
  .artifact-ref-input {
    inline-size: 100%;
  }

  .sr-only {
    block-size: 1px;
    clip: rect(0, 0, 0, 0);
    inline-size: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
  }

  .dropzone {
    align-items: center;
    border: var(--size-1-5px) dashed var(--border-2);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    justify-content: center;
    padding: var(--size-4);
    transition: all 150ms ease;

    &.drag-over {
      background-color: var(--highlight-1);
      border-color: var(--accent-1);
    }
  }

  .dropzone-label {
    align-items: center;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  .dropzone-text {
    color: var(--text-2);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .browse-link {
    color: var(--color-yellow);
    text-decoration: underline;
  }

  .dropzone-hint {
    color: var(--text-3);
    font-size: var(--font-size-1);
  }

  .file-status {
    border: var(--size-px) solid var(--border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-2);
  }

  .file-row {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .file-icon {
    color: var(--text-3);
    display: flex;
    flex: none;

    &.spinning {
      animation: spin 1s linear infinite;
    }

    &.check {
      color: var(--color-success, #22c55e);
    }

    &.error-icon {
      color: var(--color-error, #ef4444);
    }
  }

  .file-name {
    flex: 1;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-progress {
    color: var(--text-3);
    flex: none;
    font-size: var(--font-size-1);
  }

  .file-size {
    color: var(--text-3);
    flex: none;
    font-size: var(--font-size-1);
  }

  .cancel-button {
    align-items: center;
    border-radius: var(--radius-2);
    color: var(--text-3);
    display: flex;
    flex: none;
    justify-content: center;
    padding: var(--size-0-5);
    transition: all 150ms ease;

    &:hover {
      background-color: var(--highlight-1);
      color: var(--text-1);
    }
  }

  .progress-bar {
    background-color: var(--highlight-1);
    block-size: var(--size-0-75);
    border-radius: var(--radius-round);
    overflow: hidden;
  }

  .progress-fill {
    background-color: var(--accent-1);
    block-size: 100%;
    border-radius: var(--radius-round);
    transition: inline-size 150ms ease;
  }

  .converting-text {
    color: var(--text-3);
    font-size: var(--font-size-1);
  }

  .file-status.ready {
    border-color: var(--color-success, #22c55e);
  }

  .file-status.error {
    border-color: var(--color-error, #ef4444);
  }

  .error-text {
    color: var(--color-error, #ef4444);
    font-size: var(--font-size-1);
  }

  .retry-button {
    align-self: flex-end;
    color: var(--accent-1);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);

    &:hover {
      text-decoration: underline;
    }
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
