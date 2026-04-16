<script lang="ts">
  export interface ImageAttachment {
    id: string;
    file: File;
    dataUrl: string;
  }

  interface Props {
    disabled?: boolean;
    onsubmit: (message: string, images: ImageAttachment[]) => void;
  }

  const { disabled = false, onsubmit }: Props = $props();

  let value = $state("");
  let images: ImageAttachment[] = $state([]);
  let dragOver = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();

  const hasContent = $derived(value.trim().length > 0 || images.length > 0);

  function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files: FileList | File[]) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await fileToDataUrl(file);
      images = [...images, { id: crypto.randomUUID(), file, dataUrl }];
    }
  }

  function removeImage(id: string) {
    images = images.filter((img) => img.id !== id);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && hasContent && !disabled) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    if (!hasContent || disabled) return;
    onsubmit(value.trim(), images);
    value = "";
    images = [];
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragOver = false;
    if (e.dataTransfer?.files) {
      void addFiles(e.dataTransfer.files);
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      void addFiles(imageFiles);
    }
  }

  function handleFileInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) {
      void addFiles(input.files);
    }
    input.value = "";
  }
</script>

<div
  class="chat-input-wrapper"
  class:drag-over={dragOver}
  ondrop={handleDrop}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  role="presentation"
>
  {#if images.length > 0}
    <div class="image-preview-strip">
      {#each images as img (img.id)}
        <div class="image-preview">
          <img src={img.dataUrl} alt={img.file.name} />
          <button
            class="remove-image"
            onclick={() => removeImage(img.id)}
            aria-label="Remove image"
          >
            ✕
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="input-row">
    <button
      class="attach-button"
      onclick={() => fileInput?.click()}
      {disabled}
      aria-label="Attach image"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M14 10V12.667A1.333 1.333 0 0112.667 14H3.333A1.333 1.333 0 012 12.667V10M11.333 5.333L8 2M8 2L4.667 5.333M8 2v8"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*"
      multiple
      onchange={handleFileInput}
      class="file-input-hidden"
    />
    <textarea
      data-testid="chat-input"
      bind:value
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      {disabled}
      placeholder={dragOver ? "Drop image here..." : "Send a message..."}
      rows={1}
    ></textarea>
    <button
      class="send-button"
      disabled={disabled || !hasContent}
      onclick={submit}
      aria-label="Send message"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M14 2L7 9M14 2L9.5 14L7 9M14 2L2 6.5L7 9"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>
</div>

<style>
  .chat-input-wrapper {
    background-color: var(--color-surface-3);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-3);
    transition: border-color 150ms ease;
  }

  .chat-input-wrapper.drag-over {
    border-color: var(--color-primary);
    background-color: color-mix(in srgb, var(--color-primary), transparent 92%);
  }

  .input-row {
    align-items: flex-end;
    display: flex;
    gap: var(--size-2);
  }

  .file-input-hidden {
    display: none;
  }

  .attach-button {
    align-items: center;
    background: transparent;
    border: none;
    block-size: var(--size-7);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    display: flex;
    flex-shrink: 0;
    inline-size: var(--size-7);
    justify-content: center;
    transition: color 150ms ease;
  }

  .attach-button:hover:not(:disabled) {
    color: var(--color-text);
  }

  .attach-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  textarea {
    background: transparent;
    border: none;
    color: var(--color-text);
    flex: 1;
    font-family: inherit;
    font-size: var(--font-size-2);
    line-height: 1.5;
    min-block-size: var(--size-6);
    outline: none;
    resize: none;
  }

  textarea::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  textarea:disabled {
    opacity: 0.5;
  }

  .send-button {
    align-items: center;
    background-color: var(--color-primary);
    border: none;
    border-radius: var(--radius-2);
    block-size: var(--size-7);
    color: white;
    cursor: pointer;
    display: flex;
    flex-shrink: 0;
    inline-size: var(--size-7);
    justify-content: center;
    transition: opacity 150ms ease;
  }

  .send-button:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .send-button:not(:disabled):hover {
    opacity: 0.85;
  }

  /* ─── Image preview strip ──────────────────────────────────────────── */

  .image-preview-strip {
    display: flex;
    gap: var(--size-2);
    overflow-x: auto;
    padding-block: var(--size-1);
  }

  .image-preview {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    flex-shrink: 0;
    overflow: hidden;
    position: relative;
  }

  .image-preview img {
    block-size: 64px;
    display: block;
    inline-size: auto;
    max-inline-size: 120px;
    object-fit: cover;
  }

  .remove-image {
    align-items: center;
    background-color: color-mix(in srgb, var(--color-surface-1), transparent 20%);
    block-size: 18px;
    border: none;
    border-radius: 50%;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: 10px;
    inline-size: 18px;
    inset-block-start: 2px;
    inset-inline-end: 2px;
    justify-content: center;
    position: absolute;
  }

  .remove-image:hover {
    background-color: var(--color-error);
    color: white;
  }
</style>
