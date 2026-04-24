<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = { children: Snippet; fixed?: boolean };

  let { children, fixed = false }: Props = $props();
</script>

<div class:fixed>
  {@render children()}
</div>

<style>
  div {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    inline-size: 100%;
    padding-block: var(--size-1-5);
    padding-inline: var(--size-5);
    position: relative;
    z-index: var(--layer-4);

    -webkit-user-select: none;
    -moz-user-select: none;
    user-select: none;

    &.fixed {
      background: color-mix(in srgb, var(--color-surface-1), transparent 8%);
      backdrop-filter: blur(8px);
      -webkit-mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 1) 70%, rgba(0, 0, 0, 0));
      mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 1) 70%, rgba(0, 0, 0, 0));
      margin-block-end: calc(-1 * var(--size-6));
      position: sticky;
      inset-block-start: 0;
      padding-block: var(--size-4);
      z-index: var(--layer-2);
    }
  }
</style>
