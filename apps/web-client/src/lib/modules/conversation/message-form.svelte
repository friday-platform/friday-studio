<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { ALLOWED_EXTENSION_LIST } from "@atlas/core/artifacts/file-upload";
  import { getAppContext, handleFileDrop, isFileInProgress } from "$lib/app-context.svelte";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import Textarea from "$lib/components/textarea.svelte";
  import { formatFileSize } from "$lib/utils/files.svelte";

  type Props = {
    isDisabled: boolean;
    message: string;
    textareaAdditionalSize?: number;
    status: "submitted" | "streaming" | "ready" | "error";
    chatId?: string;
    onSubmit: (message: string) => void;
    onStop: () => void;
  };
  const appCtx = getAppContext();

  let {
    isDisabled,
    message = $bindable(""),
    textareaAdditionalSize = $bindable(1),
    status,
    chatId,
    onSubmit,
    onStop,
  }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form
  onkeydown={(e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      e.currentTarget?.requestSubmit();
    }
  }}
  onsubmit={async (e) => {
    e.preventDefault();

    if (isDisabled) return;

    onSubmit(message);

    message = "";
  }}
>
  {#if appCtx.stagedFiles.state.size > 0}
    <div class="staged-files">
      {#each appCtx.stagedFiles.state.entries() as [itemId, file] (itemId)}
        {@const progress = file.size > 0 ? Math.round((file.loaded / file.size) * 100) : 0}
        <button
          class="staged-file"
          class:uploading={isFileInProgress(file)}
          class:ready={file.status === "ready"}
          class:error={file.status === "error"}
          style:--progress="{progress}%"
          title={file.error || file.name}
          onclick={() => {
            if (isFileInProgress(file)) {
              appCtx.stagedFiles.cancel(itemId);
            } else {
              trackEvent(GA4.FILE_REMOVE);
              appCtx.stagedFiles.remove(itemId);
            }
          }}
        >
          {#if isFileInProgress(file)}
            <span class="status-icon spinning"><IconSmall.Progress /></span>
          {:else if file.status === "ready"}
            <span class="status-icon"><IconSmall.Check /></span>
          {:else if file.status === "error"}
            <span class="status-icon"><IconSmall.InfoCircled /></span>
          {/if}

          <span class="file-name">{file.name}</span>

          {#if file.status === "error"}
            <span class="error-text">{file.error}</span>
          {:else if file.status === "converting"}
            <span class="file-size">Converting...</span>
          {:else if file.status === "uploading"}
            <span class="file-size">{progress}%</span>
          {:else}
            <span class="file-size">{formatFileSize(file.size)}</span>
          {/if}

          <span class="close-button">
            <IconSmall.Close />
          </span>
        </button>
      {/each}
    </div>
  {/if}

  <Textarea
    name="message"
    placeholder="Type here..."
    bind:value={message}
    onResize={(value) => {
      textareaAdditionalSize = value - 40;
    }}
  />

  <div class="footer">
    <div class="commands">
      <label class="upload-files">
        <input
          type="file"
          class="sr-only"
          accept={ALLOWED_EXTENSION_LIST.join(",")}
          multiple
          onchange={(e) => {
            const files = e.currentTarget.files;
            if (files?.length) {
              trackEvent(GA4.FILE_ATTACH, { file_count: files.length });
              handleFileDrop(appCtx, Array.from(files), chatId);
            }
          }}
        />

        <Icons.Paperclip />

        Add Files
      </label>

      {#if appCtx.usage.showInputWarning}
        <span class="usage-inline-warning">
          <IconSmall.InfoCircled />
          {appCtx.usage.percent}% of limit used
        </span>
      {/if}
    </div>

    <div class="form-action">
      {#if status === "streaming" || status === "submitted"}
        <button
          class="stop-process"
          type="button"
          onclick={(e) => {
            e.preventDefault();
            onStop();
          }}
        >
          <IconSmall.Stop />
        </button>
      {:else}
        {@const hasUploadingFiles = Array.from(appCtx.stagedFiles.state.values()).some((f) =>
          isFileInProgress(f),
        )}
        <button type="submit" aria-label="Send message" disabled={hasUploadingFiles}>
          <Icons.Return />
        </button>
      {/if}
    </div>
  </div>
</form>

<style>
  form {
    background-color: var(--color-surface-1);
    border-radius: var(--radius-6);
    box-shadow: var(--shadow-1);
    display: flex;
    flex-direction: column;
    position: relative;
    padding-inline: var(--size-4) var(--size-1-5);

    .form-action {
      display: flex;
      margin-block-end: var(--size-1-5);
    }

    button[type="submit"],
    .stop-process {
      align-items: center;
      background-color: var(--accent-2);
      block-size: var(--size-7);
      border-radius: var(--radius-4);
      color: var(--color-white);
      display: flex;
      justify-content: center;
      inline-size: var(--size-7);
      transition: all 200ms ease;

      &:hover:not(:disabled) {
        background-color: var(--color-text);
        @media (prefers-color-scheme: dark) {
          color: var(--color-surface-1);
        }
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .footer {
      align-items: center;
      display: flex;
      justify-content: space-between;
      gap: var(--size-1);
    }

    .commands {
      align-items: center;
      display: flex;
      justify-content: space-between;
      gap: var(--size-1);
      margin-inline-start: calc(-1 * var(--size-1));
      margin-block-end: var(--size-1-5);
    }

    /* file upload */
    .upload-files {
      align-items: center;
      block-size: var(--size-6);
      border-radius: var(--radius-3);
      display: flex;
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      gap: var(--size-1);
      opacity: 0.8;
      padding-inline: var(--size-1) var(--size-2);

      &:hover,
      &:focus-within {
        background-color: var(--color-highlight-1);
      }
    }

    .sr-only {
      block-size: 1px;
      clip: rect(0, 0, 0, 0);
      inline-size: 1px;
      overflow: hidden;
      position: absolute;
      white-space: nowrap;
    }

    .usage-inline-warning {
      align-items: center;
      color: var(--color-error);
      display: flex;
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      gap: var(--size-1);
    }
  }

  .staged-files {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
    inline-size: 100%;
    padding-block-start: var(--size-2);
    margin-inline-start: calc(-1 * var(--size-0-5));

    .staged-file {
      align-items: center;
      block-size: var(--size-5-5);
      border-radius: var(--radius-2-5);
      border: var(--size-px) solid var(--color-border-1);
      cursor: pointer;
      display: flex;
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      gap: var(--size-0-5);
      justify-content: center;
      max-inline-size: var(--size-56);
      padding-inline: var(--size-1);
      overflow: hidden;
      text-align: left;
      transition: all 150ms ease;

      &.uploading {
        opacity: 0.7;
        cursor: wait;
      }

      &.ready {
        border-color: var(--color-success, #22c55e);

        .status-icon {
          color: var(--color-success, #22c55e);
        }
      }

      &.error {
        border-color: var(--color-error, #ef4444);
        color: var(--color-error, #ef4444);

        .status-icon {
          color: var(--color-error, #ef4444);
        }
      }

      .status-icon {
        flex: none;
        display: flex;
        align-items: center;

        &.spinning {
          animation: spin 1s linear infinite;
        }
      }

      .file-name {
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
        flex: 1;
        opacity: 0.7;
      }

      .file-size {
        font-size: var(--font-size-0);
        opacity: 0.5;
        flex: none;
      }

      .error-text {
        font-size: var(--font-size-0);
        opacity: 0.8;
        flex: none;
        max-inline-size: var(--size-24);
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
      }

      .close-button {
        border-radius: var(--radius-2);
        block-size: var(--size-4);
        flex: none;
        inline-size: var(--size-4);
        transition: all 150ms ease;
      }

      &:hover .close-button {
        background-color: var(--color-surface-2);
      }
    }
  }
</style>
