<script lang="ts">
  import {
    KEY as DIALOG_KEY,
    getContext as getDialogContext,
  } from "$lib/components/dialog/context";
  import { Icons } from "$lib/components/icons";
  import { hasContext, type Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { get } from "svelte/store";
  import { getContext } from "./context";

  const { item } = getContext();
  const dialogContext = getDialogContext();

  type Props = {
    children: Snippet;
    prepend?: Snippet;
    append?: Snippet;
    accent?: "primary" | "destructive" | "information" | "inherit" | "none";
    href?: string;
    checked?: boolean;
    radio?: boolean;
    indeterminate?: boolean;
    closeOnClick?: boolean;
    noninteractive?: boolean;
    disabled?: boolean;
    size?: "default" | "large";
    faded?: boolean;
  };

  let {
    children,
    prepend,
    append,
    accent = "none",
    checked,
    radio = false,
    indeterminate = false,
    closeOnClick = true,
    noninteractive = false,
    size = "default",
    faded = false,
    // important: disabled should not have a default value, as any value is considered true
    disabled,
    ...rest
  }: Props & HTMLAttributes<HTMLElement> = $props();

  function getElementType() {
    if (rest?.href) {
      return "a";
    } else if (noninteractive) {
      return "div";
    } else {
      return "button";
    }
  }
</script>

{#snippet contents()}
  <span class="label">
    {@render children()}
  </span>

  {#if prepend}
    <div class="prepend">
      {@render prepend()}
    </div>
  {/if}

  {#if append}
    <div class="append">
      {@render append()}
    </div>
  {/if}

  <div class="status">
    <div class="checked">
      {#if checked}
        {#if radio}
          <Icons.RadioChecked />
        {:else}
          <Icons.Checkmark />
        {/if}
      {:else if indeterminate}
        <div class="indeterminate">-</div>
      {:else if radio}
        <Icons.RadioUnchecked />
      {/if}
    </div>
  </div>
{/snippet}

{#if hasContext(DIALOG_KEY)}
  {@const trigger = dialogContext.trigger}
  <!-- svelte-ignore event_directive_deprecated -->
  <button
    {...rest}
    {disabled}
    use:item
    use:trigger
    {...$item}
    {...get(trigger)}
    class="item accent--{accent} size--{size}"
    class:faded
    on:m-click={(e) => {
      e.preventDefault();
    }}
  >
    {@render contents()}
  </button>
{:else}
  <!-- svelte-ignore event_directive_deprecated -->
  <svelte:element
    this={getElementType()}
    {disabled}
    use:item
    {...$item}
    {...rest}
    class="item accent--{accent} size--{size}"
    class:faded
    on:m-click={(e) => {
      if (!closeOnClick) {
        e.preventDefault();
      }
    }}
  >
    {@render contents()}
  </svelte:element>
{/if}

<style>
  .item {
    align-items: center;
    block-size: var(--size-8);
    cursor: default;
    display: flex;
    flex: 1 0 auto;
    gap: var(--size-1-5);
    justify-content: center;
    padding-inline: var(--size-3);
    position: relative;
    text-align: left;
    transition: color 150ms ease;
    white-space: nowrap;
    outline: none;
    z-index: 0;

    &.size--large {
      block-size: var(--size-10);
    }

    &.faded,
    &[data-disabled] {
      opacity: 0.5;
    }

    &:before {
      background-color: var(--color-surface-2);
      border-radius: var(--radius-2-5);
      content: "";
      position: absolute;
      opacity: 0;
      inset-block: 0;
      inset-inline: var(--size-1);
      z-index: -1;
    }

    &:hover:not([data-disabled]):before,
    &[data-highlighted]:not([data-disabled]):before {
      opacity: 1;
    }
  }

  .prepend {
    order: 1;
  }

  .label {
    order: 2;
    inline-size: 100%;
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-0);

    .faded & :global(svg) {
      opacity: 0.5;
    }
  }

  .append {
    order: 3;
  }

  .status {
    order: 4;
    flex: none;
    inline-size: var(--size-4);
    opacity: 0.8;
  }

  .accent--inherit :global(svg) {
    color: currentColor;
  }

  .accent--none :global(svg) {
    color: var(--color-text);
    opacity: 0.7;
  }

  .accent--primary :global(svg) {
    color: var(--color-text);
  }

  .accent--destructive :global(svg) {
    color: var(--color-red);
  }

  .sr-only {
    block-size: 1px;
    clip: rect(0, 0, 0, 0);
    inline-size: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
  }
</style>
