<script lang="ts">
import type { Snippet } from "svelte";

type Props = { children: Snippet };

let { children }: Props = $props();
</script>

<div>
  {@render children()}
</div>

<style>
  div {
    block-size: var(--size-8);
    color: var(--text-3);
    cursor: default;
    display: flex;
    flex: none;
    flex-direction: column;
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    justify-content: center;
    padding-inline: var(--size-3);
    position: relative;
    text-align: left;
    transition: color 150ms ease;
    outline: none;
    z-index: 0;
  }
</style>
