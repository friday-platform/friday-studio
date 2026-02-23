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
    background: radial-gradient(
      ellipse,
      var(--color-surface-1) 50%,
      color-mix(in srgb, var(--color-surface-1), transparent 100%)
    );
    align-items: center;
    border-radius: var(--radius-4);
    display: flex;
    gap: var(--size-3);
    inline-size: fit-content;
    margin-inline: var(--size-2-5);
    padding-block: var(--size-1-5);
    padding-inline: var(--size-2-5);
    position: relative;
    z-index: var(--layer-4);

    -webkit-user-select: none;
    -moz-user-select: none;
    user-select: none;

    &.fixed {
      /* background: linear-gradient(to bottom, var(--color-surface-1) 75%, transparent); */
      position: sticky;
      inset-block-start: var(--size-2-5);
      z-index: var(--layer-2);
    }
  }
</style>
