<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Writable } from "svelte/store";
  import { DropdownMenu } from "../dropdown-menu/index.js";

  type Props = { children: Snippet; actions?: Snippet<[Writable<boolean>]> };

  let { children, actions }: Props = $props();
</script>

{#snippet titleNode()}
  <h1 class="title">
    {@render children()}
  </h1>
{/snippet}

<div class="component">
  {#if actions}
    <DropdownMenu.Root positioning={{ placement: "bottom-start" }}>
      {#snippet children(open)}
        <DropdownMenu.Trigger>
          {@render titleNode()}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {@render actions(open)}
        </DropdownMenu.Content>
      {/snippet}
    </DropdownMenu.Root>
  {:else}
    {@render titleNode()}
  {/if}
</div>

<style>
  .component {
    padding-block: var(--size-4);
    padding-inline: var(--size-6);
    background: color-mix(in srgb, var(--surface), transparent 8%);
    backdrop-filter: blur(var(--size-2));
    -webkit-mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 1) 70%, rgba(0, 0, 0, 0));
    mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 1) 70%, rgba(0, 0, 0, 0));
    inset-block-start: 0;
    inset-inline: 0;
    inline-size: 100%;
    position: absolute;
    z-index: var(--layer-2);
  }

  .title {
    color: var(--text-bright);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    line-height: 1.2;
    margin: 0;
    text-align: start;
  }
</style>
