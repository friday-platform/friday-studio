<script lang="ts">
  import { ALLOWED_EXTENSION_LIST } from "@atlas/core/artifacts/file-upload";
  import { toast } from "@atlas/ui";
  import ModelPill from "./model-pill.svelte";
  import {
    type FileAttachment,
    type ChatAttachment,
    type ImageAttachment,
    buildFileAttachment,
    classifyAttachment,
    duplicateToast,
    isDuplicateAttachment,
    rejectionToast,
    runFileUpload,
  } from "./chat-attachment.ts";

  // Re-export the attachment types so existing imports
  // (`import { ChatAttachment } from "./chat-input.svelte"`) keep working.
  export type { FileAttachment, ChatAttachment, ImageAttachment };

  // The scratch-upload endpoint accepts every extension in ALLOWED_EXTENSION_LIST —
  // text, JSON, CSV, MD, PDF, DOCX, PPTX, audio. Drop any of them in the
  // chat and they upload as per-chat scratch attachments instead of library
  // artifacts.
  const ACCEPT_ATTR = ALLOWED_EXTENSION_LIST.join(",");

  interface Props {
    /**
     * Workspace owning the chat. Threaded into `uploadFileToScratch()` so
     * the upload route's `requireWorkspaceMember(c, workspaceId)` gate
     * passes.
     */
    workspaceId: string;
    /**
     * Chat id — the scratch-upload route writes each file under
     * `{FRIDAY_HOME}/scratch/uploads/{workspaceId}/{chatId}/{md5}`. The chat
     * owns this; user-chat passes it through unchanged.
     */
    chatId: string;
    onsubmit: (message: string, attachments: ChatAttachment[]) => void;
    /** Attached images/files. Bindable so drop targets outside this component
     * (e.g. the whole chat surface) can push files into the same preview
     * strip the file-picker uses, instead of rendering a parallel one. */
    attachments?: ChatAttachment[];
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

  let {
    workspaceId,
    chatId,
    onsubmit,
    attachments = $bindable([]),
    streaming = false,
    stopping = false,
    onstop,
    ttsEnabled = false,
    onttsToggle,
  }: Props = $props();

  let value = $state("");
  let dragOver = $state(false);
  let fileInput: HTMLInputElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  /// <reference path="./speech-recognition.d.ts" />

  let recording = $state(false);
  let recognition: SpeechRecognition | null = $state(null);

  $effect(() => {
    if (!textareaEl) return;
    value; // re-run when text changes
    textareaEl.style.height = 'auto';
    textareaEl.style.height = `${textareaEl.scrollHeight}px`;
  });

  // Block submit while any file upload is in flight or failed — sending now
  // would either race the upload or clear a failed chip that cannot be sent.
  // The textbox stays editable; users remove failed chips before retrying.
  const uploadingCount = $derived(
    attachments.filter((a) => a.kind === "file" && a.status === "uploading").length,
  );
  const failedCount = $derived(
    attachments.filter((a) => a.kind === "file" && a.status === "error").length,
  );
  const sendableAttachmentCount = $derived(
    attachments.filter((a) => a.kind === "image" || a.status === "ready").length,
  );
  const hasContent = $derived(
    (value.trim().length > 0 || sendableAttachmentCount > 0) &&
      uploadingCount === 0 &&
      failedCount === 0,
  );
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
    sr.continuous = true;
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

  /**
   * Reassign an attachment-by-id with new fields. The list is a `$state`
   * array of plain objects — replacing the array reference is what makes
   * Svelte re-render. Per-attachment state updates from the upload
   * `onProgress` callback land here.
   */
  function patchAttachment(id: string, patch: Partial<FileAttachment>) {
    attachments = attachments.map((a) =>
      a.kind === "file" && a.id === id ? { ...a, ...patch } : a,
    );

    // Post-upload dedup. The server returns `{chatId}/{md5}` as the
    // path — two uploads of identical bytes produce identical paths.
    // If the chip we just updated now has a `path` that matches
    // another chip's, the user dropped the same file twice. Collapse
    // by removing this one (the more recently added) and toasting.
    // Why not pre-upload? Computing a hash client-side is redundant
    // work — the server already does it. We pay one wasted upload of
    // the duplicate bytes; the server's rename-overwrite is idempotent
    // (atomic POSIX rename of identical bytes onto the same name).
    if (patch.path) {
      const newPath = patch.path;
      const sharing = attachments.filter((a) => a.kind === "file" && a.path === newPath);
      if (sharing.length > 1) {
        const removed = attachments.find((a) => a.id === id);
        attachments = attachments.filter((a) => a.id !== id);
        if (removed) {
          const summary = duplicateToast([removed.file]);
          if (summary) toast({ ...summary });
        }
      }
    }
  }

  async function addFiles(files: FileList | File[]) {
    const rejected: File[] = [];
    const duplicates: File[] = [];
    for (const file of files) {
      const kind = classifyAttachment(file);
      if (kind === "image") {
        // Images dedup pre-add via dataUrl equality — they don't go
        // through the server upload path, so we can't rely on a
        // server-returned md5. Two drops of the same image produce
        // identical base64 dataUrls; string equality catches it
        // cheaply.
        const dataUrl = await fileToDataUrl(file);
        if (isDuplicateAttachment({ kind: "image", dataUrl }, attachments)) {
          duplicates.push(file);
          continue;
        }
        attachments = [
          ...attachments,
          { kind: "image", id: crypto.randomUUID(), file, dataUrl },
        ];
      } else if (kind === "file") {
        // Files upload to the server which already computes md5 and
        // returns it as part of the path (`{chatId}/{md5}`). We add
        // the chip optimistically, run the upload, and reconcile in
        // `patchAttachment` — see the dedup branch there for the
        // post-upload check that collapses two-chips-with-same-path.
        const att = buildFileAttachment(file);
        attachments = [...attachments, att];
        runFileUpload({ att, chatId, workspaceId, onUpdate: patchAttachment });
      } else {
        rejected.push(file);
      }
    }
    // Coalesce: one toast for the whole drop, not one per rejected file.
    // Single-file rejection still surfaces the specific reason (e.g. SVG
    // script-injection); multi-file rejection enumerates the filenames.
    const dupSummary = duplicateToast(duplicates);
    if (dupSummary) toast({ ...dupSummary });
    const summary = rejectionToast(rejected);
    if (summary) toast({ ...summary, error: true });
  }

  function removeAttachment(id: string) {
    const target = attachments.find((a) => a.id === id);
    if (target && target.kind === "file" && target.status === "uploading") {
      target.abortController.abort();
    }
    attachments = attachments.filter((att) => att.id !== id);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && hasContent) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    if (!hasContent) return;
    onsubmit(value.trim(), attachments);
    value = "";
    attachments = [];
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    // `user-chat.svelte` wraps this component with its own drop target. Without
    // stopPropagation the same file is added twice — once here, once on the
    // outer chat container — and the persisted message ends up with duplicate
    // parts. Pre-existing bug for images; surfaced now that we ship text
    // attachments inline (so the duplicate is the *content*, not a hidden
    // preview chip).
    e.stopPropagation();
    dragOver = false;
    if (e.dataTransfer?.files) {
      void addFiles(e.dataTransfer.files);
    }
  }

  // Safari requires preventDefault on BOTH dragenter and dragover to register
  // the element as a valid drop target; without dragenter prevention it falls
  // back to its default file-open behavior on drop. stopPropagation keeps the
  // outer user-chat drop overlay from flashing while the user is targeting
  // the input row.
  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    dragOver = true;
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (const item of items) {
      // Only images (and any future binary file types) come through as
      // `kind: "file"` in the clipboard. Pasted plain text lives in the
      // `kind: "string"` items and is handled by the default textarea
      // paste — don't intercept it.
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      void addFiles(pastedFiles);
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
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  role="presentation"
>
  {#if attachments.length > 0}
    <div class="image-preview-strip">
      {#each attachments as att (att.id)}
        {#if att.kind === "image"}
          <div class="image-preview">
            <img src={att.dataUrl} alt={att.file.name} />
            <button
              class="remove-image"
              onclick={() => removeAttachment(att.id)}
              aria-label="Remove image"
            >
              ✕
            </button>
          </div>
        {:else}
          {@const pct = att.file.size > 0 ? Math.round((att.progress / att.file.size) * 100) : 0}
          <div
            class="text-attachment"
            class:uploading={att.status === "uploading"}
            class:error={att.status === "error"}
            title={att.errorMessage ?? `${att.file.name} · ${att.mediaType}`}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path
                d="M9 1.5H3.5A1.5 1.5 0 0 0 2 3v10a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 13V6.5L9 1.5Z"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
              <path d="M9 1.5V6.5H14" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
            <span class="text-attachment-name">{att.file.name}</span>
            {#if att.status === "uploading"}
              <span class="text-attachment-status">{pct}%</span>
            {:else if att.status === "error"}
              <span class="text-attachment-status text-attachment-error">!</span>
            {/if}
            <button
              class="remove-image"
              onclick={() => removeAttachment(att.id)}
              aria-label={att.status === "uploading" ? "Cancel upload" : "Remove file"}
            >
              ✕
            </button>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  <div class="input-row">
    <button
      class="attach-button"
      onclick={() => fileInput?.click()}
      aria-label="Attach file"
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
      accept={ACCEPT_ATTR}
      multiple
      onchange={handleFileInput}
      class="file-input-hidden"
    />
    <textarea
      data-testid="chat-input"
      bind:this={textareaEl}
      bind:value
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      placeholder={dragOver ? "Drop file here..." : recording ? "Listening..." : "Send a message..."}
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
    <ModelPill {workspaceId} />
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
    max-block-size: 200px;
    min-block-size: var(--size-6);
    outline: none;
    overflow-y: auto;
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

  .text-attachment {
    align-items: center;
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    display: inline-flex;
    flex-shrink: 0;
    font-size: var(--font-size-1);
    gap: var(--size-1);
    max-inline-size: 200px;
    padding: var(--size-1) var(--size-2);
    position: relative;
  }

  .text-attachment-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .text-attachment.uploading {
    opacity: 0.75;
  }

  .text-attachment.error {
    border-color: var(--color-error);
    color: var(--color-error);
  }

  .text-attachment-status {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-variant-numeric: tabular-nums;
  }

  .text-attachment-error {
    color: var(--color-error);
    font-weight: var(--font-weight-7);
  }

  .text-attachment .remove-image {
    background-color: transparent;
    block-size: 16px;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    inline-size: 16px;
    inset: auto;
    margin-inline-start: var(--size-1);
    position: static;
  }

  .text-attachment .remove-image:hover {
    background-color: var(--color-error);
    color: white;
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
