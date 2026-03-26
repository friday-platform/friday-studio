<script lang="ts">
  import type { Color } from "@atlas/utils";
  import Dot from "$lib/components/dot.svelte";
  import { formatChatDate } from "$lib/utils/date";

  type Props = {
    title: string;
    workspaceName: string | undefined;
    workspaceColor: Color | undefined;
    createdAt: string;
  };

  let { title, workspaceName, workspaceColor, createdAt }: Props = $props();

  const displayTitle = $derived(title.replaceAll("{{user_id}}", "You"));
</script>

<div class="component">
  {#if workspaceName}
    <Dot color={workspaceColor} />
  {/if}

  <div class="content">
    <p class="title">{displayTitle}</p>

    <div class="meta">
      <time datetime={new Date(createdAt).toLocaleString()}>
        {formatChatDate(createdAt)}
      </time>

      {#if workspaceName}
        <span>•</span>

        <span>{workspaceName}</span>
      {/if}
    </div>
  </div>
</div>

<style>
  .component {
    align-items: start;
    display: flex;
    gap: var(--size-2);
    overflow: hidden;
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    min-inline-size: 0;
  }

  .title {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-4-5);
    line-height: var(--font-lineheight-1);
    opacity: 0.8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    align-items: baseline;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4-5);
    line-height: var(--font-lineheight-1);
    gap: var(--size-1);
    opacity: 0.6;
  }
</style>
