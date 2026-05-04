<script lang="ts">
  import { browser } from "$app/environment";
  import { stripMimeParams } from "@atlas/core/artifacts/file-upload";
  import { z } from "zod";

  interface Props {
    artifactId: string;
  }

  const { artifactId }: Props = $props();

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

  let resolvedTitle = $state("Artifact");
  let resolvedSummary = $state<string | undefined>(undefined);
  let mimeType = $state<string | undefined>(undefined);
  let contents = $state<string | undefined>(undefined);
  let originalName = $state<string | undefined>(undefined);
  let sizeBytes = $state<number | undefined>(undefined);
  let loading = $state(true);
  let fetchError = $state<string | null>(null);

  // Iframe scale — computed from container width vs assumed content width.
  const IFRAME_CONTENT_WIDTH = 1200;
  let iframeScale = $state(0.5);
  let scalerEl = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    if (!scalerEl) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) iframeScale = Math.min(1, w / IFRAME_CONTENT_WIDTH);
    });
    observer.observe(scalerEl);
    return () => observer.disconnect();
  });

  $effect(() => {
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

  // Bytes come straight from the daemon's /:id/content endpoint, which
  // streams the Object Store blob inline (image) or as attachment.
  const serveUrl = $derived(
    artifactId ? `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}/content` : null,
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
        <a class="open-btn" href={serveUrl} target="_blank" rel="noopener noreferrer" title="Open in new tab">
          Open
        </a>
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

  .meta-path a {
    color: inherit;
    text-decoration: none;
  }

  .meta-path a:hover {
    color: var(--color-accent);
    text-decoration: underline;
  }
</style>
