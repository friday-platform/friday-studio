<!--
  Dedicated fullscreen markdown viewer for `text/markdown` artifacts.
  Mirrors the `/table` page chrome (header brand, filename, provenance
  row) and renders the document as a sequence of prose chunks and
  inline tables. Each GFM table embedded in the markdown gets the same
  TableActionsBar (Copy / Download CSV / Download MD) that the `/table`
  page exposes — so a whitepaper with one table inside ships the table
  with its own action chrome without forcing the whole document into a
  tabular renderer.

  Read-only — editing is a deliberate non-goal.
-->

<script lang="ts">
  import { MarkdownRendered, markdownToHTMLSafe } from "@atlas/ui";
  import type { PageData } from "./$types";
  import TableActionsBar from "$lib/components/chat/table-actions-bar.svelte";
  import {
    splitMarkdownByTables,
    type MarkdownSegment,
  } from "$lib/components/chat/table-parsers.ts";
  import TableView from "$lib/components/chat/table-view.svelte";

  const { data }: { data: PageData } = $props();

  const segments = $derived<MarkdownSegment[]>(splitMarkdownByTables(data.text));
  const tableCount = $derived(segments.filter((s) => s.kind === "table").length);

  function renderProse(md: string): string {
    return markdownToHTMLSafe(md);
  }
</script>

<div class="md-page">
  <header class="md-page-header">
    <a class="brand" href="/" aria-label="Friday">
      <svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
        <path
          d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z"
          fill="#1171DF"
        />
      </svg>
      <span class="brand-name">Friday</span>
    </a>

    <div class="title-row">
      <div class="title">
        <h1>{data.filename}</h1>
        <div class="meta">
          {#if tableCount > 0}
            <span class="counts">
              {tableCount} embedded table{tableCount === 1 ? "" : "s"}
            </span>
          {/if}
          {#if data.chatTitle && data.workspaceId && data.chatId}
            <span class="provenance">
              From <a
                href="/platform/{encodeURIComponent(data.workspaceId)}/chat/{encodeURIComponent(
                  data.chatId,
                )}">{data.chatTitle}</a
              >
              in <a href="/platform/{encodeURIComponent(data.workspaceId)}"
                >{data.workspaceName ?? data.workspaceId}</a
              >
            </span>
          {:else if data.workspaceId}
            <span class="provenance">
              in <a href="/platform/{encodeURIComponent(data.workspaceId)}"
                >{data.workspaceName ?? data.workspaceId}</a
              >
            </span>
          {/if}
        </div>
      </div>

      <div class="actions">
        <a class="download-raw" href={data.contentUrl} download={data.filename}>Download MD</a>
      </div>
    </div>
  </header>

  <main class="md-page-body">
    <article class="md-article">
      {#each segments as segment, i (i)}
        {#if segment.kind === "prose"}
          <MarkdownRendered>
            {@html renderProse(segment.markdown)}
          </MarkdownRendered>
        {:else}
          <section class="embedded-table">
            <div class="embedded-table-actions">
              <TableActionsBar model={segment.model} filename={data.filename} />
            </div>
            <TableView columns={segment.model.columns} rows={segment.model.rows} />
          </section>
        {/if}
      {/each}
    </article>
  </main>
</div>

<style>
  .md-page {
    block-size: 100dvh;
    display: flex;
    flex-direction: column;
    inline-size: 100%;
  }

  .md-page-header {
    background: var(--surface-dark);
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-3);
    padding-block: var(--size-3);
    padding-inline: var(--size-5);
  }

  .brand {
    align-items: center;
    align-self: flex-start;
    color: inherit;
    display: inline-flex;
    flex-shrink: 0;
    gap: var(--size-2);
    text-decoration: none;
  }
  .brand-logo {
    block-size: 20px;
    flex-shrink: 0;
    inline-size: 20px;
  }
  .brand-name {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
  }

  .title-row {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
  }
  .title {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-inline-size: 0;
  }
  .title h1 {
    color: var(--color-text);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-1);
    gap: var(--size-3);
  }
  .counts {
    font-variant-numeric: tabular-nums;
  }
  .provenance a {
    color: inherit;
    text-decoration: underline;
  }
  .provenance a:hover {
    color: var(--color-primary);
  }

  .actions {
    margin-inline-start: auto;
  }
  .download-raw {
    background-color: var(--surface, transparent);
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font: inherit;
    padding: var(--size-1) var(--size-3);
    text-decoration: none;
  }
  .download-raw:hover {
    background-color: color-mix(in srgb, var(--color-text), transparent 92%);
  }

  .md-page-body {
    flex: 1;
    inline-size: 100%;
    overflow: auto;
  }
  .md-article {
    /* Hug MarkdownRendered's own 80ch prose cap so margin-auto actually
       centers the visible text, not just the wider article container.
       Tables inside articles use their own overflow:auto for horizontal
       scroll, so a narrow article doesn't crowd them. */
    margin: 0 auto;
    max-inline-size: calc(80ch + 2 * var(--size-5));
    padding-block: var(--size-6);
    padding-inline: var(--size-5);
  }

  .embedded-table {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    margin-block: var(--size-4);
    overflow: hidden;
  }
  .embedded-table-actions {
    background: var(--surface-dark);
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    justify-content: flex-end;
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
  }
</style>
