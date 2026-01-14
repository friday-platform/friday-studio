<script lang="ts">
  import { getContext } from "./context";

  const { separator } = getContext();
</script>

<div {...$separator} use:separator></div>

<style>
  div {
    background-color: var(--color-border-1);
    block-size: var(--size-px);
    flex-shrink: 0;
    margin-inline: var(--size-2);
    margin-block: var(--size-0-5);
    opacity: 0.5;
  }
</style>
