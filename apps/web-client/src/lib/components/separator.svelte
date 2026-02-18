<script lang="ts">
  type Props = { as?: string; orientation?: "horizontal" | "vertical" };

  let { as = "div", orientation = "horizontal" }: Props = $props();
</script>

<svelte:element
  this={as}
  class="separator"
  role="presentation"
  aria-hidden="true"
  data-orientation={orientation}
/>

<style>
  /* Defaults */
  .separator {
    background-color: var(--color-border-1);
    flex-shrink: 0;
  }

  /* Horizontal */
  .separator[data-orientation="horizontal"] {
    block-size: 1px;
    inline-size: var(--separator-size, 100%);
  }

  /* Vertical */
  .separator[data-orientation="vertical"] {
    block-size: var(--separator-size, 100%);
    inline-size: 1px;
  }
</style>
