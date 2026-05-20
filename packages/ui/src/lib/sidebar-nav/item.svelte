<!--
  A single row in a `<SidebarNav>`, with optional recursive sub-items.

  The default `children` snippet is the row content (label, badges, dots).
  When `subItems` is provided AND `expanded` is true, the sub-items render
  below with L-branch tree lines — same visual language as the skills
  tree. Sub-items are themselves `<SidebarNav.Item>`s, so the structure
  recurses to arbitrary depth.

  `actions` renders sibling controls (e.g. an absolute-positioned delete
  button) that need to live outside the row's `<button>` so they can have
  their own click handlers without nested-button HTML.

  ### Interactivity
  Pass `onclick` for a click-target row; pass `href` to render as an
  anchor. With neither, the row is a static `<div>` (useful for headers
  that only toggle their own sub-items via a child element).

  ### Variant
  `variant="sub"` shrinks/quietens the row — use for nested items.
  Skills/MCP nest one level (`default` → `sub`); files-in-a-folder nest
  two (all `sub`). Variant is set per-item so consumers stay in control.

  @component
-->

<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    active?: boolean;
    expanded?: boolean;
    href?: string;
    onclick?: (event: MouseEvent) => void;
    /** Render as plain `<div>` (no hover/active styling, no interaction). */
    bare?: boolean;
    title?: string;
    variant?: "default" | "sub";
    children: Snippet;
    actions?: Snippet;
    subItems?: Snippet;
  }

  let {
    active = false,
    expanded = false,
    href,
    onclick,
    bare = false,
    title,
    variant = "default",
    children,
    actions,
    subItems,
  }: Props = $props();
</script>

<div class="item">
  <div class="row" class:active data-variant={variant}>
    {#if bare}
      <div class="trigger trigger-bare">
        {@render children()}
      </div>
    {:else if href !== undefined}
      <a class="trigger" {href} {title} aria-current={active ? "page" : undefined}>
        {@render children()}
      </a>
    {:else}
      <button
        type="button"
        class="trigger"
        {onclick}
        {title}
        aria-current={active ? "true" : undefined}
      >
        {@render children()}
      </button>
    {/if}
    {#if actions}
      <div class="actions">
        {@render actions()}
      </div>
    {/if}
  </div>

  {#if subItems && expanded}
    <div class="sub-items">
      {@render subItems()}
    </div>
  {/if}
</div>

<style>
  /* `.row` wraps trigger + optional actions so the actions can sit
     absolutely on the right without breaking the trigger's click area.
     `--sidebar-nav-row-hover` exposes the row's hover state to children
     so consumers can build CSS-only hover-swap effects (e.g. chat's
     timestamp ↔ trash toggle) without coordinating two separate :hover
     selectors. */
  .row {
    --sidebar-nav-row-hover: 0;
    --sidebar-nav-row-hover-pe: none;
    border-radius: var(--radius-2-5);
    display: flex;
    position: relative;
    transition: background-color 100ms ease;
  }

  .row:hover {
    --sidebar-nav-row-hover: 1;
    --sidebar-nav-row-hover-pe: auto;
  }

  .row.active {
    background-color: var(--highlight);
  }

  .trigger {
    align-items: center;
    background: none;
    /* min-block-size — so single-line rows match the chat's 30px target
       while multi-line content (e.g. chat row with source badge) grows. */
    min-block-size: var(--size-7-5);
    border-radius: var(--radius-2-5);
    color: var(--text);
    cursor: pointer;
    display: flex;
    flex: 1;
    font-family: inherit;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4-5);
    gap: var(--size-1-5);
    inline-size: 100%;
    min-inline-size: 0;
    padding-inline: var(--size-3);
    text-align: start;
    text-decoration: none;
    transition: color 150ms ease;
  }

  .trigger:hover {
    color: var(--text-bright);
  }

  .row.active .trigger {
    color: var(--text-bright);
  }

  /* sub variant — smaller, quieter rows for nested levels. Active sub
     rows underline instead of taking the highlight bg, to keep the
     drilled-in look light. */
  .row[data-variant="sub"] .trigger {
    min-block-size: var(--size-7);
    font-weight: var(--font-weight-4);
    opacity: 0.85;
    padding-inline: var(--size-2);
  }

  .row[data-variant="sub"].active {
    background-color: transparent;
  }

  .row[data-variant="sub"].active .trigger {
    opacity: 1;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .row[data-variant="sub"] .trigger:hover {
    opacity: 1;
  }

  .trigger-bare {
    cursor: default;
  }

  .trigger-bare:hover {
    color: var(--text);
  }

  .actions {
    align-items: center;
    display: flex;
    inset-block: 0;
    inset-inline-end: var(--size-2);
    position: absolute;
  }

  /* ─── Sub-items: L-branch tree lines ──────────────────────────────────
     Each nested `.item` draws its own connectors: `::before` is the
     rounded L-branch into the row, `::after` is the vertical trunk to
     the next sibling. Last sibling has no trunk. Selectors use `:global`
     to reach nested `<Item>` instances rendered by consumers. */

  .sub-items {
    display: flex;
    flex-direction: column;
    margin-inline-start: var(--size-3-5);
  }

  .sub-items > :global(.item) {
    padding-inline-start: var(--size-2-5);
    position: relative;
  }

  .sub-items > :global(.item)::before {
    block-size: 14px;
    border-block-end: 1px solid var(--border);
    border-end-start-radius: var(--size-1-5);
    border-inline-start: 1px solid var(--border);
    content: "";
    inline-size: var(--size-2-5);
    inset-block-start: 0;
    inset-inline-start: 0;
    position: absolute;
  }

  .sub-items > :global(.item)::after {
    background-color: var(--border);
    block-size: calc(100% - var(--size-2));
    content: "";
    inline-size: 1px;
    inset-block-start: var(--size-2);
    inset-inline-start: 0;
    position: absolute;
  }

  .sub-items > :global(.item:last-child)::after {
    display: none;
  }
</style>
