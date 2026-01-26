<script lang="ts">
  import { markdownToHTML } from "$lib/utils/markdown";
  import type { RequestEntry } from "./types";
  import MessageWrapper from "./wrapper.svelte";

  const { message }: { message: RequestEntry } = $props();

  // Convert markdown to HTML
  const htmlContent = $derived(message.content ? markdownToHTML(message.content) : "");
</script>

<MessageWrapper>
  <article class="request">
    <div class="content">
      {#if htmlContent}
        {@html htmlContent}
      {:else if message.content}
        {message.content}
      {/if}
    </div>
  </article>
</MessageWrapper>

<style>
  .request {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-3);
    inline-size: fit-content;
    margin-inline-end: unset;
    margin-inline-start: auto;
    max-inline-size: 75ch;
    overflow: hidden;
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
  }

  .content {
    max-inline-size: 100%;

    & :global(p),
    & :global(li) {
      color: color-mix(in srgb, var(--color-text) 80%, transparent 20%);
      font-size: var(--font-size-4);
      line-height: var(--font-lineheight-2);
      word-break: break-word;
    }

    & :global(li li) {
      opacity: 1;
    }

    & :global(p),
    & :global(ul),
    & :global(ol) {
      &:global(:has(+ ul, + ol, + p)) {
        margin-block-end: var(--size-1-5);
      }
    }

    & :global(ul) {
      list-style-type: "⋅ ";
      list-style-position: inside;
    }

    & :global(ol) {
      list-style-type: decimal;
      list-style-position: inside;
    }

    & :global(strong) {
      font-weight: var(--font-weight-6);
    }

    & :global(a) {
      color: var(--text-1);
      font-weight: var(--font-weight-5);
      transition: color 150ms ease;
      text-decoration: underline;

      &:hover {
        color: var(--text-3);
      }
    }

    & :global(code),
    & :global(pre) {
      background-color: var(--color-surface-2);
      color: var(--color-red);
      font-family: var(--font-family-monospace);
      font-size: var(--font-size-4);
      font-weight: var(--font-weight-5);
    }

    & :global(p code) {
      border-radius: var(--radius-1);
      display: inline block;
      line-height: var(--font-lineheight-4);
      padding-block: var(--size-0-5);
      padding-inline: var(--size-1);
    }

    & :global(pre) {
      border-radius: var(--radius-3);
      margin-block: var(--size-4);
      inline-size: max-content;
      max-inline-size: calc(100% - var(--size-16));
      margin-inline: var(--size-8);
      padding-block: var(--size-4);
      padding-inline: var(--size-6);
      overflow-x: auto;
    }
  }
</style>
