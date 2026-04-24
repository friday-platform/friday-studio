<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";
  import type { Snippet } from "svelte";

  type Props = {
    href?: string;
    children: Snippet;
    faded?: boolean;
    showCaret?: boolean;
    prepend?: Snippet;
  };

  let { href = undefined, children, faded = true, showCaret = false, prepend }: Props = $props();
</script>

{#snippet contents()}
  {#if showCaret}
    <IconSmall.CaretLeft />
  {/if}

  <span>
    {#if prepend}
      {@render prepend()}
    {/if}

    {@render children()}
  </span>
{/snippet}

{#if href}
  <a class="item" {href}>
    {@render contents()}
  </a>
{:else}
  <span class="item" class:faded>
    {@render contents()}
  </span>
{/if}

<style>
  .item {
    align-items: center;
    block-size: var(--size-6);
    border-radius: var(--radius-3);
    cursor: default;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    font-weight: var(--font-weight-5);
    inline-size: max-content;
    justify-content: start;
    margin-inline: calc(-1 * var(--size-1)) calc(-1 * var(--size-2));
    padding-inline: var(--size-2);
    padding-block: var(--size-1);
    transition: all 150ms ease;

    & :global(> svg) {
      opacity: 0.5;
    }

    span {
      align-items: center;
      display: flex;
      gap: var(--size-1-5);
    }
  }

  a {
    outline: none;
    position: relative;
  }

  .item:matches(a):focus-visible,
  .item:matches(a):hover {
    background-color: var(--color-surface-2);
  }

  span.faded {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
  }
</style>
