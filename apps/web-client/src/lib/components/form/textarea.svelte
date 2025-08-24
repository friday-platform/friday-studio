<script lang="ts">
import { hasContext } from "svelte";
import type { HTMLTextareaAttributes } from "svelte/elements";
import { FIELD_CONTEXT, getFieldContext } from "./context";

type Props = { value?: string; variant?: "regular" | "large" };

const {
  value = $bindable(),
  variant = "regular",
  ...rest
}: Props & HTMLTextareaAttributes = $props();

let id = $state<string>();

if (hasContext(FIELD_CONTEXT)) {
  id = getFieldContext().id;
}
</script>

<textarea class="variant--{variant}" {id} bind:value data-1p-ignore="true" {...rest}></textarea>

<style>
  textarea {
    background-color: var(--background-1);
    border-radius: var(--radius-2);
    border: 1px solid var(--border-2);
    block-size: var(--size-16);
    inline-size: 100%;
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
    outline: none;
    resize: none;

    &.variant--large {
      block-size: var(--size-32);
    }
  }

  textarea::placeholder {
    color: color-mix(in srgb, var(--text-3), transparent 20%);
  }

  textarea:focus-visible {
    border-color: var(--border-3);
  }
</style>
