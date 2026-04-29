<!--
  Discover Spaces — two-pane catalog browser.

  Left pane: searchable list of workspace folders pulled from a public repo
  (defaults to vercel/examples/main/starter — see server/routes/discover.ts).
  Right pane: detail view with README, manifest, and an Add Space action.

  Route: /discover           → first item selected by default
  Route: /discover/{slug}    → detail for that folder

  @component
-->

<script lang="ts">
  import {
    Button,
    IconSmall,
    ListDetail,
    MarkdownRendered,
    markdownToHTML,
    toast,
  } from "@atlas/ui";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getClient } from "$lib/client";
  import { discoverQueries, type DiscoverDetail } from "$lib/queries/discover-queries";
  import { workspaceQueries } from "$lib/queries";
  import DOMPurify from "dompurify";

  const queryClient = useQueryClient();

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  const listQuery = createQuery(() => discoverQueries.list());
  const items = $derived(listQuery.data?.items ?? []);

  // Effective slug: URL param if set, otherwise first item.
  const urlSlug = $derived(page.params.slug ?? null);
  const selectedSlug = $derived(urlSlug ?? items[0]?.slug ?? null);

  const detailQuery = createQuery(() => discoverQueries.detail(selectedSlug));
  const detail = $derived(detailQuery.data ?? null);

  // ---------------------------------------------------------------------------
  // Sidebar search
  // ---------------------------------------------------------------------------

  let searchInput = $state("");
  const filteredItems = $derived.by(() => {
    const q = searchInput.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) => i.name.toLowerCase().includes(q) || i.slug.toLowerCase().includes(q),
    );
  });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handleSelect(slug: string): void {
    goto(`/discover/${slug}`, { replaceState: true });
  }

  let importing = $state(false);

  async function handleImport(): Promise<void> {
    if (!selectedSlug || importing) return;
    importing = true;
    try {
      const res = await getClient().api.discover.import.$post({ query: { slug: selectedSlug } });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message =
          body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : `Import failed (${res.status})`;
        toast({ title: message, error: true });
        return;
      }
      const parsed =
        body && typeof body === "object" && body !== null
          ? (body as { workspaceId?: string; name?: string })
          : {};
      await queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });
      toast({ title: `Imported: ${parsed.name ?? detail?.name ?? selectedSlug}` });
      if (parsed.workspaceId) {
        await goto(`/platform/${parsed.workspaceId}`);
      }
    } finally {
      importing = false;
    }
  }

  // ---------------------------------------------------------------------------
  // README rendering — rebase relative paths to GitHub raw / tree URLs.
  // ---------------------------------------------------------------------------

  function rebaseRelativeLinks(html: string, src: DiscoverDetail["source"]): string {
    const rawBase = `https://raw.githubusercontent.com/${src.repo}/${src.ref}/${src.path}/`;
    const treeBase = `https://github.com/${src.repo}/tree/${src.ref}/${src.path}/`;
    return html
      .replace(/src="(?!https?:\/\/|data:|\/)/g, `src="${rawBase}`)
      .replace(/href="(?!https?:\/\/|#|\/|mailto:)/g, `href="${treeBase}`);
  }

  const renderedReadme = $derived.by(() => {
    if (!detail || !detail.readme) return "";
    const raw = markdownToHTML(detail.readme);
    const rebased = rebaseRelativeLinks(raw, detail.source);
    return DOMPurify.sanitize(rebased);
  });
</script>

<ListDetail>
  {#snippet header()}
    <h1>Discover Spaces</h1>
  {/snippet}

  {#snippet sidebar()}
    <div class="catalog-tree">
      <div class="search-field">
        <span class="search-icon"><IconSmall.Search /></span>
        <input
          type="text"
          placeholder="Search"
          bind:value={searchInput}
          autocomplete="off"
        />
      </div>

      <div class="tree-section">
        <div class="section-header">
          <span class="section-label">Spaces</span>
          <span class="section-count">{filteredItems.length}</span>
        </div>

        {#if listQuery.isLoading}
          <div class="tree-skeleton">
            {#each Array.from({ length: 6 }) as _, i (i)}
              <div class="skeleton-row"></div>
            {/each}
          </div>
        {:else if listQuery.isError}
          <p class="tree-empty">{listQuery.error?.message ?? "Failed to load."}</p>
        {:else if filteredItems.length === 0}
          <p class="tree-empty">
            {searchInput ? `No spaces match "${searchInput}"` : "No spaces found."}
          </p>
        {:else}
          {#each filteredItems as item (item.slug)}
            <button
              class="tree-item"
              class:active={selectedSlug === item.slug}
              onclick={() => handleSelect(item.slug)}
            >
              <span class="item-name">{item.name}</span>
            </button>
          {/each}
        {/if}
      </div>
    </div>
  {/snippet}

  <div class="detail-pane">
    {#if !selectedSlug}
      <div class="empty-state">
        <div class="empty-icon"><IconSmall.Search /></div>
        <h2 class="empty-title">Discover Spaces</h2>
        <p class="empty-desc">
          Browse example workspaces from the Friday catalog.
        </p>
      </div>
    {:else if detailQuery.isLoading}
      <div class="loading">Loading…</div>
    {:else if detailQuery.isError}
      <div class="error-banner" role="alert">
        <span>{detailQuery.error?.message ?? "Failed to load."}</span>
        <button class="retry" onclick={() => void detailQuery.refetch()}>Retry</button>
      </div>
    {:else if detail}
      <div class="detail-header">
        <div class="header-main">
          <h1 class="space-name">{detail.name}</h1>
          {#if detail.description}
            <p class="description">{detail.description}</p>
          {/if}
          <a class="meta" href={detail.source.htmlUrl} target="_blank" rel="noopener noreferrer">
            View on GitHub
          </a>
        </div>

        <div class="header-actions">
          <Button variant="primary" onclick={handleImport} disabled={importing}>
            {importing ? "Importing…" : "Add Space"}
          </Button>
        </div>
      </div>

      <div class="detail-content">
        {#if detail.readme}
          <section class="content-section">
            <div class="readme-content">
              <MarkdownRendered>
                {@html renderedReadme}
              </MarkdownRendered>
            </div>
          </section>
        {:else}
          <div class="empty">No README.md in this folder.</div>
        {/if}

        {#if detail.signals.length > 0 || detail.agents.length > 0 || detail.jobs.length > 0}
          <section class="content-section manifest-section">
            <h3 class="section-title">Manifest</h3>
            <div class="manifest">
              {#if detail.signals.length > 0}
                <div class="manifest-group">
                  <h4 class="manifest-h">Signals</h4>
                  <ul class="manifest-list">
                    {#each detail.signals as s (s.id)}
                      <li class="manifest-row">
                        <code class="row-id">{s.id}</code>
                        {#if s.title}<span class="row-title">{s.title}</span>{/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              {#if detail.agents.length > 0}
                <div class="manifest-group">
                  <h4 class="manifest-h">Agents</h4>
                  <ul class="manifest-list">
                    {#each detail.agents as a (a.id)}
                      <li class="manifest-row">
                        <code class="row-id">{a.id}</code>
                        {#if a.description}<span class="row-title">{a.description}</span>{/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              {#if detail.jobs.length > 0}
                <div class="manifest-group">
                  <h4 class="manifest-h">Jobs</h4>
                  <ul class="manifest-list">
                    {#each detail.jobs as j (j.id)}
                      <li class="manifest-row">
                        <code class="row-id">{j.id}</code>
                        {#if j.title}<span class="row-title">{j.title}</span>{/if}
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
          </section>
        {/if}
      </div>
    {/if}
  </div>
</ListDetail>

<style>
  /* ─── Sidebar ─────────────────────────────────────────────────────────── */

  .catalog-tree {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .search-field {
    align-items: center;
    background: var(--surface);
    border: none;
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-2);
    padding: 0 var(--size-3);
  }

  .search-icon {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    display: flex;
    flex-shrink: 0;
  }

  .search-field input {
    background: transparent;
    border: none;
    color: var(--color-text);
    font-family: inherit;
    font-size: var(--font-size-2);
    inline-size: 100%;
    outline: none;
    padding: var(--size-2) 0;
  }

  .search-field input::placeholder {
    color: color-mix(in srgb, var(--color-text), transparent 70%);
  }

  .tree-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .section-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    padding: 0 var(--size-1);
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .section-count {
    color: color-mix(in srgb, var(--color-text), transparent 65%);
    font-size: var(--font-size-0);
    font-variant-numeric: tabular-nums;
  }

  .tree-item {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-4);
    gap: var(--size-1-5);
    inline-size: 100%;
    opacity: 0.85;
    padding: var(--size-1) var(--size-2);
    text-align: start;
    transition:
      background-color 100ms ease,
      opacity 100ms ease;
  }

  .tree-item:hover {
    background-color: var(--highlight);
    opacity: 1;
  }

  .tree-item.active {
    background-color: var(--highlight);
    font-weight: var(--font-weight-5);
    opacity: 1;
  }

  .item-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tree-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: 0 var(--size-1);
  }

  .skeleton-row {
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    background: var(--color-surface-3);
    border-radius: 4px;
    block-size: 28px;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }

  .tree-empty {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
    margin: 0;
    padding: var(--size-2) var(--size-1);
  }

  /* ─── Detail pane ─────────────────────────────────────────────────────── */

  .detail-pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
  }

  .empty-state {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-3);
    justify-content: center;
    padding: var(--size-16);
  }

  .empty-icon {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
  }

  .empty-icon :global(svg) {
    block-size: 40px;
    inline-size: 40px;
  }

  .empty-title {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .empty-desc {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
    line-height: 1.5;
    margin: 0;
    max-inline-size: 48ch;
    text-align: center;
  }

  .detail-header {
    align-items: flex-start;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    gap: var(--size-4);
    justify-content: space-between;
    padding: var(--size-6) var(--size-8);
  }

  .header-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .space-name {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    letter-spacing: -0.01em;
    margin: 0;
    word-break: break-word;
  }

  .description {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
    font-size: var(--font-size-2);
    line-height: 1.55;
    margin: 0;
    max-inline-size: 72ch;
  }

  .meta {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-1);
    text-decoration: none;
  }

  .meta:hover {
    color: var(--color-accent);
    text-decoration: underline;
  }

  .header-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
  }

  .detail-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-4) var(--size-8) var(--size-10);
  }

  .content-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-title {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  /* ─── Manifest ────────────────────────────────────────────────────────── */

  .manifest {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .manifest-group {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .manifest-h {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    margin: 0;
    text-transform: uppercase;
  }

  .manifest-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .manifest-row {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .row-id {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .row-title {
    color: color-mix(in srgb, var(--color-text), transparent 35%);
    font-size: var(--font-size-1);
    line-height: 1.4;
  }

  .manifest-section {
    border-block-start: 1px solid var(--color-border-1);
    margin-block-start: var(--size-2);
    padding-block-start: var(--size-6);
  }

  /* ─── README ──────────────────────────────────────────────────────────── */

  .readme-content {
    color: color-mix(in srgb, var(--color-text), transparent 10%);
    font-size: var(--font-size-2);
    line-height: 1.6;
  }

  .readme-content :global(h1) {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
    margin-block: var(--size-4) var(--size-2);
  }

  .readme-content :global(h2) {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    margin-block: var(--size-4) var(--size-2);
  }

  .readme-content :global(h3) {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin-block: var(--size-3) var(--size-1);
  }

  .readme-content :global(p) {
    margin-block: var(--size-2);
  }

  .readme-content :global(ul),
  .readme-content :global(ol) {
    margin-block: var(--size-2);
    padding-inline-start: var(--size-5);
  }

  .readme-content :global(li) {
    margin-block: var(--size-0-5);
  }

  .readme-content :global(a) {
    color: var(--color-accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .readme-content :global(img) {
    border-radius: var(--radius-2);
    max-inline-size: 100%;
  }

  .readme-content :global(blockquote) {
    border-inline-start: 3px solid var(--color-border-1);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    margin: var(--size-2) 0;
    padding-inline-start: var(--size-3);
  }

  /* ─── Status banners ──────────────────────────────────────────────────── */

  .loading,
  .empty {
    color: color-mix(in srgb, var(--color-text), transparent 55%);
    font-size: var(--font-size-2);
    padding: var(--size-6) var(--size-8);
  }

  .error-banner {
    align-items: center;
    background: color-mix(in srgb, var(--color-error), transparent 85%);
    border: 1px solid color-mix(in srgb, var(--color-error), transparent 50%);
    border-radius: 6px;
    display: flex;
    gap: 12px;
    margin: var(--size-6) var(--size-8);
    padding: 10px 14px;
  }

  .retry {
    background: transparent;
    border: 1px solid var(--color-border-2);
    border-radius: 4px;
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    margin-left: auto;
    padding: 3px 10px;
  }
</style>
