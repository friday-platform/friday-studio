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
  import { isOfficialCanonicalName } from "@atlas/core/mcp-registry/official-servers";
  import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
  import {
    Button,
    Dialog,
    IconSmall,
    MarkdownRendered,
    markdownToHTML,
    SimpleTable,
  } from "@atlas/ui";
  import { browser } from "$app/environment";
  import type { SearchResult } from "$lib/queries/mcp-queries";
  import DOMPurify from "dompurify";
  import { writable } from "svelte/store";
  import McpConnectionTest from "./mcp-connection-test.svelte";
  import McpCredentialsPanel from "./mcp-credentials-panel.svelte";
  import McpTestChat from "./mcp-test-chat.svelte";
  import McpWorkspaceUsage from "./mcp-workspace-usage.svelte";

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
  let hasCredentials = $state(false);

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
  const readme = $derived(server?.readme ?? null);

  type ServerTag = "bundled" | "official" | null;

  const tag = $derived.by<ServerTag>(() => {
    if (server?.source === "static") return "bundled";
    if (server?.upstream?.canonicalName && isOfficialCanonicalName(server.upstream.canonicalName)) {
      return "official";
    }
    if (registryResult?.isOfficial) return "official";
    return null;
  });

  function sourceLabel(src: string): string {
    switch (src) {
      case "static":
        return "Bundled";
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
        return "var(--color-accent)";
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
    return "unknown";
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
        Select a server from the list to view details, or search the upstream registry to discover
        new servers.
      </p>
    </div>
  {:else}
    <!-- Header -->
    <article>
      <header>
        <h1>{displayName}</h1>

        <div class="header-badges">
          {#if source}
            <span class="badge" style:--badge-color={sourceColor(source)}>
              {sourceLabel(source)}
            </span>
          {:else if registryResult}
            <span class="badge" style:--badge-color="var(--color-accent)">Registry</span>
          {/if}

          {#if tag === "official"}
            <span class="badge official-badge">Official</span>
          {/if}
        </div>

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
              <Button size="small" variant="primary" onclick={onPullUpdate} disabled={pulling}>
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
            <Dialog.Content>
              <Dialog.Close />
              {#snippet header()}
                <Dialog.Title>Remove server</Dialog.Title>
                <Dialog.Description>
                  {displayName} will be uninstalled and no longer available to your agents. You can reinstall
                  it from the registry at any time.
                </Dialog.Description>
              {/snippet}
              {#snippet footer()}
                <Dialog.Button onclick={onDelete} disabled={deleting} closeOnClick={false}>
                  {deleting ? "Removing…" : "Remove"}
                </Dialog.Button>
                <Dialog.Cancel onclick={() => deleteDialogOpen.set(false)}>Cancel</Dialog.Cancel>
              {/snippet}
            </Dialog.Content>
          </Dialog.Root>
        </div>
      </header>
      <!-- Content -->
      <div class="detail-content">
        {#if description}
          <p class="description">{description}</p>
        {/if}

        {#if isInstalled && server}
          <div>
            <McpConnectionTest serverId={server.id} />
          </div>
          <!-- Transport -->
          <div class="content-section">
            <h3 class="section-title">Transport</h3>
            <div class="transport">
              <span class="transport-url">{transportInfo(server)}</span>
              {#if server.configTemplate.transport?.type}
                <span class="transport-type">{server.configTemplate.transport.type}</span>
              {/if}
            </div>
          </div>

          <!-- Required config -->
          {#if server.requiredConfig && server.requiredConfig.length > 0}
            <div class="content-section">
              <h3 class="section-title">Required configuration</h3>
              <SimpleTable>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {#each server.requiredConfig as field (field.key)}
                    <tr>
                      <th scope="row">{field.key}</th>
                      <td>{field.description}</td>
                    </tr>
                  {/each}
                </tbody>
              </SimpleTable>
            </div>
          {/if}

          {#if server.configTemplate}
            <div class="content-section" style:display={hasCredentials ? null : "none"}>
              <h3 class="section-title">Credentials</h3>
              <McpCredentialsPanel
                serverId={server.id}
                configTemplate={server.configTemplate}
                bind:hasContent={hasCredentials}
              />
            </div>
          {/if}

          <div class="content-section">
            <h3 class="section-title">Workspaces</h3>
            <McpWorkspaceUsage serverId={server.id} />
          </div>

          <div class="content-section">
            <h3 class="section-title">Test Chat</h3>
            <McpTestChat serverId={server.id} />
          </div>

          {#if server.upstream}
            <div class="content-section">
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
            </div>
          {/if}
        {/if}

        <!-- README -->
        {#if readme}
          <div class="content-section">
            <h3 class="section-title">Readme</h3>
            <div class="readme-content">
              <MarkdownRendered>
                {@html browser
                  ? DOMPurify.sanitize(markdownToHTML(readme))
                  : markdownToHTML(readme)}
              </MarkdownRendered>
            </div>
          </div>
        {/if}
      </div>
    </article>
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

  article {
    padding: var(--size-12);

    header {
      align-items: center;
      display: flex;
      flex-shrink: 0;
      gap: var(--size-4);

      h1 {
        color: var(--text-bright);
        font-size: var(--font-size-8);
        font-weight: var(--font-weight-6);
        letter-spacing: -0.01em;
        margin: 0;
        word-break: break-word;
      }
    }
  }

  /* ─── Header ─────────────────────────────────────────────────────────────── */

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
  }

  .content-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-title {
    color: var(--text-faded);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
  }

  .description {
    color: var(--text);
    font-size: var(--font-size-5);
    line-height: var(--font-lineheight-3);
    margin: 0;
    max-inline-size: 72ch;
  }

  /* ─── Transport ──────────────────────────────────────────────────────────── */

  .transport {
    display: flex;
    flex-direction: column;
    gap: var(--size-px);
  }

  .transport-url {
    color: var(--text-bright);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    line-break: anywhere;
    word-break: break-word;
  }

  .transport-type {
    color: var(--text-faded);
    font-size: var(--font-size-3);
    text-transform: lowercase;
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
</style>
