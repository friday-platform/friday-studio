<script lang="ts">
  import { formatChatDate } from "$lib/utils/date";

  type Props = {
    job: string;
    workspaceName?: string;
    sessionType?: "conversation" | "task";
    title?: string;
    parentTitle?: string;
    createdAt: string;
  };

  let { job, workspaceName, sessionType, title, parentTitle, createdAt }: Props = $props();
  const isTask = $derived(sessionType === "task");
  // Show title if available, otherwise fall back to workspace/job name
  const displayName = $derived(
    isTask ? `Task: ${title ?? parentTitle ?? "Conversation"}` : (title ?? workspaceName ?? job),
  );
</script>

<div class="component">
  <div class="header">
    <div class="group author">
      {displayName}
    </div>
  </div>

  <div class="details">
    <span class="message">{formatChatDate(createdAt)}</span>
  </div>
</div>

<style>
  .component {
    overflow: hidden;
  }

  .header {
    align-items: center;
    display: flex;
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    justify-content: start;
    inline-size: 100%;
    overflow: hidden;
  }

  .details {
    align-items: center;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    opacity: 0.7;
    margin-block-start: var(--size-0-5);
  }

  .author {
    flex: none;
  }

  .group {
    align-items: center;
    display: flex;
    gap: var(--size-1);
    justify-content: start;
    overflow: hidden;
    text-overflow: ellipsis;

    & :global(svg) {
      flex: none;
    }
  }

  .message {
    font-weight: var(--font-weight-4);
    max-inline-size: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
