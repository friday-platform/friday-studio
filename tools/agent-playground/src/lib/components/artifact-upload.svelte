<script lang="ts">
  import { IconSmall } from "@atlas/ui";
  import type { ArtifactInputHint } from "$lib/artifact-hints.ts";
  import { createUploadController } from "$lib/upload-controller.ts";
  import { onDestroy } from "svelte";

  type FileResult = { type: "artifact"; artifactId: string } | { type: "content"; content: string };

  type Props = { hint: ArtifactInputHint; onResult: (result: FileResult | undefined) => void };

  let { hint, onResult }: Props = $props();

  let file = $state<File | null>(null);
  let status = $state<"idle" | "uploading" | "converting" | "ready" | "error">("idle");
  let progress = $state(0);
  let errorMessage = $state<string | null>(null);
  let dragOver = $state(false);

  // Upload controller — only used for artifact-ref mode
  const ctrl = createUploadController({
    onchange(artifactId) {
      if (artifactId) {
        onResult({ type: "artifact", artifactId });
      } else {
        onResult(undefined);
      }
    },
    onUpdate() {
      file = ctrl.file;
      status = ctrl.status;
      progress = ctrl.progress;
      errorMessage = ctrl.errorMessage;
    },
  });

  const percentage = $derived(file && file.size > 0 ? Math.round((progress / file.size) * 100) : 0);
  const acceptString = hint.accept.join(",");

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** Read file as text locally (inline-content mode). */
  function readFileAsText(selectedFile: File) {
    file = selectedFile;
    status = "uploading";
    errorMessage = null;

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      if (typeof text === "string") {
        status = "ready";
        onResult({ type: "content", content: text });
      } else {
        status = "error";
        errorMessage = "Could not read file as text";
        onResult(undefined);
      }
    };
    reader.onerror = () => {
      status = "error";
      errorMessage = "Failed to read file";
      onResult(undefined);
    };
    reader.readAsText(selectedFile);
  }

  function handleFile(selectedFile: File) {
    if (hint.mode === "inline-content") {
      readFileAsText(selectedFile);
    } else {
      ctrl.handleFile(selectedFile);
    }
  }

  function cancelFile() {
    if (hint.mode === "inline-content") {
      file = null;
      status = "idle";
      errorMessage = null;
      onResult(undefined);
    } else {
      ctrl.cancel();
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragOver = false;
    const droppedFile = e.dataTransfer?.files?.[0];
    if (droppedFile) handleFile(droppedFile);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  /** Reset state when agent changes. */
  export function reset() {
    cancelFile();
  }

  onDestroy(() => {
    if (hint.mode === "artifact-ref") {
      ctrl.destroy();
    }
  });
</script>

<div class="artifact-upload" role="group" aria-label="File upload">
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
          onchange={(e) => {
            const selected = e.currentTarget.files?.[0];
            if (selected) handleFile(selected);
          }}
        />
        <span class="dropzone-text">
          Drop file here or <span class="browse-link">browse</span>
        </span>
        <span class="dropzone-hint">{hint.label} &middot; {hint.accept.join(", ")}</span>
      </label>
    </div>
  {:else if status === "uploading"}
    <div class="file-status uploading">
      <div class="file-row">
        <span class="file-name">{file?.name}</span>
        {#if hint.mode === "artifact-ref"}
          <span class="file-meta">{percentage}%</span>
        {:else}
          <span class="file-meta">Reading...</span>
        {/if}
        <button type="button" class="icon-btn" aria-label="Cancel" onclick={cancelFile}>
          <IconSmall.Close />
        </button>
      </div>
      {#if hint.mode === "artifact-ref"}
        <div class="progress-bar">
          <div class="progress-fill" style:inline-size="{percentage}%"></div>
        </div>
      {/if}
    </div>
  {:else if status === "converting"}
    <div class="file-status converting">
      <div class="file-row">
        <span class="spinner"><IconSmall.Progress /></span>
        <span class="file-name">{file?.name}</span>
        <span class="file-meta">Converting...</span>
      </div>
    </div>
  {:else if status === "ready"}
    <div class="file-status ready">
      <div class="file-row">
        <span class="check-icon"><IconSmall.Check /></span>
        <span class="file-name">{file?.name}</span>
        <span class="file-meta">{file ? formatSize(file.size) : ""}</span>
        <button type="button" class="icon-btn" aria-label="Remove file" onclick={cancelFile}>
          <IconSmall.Close />
        </button>
      </div>
    </div>
  {:else if status === "error"}
    <div class="file-status error">
      <div class="file-row">
        <span class="file-name">{file?.name}</span>
        <button type="button" class="icon-btn" aria-label="Remove file" onclick={cancelFile}>
          <IconSmall.Close />
        </button>
      </div>
      <span class="error-text">{errorMessage}</span>
      <button
        type="button"
        class="retry-btn"
        onclick={() => {
          if (file) handleFile(file);
        }}
      >
        Try again
      </button>
    </div>
  {/if}
</div>

<style>
  .artifact-upload {
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
    border: 1.5px dashed var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    justify-content: center;
    padding: var(--size-4);
    transition: all 150ms ease;

    &.drag-over {
      background-color: var(--color-surface-2);
      border-color: color-mix(in srgb, var(--color-text), transparent 40%);
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
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .browse-link {
    color: var(--color-text);
    text-decoration: underline;
  }

  .dropzone-hint {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-1);
  }

  .file-status {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
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

  .file-name {
    flex: 1;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-meta {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    flex: none;
    font-size: var(--font-size-1);
  }

  .icon-btn {
    align-items: center;
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    display: flex;
    flex: none;
    justify-content: center;
    padding: var(--size-0-5);
    transition: all 150ms ease;

    &:hover {
      background-color: var(--color-surface-2);
      color: var(--color-text);
    }
  }

  .progress-bar {
    background-color: var(--color-surface-2);
    block-size: 3px;
    border-radius: var(--radius-round);
    overflow: hidden;
  }

  .progress-fill {
    background-color: var(--color-text);
    block-size: 100%;
    border-radius: var(--radius-round);
    transition: inline-size 150ms ease;
  }

  .spinner {
    animation: spin 1s linear infinite;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    flex: none;
  }

  .check-icon {
    color: var(--color-success);
    display: flex;
    flex: none;
  }

  .file-status.ready {
    border-color: var(--color-success);
  }

  .file-status.error {
    border-color: var(--color-error);
  }

  .error-text {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }

  .retry-btn {
    align-self: flex-end;
    color: var(--color-text);
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
