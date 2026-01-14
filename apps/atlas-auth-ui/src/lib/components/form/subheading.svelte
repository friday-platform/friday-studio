<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<span>
  {@render children()}
</span>

<style>
  span {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }
</style>
