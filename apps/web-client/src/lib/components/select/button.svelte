<script lang="ts">
  import type { Snippet } from "svelte";
  import CaretDown from "../icons/caret-down.svelte";
  import { getContext } from "./context";

  type Props = { children: Snippet; variant?: "small" | "regular"; width?: "fill" | "auto" };

  let { children, variant = "regular", width = "fill" }: Props = $props();

  const { selectedLabel } = getContext();
</script>

<div class="{variant} width--{width}">
  {#if $selectedLabel}
    {$selectedLabel}
  {:else}
    {@render children()}
  {/if}

  <CaretDown inert />
</div>

<style>
  div {
    align-items: center;
    background-color: var(--background-1);
    border-radius: var(--radius-2);
    box-shadow: var(--shadow-1);
    block-size: var(--size-7-5);
    display: flex;
    font-weight: var(--font-weight-5);
    inline-size: 100%;
    padding-inline: var(--size-2) var(--size-8);
    position: relative;

    &.width--auto {
      max-inline-size: max-content;
    }
  }

  div.small {
    block-size: var(--size-6);
    font-size: var(--font-size-2);
    padding-inline: var(--size-2) var(--size-6);
  }

  div :global(svg) {
    opacity: 0.4;
    position: absolute;
    pointer-events: none;
    inset-inline-end: var(--size-1-5);
  }
</style>
