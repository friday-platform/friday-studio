<script lang="ts">
  import { type Snippet } from "svelte";
  import { expoOut } from "svelte/easing";
  import type { HTMLAttributes } from "svelte/elements";
  import { scale } from "svelte/transition";
  import { getContext } from "./context";

  type Props = { children: Snippet; size?: "regular" | "large" | "auto"; visible?: boolean };

  let node = $state<HTMLDivElement>();

  let {
    children,
    size = "auto",
    visible = true,
    ...rest
  }: Props & HTMLAttributes<HTMLDivElement> = $props();

  const { open, menu, positioning, overlay } = getContext();
</script>

{#if $open}
  <div class="overlay" {...$overlay} use:overlay></div>

  <div
    {...$menu}
    class="content size--{size} placement--{$positioning?.placement ?? 'bottom'}"
    class:visible
    use:menu
    bind:this={node}
    in:scale={{ duration: 150, start: 0.96, easing: expoOut }}
    out:scale={{ start: 0.96, duration: 250, easing: expoOut }}
    {...rest}
  >
    {@render children()}
  </div>
{/if}

<style>
  .content {
    --dropdown-menu-content-size: auto;

    background-color: var(--color-surface-1);
    border-radius: var(--radius-4);
    box-shadow: var(--shadow-1);
    display: flex;
    flex-direction: column;
    inline-size: var(--dropdown-menu-content-size, auto);
    min-inline-size: var(--size-40);
    opacity: 1;
    outline: none;
    overflow: auto;
    padding-block: var(--size-1);
    position: relative;
    scrollbar-width: thin;
    transform: translate3d(0, 0, 0);
    transition: opacity 100ms ease;
    visibility: visible;
    z-index: var(--layer-3);

    :global(&:has(.dropdown-list)) {
      padding-block: 0;
    }

    :global(body:has([role="dialog"][data-state="open"])) & {
      opacity: 0;
      overflow: hidden;
      visibility: hidden;
    }

    &.placement--top {
      transform-origin: 50% 100%;
    }

    &.placement--top-start {
      transform-origin: 0 100%;
    }

    &.placement--top-end {
      transform-origin: 100% 100%;
    }

    &.placement--right {
      transform-origin: 0 50%;
    }

    &.placement--right-end {
      transform-origin: 0 100%;
    }

    &.placement--bottom {
      transform-origin: 50% 0;
    }

    &.placement--right-start,
    &.placement--bottom-start {
      transform-origin: 0 0;
    }

    &.placement--bottom-end {
      transform-origin: 100% 0;
    }

    &.placement--left {
      transform-origin: 100% 50%;
    }

    &.placement--left-start {
      transform-origin: 100% 0;
    }

    &.placement--left-end {
      transform-origin: 100% 100%;
    }
  }

  .content.size--regular {
    --dropdown-menu-content-size: var(--size-56);
  }

  .content.size--large {
    --dropdown-menu-content-size: var(--size-72);
  }

  .content.size--auto {
    --dropdown-menu-content-size: auto;
  }

  .tab-index {
    block-size: 0px;
    inline-size: 0px;
    position: absolute;
  }

  .overlay {
    inset: 0;
    position: fixed;
    z-index: var(--layer-2);
  }
</style>
