<script lang="ts">
  import { IconSmall } from "$lib/components/icons/small";
  import { onMount } from "svelte";

  let { content }: { content: string } = $props();

  let expanded = $state(false);
  let clamped = $state(false);
  let node = $state<HTMLParagraphElement | null>(null);

  onMount(() => {
    if (!node) return;
    // Use computed line count
    const styles = getComputedStyle(node);
    const lineHeight = parseFloat(styles.lineHeight);
    const maxLines = 3;
    const actualHeight = node.scrollHeight;
    const clampHeight = lineHeight * maxLines;
    // Check if overflowing visible lines (clamped line count)
    clamped = actualHeight > clampHeight + 2;
  });
</script>

{#snippet contents()}
  <p bind:this={node}>
    {content}
  </p>

  {#if clamped}
    <span class="outline-toggle">
      <IconSmall.CaretRight />
    </span>
  {/if}
{/snippet}

{#if clamped}
  <div
    class:expanded
    role="button"
    tabindex="0"
    onclick={() => (expanded = !expanded)}
    aria-label={expanded ? "Show less" : "Show more"}
    onkeydown={(e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        expanded = !expanded;
      }
    }}
  >
    {@render contents()}
  </div>
{:else}
  <div class:expanded>
    {@render contents()}
  </div>
{/if}

<style>
  div {
    position: relative;
  }

  p {
    color: color-mix(in srgb, var(--color-text) 70%, transparent);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-4);
    line-height: var(--font-lineheight-3);
    text-wrap-style: balance;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    -webkit-line-clamp: 3;

    .expanded & {
      -webkit-line-clamp: none;
    }
  }

  .outline-toggle {
    border: none;
    color: color-mix(in srgb, var(--color-text) 70%, transparent);

    position: absolute;
    inset-block-end: 0;
    inset-inline-end: calc(-1 * var(--size-2));

    & :global(svg) {
      display: block;
      transition: transform 150ms ease-in-out;
    }

    .expanded & :global(svg) {
      transform: rotate(90deg);
    }
  }
</style>
