<script lang="ts">
  import type { Snippet } from "svelte";

  const { children }: { children: Snippet } = $props();
</script>

<div class="md">
  {@render children()}
</div>

<style>
  .md :global(:where(h1, h2, h3, h4, ul, ol, p)) {
    max-inline-size: 80ch;
  }

  .md :global(:where(h1, h2, h3, h4)) {
    line-height: var(--font-lineheight-1);
    font-weight: var(--font-weight-6);
  }

  .md :global(:where(h1)) {
    font-size: var(--font-size-7);
  }

  .md :global(:where(h2)) {
    font-size: var(--font-size-7);
  }

  .md :global(:where(h3)) {
    font-size: var(--font-size-6);
  }

  .md :global(:where(p, li)) {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-4);
    line-height: var(--font-lineheight-3);
    word-break: break-word;
  }

  .md :global(:where(ol)) {
    list-style-type: decimal;
    padding-inline-start: var(--size-6);
  }

  .md :global(:where(ul)) {
    list-style-type: "⋅ ";
    padding-inline-start: var(--size-5);
  }

  .md :global(:where(li > ul, li > ol)) {
    margin-block-end: var(--size-1);
    margin-block-start: var(--size-1);
  }

  .md :global(:where(strong)) {
    font-weight: var(--font-weight-6);
  }

  .md :global(:where(code, pre)) {
    background-color: color-mix(in oklab, var(--accent-2), var(--color-surface-1) 93%);
    color: var(--accent-3);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .md :global(:where(pre)) {
    background-color: color-mix(in oklab, var(--accent-2), var(--color-surface-1) 94%);
    border-radius: var(--radius-3);
    inline-size: max-content;
    margin-block: var(--size-4);
    max-inline-size: 100%;
    overflow-x: auto;
    padding-block: var(--size-4);
    padding-inline: var(--size-6);

    & :global(code) {
      background-color: transparent;
    }
  }

  .md :global(:where(p code)) {
    border-radius: var(--radius-2);
    display: inline-block;
    line-height: var(--font-lineheight-3);
    padding-block: var(--size-px);
    padding-inline: var(--size-1);
  }

  .md :global(:where(a)) {
    color: var(--accent-3);
    cursor: pointer;
    text-decoration-line: underline;
    text-underline-offset: 2px;
  }

  .md :global(:where(hr)) {
    border: none;
    border-block-start: var(--size-px) solid var(--color-border-1);
    margin-block: var(--size-6);
  }

  .md :global(:where(blockquote)) {
    border-inline-start: var(--size-0-5) solid var(--accent-1);
    margin-inline-start: 0;
    padding-inline-start: var(--size-4);
  }

  /* Tables */
  .md :global(:where(table)) {
    border-collapse: collapse;
    inline-size: auto;
    margin-block: var(--size-6);
  }

  .md :global(:where(th, td)) {
    border-block-end: var(--size-px) solid var(--color-border-1);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    min-inline-size: var(--size-32);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
  }

  .md :global(:where(th)) {
    border: none;
    background-color: var(--accent-1);
    font-weight: var(--font-weight-5);
    text-align: start;
  }

  .md :global(:where(th:first-of-type)) {
    border-start-start-radius: var(--radius-3);
    border-end-start-radius: var(--radius-3);
  }

  .md :global(:where(th:last-of-type)) {
    border-start-end-radius: var(--radius-3);
    border-end-end-radius: var(--radius-3);
  }

  /* Spacing between block elements */
  .md :global(:where(p, ul, ol)) {
    &:global(:has(+ ul, + ol, + p)) {
      margin-block-end: var(--size-1-5);
    }
  }

  .md :global(:where(h2)) {
    &:not(:first-child) {
      margin-block-start: var(--size-6);
    }

    & :global(+ p),
    & :global(+ ul),
    & :global(+ ol),
    & :global(+ h3) {
      margin-block-start: var(--size-1-5);
    }
  }

  .md :global(:where(h3)) {
    &:not(:first-child) {
      margin-block-start: var(--size-6);
    }

    & :global(+ p),
    & :global(+ ul),
    & :global(+ ol) {
      margin-block-start: var(--size-1-5);
    }
  }

  .md :global(:where(p, ul, ol)) {
    & :global(+ h2) {
      margin-block-start: var(--size-6);
    }
  }
</style>
