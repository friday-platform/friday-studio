<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";
  import type { ArtifactAttachedEntry } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message }: { message: ArtifactAttachedEntry } = $props();
</script>

<MessageWrapper>
  <div class="artifact-attached">
    {#each message.filenames as filename, i (i)}
      <div class="file-chip">
        <span class="icon"><IconSmall.Check /></span>
        <span class="file-name">{filename}</span>
      </div>
    {/each}
  </div>
</MessageWrapper>

<style>
  .artifact-attached {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
    justify-content: flex-end;
    padding-block: var(--size-1);
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
