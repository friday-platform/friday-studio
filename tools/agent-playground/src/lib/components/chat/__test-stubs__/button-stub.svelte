<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    onclick?: () => void;
    disabled?: boolean;
    variant?: string;
    children?: Snippet;
    [key: string]: unknown;
  }
  let { onclick, disabled, children, variant: _variant, ...rest }: Props = $props();
</script>

<button {onclick} {disabled} {...rest}>
  {#if children}{@render children()}{/if}
</button>
