<script lang="ts">
  import { IconSmall } from "./icons/small";
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

  type Props = {
    children: Snippet;
    prepend?: Snippet;
    append?: Snippet;
    isDropdown?: boolean;
    variant?: "primary" | "secondary" | "destructive" | "none";
    size?: "regular" | "small" | "icon";
    type?: "button" | "reset" | "submit";
    cursor?: "default" | "hand";
    href?: string;
    noninteractive?: boolean;
  };

  let {
    children,
    prepend = undefined,
    append = undefined,
    isDropdown = false,
    variant = "primary",
    size = "regular",
    type = "button",
    cursor,
    href = undefined,
    noninteractive = false,
    ...rest
  }: Props & HTMLButtonAttributes & HTMLAnchorAttributes = $props();
</script>

{#snippet contents()}
  {#if prepend}
    <span class="prepend">
      {@render prepend()}
    </span>
  {/if}

  <span class="contents">
    {@render children()}
  </span>

  {#if append}
    <span class="append">
      {@render append()}
    </span>
  {/if}

  {#if isDropdown}
    <span class="append">
      <IconSmall.CaretDown />
    </span>
  {/if}
{/snippet}

{#if href}
  <a
    {href}
    data-sveltekit-reload
    data-tempest
    class="button size-{size} variant-{variant}  cursor-{cursor}"
    {...rest}
  >
    {@render contents()}
  </a>
{:else if noninteractive}
  <div data-tempest class="button size-{size} variant-{variant} cursor-{cursor}">
    {@render contents()}
  </div>
{:else}
  <button
    {type}
    {...rest}
    data-tempest
    class="button size-{size} variant-{variant} cursor-{cursor}"
  >
    {@render contents()}
  </button>
{/if}

<style>
  .button {
    align-items: center;
    block-size: var(--size-6-5);
    border-radius: var(--radius-2-5);
    color: var(--text-bright);
    cursor: default;
    display: inline flex;
    flex: none;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    inline-size: max-content;
    min-inline-size: var(--size-12);
    line-height: var(--font-lineheight-0);
    justify-content: center;
    padding-inline: var(--size-3);
    white-space: initial;
    transition: all 150ms ease;
    -webkit-user-select: none;
    user-select: none;

    &:focus-visible {
      outline: 1px solid var(--color-text);
      z-index: var(--layer-1);
    }

    &.cursor-hand {
      cursor: pointer;
    }

    .contents {
      position: relative;
      z-index: 1;
    }

    &[disabled=""],
    &[disabled="true"] {
      color: var(--text-faded);
      pointer-events: none;
    }

    &[href] {
      cursor: pointer;

      &.cursor-default {
        cursor: default;
      }
    }

    .prepend {
      color: var(--text-faded);
      transition: color 150ms ease;
    }

    .append {
      opacity: 0.4;
      transition: all 150ms ease;
      transform: translate3d(0, 0, 0);
    }

    /* Variants */
    &.variant-primary {
      --button-shadow-outline-color: rgb(238 238 239 / 0.5);

      background: var(--surface);
      box-shadow:
        var(--shadow-1),
        0px 0px 0px 1px var(--button-shadow-outline-color);
    }

    &.variant-secondary {
      background-color: var(--highlight-bright);

      &:hover {
        background-color: color-mix(in srgb, var(--highlight-bright), var(--color-text) 5%);
      }
    }

    &.variant-destructive {
      background-color: var(--highlight-bright);
      color: var(--red-primary);

      &:hover {
        background-color: color-mix(in srgb, var(--highlight-bright), var(--color-text) 5%);
      }
    }

    &.variant-none {
      padding-inline: unset;

      &:hover .prepend {
        color: var(--text-bright);
      }
    }

    /* Sizes */
    &.size-small {
      font-size: var(--font-size-2);
    }

    &.size-icon {
      block-size: var(--size-6);
      inline-size: var(--size-6);
      min-inline-size: unset;
      padding-inline: 0;
    }
  }
</style>
