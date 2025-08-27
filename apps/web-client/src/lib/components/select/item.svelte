<script lang="ts">
import type { Snippet } from "svelte";
import { Icons } from "$lib/components/icons";
import { getContext } from "./context";

const { option, isSelected } = getContext();

type Props = { children: Snippet; value: string | null; label?: string; disabled?: boolean };

let { children, label, value, disabled = false }: Props = $props();
</script>

<div class="option" {...$option({ value, label: label || String(value), disabled })} use:option>
  {@render children()}

  <div class="check" class:visible={$isSelected(value)}>
    <Icons.Check />
  </div>
</div>

<style>
  .option {
    align-items: center;
    block-size: var(--size-8);
    display: flex;
    flex: none;
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    justify-content: space-between;
    padding-inline: var(--size-3);
    position: relative;
    outline: none;
    transition: all 75ms ease;

    &:before {
      background-color: var(--highlight-2);
      border-radius: var(--radius-2);
      content: "";
      position: absolute;
      opacity: 0;
      inset-block: 0;
      inset-inline: var(--size-1);
    }

    &[data-highlighted]:before {
      opacity: 1;
    }

    &[data-disabled="true"] {
      opacity: 0.5;
    }

    & :global(svg) {
      color: var(--accent-1);
    }

    &[aria-disabled="true"] {
      opacity: 0.5;
    }
  }

  .check {
    visibility: hidden;

    &.visible {
      visibility: visible;
    }
  }
</style>
