<script lang="ts">
  import { Icons } from "$lib/components/icons";

  type Props = { onclick: () => void };

  let { onclick }: Props = $props();
</script>

<button type="button" class="remove-button" {onclick} aria-label="Remove entry">
  <Icons.Trash />
</button>

<style>
  .remove-button {
    align-items: center;
    background: none;
    block-size: var(--size-7);
    border-radius: var(--radius-3);
    box-shadow: none;
    color: color-mix(in srgb, var(--color-text) 80%, transparent);
    display: flex;
    inline-size: var(--size-8);
    justify-content: center;
    margin-inline-start: auto;
    opacity: 0;
    padding: 0;
    transition:
      opacity 0.2s ease,
      color 0.2s ease;
  }

  .remove-button:hover {
    background: none;
    color: var(--color-red);
  }

  :global(.row:hover) .remove-button,
  .remove-button:focus {
    opacity: 1;
    outline: none;
  }
</style>
