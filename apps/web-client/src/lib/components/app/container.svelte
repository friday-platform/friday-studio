<script lang="ts">
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";

  let { children }: { children: Snippet } = $props();
  let mounted = $state(false);

  onMount(() => {
    // avoids the sidebar animating open if its open by default via localStorage
    setTimeout(() => {
      mounted = true;
    }, 100);
  });
</script>

<div class:mounted>
  {@render children()}
</div>

<style>
  div {
    block-size: 100dvh;
    display: grid;
    /* grid-template-columns: calc(var(--size-23) + var(--size-px)) 1fr; */
    grid-template-columns: var(--size-56) 1fr;
    flex-direction: column;

    &.mounted {
      transition: all 0.2s ease-in-out;
    }
  }
</style>
