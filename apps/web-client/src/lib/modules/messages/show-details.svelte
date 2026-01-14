<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";

  const { onclick, open }: { onclick: () => void; open: boolean } = $props();
</script>

<button type="button" {onclick} class:open>
  {open ? "Hide Details" : "Show Details"}

  <IconSmall.CaretRight />
</button>

<style>
  button {
    align-items: center;
    display: flex;
    color: color-mix(in srgb, var(--color-text) 80%, transparent);
    gap: var(--size-1);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    margin-block-start: var(--size-2);
    transition: opacity 250ms ease;

    & :global(svg) {
      opacity: 0.7;
      transition: transform 150ms ease-in-out;
    }

    &.open :global(svg) {
      transform: rotate(90deg);
    }
  }
</style>
