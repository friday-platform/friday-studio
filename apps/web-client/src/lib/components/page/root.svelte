<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="wrapper">
  {@render children()}
</div>

<style>
  .wrapper {
    block-size: 100%;
    display: grid;
    grid-template-columns: 2fr minmax(var(--size-80), 1fr);
    inline-size: 100%;

    @media (min-width: 1920px) {
      grid-template-columns: 1fr var(--size-112);
    }
  }
</style>
