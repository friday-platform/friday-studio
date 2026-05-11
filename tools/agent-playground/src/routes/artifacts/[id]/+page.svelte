<!--
  Fallback view shown by the artifact dispatcher when the mime type
  isn't one we have a dedicated renderer for. Tabular mimes 307 to
  `./table` from the loader so this page never runs in those cases.

  Future renderers (`./raw`, `./image`, `./pdf`, etc.) will siphon
  off their respective mimes; this page is the "we recognize this is
  a file but have no inline preview wired up" terminus — show the
  basics and offer a download.
-->

<script lang="ts">
  import type { PageData } from "./$types";

  const { data }: { data: PageData } = $props();

  function fmtBytes(n: number | undefined): string {
    if (n === undefined) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

<div class="page">
  <header class="brand-row">
    <a class="brand" href="/" aria-label="Friday">
      <svg class="brand-logo" xmlns="http://www.w3.org/2000/svg" viewBox="-4.1 -0.2 26 26">
        <path
          d="M9.9375 14.9014C10.344 14.9014 10.6738 15.2312 10.6738 15.6377V20.2383C10.6737 23.1855 8.28412 25.5751 5.33691 25.5752C2.38962 25.5752 0.000158184 23.1855 0 20.2383C0 17.2909 2.38953 14.9014 5.33691 14.9014H9.9375ZM11.1377 0C14.8218 0.00013192 17.8086 2.98674 17.8086 6.6709C17.8086 10.3551 14.8218 13.3417 11.1377 13.3418H5.21289C4.80079 13.3418 4.46696 13.0078 4.4668 12.5957V6.6709C4.4668 2.98666 7.45346 0 11.1377 0Z"
          fill="#1171DF"
        />
      </svg>
      <span class="brand-name">Friday</span>
    </a>
  </header>

  <main class="body">
    <h1 class="filename">{data.filename}</h1>
    <dl class="meta">
      <div>
        <dt>Type</dt>
        <dd>{data.mimeType}</dd>
      </div>
      {#if data.size !== undefined}
        <div>
          <dt>Size</dt>
          <dd>{fmtBytes(data.size)}</dd>
        </div>
      {/if}
    </dl>
    <p class="hint">
      No inline preview for this artifact type yet — download the raw file below.
    </p>
    <a class="download" href={data.contentUrl} download={data.filename}>
      Download {data.filename}
    </a>
  </main>
</div>

<style>
  .page {
    block-size: 100dvh;
    display: flex;
    flex-direction: column;
    inline-size: 100%;
  }

  .brand-row {
    background: var(--surface-dark);
    border-block-end: 1px solid var(--color-border-1);
    flex-shrink: 0;
    padding-block: var(--size-3);
    padding-inline: var(--size-5);
  }

  .brand {
    align-items: center;
    color: inherit;
    display: inline-flex;
    gap: var(--size-2);
    text-decoration: none;
  }
  .brand-logo {
    block-size: 20px;
    inline-size: 20px;
  }
  .brand-name {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
  }

  .body {
    align-items: flex-start;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-3);
    max-inline-size: 36rem;
    padding-block: var(--size-6);
    padding-inline: var(--size-5);
  }

  .filename {
    color: var(--color-text);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
  }
  .meta div {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
  }
  .meta dt {
    font-weight: var(--font-weight-6);
    inline-size: 4rem;
  }
  .meta dd {
    font-family: var(--font-mono, ui-monospace, monospace);
    margin: 0;
  }

  .hint {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-2);
    margin: 0;
  }

  .download {
    background: var(--color-primary);
    border-radius: var(--radius-2);
    color: var(--color-text-on-primary, white);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    padding: var(--size-2) var(--size-4);
    text-decoration: none;
  }
  .download:hover {
    opacity: 0.9;
  }
</style>
