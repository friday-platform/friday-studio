<!--
  Re-setup banner — shows when a workspace's `requires_setup` flag is true and
  no `active_setup_session_id` is set (Decision 4: re-setup is agent-driven,
  not redirect-driven). Operational pages still load; this sits above them.

  @component
-->
<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { workspaceQueries } from "$lib/queries";

  type Props = { workspaceId: string | null };
  const { workspaceId }: Props = $props();

  const detailQuery = createQuery(() => workspaceQueries.detail(workspaceId));

  const showBanner = $derived.by(() => {
    const data = detailQuery.data;
    if (!data) return false;
    if (!data.requires_setup) return false;
    return !data.metadata?.active_setup_session_id;
  });

  const chatHref = $derived(workspaceId ? `/platform/${workspaceId}/chat` : "#");
</script>

{#if showBanner}
  <div class="setup-banner" role="status" aria-live="polite" data-testid="workspace-setup-banner">
    <span class="dot" aria-hidden="true"></span>
    <span class="message">This workspace has setup gaps —</span>
    <a class="cta" href={chatHref}>chat with Friday to fix</a>
  </div>
{/if}

<style>
  .setup-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-warning, #d29922), transparent 82%);
    border-block-end: 1px solid color-mix(in srgb, var(--color-warning, #d29922), transparent 60%);
    color: var(--color-text);
    display: flex;
    flex: 0 0 auto;
    font-size: var(--font-size-3);
    gap: var(--size-2);
    inline-size: 100%;
    padding-block: var(--size-2);
    padding-inline: var(--size-4);
  }

  .dot {
    background: var(--color-warning, #d29922);
    block-size: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
    inline-size: 8px;
  }

  .message {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
  }

  .cta {
    color: var(--color-text);
    font-weight: var(--font-weight-6);
    text-decoration: underline;
  }

  .cta:hover {
    text-decoration: none;
  }
</style>
