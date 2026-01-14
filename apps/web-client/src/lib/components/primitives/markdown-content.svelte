<script lang="ts">
  import { markdownToHTML } from "$lib/utils/markdown";
  import type { Snippet } from "svelte";

  const { content, children }: { content?: string; children?: Snippet } = $props();

  // Convert markdown to HTML
  const htmlContent = $derived(content ? markdownToHTML(content) : null);
</script>

<div>
  {#if htmlContent}
    {@html htmlContent}
  {:else if children}
    {@render children()}
  {/if}
</div>

<style>
  div {
    & :global(:not([data-tempest], [data-tempest] *)) {
      &:global(:where(h1, h2, h3, h4, ul, ol, p)) {
        color: color-mix(in srgb, var(--color-text) 80%, transparent 20%);
        max-inline-size: 80ch;
      }

      /* HEADING 1 */
      &:global(:where(h1)) {
        font-size: var(--font-size-7);
        font-weight: var(--font-weight-6);
        line-height: var(--font-lineheight-1);
      }

      /* HEADING 2 */
      &:global(:where(h2)) {
        font-size: var(--font-size-6);
        font-weight: var(--font-weight-6);
        line-height: var(--font-lineheight-1);
      }

      /* HEADING 3 */
      &:global(:where(h3)) {
        font-size: var(--font-size-5);
        font-weight: var(--font-weight-6);
      }

      /* HEADING 4 */
      &:global(:where(h4)) {
        font-size: var(--font-size-3);
        font-weight: var(--font-weight-5);
      }

      &:global(:where(p, li)) {
        font-size: var(--font-size-5);
        line-height: var(--font-lineheight-3);
        word-break: break-word;
      }

      &:global(:where(li li)) {
        opacity: 1;
      }

      &:global(:where(ol)) {
        padding-inline-start: var(--size-6);
        list-style-type: decimal;
      }

      &:global(:where(ul)) {
        padding-inline-start: var(--size-5);
        list-style-type: "⋅ ";
      }

      &:global(:where(li > ul, li > ol)) {
        margin-block-start: var(--size-1);
        margin-block-end: var(--size-1);
      }

      &:global(:where(strong)) {
        font-weight: var(--font-weight-6);
      }

      &:global(:where(a)) {
        color: var(--text-1);
        font-weight: var(--font-weight-5);
        transition: color 150ms ease;
        text-decoration: underline;

        &:hover {
          color: var(--text-3);
        }
      }

      &:global(:where(code, pre)) {
        background-color: var(--color-surface-2);
        color: var(--color-red);
        font-family: var(--font-family-monospace);
        font-size: var(--font-size-4);
        font-weight: var(--font-weight-5);
      }

      &:global(:where(pre)) {
        border-radius: var(--radius-3);
        margin-block: var(--size-4);
        inline-size: max-content;
        max-inline-size: calc(100% - var(--size-16));
        margin-inline: var(--size-8);
        padding-block: var(--size-4);
        padding-inline: var(--size-6);
        overflow-x: auto;
      }

      /* Spacing */
      &:global(:where(h1)) {
        & :global(+ h2:not([data-tempest])) {
          margin-block-start: var(--size-6);
        }
      }

      &:global(:where(h2)) {
        & :global(+ p:not([data-tempest])),
        & :global(+ ul:not([data-tempest])),
        & :global(+ ol:not([data-tempest])),
        & :global(+ h3:not([data-tempest])) {
          margin-block-start: var(--size-1);
        }
      }

      &:global(:where(h3)) {
        & :global(+ p:not([data-tempest])),
        & :global(+ ul:not([data-tempest])),
        & :global(+ ol:not([data-tempest])) {
          margin-block-start: var(--size-1);
        }
      }

      &:global(:where(h2, h3, p, ol, ul)) {
        & :global(+ h3:not([data-tempest])) {
          margin-block-start: var(--size-4);
        }
      }

      &:global(:where(p, ul, ol)) {
        &:global(:has(+ ul, + ol, + p)) {
          margin-block-end: var(--size-1-5);
        }

        & :global(+ h2:not([data-tempest])) {
          margin-block-start: var(--size-6);
        }

        & :global(+ code:not([data-tempest])) {
          margin-block-start: var(--size-3);
        }
      }

      &:global(:where(p code)) {
        border-radius: var(--radius-1);
        display: inline-block;
        line-height: var(--font-lineheight-4);
        padding-block: var(--size-0-5);
        padding-inline: var(--size-1);
      }
    }
  }
</style>
