<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="root">
  {@render children()}
</div>

<style>
  .root {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    inline-size: 100%;
    position: relative;
    overflow: hidden;
  }
</style>
