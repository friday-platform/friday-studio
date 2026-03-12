<script lang="ts">
  import { jsonHighlighter } from "$lib/modules/formatting/highlighter";

  interface Props {
    code: string;
  }

  let { code }: Props = $props();

  const highlighted = $derived(
    jsonHighlighter.codeToHtml(code, { lang: "json", theme: "atlas-json" }),
  );
</script>

<div class="json-highlight">
  {@html highlighted}
</div>

<style>
  .json-highlight :global(pre) {
    background: transparent !important;
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-4);
    margin: 0;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .json-highlight :global(code) {
    font-family: inherit;
  }
</style>
