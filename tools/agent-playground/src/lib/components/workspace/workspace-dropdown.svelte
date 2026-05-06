<script lang="ts">
  import { DropdownMenu, IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { workspaceQueries } from "$lib/queries";

  interface Props {
    selected: string;
  }
  const { selected }: Props = $props();

  const workspacesQuery = createQuery(() => workspaceQueries.enriched());

  const workspaces = $derived(
    [...(workspacesQuery.data ?? [])].sort((a, b) => {
      if (a.id === "user") return -1;
      if (b.id === "user") return 1;
      return 0;
    }),
  );

  const activeWorkspace = $derived(workspaces.find((ws) => ws.id === selected));

  const COLORS: Record<string, string> = {
    yellow: "var(--yellow-2, #facc15)",
    purple: "var(--purple-2, #a78bfa)",
    red: "var(--red-2, #f87171)",
    blue: "var(--blue-2, #60a5fa)",
    green: "var(--green-2, #4ade80)",
    brown: "var(--brown-2, #a3824a)",
  };

  function dotColor(color: string | undefined): string {
    return COLORS[color ?? "yellow"] ?? COLORS["yellow"] ?? "#facc15";
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class="ws-trigger">
    <span class="dot" style:--dot-color={dotColor(activeWorkspace?.metadata?.color)}></span>
    <span class="name">{activeWorkspace?.displayName ?? selected}</span>
    <IconSmall.CaretDown />
  </DropdownMenu.Trigger>

  <DropdownMenu.Content size="regular">
    <DropdownMenu.List>
      {#each workspaces as ws (ws.id)}
        <DropdownMenu.Item href="/platform/{ws.id}/chat" radio checked={ws.id === selected}>
          {#snippet prepend()}
            <span class="dot" style:--dot-color={dotColor(ws.metadata?.color)}></span>
          {/snippet}
          {ws.displayName}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.List>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  :global(.ws-trigger) {
    align-items: center;
    background: var(--highlight);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text-bright);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    inline-size: 100%;
    min-block-size: var(--size-7);
    padding-block: var(--size-1);
    padding-inline: var(--size-2);
  }

  :global(.ws-trigger:hover) {
    background: var(--highlight-bright);
  }

  .dot {
    background-color: var(--dot-color);
    block-size: var(--size-2);
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: var(--size-2);
  }

  .name {
    flex: 1;
    overflow: hidden;
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
