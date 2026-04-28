<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";
  import { IconSmall } from "./icons/small";

  type Props = {
    children: Snippet;
    prepend?: Snippet;
    append?: Snippet;
    isDropdown?: boolean;
    variant?: "primary" | "secondary";
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
  <div data-tempest class="button size-{size} variant-{variant}">
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
    --button-shadow-outline-color: rgb(238 238 239 / 0.5);

    align-items: center;
    background: var(--color-surface-1);
    block-size: var(--size-6-5);
    box-shadow:
      var(--shadow-1),
      0px 0px 0px 1px var(--button-shadow-outline-color);
    border-radius: var(--radius-2-5);
    box-sizing: border-box;
    color: var(--text-1);
    cursor: default;
    display: inline flex;
    flex: none;
    font-family: var(--font-family-sans);
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

    &.size-small {
      font-size: var(--font-size-2);
    }

    &.size-icon {
      block-size: var(--size-6);
      inline-size: var(--size-6);
      min-inline-size: unset;
      padding-inline: 0;
    }

    &.variant-primary.size-small {
      block-size: var(--size-6);
      font-size: var(--font-size-2);
    }

    &.variant-secondary {
      background-color: var(--highlight-bright);
      box-shadow: none;

      &:hover {
        background-color: color-mix(in srgb, var(--highlight-bright), var(--color-text) 5%);
      }
    }

    &:focus-visible {
      outline: 1px solid var(--color-text);
      z-index: var(--layer-1);
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

    &.cursor-hand {
      cursor: pointer;
    }

    .contents {
      position: relative;
      z-index: 1;
    }

    @media (prefers-color-scheme: dark) {
      & {
        --button-shadow-outline-color: rgba(225, 225, 239, 0);
        box-shadow:
          0px 0px 0px 1px var(--button-shadow-outline-color),
          var(--shadow-1);
      }
    }
  }

  /* DEFAULT */
  .variant-primary {
    --button-variant-default-color: var(--accent-1);

    /* Due to snippets, this selector isn't captured without :global() */
    & :global(.prepend) {
      color: var(--button-variant-default-color);
    }

    /* disabled="" indicates that the button *is* disabled. Weird, I know. */
    &[disabled=""] :global(.prepend) {
      color: var(--border-3);
    }

    & :global(.append) {
      opacity: 0.4;
      transition: all 150ms ease;
      transform: translate3d(0, 0, 0);
    }

    /* *Not* disabled. See above. */
    &:not([disabled=""]):hover {
      background-color: color-mix(
        in srgb,
        var(--background-1),
        var(--button-variant-default-color) 3%
      );
    }
  }
</style>
