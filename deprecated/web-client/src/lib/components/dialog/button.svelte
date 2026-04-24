<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
  import { getContext } from "./context";

  const { close } = getContext();
  type Props = { children: Snippet; closeOnClick?: boolean };

  let {
    children,
    closeOnClick = true,
    ...rest
  }: Props & HTMLButtonAttributes & HTMLAnchorAttributes = $props();
</script>

{#if closeOnClick}
  <button {...rest} {...$close} use:close>
    {@render children()}
  </button>
{:else}
  <button {...rest}>
    {@render children()}
  </button>
{/if}

<style>
  button {
    background: var(--color-surface-1);
    block-size: var(--size-7);
    border-radius: var(--radius-3);
    box-shadow: var(--shadow-1);
    display: inline-block;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    outline: none;
    inline-size: 100%;
    transition: background-color 150ms ease;

    &:focus {
      outline: none;
    }

    &:hover {
      background-color: color-mix(in srgb, var(--color-surface-1), var(--color-surface-2) 50%);
    }

    &:focus-visible {
      border-radius: var(--radius-2);
      outline: 1px solid var(--color-text);
      z-index: var(--layer-1);
    }
  }
</style>
