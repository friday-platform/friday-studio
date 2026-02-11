<script lang="ts">
  import type { Snippet } from "svelte";
  import { sineOut } from "svelte/easing";
  import { slide } from "svelte/transition";
  import { getContext } from "./context";

  const { content, open } = getContext();

  type Props = { children: Snippet; animate?: boolean };

  let { animate = false, children }: Props = $props();
</script>

{#if $open}
  <div
    class="animate-{animate}"
    transition:slide={{ duration: animate ? 150 : 0, easing: sineOut }}
    use:content
    {...$content}
  >
    {@render children()}
  </div>
{/if}

<style>
  .animate-true {
    overflow: hidden;
  }
</style>
