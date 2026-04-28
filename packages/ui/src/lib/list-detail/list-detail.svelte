<!--
  Two-pane list/detail layout. Sidebar with header on the left, main
  content on the right with a rounded leading edge.

  @component
-->

<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    header: Snippet;
    sidebar: Snippet;
    children: Snippet;
  }

  let { header, sidebar, children }: Props = $props();
</script>

<div class="layout">
  <aside class="sidebar">
    <div class="header">
      {@render header()}
    </div>
    {@render sidebar()}
  </aside>

  <div class="content">
    {@render children()}
  </div>
</div>

<style>
  .layout {
    background: var(--surface-dark);
    block-size: 100%;
    display: flex;
  }

  .sidebar {
    border-inline-start: var(--size-px) solid var(--border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-4);
    inline-size: 300px;
    overflow-y: auto;
    padding: var(--size-4);
    scrollbar-width: thin;
  }

  .header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
    padding: 0 var(--size-1);
  }

  .header :global(h1) {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .content {
    background: var(--surface);
    border-end-start-radius: var(--radius-7);
    border-start-start-radius: var(--radius-7);
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }
</style>
