<script lang="ts">
  import type { Snippet } from "svelte";
  import { getContext } from "./context";

  let { children, size = "shrink" }: { size?: "shrink" | "grow"; children: Snippet<[boolean]> } =
    $props();

  const { trigger, open } = getContext();
</script>

<button
  {...$trigger}
  type="button"
  use:trigger
  class:shrink={size === "shrink"}
  class:grow={size === "grow"}
>
  {@render children($open)}
</button>

<style>
  button {
    display: block;

    &.shrink {
      inline-size: max-content;
    }

    &.grow {
      inline-size: 100%;
    }

    &:focus {
      outline: none;
    }

    &:focus-visible {
      border-radius: var(--radius-1);
      outline: 1px solid var(--accent-1);
    }
  }
</style>
