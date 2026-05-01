<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  type Props = HTMLAttributes<HTMLDivElement> & {
    children?: Snippet;
    align?: "left" | "center" | "right" | "full";
    sorted?: false | "asc" | "desc";
    maxWidth?: string;
    width?: string;
    noCheckbox?: boolean;
    background?: "white" | "gray";
  };

  let {
    children,
    align = "left",
    sorted = false,
    maxWidth = "none",
    width = "revert-layer",
    background = "white",
    ...rest
  }: Props = $props();
</script>

<div
  class="header align--{align} background--{background}"
  class:sorted
  class:asc={sorted === "asc"}
  class:desc={sorted === "desc"}
  style:max-inline-size={maxWidth}
  style:inline-size={width}
  {...rest}
>
  {#if children}
    {@render children()}
  {/if}
</div>

<style>
  div {
    align-items: center;
    block-size: var(--size-10);
    display: flex;
    font-weight: var(--font-weight-5);
    text-align: left;
    -webkit-user-select: none;
    user-select: none;
    white-space: nowrap;

    &:last-child {
      padding-inline-end: var(--size-3);
    }

    &.align--center {
      justify-content: center;
      text-align: center;
    }

    &.align--right {
      justify-content: end;
      text-align: end;
    }

    &.align--full {
      justify-content: center;
      text-align: center;
    }
  }
</style>
