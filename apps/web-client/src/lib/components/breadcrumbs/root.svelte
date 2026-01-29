<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = { children: Snippet };

  let { children }: Props = $props();
</script>

<div>
  {@render children()}
</div>

<style>
  div {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    inline-size: fit-content;
    padding-block: var(--size-3-5) var(--size-1);
    padding-inline: var(--size-6);
    position: relative;
    z-index: var(--layer-4);

    -webkit-user-select: none;
    -moz-user-select: none;
    user-select: none;
  }
</style>
