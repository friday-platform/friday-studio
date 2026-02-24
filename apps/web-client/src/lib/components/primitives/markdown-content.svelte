<script lang="ts">
  import { markdownToHTML } from "$lib/utils/markdown";
  import type { Snippet } from "svelte";
  import MarkdownRendered from "./markdown-rendered.svelte";

  const { content, children }: { content?: string; children?: Snippet } = $props();

  // Convert markdown to HTML
  const htmlContent = $derived(content ? markdownToHTML(content) : null);
</script>

<MarkdownRendered>
  {#if htmlContent}
    {@html htmlContent}
  {:else if children}
    {@render children()}
  {/if}
</MarkdownRendered>
