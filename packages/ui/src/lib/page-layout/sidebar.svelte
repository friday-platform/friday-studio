<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<aside class="sidebar" data-friday-pagelayout-sidebar>
  {@render children()}
</aside>

<style>
  .sidebar {
    inline-size: var(--size-72);
    min-inline-size: 0;
  }
</style>
