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
    block-size: var(--size-16);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    margin-block: calc(-1 * var(--size-1)) var(--size-1);
    padding-block: var(--size-1);
  }
</style>
