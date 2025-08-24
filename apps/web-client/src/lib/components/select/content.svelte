<script lang="ts">
import type { Snippet } from "svelte";
import { expoOut } from "svelte/easing";
import type { HTMLAttributes } from "svelte/elements";
import { scale } from "svelte/transition";
import { getContext } from "./context";

const { menu, open } = getContext();
const { children, ...rest }: { children: Snippet } & HTMLAttributes<HTMLDivElement> = $props();
</script>

{#if $open}
  <div
    data-tempest
    class="component"
    {...$menu}
    use:menu
    in:scale={{ duration: 150, start: 0.96, easing: expoOut }}
    out:scale={{ start: 0.96, duration: 250, easing: expoOut }}
    {...rest}
  >
    {@render children()}
  </div>
{/if}

<style>
  .component {
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    background-color: color-mix(in srgb, var(--background-1), transparent 20%);
    border-radius: var(--radius-3);
    box-shadow: var(--shadow-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    min-inline-size: var(--size-32);
    overflow: auto;
    padding-block: var(--size-1);
    transform-origin: 0 0;
    z-index: var(--layer-4);
  }
</style>
