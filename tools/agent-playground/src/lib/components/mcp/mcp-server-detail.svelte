<!--
  MCP Server Detail — right pane for the two-pane catalog layout.

  Renders full details for an installed server or a registry preview.
  Includes README markdown rendering, transport info, env vars, and actions.

  @component
  @prop server - Installed server metadata (if selected)
  @prop registryResult - Registry search result (if previewing uninstalled)
  @prop onInstall - Called to install a registry result
  @prop onCheckUpdate - Called to check for updates
  @prop onPullUpdate - Called to pull an update
  @prop onDelete - Called to remove a server
  @prop installing - Whether an install is in progress
  @prop checking - Whether check-update is in progress
  @prop pulling - Whether pull-update is in progress
  @prop deleting - Whether delete is in progress
-->

<script lang="ts">
  import { browser } from "$app/environment";
  import {
    Button,
    Dialog,
    IconSmall,
    MarkdownRendered,
    markdownToHTML,
  } from "@atlas/ui";
  import McpCredentialsPanel from "./mcp-credentials-panel.svelte";
  import { writable } from "svelte/store";
  import DOMPurify from "dompurify";
  import { isOfficialCanonicalName } from "@atlas/core/mcp-registry/official-servers";
  import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
  import type { SearchResult } from "$lib/queries/mcp-queries";

  interface Props {
    server?: MCPServerMetadata | null;
    registryResult?: SearchResult | null;
    onInstall?: (registryName: string) => void;
    onCheckUpdate?: () => void;
    onPullUpdate?: () => void;
    onDelete?: () => void;
    installing?: boolean;
    checking?: boolean;
    pulling?: boolean;
    deleting?: boolean;
    hasUpdate?: boolean;
  }

  let {
    server = null,
    registryResult = null,
    onInstall,
    onCheckUpdate,
    onPullUpdate,
    onDelete,
    installing = false,
    checking = false,
    pulling = false,
    deleting = false,
    hasUpdate = false,
  }: Props = $props();

  const deleteDialogOpen = writable(false);

  // Reset delete dialog when navigating to a different server
  $effect(() => {
    server?.id;
    deleteDialogOpen.set(false);
  });

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------

  const displayName = $derived(server?.name ?? registryResult?.name ?? "");
  const description = $derived(server?.description ?? registryResult?.description ?? null);
  const source = $derived(server?.source ?? null);
  const isInstalled = $derived(server !== null);
  const isRegistry = $derived(source === "registry" || registryResult !== null);
  const readme = $derived(server?.readme ?? null);

  const isOfficial = $derived.by(() => {
    if (server?.source === "static") return true;
    if (server?.upstream?.canonicalName) {
      return isOfficialCanonicalName(server.upstream.canonicalName);
    }
    if (registryResult?.isOfficial) return true;
    return false;
  });

  const repoUrl = $derived.by(() => {
    // For registry results, we don't have the repo URL in the search response yet
    // For installed servers, we can construct from upstream canonical name if needed
    return null;
  });

  function sourceLabel(src: string): string {
    switch (src) {
      case "static":
        return "Built-in";
      case "registry":
        return "Registry";
      case "web":
        return "Web";
      case "agents":
        return "Agents";
      default:
        return src;
    }
  }

  function sourceColor(src: string): string {
    switch (src) {
      case "static":
        return "var(--color-success)";
      case "registry":
        return "var(--color-accent)";
      case "web":
        return "var(--color-info)";
      case "agents":
        return "var(--color-warning)";
      default:
        return "var(--color-text)";
    }
  }

  function transportInfo(s: MCPServerMetadata): string {
    const t = s.configTemplate.transport;
    if (!t) return "unknown";
    if (t.type === "stdio") {
      return `${t.command ?? "npx"} ${(t.args ?? []).join(" ")}`;
    }
    if (t.type === "http") {
      return t.url ?? "HTTP endpoint";
    }
    return t.type;
  }

  function securityLabel(rating: string | undefined): string {
    switch (rating) {
      case "high":
        return "High";
      case "medium":
        return "Medium";
      case "low":
        return "Low";
      default:
        return "Unverified";
    }
  }

  function formatDate(iso: string | undefined): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch {
      return iso;
    }
  }
</script>

<div class="detail-pane">
  {#if !server && !registryResult}
    <!-- Empty state -->
    <div class="empty-state">
      <div class="empty-icon">
        <IconSmall.Search />
      </div>
      <h2 class="empty-title">MCP Catalog</h2>
      <p class="empty-desc">
        Select a server from the list to view details, or search the upstream
        registry to discover new servers.
      </p>
    </div>
  {:else}
    <!-- Header -->
    <div class="detail-header">
      <div class="header-main">
        <h1 class="server-name">{displayName}</h1>
        <div class="header-badges">
          {#if source}
            <span class="badge" style:--badge-color={sourceColor(source)}>
              {sourceLabel(source)}
            </span>
          {:else if registryResult}
            <span class="badge" style:--badge-color="var(--color-accent)">
              Registry
            </span>
          {/if}
          {#if server?.securityRating}
            <span class="badge security-{server.securityRating}">
              {securityLabel(server.securityRating)}
            </span>
          {/if}
          {#if server?.configTemplate.transport?.type}
            <span class="badge transport-badge">
              {server.configTemplate.transport.type}
            </span>
          {/if}
          {#if isOfficial}
            <span class="badge official-badge">Official</span>
          {/if}
        </div>
      </div>

      <!-- Actions -->
      <div class="header-actions">
        {#if !isInstalled && registryResult && onInstall}
          <Button
            variant="primary"
            onclick={() => onInstall(registryResult.name)}
            disabled={installing || registryResult.alreadyInstalled}
          >
            {#snippet prepend()}
              <IconSmall.Plus />
            {/snippet}
            {installing
              ? "Installing…"
              : registryResult.alreadyInstalled
                ? "Already installed"
                : "Install"}
          </Button>
        {/if}

        {#if isInstalled && server?.source === "registry"}
          {#if onCheckUpdate}
            <Button
              size="small"
              variant="secondary"
              onclick={onCheckUpdate}
              disabled={checking || pulling}
            >
              {checking ? "Checking…" : "Check for updates"}
            </Button>
          {/if}
          {#if hasUpdate && onPullUpdate}
            <Button
              size="small"
              variant="primary"
              onclick={onPullUpdate}
              disabled={pulling}
            >
              {pulling ? "Updating…" : "Pull update"}
            </Button>
          {/if}
        {/if}

        {#if isInstalled && server?.source !== "static" && onDelete}
          <Button
            size="small"
            variant="secondary"
            onclick={() => deleteDialogOpen.set(true)}
            disabled={deleting}
          >
            {deleting ? "Removing…" : "Remove"}
          </Button>
        {/if}

        <Dialog.Root open={deleteDialogOpen}>
          {#snippet children()}
            <Dialog.Content>
              <Dialog.Close />
              {#snippet header()}
                <Dialog.Title>Remove server</Dialog.Title>
                <Dialog.Description>
                  {displayName} will be uninstalled and no longer available to your agents. You can
                  reinstall it from the registry at any time.
                </Dialog.Description>
              {/snippet}
              {#snippet footer()}
                <Dialog.Button
                  onclick={onDelete}
                  disabled={deleting}
                  closeOnClick={false}
                >
                  {deleting ? "Removing…" : "Remove"}
                </Dialog.Button>
                <Dialog.Cancel onclick={() => deleteDialogOpen.set(false)}>Cancel</Dialog.Cancel>
              {/snippet}
            </Dialog.Content>
          {/snippet}
        </Dialog.Root>
      </div>
    </div>

    <!-- Content -->
    <div class="detail-content">
      {#if description}
        <section class="content-section">
          <p class="description">{description}</p>
        </section>
      {/if}

      {#if isInstalled && server}
        <!-- Transport -->
        <section class="content-section">
          <h3 class="section-title">Transport</h3>
          <code class="transport-code">{transportInfo(server)}</code>
        </section>

        <!-- Required config -->
        {#if server.requiredConfig && server.requiredConfig.length > 0}
          <section class="content-section">
            <h3 class="section-title">Required Configuration</h3>
            <div class="config-table">
              {#each server.requiredConfig as field (field.key)}
                <div class="config-row">
                  <span class="config-key">{field.key}</span>
                  <span class="config-desc">{field.description}</span>
                  {#if field.examples && field.examples.length > 0}
                    <span class="config-example">e.g. {field.examples[0]}</span>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- Credentials -->
        {#if server.configTemplate}
          <McpCredentialsPanel
            serverId={server.id}
            configTemplate={server.configTemplate}
          />
        {/if}

        <!-- Upstream info -->
        {#if server.upstream}
          <section class="content-section">
            <h3 class="section-title">Upstream</h3>
            <div class="meta-grid">
              <div class="meta-item">
                <span class="meta-label">Canonical name</span>
                <span class="meta-value">{server.upstream.canonicalName}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Version</span>
                <span class="meta-value">{server.upstream.version}</span>
              </div>
              <div class="meta-item">
                <span class="meta-label">Updated</span>
                <span class="meta-value">{formatDate(server.upstream.updatedAt)}</span>
              </div>
            </div>
          </section>
        {/if}
      {/if}

      <!-- README -->
      {#if readme}
        <section class="content-section readme-section">
          <h3 class="section-title">README</h3>
          <div class="readme-content">
            <MarkdownRendered>
              {@html browser ? DOMPurify.sanitize(markdownToHTML(readme)) : markdownToHTML(readme)}
            </MarkdownRendered>
          </div>
        </section>
      {/if}
    </div>
  {/if}
</div>

<style>
  .detail-pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  /* ─── Empty state ────────────────────────────────────────────────────────── */

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

  /* ─── Header ─────────────────────────────────────────────────────────────── */

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

  .server-name {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    letter-spacing: -0.01em;
    margin: 0;
    word-break: break-word;
  }

  .header-badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1);
  }

  .badge {
    background-color: color-mix(in srgb, var(--badge-color), transparent 88%);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--badge-color), var(--color-text) 35%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    padding: 2px 6px;
    text-transform: uppercase;
  }

  .badge.security-high {
    --badge-color: var(--color-success);
  }

  .badge.security-medium {
    --badge-color: var(--color-warning);
  }

  .badge.security-low {
    --badge-color: var(--color-error);
  }

  .badge.security-unverified {
    --badge-color: color-mix(in srgb, var(--color-text), transparent 45%);
  }

  .transport-badge {
    --badge-color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-family: var(--font-family-monospace);
  }

  .official-badge {
    --badge-color: var(--color-accent);
  }

  .header-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
  }

  /* ─── Content ────────────────────────────────────────────────────────────── */

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

  .description {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
    font-size: var(--font-size-2);
    line-height: 1.55;
    margin: 0;
    max-inline-size: 72ch;
  }

  /* ─── Transport ──────────────────────────────────────────────────────────── */

  .transport-code {
    background: var(--color-surface-2);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    line-break: anywhere;
    padding: var(--size-2) var(--size-3);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ─── Config table ───────────────────────────────────────────────────────── */

  .config-table {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .config-row {
    align-items: baseline;
    background: var(--color-surface-1);
    display: grid;
    gap: var(--size-3);
    grid-template-columns: 180px 1fr auto;
    padding: var(--size-2) var(--size-3);
  }

  .config-row:first-child {
    border-start-start-radius: var(--radius-2);
    border-start-end-radius: var(--radius-2);
  }

  .config-row:last-child {
    border-end-start-radius: var(--radius-2);
    border-end-end-radius: var(--radius-2);
  }

  .config-key {
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .config-desc {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
    font-size: var(--font-size-2);
  }

  .config-example {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
    font-style: italic;
  }

  /* ─── Meta grid ──────────────────────────────────────────────────────────── */

  .meta-grid {
    display: grid;
    gap: var(--size-2) var(--size-6);
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  }

  .meta-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .meta-label {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .meta-value {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  /* ─── README ─────────────────────────────────────────────────────────────── */

  .readme-section {
    border-block-start: 1px solid var(--color-border-1);
    margin-block-start: var(--size-2);
    padding-block-start: var(--size-6);
  }

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

  .readme-content :global(pre) {
    background: var(--color-surface-2);
    border-radius: var(--radius-2);
    font-size: var(--font-size-1);
    overflow-x: auto;
    padding: var(--size-2) var(--size-3);
  }

  .readme-content :global(code) {
    background: var(--color-surface-2);
    border-radius: var(--radius-1);
    font-family: var(--font-family-monospace);
    font-size: 0.9em;
    padding: 1px 4px;
  }

  .readme-content :global(pre code) {
    background: none;
    padding: 0;
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
</style>
