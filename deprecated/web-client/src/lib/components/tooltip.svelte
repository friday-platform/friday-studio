<script lang="ts">
  import { createTooltip } from "@melt-ui/svelte";
  import type { Snippet } from "svelte";
  import { fade } from "svelte/transition";

  type Props = {
    children: Snippet;
    label?: string;
    as?: "span" | "div";
    size?: "auto" | "small";
    // useful for info tooltips where we don't want to close on click
    closeOnPointerDown?: boolean;
    openDelay?: number;
  };

  let {
    as = "div",
    children,
    label,
    size = "auto",
    closeOnPointerDown = true,
    openDelay = 375,
  }: Props = $props();

  const {
    elements: { trigger, content },
    states: { open },
  } = createTooltip({
    positioning: { placement: "top" },
    openDelay,
    closeDelay: 0,
    forceVisible: true,
    closeOnPointerDown,
  });
</script>

{#if as === "span"}
  <span data-tempest-tooltip class="container" use:trigger {...$trigger}>
    {@render children()}
  </span>
{:else}
  <div data-tempest-tooltip class="container" use:trigger {...$trigger}>
    {@render children()}
  </div>
{/if}

{#if $open && label}
  <div class="tooltip size--{size}" {...$content} use:content transition:fade={{ duration: 100 }}>
    <p>{label}</p>
  </div>
{/if}

<style>
  .container {
    inline-size: max-content;
    max-inline-size: 100%;
  }

  .tooltip {
    background-color: var(--color-surface-1);
    border-radius: var(--radius-1);
    box-shadow: var(--shadow-1);
    color: var(--text-3);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-4);
    padding-block: var(--size-1);
    padding-inline: var(--size-2);
    text-align: center;
    z-index: var(--layer-5);

    &.size--small {
      border-radius: var(--radius-2);
      max-inline-size: var(--size-56);
      padding-block: var(--size-2);
    }
  }
</style>
