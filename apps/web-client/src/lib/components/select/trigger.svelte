<script lang="ts">
  import type { Snippet } from "svelte";
  import { getContext } from "./context";

  const { trigger } = getContext();

  let { children }: { children: Snippet } = $props();
</script>

<button data-tempest {...$trigger} use:trigger>
  {@render children()}
</button>

<style>
  button {
    display: inline-block;
    outline: none;

    /* The select primitive doesn't work consistenly with focus vs focus-visible
     * like the Dropdown and Popover primitives. Therefore we have to check for
     * `aria-expanded=true` to create a "hack" to avoid showing an outline when
     * clicking the element. This works for both clicking and keyboard because the
     * selected item is highlighted and navigating the keyboard starts from that item
     */
    &:not([aria-expanded="true"]):focus-visible {
      border-radius: var(--radius-3);
      outline: 1px solid var(--accent-1);
      overflow: hidden;
    }

    &[disabled] {
      color: var(--text-3);
      opacity: 0.8;
    }
  }
</style>
