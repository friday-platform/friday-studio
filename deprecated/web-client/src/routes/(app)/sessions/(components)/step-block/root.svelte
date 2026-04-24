<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    header?: Snippet;
    children?: Snippet;
  }

  let { header, children }: Props = $props();
</script>

<div class="component">
  {#if header}
    {@render header()}
  {/if}
  {#if children}
    <div class="content">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .component {
    border-inline-start: var(--size-px) solid var(--color-border-1);
    margin-inline-start: var(--size-2);
    padding-block: 0 var(--size-6);

    &:global(:last-of-type) {
      padding-block: 0;
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    padding-inline: var(--size-4);
  }
</style>
