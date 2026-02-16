<script lang="ts">
  import {
    KEY as DIALOG_KEY,
    getContext as getDialogContext,
  } from "$lib/components/dialog/context";
  import { Icons } from "$lib/components/icons";
  import { hasContext, type Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { get, writable } from "svelte/store";
  import { getContext } from "./context";

  const { item, createCheckboxItem } = getContext();
  const dialogContext = getDialogContext();

  type Props = {
    children: Snippet;
    accent?: "primary" | "destructive" | "information" | "inherit" | "none";
    href?: string;
    description?: Snippet;
    checked?: boolean;
    indeterminate?: boolean;
    closeOnClick?: boolean;
    noninteractive?: boolean;
    disabled?: boolean;
    size?: "default" | "large";
    faded?: boolean;
  };

  let {
    children,
    accent = "none",
    description,
    checked,
    indeterminate = false,
    closeOnClick = true,
    noninteractive = false,
    size = "default",
    faded = false,
    // important: disabled should not have a default value, as any value is considered true
    disabled,
    ...rest
  }: Props & HTMLAttributes<HTMLElement> = $props();

  let localChecked = writable(Boolean(checked));

  const {
    elements: { checkboxItem },
  } = createCheckboxItem({ checked: localChecked });

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

    <div class="status">
      {#if checked}
        <div class="checked">
          <Icons.Checkmark />
        </div>
      {:else if indeterminate}
        <div class="indeterminate">-</div>
      {/if}
    </div>
  </span>

  {#if description}
    <div class="item-description">
      {@render description()}
    </div>
  {/if}
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
    class:description={description !== undefined}
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
    class:description={description !== undefined}
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
    block-size: var(--size-8);
    cursor: default;
    display: flex;
    flex: 1 0 auto;
    flex-direction: column;
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

    &.description {
      block-size: var(--size-10);
    }

    .item-description {
      opacity: 0.5;
      font-size: var(--font-size-1);
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

  .label {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
    inline-size: 100%;
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-0);

    .faded & :global(svg) {
      opacity: 0.5;
    }

    .status {
      margin-inline-start: auto;
      padding-inline-start: var(--size-2);
      opacity: 0.6;
    }
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
