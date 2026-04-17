<script lang="ts">
  export interface ImageAttachment {
    id: string;
    file: File;
    dataUrl: string;
  }

  interface Props {
    onsubmit: (message: string, images: ImageAttachment[]) => void;
    /** True while the assistant is producing a response. Swaps the send slot
     * for a stop button; users press Enter to send when idle. */
    streaming?: boolean;
    /** True while a stop request is in flight (DELETE session). */
    stopping?: boolean;
    /** Abort the current turn. Required when `streaming` can be true. */
    onstop?: () => void;
    /** Text-to-speech read-out toggle state, lifted to the parent so it
     * can drive the speechSynthesis queue. */
    ttsEnabled?: boolean;
    /** User flipped the TTS button. */
    onttsToggle?: () => void;
  }

  const {
    onsubmit,
    streaming = false,
    stopping = false,
    onstop,
    ttsEnabled = false,
    onttsToggle,
  }: Props = $props();

  let value = $state("");
  let images: ImageAttachment[] = $state([]);
  let dragOver = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  /// <reference path="./speech-recognition.d.ts" />

  let recording = $state(false);
  let recognition: SpeechRecognition | null = $state(null);

  const hasContent = $derived(value.trim().length > 0 || images.length > 0);
  const sttSupported = typeof window !== "undefined"
    && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);

  function toggleRecording() {
    if (recording) {
      recognition?.stop();
      return;
    }
    const w = window as unknown as Record<string, unknown>;
    const SpeechRecognitionCtor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as SpeechRecognitionConstructor | undefined;
    if (!SpeechRecognitionCtor) return;

    const sr = new SpeechRecognitionCtor();
    sr.continuous = false;
    sr.interimResults = true;
    sr.lang = navigator.language || "en-US";

    // Text that was in the input before recording started
    const preExisting = value;

    sr.onresult = (e: SpeechRecognitionEvent) => {
      let final = "";
      let interim = "";
      // Rebuild full transcript from all results each time
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i];
        if (result && result[0]) {
          if (result.isFinal) {
            final += result[0].transcript;
          } else {
            interim += result[0].transcript;
          }
        }
      }
      const sep = preExisting.length > 0 && !preExisting.endsWith(" ") ? " " : "";
      value = preExisting + sep + final + interim;
    };

    sr.onend = () => {
      recording = false;
      recognition = null;
    };

    sr.onerror = () => {
      recording = false;
      recognition = null;
    };

    recognition = sr;
    recording = true;
    sr.start();
  }

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
    if (e.key === "Enter" && !e.shiftKey && hasContent) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    if (!hasContent) return;
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
      placeholder={dragOver ? "Drop image here..." : recording ? "Listening..." : "Send a message..."}
      rows={1}
    ></textarea>
    {#if sttSupported}
      <button
        class="mic-button"
        class:recording
        onclick={toggleRecording}
        aria-label={recording ? "Stop recording" : "Voice input"}
        title={recording ? "Stop recording" : "Voice input"}
      >
        {#if recording}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2Z" fill="currentColor" />
            <path d="M4 6.5a.5.5 0 0 1 1 0v1a3 3 0 0 0 6 0v-1a.5.5 0 0 1 1 0v1a4 4 0 0 1-3.5 3.97V13h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.53A4 4 0 0 1 4 7.5v-1Z" fill="currentColor" />
          </svg>
        {/if}
      </button>
    {/if}
    {#if onttsToggle}
      <button
        class="tts-button"
        class:active={ttsEnabled}
        onclick={() => onttsToggle?.()}
        aria-label={ttsEnabled ? "Turn off read-aloud" : "Turn on read-aloud"}
        aria-pressed={ttsEnabled}
        title={ttsEnabled ? "Read-aloud: on" : "Read-aloud: off"}
      >
        {#if ttsEnabled}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="6" width="1.5" height="4" rx="0.5" fill="currentColor"><animate attributeName="height" values="4;8;4" dur="1s" repeatCount="indefinite"/><animate attributeName="y" values="6;4;6" dur="1s" repeatCount="indefinite"/></rect>
            <rect x="5" y="4" width="1.5" height="8" rx="0.5" fill="currentColor"><animate attributeName="height" values="8;4;8" dur="1s" repeatCount="indefinite"/><animate attributeName="y" values="4;6;4" dur="1s" repeatCount="indefinite"/></rect>
            <rect x="8" y="5" width="1.5" height="6" rx="0.5" fill="currentColor"><animate attributeName="height" values="6;10;6" dur="1.1s" repeatCount="indefinite"/><animate attributeName="y" values="5;3;5" dur="1.1s" repeatCount="indefinite"/></rect>
            <rect x="11" y="6" width="1.5" height="4" rx="0.5" fill="currentColor"><animate attributeName="height" values="4;8;4" dur="0.9s" repeatCount="indefinite"/><animate attributeName="y" values="6;4;6" dur="0.9s" repeatCount="indefinite"/></rect>
          </svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 2.5L4.5 5H2v6h2.5L8 13.5v-11Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/>
            <path d="M11 6l3 4M14 6l-3 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
        {/if}
      </button>
    {/if}
    {#if streaming}
      <button
        class="stop-button"
        onclick={() => onstop?.()}
        disabled={stopping}
        aria-label="Stop response"
        title="Stop response"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
        </svg>
      </button>
    {/if}
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

  .mic-button {
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

  .mic-button:hover:not(:disabled) {
    color: var(--color-text);
  }

  .mic-button.recording {
    animation: mic-pulse 1.5s ease-in-out infinite;
    color: var(--color-error);
  }

  .mic-button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .tts-button {
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

  .tts-button:hover {
    color: var(--color-text);
  }

  .tts-button.active {
    color: var(--color-primary);
  }

  @keyframes mic-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
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

  .stop-button {
    align-items: center;
    background-color: var(--color-error, #c93b3b);
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

  .stop-button:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .stop-button:not(:disabled):hover {
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
