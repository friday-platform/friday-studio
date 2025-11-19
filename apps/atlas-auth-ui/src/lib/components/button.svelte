<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

type Props = {
  children: Snippet;
  prepend?: Snippet;
  append?: Snippet;
  variant?: "default" | "primary" | "fill" | "none";
  size?: "regular" | "large" | "small" | "icon" | "icon-small";
  accent?: "none" | "destructive" | "information" | "faded" | "primary" | "text";
  type?: "button" | "submit";
};

let {
  children,
  prepend,
  append,
  variant = "default",
  size = "regular",
  accent = "none",
  type = "button",
  ...rest
}: Props & HTMLButtonAttributes = $props();
</script>

<button {type} {...rest} class="button variant-{variant} size-{size} accent-{accent}">
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
</button>

<style>
  .button {
    --button-shadow-outline-color: rgb(238 238 239 / 0.5);
    align-items: center;
    background: var(--background-1);
    block-size: var(--size-6-5);
    box-shadow: var(--shadow-1), 0 0 0 1px var(--button-shadow-outline-color);
    border-radius: var(--radius-2-5);
    box-sizing: border-box;
    color: var(--text-1);
    cursor: default;
    display: inline-flex;
    flex: none;
    font-family: var(--font-family-sans);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    inline-size: 100%;
    line-height: var(--font-lineheight-0);
    justify-content: center;
    padding-inline: var(--size-2);
    white-space: initial;
    transition: all 0.15s ease;
    -webkit-user-select: none;
    user-select: none;
    border: none;
  }

  .button:focus-visible {
    outline: 1px solid var(--accent-1);
    z-index: var(--layer-1);
  }

  .button[disabled=""],
  .button[disabled="true"],
  .button:disabled {
    color: var(--text-3);
    pointer-events: none;
  }

  .button[href] {
    cursor: pointer;
  }

  .button.cursor-hand {
    cursor: pointer;
  }

  .button .contents {
    position: relative;
    z-index: 1;
  }

  @media (prefers-color-scheme: dark) {
    .button {
      --button-shadow-outline-color: rgba(225, 225, 239, 0);
      box-shadow: 0 0 0 1px var(--button-shadow-outline-color), var(--shadow-1);
    }
  }

  /* variant-default */
  .variant-default {
    --button-variant-default-color: var(--accent-1);
  }

  .variant-default.accent-destructive {
    --button-variant-default-color: var(--accent-2);
    color: var(--accent-2);
  }

  .variant-default.accent-information {
    --button-variant-default-color: var(--accent-3);
  }

  .variant-default.accent-faded {
    --button-variant-default-color: var(--text-3);
  }

  .variant-default:not([disabled=""]):hover {
    background-color: color-mix(
      in srgb,
      var(--background-1),
      var(--button-variant-default-color) 3%
    );
  }

  .variant-default.accent-none:not([disabled=""]):hover {
    --button-shadow-outline-color: color-mix(in srgb, var(--accent-1), transparent 70%);
  }

  .variant-default.accent-destructive:not([disabled=""]):hover {
    --button-shadow-outline-color: color-mix(in srgb, var(--accent-2), transparent 80%);
  }

  .variant-default.accent-information:not([disabled=""]):hover {
    --button-shadow-outline-color: color-mix(in srgb, var(--accent-3), transparent 80%);
  }

  .variant-default.accent-faded:not([disabled=""]):hover {
    --button-shadow-outline-color: var(--text-4);
  }

  /* variant-primary */
  .variant-primary {
    --button-variant-primary-color: var(--accent-1);
    color: var(--button-variant-primary-color);
  }

  .variant-primary.accent-destructive {
    --button-variant-primary-color: var(--accent-2);
  }

  .variant-primary:hover {
    background-color: color-mix(
      in srgb,
      var(--background-1),
      var(--button-variant-primary-color) 3%
    );
  }

  .variant-primary.accent-none:hover {
    --button-shadow-outline-color: color-mix(in srgb, var(--accent-1), transparent 70%);
  }

  .variant-primary.accent-destructive:hover {
    --button-shadow-outline-color: color-mix(in srgb, var(--accent-2), transparent 80%);
  }

  /* variant-fill */
  .variant-fill {
    box-shadow: none;
    position: relative;
    overflow: hidden;
  }

  .variant-fill:before {
    content: "";
    position: absolute;
    inset-block: 0;
    inset-inline: 0;
    transition: opacity 0.25s ease;
    z-index: 0;
  }

  .variant-fill.accent-text {
    background-color: var(--text-1);
    color: var(--background-1);
  }

  .variant-fill.accent-text:before {
    background: var(--gradient-black-1);
    opacity: 0.6;
  }

  @media (prefers-color-scheme: dark) {
    .variant-fill.accent-text:before {
      background: var(--gradient-grey-1);
    }
  }

  .variant-fill.accent-text:hover:before {
    opacity: 1;
  }

  /* variant-none */
  .variant-none {
    --button-variant-none-color: var(--text-1);
    background-color: transparent;
    box-shadow: none;
    color: var(--button-variant-none-color);
    position: relative;
  }

  .variant-none.accent-primary {
    --button-variant-none-color: var(--accent-1);
  }

  .variant-none.accent-destructive {
    --button-variant-none-color: var(--accent-2);
  }

  .variant-none.accent-information {
    --button-variant-none-color: var(--accent-3);
  }

  .variant-none:after {
    background-color: color-mix(in srgb, var(--button-variant-none-color), transparent 90%);
    border-radius: var(--radius-2-5);
    content: "";
    inset: calc(-1 * var(--size-px));
    inset-inline: calc(-1 * var(--size-1-5)) calc(-1 * var(--size-1));
    opacity: 0;
    position: absolute;
    transition: all 0.15s ease;
  }

  .variant-none.accent-faded {
    --button-variant-none-color: var(--text-3);
  }

  .variant-none.accent-faded:after {
    background-color: var(--highlight-1);
  }

  .variant-none:focus:after,
  .variant-none:hover:after {
    opacity: 1;
  }

  /* size-large */
  .size-large {
    block-size: var(--size-7);
    border-radius: var(--radius-3);
    padding-inline: var(--size-3);
  }

  /* size-small */
  .size-small {
    border-radius: var(--radius-2);
    block-size: var(--size-5-5);
    font-size: var(--font-size-2);
    gap: var(--size-1-5);
    padding-inline: var(--size-1-5);
  }

  .size-small.variant-none {
    padding-inline: 0;
  }

  /* size-icon */
  .size-icon {
    block-size: var(--size-6-5);
    inline-size: var(--size-6-5);
    justify-content: center;
    padding: 0;
  }

  /* size-icon-small */
  .size-icon-small {
    block-size: var(--size-5);
    inline-size: var(--size-5);
    border-radius: var(--radius-1);
    justify-content: center;
    padding: 0;
  }
</style>
