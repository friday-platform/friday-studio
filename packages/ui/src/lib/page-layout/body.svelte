<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="body">
  {@render children()}
</div>

<style>
  .body {
    flex: 1;
    min-block-size: 0;
    overflow: auto;
    padding-block: var(--size-16) var(--size-12);
    padding-inline: var(--size-12);
    scrollbar-width: thin;

    &:global(:has([data-friday-page-layout-sidebar])) {
      column-gap: var(--size-24);
      display: grid;
      grid-template-columns: 1fr auto;
    }
  }
</style>
