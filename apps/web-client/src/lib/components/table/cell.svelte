<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  type Props = HTMLAttributes<HTMLDivElement> & {
    children?: Snippet;
    align?: "left" | "center" | "right" | "full";
    weight?: "regular" | "bold";
    size?: "small" | "regular";
    variant?: "faded" | "regular";
    maxWidth?: string;
    width?: string;
    inset?: number;
  };

  let {
    children,
    align = "left",
    size = "regular",
    weight = "regular",
    variant = "regular",
    maxWidth = "none",
    width = "revert-layer",
    inset = 0,
    ...rest
  }: Props = $props();
</script>

<div
  class="cell align--{align} weight--{weight} variant--{variant} size--{size}"
  style:max-inline-size={maxWidth}
  style:inline-size={width}
  style:--cell-additional-padding="{inset * 32}px"
  {...rest}
>
  {#if children}
    {@render children()}
  {/if}
</div>

<style>
  div {
    align-items: center;
    block-size: var(--size-10);
    display: flex;
    overflow: hidden;
    position: relative;
    white-space: nowrap;

    &.align--center {
      justify-content: center;
      text-align: center;
    }

    &.align--right {
      justify-content: end;
      text-align: end;

      :global(& > *) {
        margin-inline-start: auto;
      }
    }

    &.align--full {
      justify-content: stretch;
      text-align: center;

      & :global([data-tempest-tooltip]),
      & :global([data-tempest-tag]) {
        flex-grow: 1;
        inline-size: 100%;
      }
    }

    &.weight--bold {
      font-weight: 500;
    }

    &.variant--faded {
      opacity: 0.7;
    }

    &.size--small {
      font-size: var(--font-size-2);
    }
  }
</style>
