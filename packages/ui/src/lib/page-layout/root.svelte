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

    /* Shell mode: when a sidebar is a direct child of Root (workspace-level
       persistent sidebar), switch to a responsive 2-column grid. Sidebars
       nested inside Body are unaffected and keep Body's grid behavior. */
    &:global(:has(> [data-friday-pagelayout-sidebar])) {
      display: grid;
      grid-template-columns: 1fr var(--size-80);

      @media (min-width: 1156px) {
        grid-template-columns: 1fr var(--size-96);
      }

      @media (min-width: 1920px) {
        grid-template-columns: 1fr var(--size-112);
      }

      > :global(:not([data-friday-pagelayout-sidebar])) {
        min-block-size: 0;
        overflow: hidden;
      }

      > :global([data-friday-pagelayout-sidebar]) {
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
    }
  }
</style>
