<script lang="ts">
  import type { Color } from "@atlas/utils";

  let { color }: { color?: Color } = $props();
</script>

<span class="dot" style:color={color ? `var(--${color}-2)` : "var(--color-text)"}>
  <span></span>
</span>

<style>
  .dot {
    align-items: center;
    block-size: var(--size-4);
    aspect-ratio: 1;
    display: flex;
    justify-content: center;

    span {
      background-color: currentColor;
      border: var(--size-0-5) solid var(--color-white);
      block-size: 11px;
      border-radius: var(--radius-round);
      box-shadow: var(--shadow-1);
      inline-size: 11px;
    }
  }
</style>
