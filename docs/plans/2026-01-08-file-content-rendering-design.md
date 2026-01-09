# Human-Friendly File Content Rendering

**Bead:** atlas-vzs
**Date:** 2026-01-08
**Branch:** david/tem-3408-i-can-view-uploads-from-the-library

## Problem

The file primitive component renders all file contents as raw strings in `<pre><code>` blocks, regardless of file type. CSV data appears as comma-separated text, JSON is unformatted, and Markdown shows raw syntax instead of rendered content.

## Solution

Render file contents based on MIME type:

| MIME Type | Rendering |
|-----------|-----------|
| `text/markdown`, `text/x-markdown` | Rendered HTML via `markdown-content.svelte` |
| `text/csv` | Parsed table via new `basic-table.svelte` |
| `application/json` | Pretty-printed in `<pre><code>` |
| `text/yaml` | Pretty-printed in `<pre><code>` |
| `text/plain` | Plain `<p>` tag (not code-formatted) |

Malformed content (invalid JSON, broken CSV) shows an error message inline and falls back to raw text.

## Implementation

### 1. Create `basic-table.svelte`

Extract table markup and styling from `table.svelte`:

```svelte
<script lang="ts">
type Props = {
  headers: string[];
  rows: Record<string, string | number>[];
};

const { headers, rows }: Props = $props();
</script>

<table>
  <thead>
    <tr>
      {#each headers as header (header)}
        <th>{header}</th>
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each rows as row, i (i)}
      <tr>
        {#each headers as header (header)}
          <td>{row[header]}</td>
        {/each}
      </tr>
    {/each}
  </tbody>
</table>

<style>
  /* Styles extracted from table.svelte */
</style>
```

### 2. Update `table.svelte`

Import and use `basic-table.svelte` inside the `<Document>` wrapper:

```svelte
<script lang="ts">
import Document from "$lib/components/primitives/document.svelte";
import BasicTable from "$lib/components/primitives/basic-table.svelte";

const { data }: { data: { headers: string[]; rows: Record<string, string | number>[] } } = $props();
</script>

<Document name="Table">
  <BasicTable headers={data.headers} rows={data.rows} />
</Document>
```

### 3. Update `file.svelte`

Add imports and derived parsing state:

```typescript
import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
import BasicTable from "$lib/components/primitives/basic-table.svelte";
import Papa from "papaparse";

const parsedContent = $derived.by(() => {
  if (!fileContents) return null;

  switch (data.mimeType) {
    case "application/json": {
      try {
        const parsed = JSON.parse(fileContents);
        return { type: "json", content: JSON.stringify(parsed, null, 2) };
      } catch {
        return { type: "error", content: "Invalid JSON", raw: fileContents };
      }
    }
    case "text/csv": {
      const result = Papa.parse<Record<string, string>>(fileContents, { header: true });
      if (result.errors.length > 0) {
        return { type: "error", content: "Invalid CSV", raw: fileContents };
      }
      return { type: "csv", headers: result.meta.fields ?? [], rows: result.data };
    }
    case "text/markdown":
    case "text/x-markdown":
      return { type: "markdown", content: fileContents };
    case "text/yaml":
      return { type: "yaml", content: fileContents };
    default:
      return { type: "text", content: fileContents };
  }
});
```

Template:

```svelte
<div class="contents" ...>
  {#if parsedContent}
    {#if parsedContent.type === "error"}
      <p class="error">{parsedContent.content}</p>
      <p>{parsedContent.raw}</p>
    {:else if parsedContent.type === "markdown"}
      <MarkdownContent content={parsedContent.content} />
    {:else if parsedContent.type === "csv"}
      <BasicTable headers={parsedContent.headers} rows={parsedContent.rows} />
    {:else if parsedContent.type === "json" || parsedContent.type === "yaml"}
      <pre><code>{parsedContent.content}</code></pre>
    {:else}
      <p>{parsedContent.content}</p>
    {/if}
  {/if}
</div>
```

### 4. Add dependency

```bash
cd apps/web-client && npm install papaparse @types/papaparse
```

## Styling Notes

- Plain text: Add `white-space: pre-wrap` to preserve line breaks
- Markdown: Styles come from `markdown-content.svelte` via `:global()` selectors
- Tables: Scroll horizontally in `.contents` div (already has `overflow: auto`)
- Errors: Use existing `.error { color: var(--color-error); }` class

## Files Changed

1. **Create** `apps/web-client/src/lib/components/primitives/basic-table.svelte`
2. **Modify** `apps/web-client/src/lib/components/primitives/table.svelte`
3. **Modify** `apps/web-client/src/lib/components/primitives/file.svelte`
4. **Modify** `apps/web-client/package.json` (add papaparse)
