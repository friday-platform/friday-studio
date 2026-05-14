<!--
  Two-pane list/detail layout. Sidebar with header on the left, main
  content on the right with a rounded leading edge.

  @component
-->

<script lang="ts">
  import type { Snippet } from "svelte";
  import { IconSmall } from "../icons/small/index.js";

  interface Props {
    header: Snippet;
    sidebar: Snippet;
    children: Snippet;
    /**
     * When true, the sidebar collapses to a thin peek strip with a
     * chevron button. Clicking (or keyboard-activating) the strip
     * slides the sidebar back out — bindable, so this component flips
     * it to false itself. Default false — existing consumers see no
     * change.
     */
    sidebarCollapsed?: boolean;
  }

  let { header, sidebar, children, sidebarCollapsed = $bindable(false) }: Props = $props();
</script>

<div class="layout" class:sidebar-collapsed={sidebarCollapsed}>
  <aside class="sidebar">
    <!-- `inert` when collapsed pulls the faded-out content out of the
         tab order and the accessibility tree, so keyboard / screen
         reader users can't land on invisible controls. -->
    <div class="sidebar-inner" inert={sidebarCollapsed}>
      <div class="header">
        {@render header()}
      </div>
      {@render sidebar()}
    </div>
    {#if sidebarCollapsed}
      <button
        type="button"
        class="peek-indicator"
        aria-label="Expand sidebar"
        aria-expanded="false"
        onclick={() => (sidebarCollapsed = false)}
      >
        <IconSmall.ChevronRight />
      </button>
    {/if}
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
    inline-size: 300px;
    /* overflow: hidden clips the inner content during the collapse /
       expand width transition (both directions) so no scrollbar flashes
       while the sidebar is mid-slide. The actual scroll lives on
       .sidebar-inner. */
    overflow: hidden;
    /* No block-end padding: the sidebar snippet owns the bottom edge so
       content (e.g. an overlay footer) can sit flush against it. */
    padding: var(--size-4) var(--size-4) 0;
    position: relative;
    transition:
      inline-size 240ms cubic-bezier(0.4, 0, 0.2, 1),
      padding 240ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  .sidebar-inner {
    display: flex;
    /* Fill the aside so children with flex: 1 (e.g. chat-list-panel)
       get the full available height. */
    flex: 1;
    flex-direction: column;
    gap: var(--size-4);
    min-block-size: 0;
    opacity: 1;
    /* The scroll container for every consumer. Sidebar snippets that
       manage their own internal scroll (chat-list-panel) simply never
       overflow this; tree-style snippets (skills, mcp, discover) scroll
       here. */
    overflow-y: auto;
    scrollbar-width: thin;
    transition: opacity 180ms cubic-bezier(0.4, 0, 0.2, 1);
  }

  /* Collapsed: sidebar slides out to a thin peek strip. The
     .peek-indicator button is the affordance to bring it back — hover
     and focus only highlight the chevron, the sidebar does not expand
     on hover so the pointer can graze the strip safely. */
  .sidebar-collapsed .sidebar {
    inline-size: var(--size-5);
    padding-inline: 0;
  }

  .sidebar-collapsed .sidebar-inner {
    opacity: 0;
  }

  .peek-indicator {
    align-items: center;
    background: none;
    border: none;
    color: var(--text-faded);
    cursor: pointer;
    display: flex;
    inline-size: var(--size-5);
    inset-block: 0;
    inset-inline-start: 0;
    justify-content: center;
    padding: 0;
    position: absolute;
    transition: color 120ms ease;
  }

  .peek-indicator:hover,
  .peek-indicator:focus-visible {
    color: var(--text-bright);
  }

  .header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    justify-content: space-between;
    padding: 0 var(--size-1);
  }

  .header :global(h1) {
    color: var(--text-bright);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
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
