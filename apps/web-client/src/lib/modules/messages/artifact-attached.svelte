<script lang="ts">
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { IconSmall } from "$lib/components/icons/small";
  import type { ArtifactAttachedEntry } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message }: { message: ArtifactAttachedEntry } = $props();

  /** Track per-image load errors so we can fall back to chip rendering. */
  let imageErrors: Record<number, boolean> = $state({});

  function isImage(index: number): boolean {
    return message.mimeTypes?.[index]?.startsWith("image/") ?? false;
  }

  function imageUrl(index: number): string {
    return `${getAtlasDaemonUrl()}/api/artifacts/${message.artifactIds[index]}/content`;
  }
</script>

<MessageWrapper>
  <div class="artifact-attached">
    {#each message.filenames as filename, i (i)}
      {#if isImage(i) && !imageErrors[i]}
        <div class="image-attachment">
          <img
            src={imageUrl(i)}
            alt={filename}
            class="image-preview"
            onerror={() => (imageErrors[i] = true)}
          />
          <span class="image-caption">{filename}</span>
        </div>
      {:else}
        <div class="file-chip">
          <span class="icon"><IconSmall.Check /></span>
          <span class="file-name">{filename}</span>
        </div>
      {/if}
    {/each}
  </div>
</MessageWrapper>

<style>
  .artifact-attached {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: var(--size-2);
    padding-block: var(--size-1);
  }

  .image-attachment {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .image-preview {
    border-radius: var(--radius-3);
    display: block;
    max-inline-size: 400px;
    object-fit: contain;
  }

  .image-caption {
    color: var(--color-text-muted);
    font-size: var(--font-size-1);
  }

  .file-chip {
    align-items: center;
    background-color: var(--color-surface-2);
    border-radius: var(--radius-2-5);
    border: var(--size-px) solid var(--color-success, #22c55e);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    gap: var(--size-0-5);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1-5);
  }

  .icon {
    color: var(--color-success, #22c55e);
    display: flex;
  }

  .file-name {
    opacity: 0.7;
    max-inline-size: var(--size-40);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
