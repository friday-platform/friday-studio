<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLLabelAttributes } from "svelte/elements";

type Props = {
  children: Snippet;
  inline?: boolean;
  label: string;
  required?: boolean;
} & HTMLLabelAttributes;

let { children, inline = false, label, required = false, ...rest }: Props = $props();
</script>

<label class={inline ? "inline" : ""} {...rest}>
  <span>
    {label}
    {#if required}
      <span class="required">*</span>
    {/if}
  </span>

  {@render children()}
</label>

<style>
  label {
    display: flex;
    flex-direction: column;
    inline-size: 100%;
    gap: var(--size-1);
  }

  label.inline {
    flex-direction: row;
    justify-content: space-between;
  }

  label.inline :global(span) {
    inline-size: var(--size-32);
    line-height: var(--font-lineheight-1);
    padding-block-start: var(--size-2);
  }

  label.inline :global(> input:not([type="checkbox"])),
  label.inline :global(> input:not([type="radio"])),
  label.inline :global(> textarea),
  label.inline :global(> select),
  label.inline :global(> div) {
    flex: 1 1 auto;
  }

  span {
    font-weight: var(--font-weight-5);
  }

  .required {
    color: var(--accent-2);
  }
</style>
