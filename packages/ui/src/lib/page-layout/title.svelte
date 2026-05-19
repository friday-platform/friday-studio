<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Writable } from "svelte/store";
  import { DropdownMenu } from "../dropdown-menu/index.js";

  type Props = { subtitle?: string; children: Snippet; actions?: Snippet<[Writable<boolean>]> };

  let { subtitle, children, actions }: Props = $props();

  let descriptionTruncated = $state(true);
</script>

{#snippet titleNode()}
  <h1 class="text text-bright">
    {@render children()}
  </h1>
{/snippet}

<div class="component" data-friday-pagelayout-title>
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

  {#if subtitle}
    <p
      class="description text text-faded"
      class:truncated={descriptionTruncated}
      role="button"
      tabindex="0"
      aria-expanded={!descriptionTruncated}
      onclick={() => (descriptionTruncated = !descriptionTruncated)}
      onkeydown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          descriptionTruncated = !descriptionTruncated;
        }
      }}
    >
      {subtitle}
    </p>
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
    inline-size: calc(100% - var(--size-8));
    position: absolute;
    z-index: var(--layer-2);
  }

  h1 {
    font-weight: var(--font-weight-5);
    line-height: 1.2;
    margin: 0;
    text-align: start;
  }

  .description {
    cursor: pointer;
    max-inline-size: 60ch;
    transition: color 0.1s ease;

    &:hover,
    &:focus-visible {
      color: var(--text);
    }

    &.truncated {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
</style>
