<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";
  import { ACCEPT_STRING, validateImageFile } from "$lib/components/image-picker-validation";
  import { onDestroy } from "svelte";

  type Props = {
    currentImageUrl: string | null;
    onFileSelect: (file: File | null) => void;
    size?: number;
  };

  let { currentImageUrl = null, onFileSelect, size = 96 }: Props = $props();

  let previewUrl = $state<string | null>(null);
  let dragOver = $state(false);
  let error = $state<string | null>(null);
  let fileInputEl: HTMLInputElement | undefined = $state();

  let displayUrl = $derived(previewUrl ?? currentImageUrl);

  function handleFile(file: File) {
    error = null;
    const validationError = validateImageFile(file);
    if (validationError) {
      error = validationError;
      return;
    }
    revokePreview();
    previewUrl = URL.createObjectURL(file);
    onFileSelect(file);
  }

  function handleInputChange() {
    const file = fileInputEl?.files?.[0];
    if (file) {
      handleFile(file);
    }
    // Reset so re-selecting the same file triggers change
    if (fileInputEl) fileInputEl.value = "";
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragOver = false;
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      handleFile(file);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function handleRemove(e: MouseEvent) {
    e.stopPropagation();
    revokePreview();
    error = null;
    onFileSelect(null);
  }

  function handleClick() {
    fileInputEl?.click();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInputEl?.click();
    }
  }

  function revokePreview() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  }

  onDestroy(() => {
    revokePreview();
  });
</script>

<div class="image-picker" style:--picker-size="{size}px">
  <div
    class="pick-area"
    class:drag-over={dragOver}
    class:has-image={!!displayUrl}
    ondrop={handleDrop}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    onclick={handleClick}
    onkeydown={handleKeydown}
    role="button"
    tabindex="0"
    aria-label="Choose profile photo"
  >
    <input
      bind:this={fileInputEl}
      type="file"
      class="sr-only"
      accept={ACCEPT_STRING}
      onchange={handleInputChange}
    />

    {#if displayUrl}
      <img src={displayUrl} alt="Profile preview" class="preview" />
      <button type="button" class="remove-button" aria-label="Remove photo" onclick={handleRemove}>
        <IconSmall.Close />
      </button>
    {:else}
      <div class="placeholder">
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.5" />
          <path
            d="M4 21c0-3.866 3.582-7 8-7s8 3.134 8 7"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </div>
      <div class="overlay">
        <span class="overlay-text">Upload photo</span>
      </div>
    {/if}
  </div>

  {#if error}
    <span class="error-text">{error}</span>
  {/if}
</div>

<style>
  .image-picker {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--size-1-5);
  }

  .sr-only {
    block-size: 1px;
    clip: rect(0, 0, 0, 0);
    inline-size: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
  }

  .pick-area {
    position: relative;
    inline-size: var(--picker-size);
    block-size: var(--picker-size);
    border-radius: var(--radius-round);
    border: var(--size-1-5px) dashed var(--color-border-1);
    cursor: pointer;
    transition: border-color 150ms ease;
    display: flex;
    align-items: center;
    justify-content: center;

    &:hover {
      border-color: color-mix(in srgb, var(--color-border-1), var(--color-text) 30%);
    }

    &:focus-visible {
      outline: 2px solid var(--color-text);
      outline-offset: 2px;
    }

    &.drag-over {
      border-color: var(--color-yellow);
      border-style: solid;
    }

    &.has-image {
      border-style: solid;
      border-color: var(--color-border-1);
    }
  }

  .preview {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
    border-radius: var(--radius-round);
  }

  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: color-mix(in srgb, var(--color-surface-1), transparent 40%);
    opacity: 0;
    transition: opacity 150ms ease;
    border-radius: var(--radius-round);

    .pick-area:hover &,
    .pick-area.drag-over & {
      opacity: 1;
    }
  }

  .overlay-text {
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    color: var(--color-text);
  }

  .remove-button {
    position: absolute;
    inset-block-start: var(--size-1);
    inset-inline-end: var(--size-1);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--size-0-5);
    border-radius: var(--radius-round);
    background-color: var(--color-surface-1);
    color: var(--color-text);
    box-shadow: var(--shadow-1);
    opacity: 0;
    transition: opacity 150ms ease;
    cursor: pointer;

    .pick-area:hover & {
      opacity: 1;
    }

    &:hover {
      background-color: var(--color-surface-2);
    }
  }

  .error-text {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }
</style>
