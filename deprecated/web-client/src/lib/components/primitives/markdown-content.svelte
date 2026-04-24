<script lang="ts">
  import { browser } from "$app/environment";
  import { markdownToHTML } from "$lib/utils/markdown";
  import DOMPurify from "dompurify";
  import type { Snippet } from "svelte";
  import MarkdownRendered from "./markdown-rendered.svelte";

  const { content, children }: { content?: string; children?: Snippet } = $props();

  // Convert markdown to HTML — escapeHtml runs in both contexts;
  // DOMPurify is the client-only safety net (requires DOM APIs)
  const htmlContent = $derived(
    content
      ? browser
        ? DOMPurify.sanitize(markdownToHTML(content))
        : markdownToHTML(content)
      : null,
  );
</script>

<MarkdownRendered>
  {#if htmlContent}
    {@html htmlContent}
  {:else if children}
    {@render children()}
  {/if}
</MarkdownRendered>
