<script lang="ts">
  import { type Snippet } from "svelte";

  type Props = { children: Snippet };

  let { children }: Props = $props();
</script>

<div class="dropdown-list">
  {@render children()}
</div>

<style>
  .dropdown-list {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    inline-size: 100%;
    max-block-size: min(calc(23.375rem * var(--size-scale)), 70dvh);
    max-inline-size: var(--size-72);
    overflow-x: hidden;
    overflow-y: scroll;
    overscroll-behavior: none;
    padding-block: var(--size-1);
    transform: translate3d(0, 0, 0);
    scrollbar-width: none;
  }
</style>
