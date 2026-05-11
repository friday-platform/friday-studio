<script lang="ts">
  import { browser } from "$app/environment";
  import { stripMimeParams } from "@atlas/core/artifacts/file-upload";
  import { z } from "zod";
  import { getExportContext } from "./export-context.ts";
  import { parseTabular, TABULAR_MIMES, type TableModel } from "./table-parsers.ts";
  import TableView from "./table-view.svelte";

  interface Props {
    artifactId: string;
  }

  const { artifactId }: Props = $props();

  // Pulled at script init per Svelte's getContext rule. When defined, the
  // card renders synchronously from prefetched data and the fetch +
  // ResizeObserver effects are skipped — the live UI path is only taken
  // when this is undefined.
  const exportCtx = getExportContext();

  const ArtifactResponseSchema = z.object({
    artifact: z.object({
      id: z.string(),
      title: z.string(),
      summary: z.string().optional(),
      data: z.object({
        type: z.literal("file"),
        mimeType: z.string(),
        size: z.number().int().nonnegative(),
        originalName: z.string().optional(),
      }),
    }),
    contents: z.string().optional(),
  });

  // Initial state branches on `exportCtx`. With context, every field is
  // populated synchronously from the prefetch map and `loading` is false
  // out of the gate so the card never paints a spinner. The trust
  // contract from `export-context.ts` says: if a referenced artifactId is
  // missing from the map, surface a clear error rather than spin.
  // `artifactId` doesn't change after mount (the parent re-keys to switch
  // artifacts), so capturing its initial value here is intentional.
  // svelte-ignore state_referenced_locally
  const prefetched = exportCtx?.artifacts.get(artifactId);
  const exportMissing = exportCtx !== undefined && prefetched === undefined;

  let resolvedTitle = $state(prefetched?.title || "Artifact");
  let resolvedSummary = $state<string | undefined>(prefetched?.summary);
  let mimeType = $state<string | undefined>(prefetched?.mimeType);
  let contents = $state<string | undefined>(undefined);
  let originalName = $state<string | undefined>(prefetched?.originalName);
  let sizeBytes = $state<number | undefined>(prefetched?.size);
  let loading = $state(exportCtx === undefined);
  // svelte-ignore state_referenced_locally
  let fetchError = $state<string | null>(
    exportMissing ? `Artifact ${artifactId} missing from export context` : null,
  );

  // Iframe scale — computed from container width vs assumed content width.
  // In export mode the ResizeObserver path is skipped and we render at 1:1
  // so iframes fill their container without runtime measurement.
  const IFRAME_CONTENT_WIDTH = 1200;
  let iframeScale = $state(exportCtx === undefined ? 0.5 : 1);
  let scalerEl = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    // Skip in export mode — no JS runtime in the static HTML, and we
    // already locked iframeScale to 1 so the iframe renders 1:1.
    if (exportCtx !== undefined) return;
    if (!scalerEl) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) iframeScale = Math.min(1, w / IFRAME_CONTENT_WIDTH);
    });
    observer.observe(scalerEl);
    return () => observer.disconnect();
  });

  $effect(() => {
    // In export mode, the prefetch map already populated state — no fetch
    // is fired (and the daemon API isn't reachable from the static HTML
    // anyway).
    if (exportCtx !== undefined) return;
    if (!browser || !artifactId) return;

    let cancelled = false;
    loading = true;
    fetchError = null;

    async function load() {
      try {
        const res = await fetch(`/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}`);
        if (cancelled) return;
        if (!res.ok) {
          fetchError = `Failed to load artifact (${res.status})`;
          loading = false;
          return;
        }
        const raw: unknown = await res.json();
        if (cancelled) return;
        const parsed = ArtifactResponseSchema.safeParse(raw);
        if (!parsed.success) {
          fetchError = "Unexpected artifact shape from server";
          loading = false;
          return;
        }
        const { artifact, contents: rawContents } = parsed.data;
        resolvedTitle = artifact.title || "Artifact";
        resolvedSummary = artifact.summary;
        mimeType = artifact.data.mimeType;
        sizeBytes = artifact.data.size;
        originalName = artifact.data.originalName;
        contents = rawContents;
        loading = false;
      } catch (e) {
        if (cancelled) return;
        fetchError = e instanceof Error ? e.message : String(e);
        loading = false;
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  });

  // Live UI hits the daemon's /:id/content endpoint; export mode rewrites
  // the URL to a relative `assets/artifacts/<id>/<file>` path inside the
  // zip via the context-supplied resolver.
  const serveUrl = $derived(
    artifactId
      ? exportCtx !== undefined
        ? exportCtx.resolveUrl(artifactId)
        : `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}/content`
      : null,
  );

  // Storage adapters can round-trip text mimes with a charset parameter
  // (`text/html; charset=utf-8`); equality checks against literal mimes
  // would silently miss the parameterised form, falling through to the
  // download tile instead of the inline iframe.
  const baseMime = $derived(mimeType ? stripMimeParams(mimeType) : undefined);

  const imageUrl = $derived(
    serveUrl && baseMime?.startsWith("image/") ? serveUrl : null,
  );

  const htmlUrl = $derived(
    serveUrl && baseMime === "text/html" ? serveUrl : null,
  );

  // PDFs render natively in an iframe via the browser's built-in PDF
  // viewer. Same affordance as html — embed for inline preview, "Open"
  // button for full-screen. No extra deps; this works in Chrome/Edge/
  // Safari/Firefox out of the box.
  const pdfUrl = $derived(
    serveUrl && baseMime === "application/pdf" ? serveUrl : null,
  );

  function mimeLabel(mt: string | undefined): string {
    if (!mt) return "file";
    const map: Record<string, string> = {
      "application/json": "JSON",
      "text/plain": "Text",
      "text/markdown": "Markdown",
      "text/csv": "CSV",
      "text/html": "HTML",
      "image/png": "PNG",
      "image/jpeg": "JPEG",
      "image/gif": "GIF",
      "image/webp": "WebP",
      "image/svg+xml": "SVG",
      "application/pdf": "PDF",
    };
    return map[mt] ?? (mt.split("/")[1] ?? "file");
  }

  function isTextPreviewable(mt: string | undefined): boolean {
    if (!mt) return false;
    return (mt.startsWith("text/") && mt !== "text/html") || mt === "application/json";
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  const sizeLabel = $derived(sizeBytes !== undefined ? formatBytes(sizeBytes) : undefined);

  // -- Tabular preview -----------------------------------------------
  // When an artifact's mime is one the dedicated table view can parse
  // (csv/tsv/json/html/markdown), render the first N rows inline as a
  // real table, and route the existing Open button to the table view
  // instead of a raw-content tab. Falls back to the generic preview/
  // download tile when the bytes don't actually parse as tabular.

  // `TABULAR_MIMES` is imported from `table-parsers.ts` — both the
  // route dispatcher and this card classify against the same set so a
  // tabular artifact gets the table preview here AND a /table route
  // redirect from the dispatcher.
  const PREVIEW_ROW_LIMIT = 8;

  const isTabularMime = $derived(baseMime ? TABULAR_MIMES.has(baseMime) : false);

  // Tabular artifacts open in the dedicated full-screen table viewer
  // at `/artifacts/<id>/table` — the explicit "render as table" path
  // (the bare `/artifacts/<id>` dispatcher would redirect there
  // anyway for tabular mimes, but linking directly skips the
  // round-trip). Workspace-agnostic; export mode skips this — the
  // static HTML has no router.
  const tableRouteUrl = $derived(
    isTabularMime && exportCtx === undefined
      ? `/artifacts/${encodeURIComponent(artifactId)}/table`
      : undefined,
  );

  // text/markdown routes through the bare `/artifacts/<id>` dispatcher
  // (one redirect hop) so the same disambiguation lives in one place:
  // table-shaped markdown (heading + one table) lands on /table, prose
  // lands on /markdown. Linking direct to /markdown would bypass that
  // and ship every md to the prose viewer — wrong for table-only
  // artifacts. Without this branch, Open would fall through to
  // `serveUrl` (the raw /content endpoint, served as a download).
  const markdownDispatchUrl = $derived(
    baseMime === "text/markdown" && exportCtx === undefined
      ? `/artifacts/${encodeURIComponent(artifactId)}`
      : undefined,
  );

  // Fetch raw text for tabular artifacts when the metadata endpoint
  // didn't return `contents` inline. The /content endpoint is content-
  // addressed + cacheable so re-fetching is cheap; we only do it when
  // the mime says "tabular" and we don't already have the text.
  let tabularText = $state<string | undefined>(undefined);
  $effect(() => {
    if (exportCtx !== undefined) return;
    if (!browser) return;
    if (!isTabularMime) {
      tabularText = undefined;
      return;
    }
    if (contents) {
      tabularText = contents;
      return;
    }
    let cancelled = false;
    void fetch(`/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}/content`).then(
      async (res) => {
        if (cancelled || !res.ok) return;
        const text = await res.text();
        if (!cancelled) tabularText = text;
      },
      () => {
        // Silent — preview falls back to download tile when text never
        // arrives. Network errors aren't worth a card-level error
        // banner for what is itself a fallback affordance.
      },
    );
    return () => {
      cancelled = true;
    };
  });

  const tableModel = $derived<TableModel | null>(
    isTabularMime && tabularText && baseMime ? parseTabular(baseMime, tabularText) : null,
  );

  const tablePreview = $derived<TableModel | null>(
    tableModel
      ? {
          columns: tableModel.columns,
          rows: tableModel.rows.slice(0, PREVIEW_ROW_LIMIT),
        }
      : null,
  );

  const tableHiddenRows = $derived(
    tableModel ? Math.max(0, tableModel.rows.length - PREVIEW_ROW_LIMIT) : 0,
  );

  function previewContents(raw: string | undefined, mt: string | undefined): string {
    if (!raw) return "";
    const text =
      mt === "application/json"
        ? (() => {
            try {
              return JSON.stringify(JSON.parse(raw), null, 2);
            } catch {
              return raw;
            }
          })()
        : raw;
    const limit = 3000;
    return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
  }

</script>

<div class="artifact-card">
  <div class="artifact-header">
    <div class="artifact-icon" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    </div>

    <div class="artifact-title-wrap">
      <span class="artifact-title">{resolvedTitle}</span>
      {#if mimeType}
        <span class="mime-badge">{mimeLabel(baseMime)}</span>
      {/if}
    </div>

    {#if serveUrl && !loading}
      <div class="artifact-actions">
        <!-- `download` (no value) defers to the server's
             Content-Disposition filename, which `deriveDownloadFilename`
             rewrites to match the actual mime type — so legacy `.bin`
             artifacts still save with the correct extension. The
             `download` attribute also forces save (rather than render)
             even for inline-disposition mimes like PDF. -->
        <a class="download-btn" href={serveUrl} download title="Download">
          Download
        </a>
        {#if tableRouteUrl}
          <!-- Tabular artifacts open in the dedicated full-screen
               table view (sticky header, copy / download CSV / MD
               buttons) in a new tab. The view runs without app
               chrome — see `isChromeless` in the root layout. -->
          <a
            class="open-btn"
            href={tableRouteUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open table in new tab"
          >
            Open
          </a>
        {:else if markdownDispatchUrl}
          <!-- Markdown artifacts go through the bare /artifacts/<id>
               dispatcher so the table-vs-prose disambiguation
               (isPureMarkdownTable) lives in one place. -->
          <a
            class="open-btn"
            href={markdownDispatchUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open markdown in new tab"
          >
            Open
          </a>
        {:else}
          <a
            class="open-btn"
            href={serveUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in new tab"
          >
            Open
          </a>
        {/if}
      </div>
    {/if}
  </div>

  {#if resolvedSummary}
    <p class="artifact-summary">{resolvedSummary}</p>
  {/if}

  {#if loading}
    <div class="artifact-loading">
      <span class="spinner" aria-hidden="true"></span>
      Loading…
    </div>
  {:else if fetchError}
    <div class="artifact-error">{fetchError}</div>
  {:else if imageUrl}
    <img src={imageUrl} alt={resolvedTitle} class="artifact-image" />
  {:else if htmlUrl}
    <div class="iframe-scaler" bind:this={scalerEl}>
      <!--
        `sandbox="allow-scripts"` (no `allow-same-origin`) drops the
        iframe into an opaque origin so embedded JS can't reach the
        chat UI's cookies, storage, or DOM via SOP — but `allow-scripts`
        lets agent-rendered HTML actually run (Leaflet maps, charts,
        etc). Pair with the daemon's `Content-Security-Policy: sandbox
        allow-scripts; …` header on the /content route.
      -->
      <iframe
        title={resolvedTitle}
        src={htmlUrl}
        sandbox="allow-scripts"
        class="artifact-iframe"
        style="--scale: {iframeScale}"
      ></iframe>
    </div>
  {:else if pdfUrl}
    <!-- loading="lazy" defers the fetch until near the viewport. A chat
         history with multiple PDF artifacts otherwise stampedes the
         daemon for every card on a fresh page load whether the user
         scrolls past it or not — and pre-inline-disposition, that
         triggered a download dialog per card. -->
    <iframe
      title={resolvedTitle}
      src={pdfUrl}
      class="artifact-pdf"
      loading="lazy"
    ></iframe>
  {:else if tablePreview}
    <!-- First N rows rendered with the same shared TableView the
         dedicated route uses. Cap the height so the preview stays
         in chat-bubble scale; users wanting the full grid click
         Open in the header above. -->
    <div class="artifact-table-preview">
      <TableView
        columns={tablePreview.columns}
        rows={tablePreview.rows}
        maxBlockSize="240px"
      />
      {#if tableHiddenRows > 0}
        <div class="artifact-table-footer">
          + {tableHiddenRows} more row{tableHiddenRows === 1 ? "" : "s"} —
          {#if tableRouteUrl}
            <a href={tableRouteUrl}>open the full table</a>
          {:else}
            open the full table
          {/if}
        </div>
      {/if}
    </div>
  {:else if contents && isTextPreviewable(baseMime)}
    <pre class="artifact-preview">{previewContents(contents, baseMime)}</pre>
  {/if}

  {#if !loading && !fetchError && (originalName || sizeLabel || mimeType)}
    <dl class="artifact-meta">
      {#if originalName}
        <div class="meta-row">
          <dt>Name</dt>
          <dd class="meta-path" title={originalName}>{originalName}</dd>
        </div>
      {/if}
      {#if mimeType}
        <div class="meta-row">
          <dt>Type</dt>
          <dd>{mimeType}</dd>
        </div>
      {/if}
      {#if sizeLabel}
        <div class="meta-row">
          <dt>Size</dt>
          <dd>{sizeLabel}</dd>
        </div>
      {/if}
    </dl>
  {/if}
</div>

<style>
  .artifact-card {
    background: var(--surface-dark);
    border: 1px solid var(--color-border-1);
    border-left: 3px solid var(--color-accent);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-2-5) var(--size-3);
  }

  .artifact-header {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
    min-inline-size: 0;
  }

  .artifact-icon {
    color: var(--color-accent);
    display: inline-flex;
    flex-shrink: 0;
    opacity: 0.7;
  }

  .artifact-title-wrap {
    align-items: center;
    display: flex;
    flex: 1;
    gap: var(--size-1-5);
    min-inline-size: 0;
    overflow: hidden;
  }

  .artifact-title {
    color: var(--text-bright);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mime-badge {
    background: color-mix(in srgb, var(--color-accent), transparent 88%);
    border-radius: var(--radius-1);
    color: var(--color-accent);
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    padding: 1px 6px;
  }

  .artifact-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-1, 4px);
  }

  .open-btn {
    background: var(--color-accent);
    border: 1px solid var(--color-accent);
    border-radius: var(--radius-1);
    color: var(--color-text-on-accent, white);
    cursor: pointer;
    flex-shrink: 0;
    font-family: inherit;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 3px 10px;
    text-decoration: none;
    transition: opacity 100ms ease;
  }

  .open-btn:hover:not(:disabled) {
    opacity: 0.85;
  }

  .open-btn:disabled {
    opacity: 0.5;
  }

  /* Secondary action — same shape as Open but neutral so the chat header
     doesn't sprout two equally-loud accent buttons next to each other. */
  .download-btn {
    background: transparent;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: var(--text);
    cursor: pointer;
    flex-shrink: 0;
    font-family: inherit;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 3px 10px;
    text-decoration: none;
    transition: background 100ms ease;
  }

  .download-btn:hover {
    background: var(--surface-bright, var(--surface));
  }

  .artifact-summary {
    color: var(--text-faded);
    font-size: var(--font-size-1);
    line-height: 1.45;
    margin: 0;
  }

  .artifact-loading {
    align-items: center;
    color: color-mix(in srgb, var(--text-faded), transparent 30%);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1-5);
  }

  .spinner {
    animation: spin 0.8s linear infinite;
    border: 2px solid color-mix(in srgb, var(--color-accent), transparent 65%);
    border-block-start-color: var(--color-accent);
    border-radius: 50%;
    block-size: 12px;
    display: inline-block;
    inline-size: 12px;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .artifact-image {
    border-radius: var(--radius-1);
    display: block;
    max-block-size: 480px;
    max-inline-size: 100%;
    object-fit: contain;
  }

  .iframe-scaler {
    block-size: 360px;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    overflow: hidden;
    position: relative;
  }

  .artifact-iframe {
    --scale: 0.5;
    block-size: calc(360px / var(--scale));
    border: none;
    display: block;
    inline-size: 1200px;
    transform: scale(var(--scale));
    transform-origin: top left;
  }

  .artifact-pdf {
    block-size: 480px;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    display: block;
    inline-size: 100%;
  }

  .artifact-preview {
    background: var(--surface-bright, var(--surface));
    border-radius: var(--radius-1);
    color: var(--text);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    line-height: 1.5;
    margin: 0;
    max-block-size: 280px;
    overflow: auto;
    padding: var(--size-2);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .artifact-table-preview {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .artifact-table-footer {
    background: var(--surface-bright, var(--surface));
    border-block-start: 1px solid var(--color-border-1);
    color: var(--text-faded);
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-2);
  }
  .artifact-table-footer a {
    color: var(--color-primary);
    text-decoration: underline;
  }

  .artifact-error {
    color: var(--color-error, var(--red-primary));
    font-size: var(--font-size-1);
  }

  .artifact-meta {
    border-block-start: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding-block-start: var(--size-1-5);
  }

  .meta-row {
    display: flex;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .meta-row dt {
    color: var(--text-faded);
    flex-shrink: 0;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    inline-size: 36px;
    opacity: 0.6;
    text-transform: uppercase;
  }

  .meta-row dd {
    color: var(--text-faded);
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-0, 11px);
    margin: 0;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta-path {
    direction: rtl;
    text-align: start;
    unicode-bidi: plaintext;
  }
</style>
