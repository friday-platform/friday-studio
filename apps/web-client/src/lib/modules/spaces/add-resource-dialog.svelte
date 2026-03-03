<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { Dialog } from "$lib/components/dialog";
  import { IconSmall } from "$lib/components/icons/small";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { formatFileSize } from "$lib/utils/files.svelte";
  import { detectProvider, extractNameFromUrl } from "$lib/utils/provider-detection";
  import { uploadResource } from "$lib/utils/resource-upload";
  import { retrySlugCollision, SlugCollisionError } from "$lib/utils/slug";
  import type { Component, Snippet } from "svelte";
  import { z } from "zod/v4";

  /**
   * Modal dialog for adding resources to a workspace.
   * Supports file upload via drag-and-drop or file browser,
   * and external link creation via URL paste with provider detection.
   */
  type Props = { workspaceId: string; triggerContents: Snippet };

  let { workspaceId, triggerContents }: Props = $props();

  const queryClient = useQueryClient();
  const queryKey = $derived(["resources", workspaceId]);

  type LinkState = { mode: "link"; url: string; provider: string; icon: Component };
  type AddState = { mode: "idle" } | { mode: "file"; file: File } | LinkState;

  let addState = $state<AddState>({ mode: "idle" });
  let resourceName = $state("");
  let linkUrl = $state("");
  let urlError = $state("");
  let dragOver = $state(false);

  const FIVE_MB = 5 * 1024 * 1024;

  const BINARY_TYPES = new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]);

  function isReadOnly(file: File): boolean {
    if (file.size > FIVE_MB) return true;
    if (BINARY_TYPES.has(file.type)) return true;
    const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if ([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pptx"].includes(ext)) return true;
    return false;
  }

  const addMutation = createMutation(() => ({
    mutationFn: async (file: File) => {
      const name = resourceName.trim() || file.name.replace(/\.[^.]+$/, "");
      const ext = file.name.slice(file.name.lastIndexOf("."));
      return retrySlugCollision(name, async (slug) => {
        const renamed = new File([file], `${slug}${ext}`, { type: file.type });
        const result = await uploadResource(renamed, workspaceId);
        if (!result.ok && result.status === 409) {
          return { conflict: true as const };
        }
        if (!result.ok) throw new Error(result.error);
        return { conflict: false as const, data: result };
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: unknown, file: File) => {
      const msg =
        error instanceof SlugCollisionError
          ? `Could not generate unique name for ${file.name}`
          : `Failed to upload ${file.name}`;
      toast({ title: msg, error: true, viewAction: () => {} });
    },
  }));

  const linkMutation = createMutation(() => ({
    mutationFn: async (link: { url: string; name: string; provider: string }) => {
      const res = await parseResult(
        client.workspace[":workspaceId"].resources.link.$post({
          param: { workspaceId },
          json: { url: link.url, name: link.name, provider: link.provider },
        }),
      );
      if (!res.ok) throw new Error(String(res.error));
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onError: () => {
      toast({ title: "Failed to add link", error: true, viewAction: () => {} });
    },
  }));

  const UrlSchema = z.url();

  function parseUrl(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const withProtocol =
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`;
    const result = UrlSchema.safeParse(withProtocol);
    if (!result.success) return null;
    try {
      const parsed = new URL(result.data);
      if (!parsed.hostname.includes(".")) return null;
      return result.data;
    } catch {
      return null;
    }
  }

  function handleUrlSubmit() {
    if (!linkUrl.trim()) {
      urlError = "";
      return;
    }
    const url = parseUrl(linkUrl);
    if (!url) {
      urlError = "Enter a valid URL";
      addState = { mode: "idle" };
      return;
    }
    urlError = "";
    const { provider, icon } = detectProvider(url);
    addState = { mode: "link", url, provider, icon };
    if (!resourceName.trim()) {
      resourceName = extractNameFromUrl(url);
    }
  }

  function selectFile(file: File) {
    addState = { mode: "file", file };
    resourceName = file.name.replace(/\.[^.]+$/, "");
  }

  function clearSelection() {
    addState = { mode: "idle" };
    linkUrl = "";
    urlError = "";
  }

  function resetState() {
    addState = { mode: "idle" };
    resourceName = "";
    linkUrl = "";
    urlError = "";
    dragOver = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragOver = false;
    const droppedFile = e.dataTransfer?.files?.[0];
    if (droppedFile) selectFile(droppedFile);
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    dragOver = true;
  }

  function handleDragLeave() {
    dragOver = false;
  }

  function handleBrowse(e: Event) {
    if (!(e.target instanceof HTMLInputElement)) return;
    const file = e.target.files?.[0];
    if (file) selectFile(file);
    e.target.value = "";
  }

  async function handleSubmit(open: { set: (v: boolean) => void }) {
    if (addState.mode === "file") {
      addMutation.mutate(addState.file, {
        onSuccess: () => {
          open.set(false);
          resetState();
        },
      });
    } else if (addState.mode === "link") {
      const { url, provider } = addState;
      const name = resourceName.trim() || extractNameFromUrl(url);
      linkMutation.mutate(
        { url, name, provider },
        {
          onSuccess: () => {
            open.set(false);
            resetState();
          },
        },
      );
    }
  }
</script>

<Dialog.Root
  onOpenChange={({ next }) => {
    if (!next) resetState();
    return next;
  }}
>
  {#snippet children(open)}
    <Dialog.Trigger>
      {@render triggerContents()}
    </Dialog.Trigger>

    <Dialog.Content size="large">
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Add a resource</Dialog.Title>
        <Dialog.Description>
          <p>Data and documents your agents can reference and update between sessions.</p>
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <div class="dialog-body">
          <div class="field">
            <label for="resource-name">Name</label>
            <input
              id="resource-name"
              type="text"
              class="text-input"
              placeholder="Resource name"
              bind:value={resourceName}
            />
          </div>

          {#if addState.mode === "idle"}
            <div class="source-picker">
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="surface"
                class:drag-over={dragOver}
                ondrop={handleDrop}
                ondragover={handleDragOver}
                ondragleave={handleDragLeave}
              >
                <label class="dropzone-label">
                  <input type="file" class="sr-only" onchange={handleBrowse} />
                  <span class="dropzone-icon"><IconSmall.File /></span>
                  <span class="dropzone-text">Click or drop here to upload</span>
                </label>
              </div>

              <div class="divider">
                <span class="divider-line"></span>
                <span class="divider-text">or paste a link</span>
                <span class="divider-line"></span>
              </div>

              <input
                id="url-input"
                type="text"
                class="text-input"
                class:has-error={urlError}
                placeholder="notion.so/your-page, docs.google.com/d/..."
                bind:value={linkUrl}
                onpaste={() => requestAnimationFrame(handleUrlSubmit)}
                onblur={handleUrlSubmit}
                onkeydown={(e) => {
                  if (e.key === "Enter") handleUrlSubmit();
                }}
              />
              {#if urlError}
                <span class="field-error">{urlError}</span>
              {/if}
            </div>
          {:else if addState.mode === "file"}
            <div class="preview-chip">
              <div class="chip-body">
                <span class="chip-icon"><IconSmall.File /></span>
                <div class="chip-info">
                  <span class="chip-name">{addState.file.name}</span>
                  <span class="chip-meta">{formatFileSize(addState.file.size)}</span>
                </div>
                <button
                  type="button"
                  class="chip-close"
                  aria-label="Remove file"
                  onclick={clearSelection}
                >
                  <IconSmall.Close />
                </button>
              </div>
            </div>
            {#if isReadOnly(addState.file)}
              <p class="chip-hint">Agents can reference this file but aren't able to modify it</p>
            {/if}
          {:else if addState.mode === "link"}
            {@const IconComponent = addState.icon}
            <div class="preview-chip">
              <div class="chip-body">
                <span class="chip-icon"><IconComponent /></span>
                <div class="chip-info">
                  <span class="chip-name">{addState.url}</span>
                </div>
                <button
                  type="button"
                  class="chip-close"
                  aria-label="Clear URL"
                  onclick={clearSelection}
                >
                  <IconSmall.Close />
                </button>
              </div>
            </div>
          {/if}

          <div class="buttons">
            <Dialog.Button
              type="button"
              closeOnClick={false}
              disabled={addState.mode === "idle" || addMutation.isPending || linkMutation.isPending}
              onclick={() => handleSubmit(open)}
            >
              {#if addMutation.isPending}
                Uploading...
              {:else if linkMutation.isPending}
                Adding...
              {:else}
                Add
              {/if}
            </Dialog.Button>
            <Dialog.Cancel onclick={resetState}>Cancel</Dialog.Cancel>
          </div>
        </div>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    inline-size: 100%;
    max-inline-size: var(--size-96);
  }

  .sr-only {
    block-size: 1px;
    clip: rect(0, 0, 0, 0);
    inline-size: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    text-align: start;
  }

  .field label {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    opacity: 0.7;
  }

  .text-input {
    background-color: var(--color-surface-2);
    block-size: var(--size-9);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-3);
    color: var(--color-text);
    font-size: var(--font-size-2);
    inline-size: 100%;
    padding-inline: var(--size-3);

    &::placeholder {
      color: color-mix(in oklch, var(--color-text) 50%, transparent);
    }

    &.has-error {
      border-color: var(--color-red);
    }
  }

  .field-error {
    color: var(--color-red);
    font-size: var(--font-size-1);
  }

  .source-picker {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .divider {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .divider-line {
    background-color: var(--color-border-1);
    block-size: 1px;
    flex: 1;
  }

  .divider-text {
    color: var(--color-text);
    font-size: var(--font-size-1);
    opacity: 0.4;
    white-space: nowrap;
  }

  .surface {
    align-items: center;
    border: 1px dashed var(--color-border-1);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-6);
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
    gap: var(--size-1);
  }

  .dropzone-icon {
    color: var(--text-3);
    display: flex;
  }

  .dropzone-text {
    color: var(--text-2);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .preview-chip {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2-5);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-3);
    text-align: start;
  }

  .chip-close {
    align-items: center;
    border-radius: var(--radius-2);
    color: var(--color-text);
    display: flex;
    flex: none;
    justify-content: center;
    opacity: 0.4;
    padding: var(--size-1);
    transition: all 150ms ease;

    &:hover {
      background-color: var(--highlight-1);
      opacity: 1;
    }
  }

  .chip-body {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .chip-icon {
    display: flex;
    flex: none;

    :global(svg) {
      block-size: var(--size-4);
      inline-size: var(--size-4);
    }
  }

  .chip-info {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-0-5);
    min-inline-size: 0;
  }

  .chip-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-meta {
    color: var(--color-text);
    font-size: var(--font-size-1);
    opacity: 0.5;
  }

  .chip-hint {
    color: var(--color-text);
    font-size: var(--font-size-1);
    font-style: italic;
    margin-block-start: calc(-1 * var(--size-2));
    opacity: 0.5;
  }

  .buttons {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    inline-size: 100%;
    margin-block-start: var(--size-2);
  }
</style>
