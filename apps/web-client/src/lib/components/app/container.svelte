<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div>
  {@render children()}
</div>

<style>
  div {
    block-size: 100dvh;
    display: grid;
    grid-template-columns: var(--size-56) 1fr;
    flex-direction: column;

    @media (min-width: 1920px) {
      grid-template-columns: var(--size-72) 1fr;
    }
  }
</style>
