<script lang="ts">
import { hasContext, type Snippet } from "svelte";
import type { HTMLSelectAttributes } from "svelte/elements";
import type { JsonValue } from "$lib/utils/json-schema";
import CaretDown from "../icons/caret-down.svelte";
import { FIELD_CONTEXT, getFieldContext } from "./context";

type Props = {
  children: Snippet;
  value?: JsonValue;
  variant?: "small" | "regular";
  width?: "fill" | "auto";
};

let {
  children,
  variant = "regular",
  width = "fill",
  value = $bindable(),
  ...rest
}: Props & HTMLSelectAttributes = $props();

let id = $state<string>();

if (hasContext(FIELD_CONTEXT)) {
  id = getFieldContext().id;
}
</script>

<div class="{variant} width--{width}">
  <select {id} bind:value data-1p-ignore="true" {...rest}>
    {@render children()}
  </select>

  <CaretDown inert />
</div>

<style>
  div {
    align-items: center;
    background-color: var(--background-1);
    border-radius: var(--radius-2);
    box-shadow: var(--shadow-1);
    block-size: var(--size-7);
    display: flex;
    inline-size: 100%;
    position: relative;

    &.width--auto {
      max-inline-size: max-content;
    }
  }

  div.small {
    block-size: var(--size-6);
    font-size: var(--font-size-2);
  }

  div :global(svg) {
    opacity: 0.4;
    position: absolute;
    pointer-events: none;
    inset-inline-end: var(--size-1-5);
  }

  select {
    appearance: none;
    background-color: transparent;
    border: 1px solid transparent;
    block-size: 100%;
    inline-size: 100%;
    outline: none;
    overflow: hidden;
    padding-inline: var(--size-2) var(--size-6);
    text-overflow: ellipsis;
  }

  div.small select {
    font-size: var(--font-size-2);
    padding-inline: var(--size-2) var(--size-5);
  }

  div:has(select:focus-visible) {
    outline: var(--size-px) solid var(--accent-1);
  }

  div:has(select[disabled]) {
    opacity: 0.65;
  }

  div:not(:has(select[disabled])):hover {
    outline: var(--size-px) solid var(--border-3);
  }
</style>
