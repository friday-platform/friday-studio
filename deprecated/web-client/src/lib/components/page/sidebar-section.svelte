<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    title: string;
    empty?: string;
    children?: Snippet;
  }

  let { title, empty = undefined, children }: Props = $props();
</script>

<div class="sidebar-section">
  <h3>{title}</h3>
  {#if children}
    {@render children()}
  {:else if empty}
    <span class="empty">{empty}</span>
  {/if}
</div>

<style>
  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);

    h3 {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-1);
      opacity: 0.6;
    }
  }

  .empty {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4);
    line-height: var(--font-lineheight-1);
    opacity: 0.6;
  }
</style>
