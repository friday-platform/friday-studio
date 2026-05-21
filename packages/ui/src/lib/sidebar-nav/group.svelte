<!--
  Collapsible group header for `<SidebarNav>`. Renders an uppercase
  namespace label with a caret-down toggle and an optional count badge;
  children render in the expanded content area.

  Used for grouping like the skills tree's `namespace` headers.

  @component
-->

<script lang="ts">
  import type { Snippet } from "svelte";
  import { Collapsible } from "../collapsible/index.js";
  import { IconSmall } from "../icons/small/index.js";

  interface Props {
    label: string;
    count?: number;
    defaultOpen?: boolean;
    children: Snippet;
  }

  let { label, count, defaultOpen = false, children }: Props = $props();
</script>

<Collapsible.Root {defaultOpen}>
  <Collapsible.Trigger>
    {#snippet children(_open)}
      <span class="group-header">
        <IconSmall.CaretDown />
        <span class="group-label">{label}</span>
        {#if count !== undefined}
          <span class="group-count">{count}</span>
        {/if}
      </span>
    {/snippet}
  </Collapsible.Trigger>
  <Collapsible.Content>
    <div class="group-body">
      {@render children()}
    </div>
  </Collapsible.Content>
</Collapsible.Root>

<style>
  .group-header {
    align-items: center;
    block-size: var(--size-4);
    color: var(--text-faded);
    display: flex;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
    gap: var(--size-1);
    letter-spacing: 0.04em;
    margin-block-start: var(--size-2);
    padding-inline: var(--size-1);
    text-transform: uppercase;
  }

  .group-header :global(svg) {
    flex-shrink: 0;
    transform: rotate(-90deg);
    transition: transform 150ms ease;
  }

  :global([data-melt-collapsible-trigger][data-state="open"]) .group-header :global(svg) {
    transform: rotate(0deg);
  }

  .group-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group-count {
    color: var(--text-faded);
    font-size: var(--font-size-1);
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }

  .group-body {
    display: flex;
    flex-direction: column;
  }
</style>
