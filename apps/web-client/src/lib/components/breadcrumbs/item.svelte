<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = { href?: string; children: Snippet; highlighted?: boolean; prepend?: Snippet };

  let { href = undefined, children, highlighted = true, prepend }: Props = $props();
</script>

{#snippet contents()}
  {#if prepend}
    {@render prepend()}
  {/if}
  {@render children()}
{/snippet}

{#if href}
  <a class="item" {href}>
    {@render contents()}
  </a>
{:else}
  <span class="item" class:highlighted>
    {@render contents()}
  </span>
{/if}

<style>
  .item {
    align-items: center;
    block-size: var(--size-6);
    border-radius: var(--radius-3);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: default;
    display: flex;
    flex: 1 1 auto;
    font-weight: var(--font-weight-5);
    inline-size: max-content;
    margin-inline: calc(-1 * var(--size-2));
    padding-inline: var(--size-2);
    padding-block: var(--size-1);
    transition: all 150ms ease;
  }

  a {
    outline: none;
    position: relative;
  }

  .item:matches(a):focus-visible,
  .item:matches(a):hover {
    background-color: var(--color-surface-2);
  }

  span.highlighted {
    opacity: 1;
  }
</style>
