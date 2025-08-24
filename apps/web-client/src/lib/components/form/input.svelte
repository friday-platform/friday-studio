<script lang="ts">
import { hasContext } from "svelte";
import type { HTMLInputAttributes } from "svelte/elements";
import { FIELD_CONTEXT, getFieldContext } from "./context";

type Props = { value?: string | number; variant?: "small" | "regular"; readOnly?: boolean };

const {
  value = $bindable(),
  variant = "regular",
  readOnly = false,
  ...rest
}: Props & HTMLInputAttributes = $props();

let id = $state<string>();

if (hasContext(FIELD_CONTEXT)) {
  id = getFieldContext().id;
}
</script>

{#if readOnly}
  <span class="read-only-field">
    {value}
  </span>
{:else}
  <input
    {id}
    class={variant}
    bind:value
    data-1p-ignore="true"
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
    spellcheck={false}
    {...rest}
  />
{/if}

<style>
  input {
    background-color: var(--background-1);
    border-radius: var(--radius-2);
    border: 1px solid var(--border-2);
    block-size: var(--size-8);
    inline-size: 100%;
    padding-inline: var(--size-3);
    outline: none;

    &[disabled] {
      background-color: var(--background-2);
      color: var(--text-3);
      cursor: not-allowed;
    }
  }

  .read-only-field {
    font-weight: var(--font-weight-5);
  }

  input::placeholder {
    color: color-mix(in srgb, var(--text-3), transparent 20%);
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
