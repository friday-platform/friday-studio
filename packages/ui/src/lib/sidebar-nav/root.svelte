<!--
  Container for a sidebar navigation tree.

  The shared visual language for catalog/listing sidebars in `<ListDetail>`:
  flat row items, optional groups, recursive sub-items that expand in place
  with L-branch tree lines. Used by the skills tree, MCP catalog, and chat
  list.

  Children are composed freely (Search, Group, Item) — Root only owns the
  flex column layout and the bottom gutter the parent `<ListDetail>` sidebar
  intentionally omits.

  @component
-->

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  interface Props extends HTMLAttributes<HTMLElement> {
    children: Snippet;
    /** Spacing between top-level children. Defaults to a tight tree gap. */
    gap?: "tight" | "loose";
  }

  let { children, gap = "tight", ...rest }: Props = $props();
</script>

<nav class="sidebar-nav" data-gap={gap} {...rest}>
  {@render children()}
</nav>

<style>
  .sidebar-nav {
    display: flex;
    flex-direction: column;
    /* ListDetail's aside is full-bleed at block-end so the chat consumer's
       absolute footer can sit flush; tree-style sidebars add their own
       bottom gutter so the last item isn't jammed against the edge when
       the list scrolls. */
    padding-block-end: var(--size-4);
  }

  .sidebar-nav[data-gap="tight"] {
    gap: var(--size-0-5);
  }

  .sidebar-nav[data-gap="loose"] {
    gap: var(--size-2);
  }
</style>
