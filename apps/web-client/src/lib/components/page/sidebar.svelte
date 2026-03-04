<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<aside class="sidebar" data-friday-page-sidebar>
  {@render children()}
</aside>

<style>
  .sidebar {
    border-inline-start: var(--size-px) solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-10);
    inline-size: 100%;
    min-inline-size: var(--size-80);
    overflow: auto;
    padding: var(--size-10);
    scrollbar-width: thin;
  }
</style>
