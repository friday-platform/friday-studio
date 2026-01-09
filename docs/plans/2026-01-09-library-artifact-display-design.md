# Library Artifact Display Refactor

## Problem

The library `[artifactId]` page uses `<Display>` which wraps content in
`<MessageWrapper>`. We want custom styling per artifact type without the
`<Document>` wrapper, and to consolidate file rendering logic.

## Solution

Hoist `<Document>` wrapping responsibility to `display.svelte`, inline simple
rendering (summary), and build custom rendering in the library page.

## Changes

### Create: `lib/modules/artifacts/file-utils.ts`

Extract file parsing logic into a utility:

```ts
export type ParsedContent =
  | { type: "markdown"; content: string }
  | { type: "csv"; headers: string[]; rows: Record<string, string | number>[] }
  | { type: "json"; content: string }
  | { type: "yaml"; content: string }
  | { type: "plaintext"; content: string }
  | { type: "code"; content: string }
  | { type: "error"; message: string; raw: string };

export function parseFileContents(contents: string, mimeType: string): ParsedContent
```

### Modify: `primitives/file.svelte`

- Import `parseFileContents` from utility
- Remove inline parsing logic
- Keep all UI (header, collapsible, dropdown, download/copy)

### Modify: `modules/artifacts/display.svelte`

- Remove `<MessageWrapper>`
- Inline summary rendering with `<MarkdownContent>`
- Handle `<Document>` wrapping for summary, table, file types
- Import `BasicTable` directly instead of `Table`

```svelte
{#if artifact.type === 'summary'}
  <Document name="Search Result">
    <div class="summary">
      <MarkdownContent content={artifact.data} />
    </div>
  </Document>
{:else if artifact.type === 'table'}
  <Document name="Table">
    <BasicTable headers={artifact.data.headers} rows={artifact.data.rows} />
  </Document>
{:else if artifact.type === 'file'}
  <Document name={fileName}>
    <File data={artifact.data} artifactId={artifactId} />
  </Document>
{/if}
```

### Modify: `routes/(app)/library/[artifactId]/+page.svelte`

- Fetch artifact directly (no Display component)
- Single API call fetches both artifact and file contents
- Render each type with custom styling
- File artifacts get header with dropdown for download/copy
- No `<Document>` wrappers

### Delete: `primitives/table.svelte`

No longer needed - `display.svelte` uses `<BasicTable>` directly.

### Delete: `primitives/summary.svelte`

No longer needed - `display.svelte` inlines the rendering.

## Beads

- `atlas-ay0`: Create file-utils.ts
- `atlas-a3c`: Update display.svelte (inline summary, Document wrapping)
- `atlas-fqz`: Update file.svelte to use utility (depends on atlas-ay0)
- `atlas-fvp`: Update library page (depends on atlas-ay0)
- `atlas-kw2`: Delete table.svelte (depends on atlas-a3c)
- `atlas-gmx`: Delete summary.svelte (depends on atlas-a3c)
