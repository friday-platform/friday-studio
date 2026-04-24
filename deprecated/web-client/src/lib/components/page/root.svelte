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
    inline-size: 100%;

    &:global(:has([data-friday-page-sidebar])) {
      grid-template-columns: 1fr var(--size-80);

      @media (min-width: 1156px) {
        grid-template-columns: 1fr var(--size-96);
      }

      @media (min-width: 1920px) {
        grid-template-columns: 1fr var(--size-112);
      }
    }

    > :global(:only-child) {
      grid-column: 1 / -1;
    }
  }
</style>
