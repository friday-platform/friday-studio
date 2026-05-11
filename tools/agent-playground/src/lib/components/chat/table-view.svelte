<!--
  Read-only fullscreen table renderer used by the dedicated
  `/artifacts/[id]/table` route and by any
  ArtifactCard preview that wants the same table chrome inline.

  Props:
    columns — string array of column headers (one per visual column)
    rows    — string array per row, parallel to columns

  Renders a sticky-header table inside a horizontally-scrollable
  container. The container takes 100% of its parent's height so the
  table body scrolls vertically without the header leaving the
  viewport. Horizontal scroll is handled by the same container so
  wide tables fit inside the parent layout without overflowing.

  Cell content is rendered as plain text (no HTML, no markdown
  re-rendering). Tables that originated as HTML or markdown have
  already been parsed into the flat string-grid model upstream;
  preserving rich content per-cell isn't a feature we ship today.
-->

<script lang="ts">
  interface Props {
    columns: string[];
    rows: string[][];
    /** Optional max-height override so the component fits inside a
     *  card preview (~12 rows) instead of filling its parent. */
    maxBlockSize?: string;
  }

  const { columns, rows, maxBlockSize }: Props = $props();

  // Pad short rows to the column count so the grid is rectangular.
  // Datasets that came from CSV / TSV occasionally trail with rows
  // that omit empty trailing cells; we want every <tr> to have the
  // full <td> count so the header alignment doesn't drift.
  const normalizedRows = $derived(
    rows.map((r) => {
      if (r.length >= columns.length) return r;
      const padded = [...r];
      while (padded.length < columns.length) padded.push("");
      return padded;
    }),
  );
</script>

<div class="table-scroll" style:max-block-size={maxBlockSize}>
  <table class="data-table">
    <thead>
      <tr>
        {#each columns as col, ci (ci)}
          <th>{col}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each normalizedRows as row, ri (ri)}
        <tr>
          {#each row as cell, ci (ci)}
            <td>{cell}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  /* Scroll container owns BOTH axes — horizontal for wide tables,
     vertical for long ones. Body of the page sets height; this fills it. */
  .table-scroll {
    block-size: 100%;
    inline-size: 100%;
    overflow: auto;
    /* Thin scrollbars match the chat surfaces. */
    scrollbar-width: thin;
  }

  .data-table {
    border-collapse: separate;
    border-spacing: 0;
    font-size: var(--font-size-2);
    /* Expand to fill the available width when content is narrower
       than the viewport — wide-margin tables (few columns) look like
       sparse data and the dead horizontal space hurts more than the
       expanded column widths. min-inline-size: max-content preserves
       the horizontal-scroll behavior when content is WIDER than the
       viewport — content "wants" max-content, but can grow to the
       container's full width. */
    inline-size: 100%;
    min-inline-size: max-content;
    /* Borderless edges; cell borders below own the grid lines so
       sticky-header positioning doesn't get a doubled top border. */
  }

  .data-table thead th {
    background-color: var(--color-surface-2, var(--surface));
    /* Sticky header survives vertical scroll inside .table-scroll. */
    border-block-end: 1px solid var(--color-border-1);
    color: var(--color-text);
    font-weight: var(--font-weight-6);
    inset-block-start: 0;
    padding: var(--size-1-5) var(--size-2);
    position: sticky;
    text-align: start;
    /* Above the body cells so they scroll under instead of over. */
    z-index: 1;
  }

  .data-table td {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    padding: var(--size-1-5) var(--size-2);
    /* Cells stay on one line so wide datasets keep their grid shape
       and horizontal scroll has something to scroll. Long strings
       (URLs, sentences) will push the column wider; that's the
       point of the dedicated view. */
    white-space: nowrap;
  }

  .data-table tbody tr:hover td {
    background-color: color-mix(in srgb, var(--color-text), transparent 95%);
  }
</style>
