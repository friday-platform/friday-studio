<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

  type Props = {
    children: Snippet;
    prepend?: Snippet;
    append?: Snippet;
    isDropdown?: boolean;
    variant?: "primary" | "default" | "none" | "fill";
    accent?: "primary" | "destructive" | "information" | "faded" | "none" | "text";
    size?: "regular" | "small" | "icon" | "icon-small" | "large";
    font?: "regular" | "monospace";
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
    variant = "default",
    accent = "none",
    size = "regular",
    font = "regular",
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
    class="button variant-{variant} size-{size} accent-{accent} font-{font} cursor-{cursor}"
    {...rest}
  >
    {@render contents()}
  </a>
{:else if noninteractive}
  <div data-tempest class="button variant-{variant} size-{size} accent-{accent} font-{font}">
    {@render contents()}
  </div>
{:else}
  <button
    {type}
    {...rest}
    data-tempest
    class="button variant-{variant} size-{size} accent-{accent} font-{font} cursor-{cursor}"
  >
    {@render contents()}
  </button>
{/if}

<style>
  .button {
    --button-shadow-outline-color: rgb(238 238 239 / 0.5);

    align-items: center;
    background: var(--background-1);
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
    gap: var(--size-2);
    inline-size: max-content;
    line-height: var(--font-lineheight-0);
    justify-content: center;
    padding-inline: var(--size-2);
    white-space: initial;
    transition: all 150ms ease;
    -webkit-user-select: none;
    user-select: none;

    &:focus-visible {
      outline: 1px solid var(--accent-1);
      z-index: var(--layer-1);
    }

    &[disabled=""],
    &[disabled="true"] {
      color: var(--text-3);
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
  .variant-default {
    --button-variant-default-color: var(--accent-1);

    &.accent-destructive {
      --button-variant-default-color: var(--accent-2);
      color: var(--accent-2);
    }

    &.accent-information {
      --button-variant-default-color: var(--accent-3);
    }

    &.accent-faded {
      --button-variant-default-color: var(--text-3);
    }

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

    &.accent-none:not([disabled=""]):hover {
      --button-shadow-outline-color: color-mix(in srgb, var(--accent-1), transparent 70%);
    }

    &.accent-destructive:not([disabled=""]):hover {
      --button-shadow-outline-color: color-mix(in srgb, var(--accent-2), transparent 80%);
    }

    &.accent-information:not([disabled=""]):hover {
      --button-shadow-outline-color: color-mix(in srgb, var(--accent-3), transparent 80%);
    }

    &.accent-faded:not([disabled=""]):hover {
      --button-shadow-outline-color: var(--text-4);
    }
  }

  /* PRIMARY */
  .variant-primary {
    --button-variant-primary-color: var(--accent-1);
    color: var(--button-variant-primary-color);

    &.accent-destructive {
      --button-variant-primary-color: var(--accent-2);
    }

    &:hover {
      background-color: color-mix(
        in srgb,
        var(--background-1),
        var(--button-variant-primary-color) 3%
      );
    }

    &.accent-none:hover {
      --button-shadow-outline-color: color-mix(in srgb, var(--accent-1), transparent 70%);
    }

    &.accent-destructive:hover {
      --button-shadow-outline-color: color-mix(in srgb, var(--accent-2), transparent 80%);
    }
  }

  /* FILL */
  .variant-fill {
    & {
      box-shadow: none;
      position: relative;
      overflow: hidden;
    }

    &:before {
      content: "";
      position: absolute;
      inset-block: 0;
      inset-inline: 0;
      transition: opacity 250ms ease;
      z-index: 0;
    }

    &.accent-text {
      background-color: var(--text-1);
      color: var(--background-1);

      &:before {
        background: var(--gradient-black-1);
        opacity: 0.6;
      }

      @media (prefers-color-scheme: dark) {
        &:before {
          background: var(--gradient-grey-1);
        }
      }

      &:hover:before {
        opacity: 1;
      }
    }
  }

  /* UNSTYLED */
  .variant-none {
    --button-variant-none-color: var(--text-1);
    background-color: transparent;
    box-shadow: none;
    color: var(--button-variant-none-color);
    position: relative;

    &.accent-primary {
      --button-variant-none-color: var(--accent-1);
    }

    &.accent-destructive {
      --button-variant-none-color: var(--accent-2);
    }

    &.accent-information {
      --button-variant-none-color: var(--accent-3);
    }

    &:after {
      background-color: color-mix(in srgb, var(--button-variant-none-color), transparent 90%);
      border-radius: var(--radius-2-5);
      content: "";
      inset: calc(-1 * var(--size-px));
      inset-inline: calc(-1 * var(--size-1-5)) calc(-1 * var(--size-1));
      opacity: 0;
      position: absolute;
      transition: all 150ms ease;
    }

    &.accent-faded {
      --button-variant-none-color: var(--text-3);

      &:after {
        background-color: var(--highlight-1);
      }
    }

    &:focus:after,
    &:hover:after {
      opacity: 1;
    }
  }

  /* font family: monospace */
  .font-monospace {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1); /* downscale from 13 to 12px */
  }

  .size-large {
    block-size: var(--size-7);
    border-radius: var(--radius-3);
    padding-inline: var(--size-3);
  }

  /* size: small */
  .size-small {
    border-radius: var(--radius-2);
    block-size: var(--size-5-5);
    font-size: var(--font-size-2);
    gap: var(--size-1-5);
    padding-inline: var(--size-1-5);

    &.font-monospace {
      font-size: var(--font-size-1); /* downscale from 12 to 11px */
    }

    &.variant-none {
      padding-inline: 0;
    }
  }

  /* size: icon */
  .size-icon {
    block-size: var(--size-6-5);
    inline-size: var(--size-6-5);
    justify-content: center;
    padding: 0;
  }

  .size-icon-small {
    block-size: var(--size-5);
    inline-size: var(--size-5);
    border-radius: var(--radius-1);
    justify-content: center;
    padding: 0;
  }
</style>
