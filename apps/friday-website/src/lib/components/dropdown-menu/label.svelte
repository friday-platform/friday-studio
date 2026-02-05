<script lang="ts">
import type { Snippet } from "svelte";

type Props = { children: Snippet };

let { children }: Props = $props();
</script>

<span>
  {@render children()}
</span>

<style>
  span {
    align-items: center;
    block-size: var(--size-6);
    color: var(--color-text-1);
    display: flex;
    flex: none;
    inline-size: max-content;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    opacity: 0.5;
    padding-block-start: var(--size-1);
    padding-inline: var(--size-3);
    gap: var(--size-1);
  }
</style>
