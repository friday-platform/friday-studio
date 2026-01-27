<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

  type Props = {
    children: Snippet;
    prepend?: Snippet;
    append?: Snippet;
    isDropdown?: boolean;
    size?: "regular" | "small";
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
    class="button size-{size}  cursor-{cursor}"
    {...rest}
  >
    {@render contents()}
  </a>
{:else if noninteractive}
  <div data-tempest class="button size-{size} ">
    {@render contents()}
  </div>
{:else}
  <button {type} {...rest} data-tempest class="button size-{size}  cursor-{cursor}">
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

  .size-small {
    border-radius: var(--radius-2);
    block-size: var(--size-5-5);
    font-size: var(--font-size-2);
    gap: var(--size-1-5);
    padding-inline: var(--size-1-5);
  }
</style>
