<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { invalidateAll } from "$app/navigation";
  import Button from "$lib/components/button.svelte";
  import { IconSmall } from "$lib/components/icons/small";
  import { formatChatDate } from "$lib/utils/date";

  let {
    workspaceId,
    pendingRevision,
  }: {
    workspaceId: string;
    pendingRevision: {
      artifactId: string;
      revision: number;
      summary: string;
      triageReasoning: string;
      createdAt: string;
    };
  } = $props();

  let loading = $state<"approve" | "reject" | null>(null);
  let error = $state<string | null>(null);
  let showReasoning = $state(false);

  const queryClient = useQueryClient();

  async function handleApprove() {
    loading = "approve";
    error = null;

    const res = await parseResult(
      client.workspace[":workspaceId"]["pending-revision"].approve.$post({
        param: { workspaceId },
      }),
    );

    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
      await invalidateAll();
    } else {
      error = "Failed to approve revision";
    }

    loading = null;
  }

  async function handleReject() {
    loading = "reject";
    error = null;

    const res = await parseResult(
      client.workspace[":workspaceId"]["pending-revision"].reject.$post({ param: { workspaceId } }),
    );

    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
      await invalidateAll();
    } else {
      error = "Failed to reject revision";
    }

    loading = null;
  }
</script>

<div class="pending-revision">
  <div class="header">
    <span class="badge">
      <IconSmall.Progress />
      Suggested Fix
    </span>
    <time>{formatChatDate(pendingRevision.createdAt)}</time>
  </div>

  <p class="summary">{pendingRevision.summary}</p>

  <button class="reasoning-toggle" onclick={() => (showReasoning = !showReasoning)}>
    {showReasoning ? "Hide" : "Show"} triage reasoning
  </button>

  {#if showReasoning}
    <p class="reasoning">{pendingRevision.triageReasoning}</p>
  {/if}

  {#if error}
    <p class="error">{error}</p>
  {/if}

  <div class="actions">
    <Button size="small" onclick={handleApprove} disabled={loading !== null}>
      {loading === "approve" ? "Applying..." : "Approve & Apply"}
    </Button>
    <Button size="small" variant="secondary" onclick={handleReject} disabled={loading !== null}>
      {loading === "reject" ? "Rejecting..." : "Dismiss"}
    </Button>
  </div>
</div>

<style>
  .pending-revision {
    background: color-mix(in srgb, var(--color-yellow) 5%, transparent);
    border: var(--size-px) solid color-mix(in srgb, var(--color-yellow) 20%, transparent);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .header {
    align-items: center;
    display: flex;
    justify-content: space-between;

    time {
      font-size: var(--font-size-1);
      opacity: 0.5;
    }
  }

  .badge {
    align-items: center;
    background: color-mix(in srgb, var(--color-yellow) 15%, transparent);
    border-radius: var(--radius-2-5);
    color: var(--color-yellow-2);
    display: inline-flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    gap: var(--size-1);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-1-5);
    white-space: nowrap;
  }

  .summary {
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
  }

  .reasoning-toggle {
    background: none;
    border: none;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-1);
    inline-size: max-content;
    padding: 0;
    text-decoration: underline;
    text-decoration-color: transparent;
    transition: text-decoration-color 150ms ease;

    &:hover {
      text-decoration-color: currentColor;
    }
  }

  .reasoning {
    background: color-mix(in srgb, var(--color-text), transparent 95%);
    border-radius: var(--radius-2);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    opacity: 0.7;
    padding: var(--size-2);
  }

  .error {
    color: var(--color-red);
    font-size: var(--font-size-2);
  }

  .actions {
    display: flex;
    gap: var(--size-2);
    margin-block-start: var(--size-1);
  }
</style>
