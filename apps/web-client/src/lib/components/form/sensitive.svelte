<script lang="ts">
import { hasContext } from "svelte";
import type { HTMLInputAttributes } from "svelte/elements";
import { CustomIcons } from "$lib/components/icons/custom";
import { FIELD_CONTEXT, getFieldContext } from "./context";

type Props = { value?: string | number; variant?: "small" | "regular" };

let { value = $bindable(), variant = "regular", ...rest }: Props & HTMLInputAttributes = $props();

let id = $state<string>();

if (hasContext(FIELD_CONTEXT)) {
  id = getFieldContext().id;
}

let visible = $state(false);
</script>

<div>
  <input
    {id}
    class={variant}
    bind:value
    data-1p-ignore="true"
    autocapitalize="off"
    autocorrect="off"
    autocomplete="new-password"
    type={visible ? "text" : "password"}
    spellcheck={false}
    {...rest}
  />
  <button type="button" onclick={() => (visible = !visible)}>
    {#if visible}
      <CustomIcons.Eye />
    {:else}
      <CustomIcons.EyeClosed />
    {/if}
  </button>
</div>

<style>
  div {
    position: relative;
  }

  button {
    align-items: center;
    color: var(--text-3);
    display: flex;
    position: absolute;
    top: 0;
    right: var(--size-3);
    height: 100%;
    padding: var(--size-3);
    margin: 0;
    opacity: 0.6;
    transition: all 150ms ease;
    &:hover {
      opacity: 1;
    }
  }

  input {
    background-color: var(--background-1);
    border-radius: var(--radius-2);
    border: 1px solid var(--border-2);
    block-size: var(--size-8);
    inline-size: 100%;
    padding-inline-start: var(--size-3);
    padding-inline-end: var(--size-9);
    outline: none;
  }

  input::placeholder {
    color: var(--text-3);
  }

  input.small {
    block-size: var(--size-6);
    font-size: var(--font-size-2);
    padding-inline: var(--size-2);
  }

  input:focus-visible {
    border-color: var(--border-3);
  }
</style>
