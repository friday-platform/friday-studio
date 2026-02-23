<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<aside class="sidebar">
  {@render children()}
</aside>

<style>
  .sidebar {
    border-inline-start: var(--size-px) solid var(--accent-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-10);
    inline-size: 100%;
    min-inline-size: var(--size-80);
    padding: var(--size-10);
  }
</style>
