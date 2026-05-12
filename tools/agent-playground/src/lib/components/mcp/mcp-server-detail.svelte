<!--
  MCP Server Detail — right pane for the two-pane catalog layout.

  Renders full details for an installed server or a registry preview.
  Includes README markdown rendering, transport info, env vars, and actions.

  @component
  @prop server - Installed server metadata (if selected)

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
  import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
  import {
    Badge,
    Button,
    Dialog,
    IconSmall,
    MarkdownRendered,
    markdownToHTMLSafe,
    SimpleTable,
  } from "@atlas/ui";
  import { writable } from "svelte/store";
  import McpConnectionTest from "./mcp-connection-test.svelte";
  import McpCredentialsPanel from "./mcp-credentials-panel.svelte";
  import { isOfficialServer, sourceLabel } from "./mcp-server-utils";
  import McpTestChat from "./mcp-test-chat.svelte";
  import McpWorkspaceUsage from "./mcp-workspace-usage.svelte";

  interface Props {
    server?: MCPServerMetadata | null;
    onCheckUpdate?: () => void;
    onPullUpdate?: () => void;
    onDelete?: () => void;
    checking?: boolean;
    pulling?: boolean;
    deleting?: boolean;
    hasUpdate?: boolean;
  }

  let {
    server = null,
    onCheckUpdate,
    onPullUpdate,
    onDelete,
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

  const displayName = $derived(server?.name ?? "");
  const description = $derived(server?.description ?? null);
  const source = $derived(server?.source ?? null);
  const isInstalled = $derived(server !== null);
  const readme = $derived(server?.readme ?? null);

  const isOfficial = $derived(server ? isOfficialServer(server) : false);

  const canCheckUpdate = $derived(
    isInstalled && server?.source === "registry" && !!onCheckUpdate,
  );
  const canPullUpdate = $derived(
    isInstalled && server?.source === "registry" && hasUpdate && !!onPullUpdate,
  );
  const canDelete = $derived(
    isInstalled && server?.source !== "static" && !!onDelete,
  );
  const hasActions = $derived(canCheckUpdate || canPullUpdate || canDelete);

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
  {#if !server}
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
    <article>
      {#if hasActions}
        <div class="actions-bar">
          <span class="actions-indent actions-indent-tl" aria-hidden="true"
          ></span>
          <div class="actions-int">
            {#if canCheckUpdate}
              <Button
                size="small"
                variant="none"
                onclick={onCheckUpdate}
                disabled={checking || pulling}
              >
                {#snippet prepend()}
                  <IconSmall.ArrowsRotate />
                {/snippet}
                {checking ? "Checking…" : "Check for updates"}
              </Button>
            {/if}

            {#if canPullUpdate}
              <Button
                size="small"
                variant="primary"
                onclick={onPullUpdate}
                disabled={pulling}
              >
                {pulling ? "Updating…" : "Pull update"}
              </Button>
            {/if}

            {#if canDelete}
              <Button
                size="small"
                variant="none"
                onclick={() => deleteDialogOpen.set(true)}
                disabled={deleting}
              >
                {#snippet prepend()}
                  <IconSmall.TrashBin />
                {/snippet}
                {deleting ? "Removing…" : "Remove"}
              </Button>
            {/if}

            <Dialog.Root open={deleteDialogOpen}>
              <Dialog.Content>
                <Dialog.Close />
                {#snippet header()}
                  <Dialog.Title>Remove server</Dialog.Title>
                  <Dialog.Description>
                    {displayName} will be uninstalled and no longer available to your
                    agents. You can reinstall it from the registry at any time.
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
                  <Dialog.Cancel onclick={() => deleteDialogOpen.set(false)}
                    >Cancel</Dialog.Cancel
                  >
                {/snippet}
              </Dialog.Content>
            </Dialog.Root>
          </div>
          <span class="actions-indent actions-indent-br" aria-hidden="true"
          ></span>
        </div>
      {/if}

      <header>
        <h1>{displayName}</h1>

        <div class="header-badges">
          {#if source}
            <Badge variant="status">
              {sourceLabel(source)}

              {#if isOfficial}
                • Official
              {/if}
            </Badge>
          {/if}
        </div>
      </header>
      <!-- Content -->
      <div class="detail-content">
        <p class="description" class:faded={!description}>
          {description ?? "No description provided"}
        </p>

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
                <span class="transport-type"
                  >{server.configTemplate.transport.type}</span
                >
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
            <div class="content-section credentials-section">
              <h3 class="section-title">Credentials</h3>
              <McpCredentialsPanel
                serverId={server.id}
                configTemplate={server.configTemplate}
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
                  <span class="meta-value">{server.upstream.canonicalName}</span
                  >
                </div>
                <div class="meta-item">
                  <span class="meta-label">Version</span>
                  <span class="meta-value">{server.upstream.version}</span>
                </div>
                <div class="meta-item">
                  <span class="meta-label">Updated</span>
                  <span class="meta-value"
                    >{formatDate(server.upstream.updatedAt)}</span
                  >
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
                {@html markdownToHTMLSafe(readme)}
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

  .actions-bar {
    display: flex;
    align-items: center;
    gap: var(--size-3);
    position: absolute;
    inset-block-start: var(--size-1-5);
    inset-inline-end: var(--size-1-5);
    z-index: 1;

    .actions-int {
      background-color: var(--surface-dark);
      border-start-end-radius: var(--radius-6);
      border-end-start-radius: var(--radius-6);
      block-size: var(--size-8);
      display: flex;
      gap: var(--size-4);
      padding-inline: var(--size-4);
    }

    .actions-indent {
      background-color: var(--surface-dark);
      position: absolute;
    }

    .actions-indent-tl {
      block-size: 11px;
      clip-path: path("M11 11C11 4.92487 6.07513 0 0 0H11V11Z");
      inline-size: 11px;
      inset-block-start: 0;
      inset-inline-end: 100%;
      position: absolute;
    }

    .actions-indent-br {
      block-size: 12px;
      clip-path: path("M12 12C12 5.37258 6.62742 0 0 0H12V12Z");
      inline-size: 12px;
      inset-block-start: 100%;
      inset-inline-end: 0;
      position: absolute;
    }
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
      gap: var(--size-3);

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

  .credentials-section:not(:has(> *:nth-child(2))) {
    display: none;
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

    &.faded {
      color: var(--text-faded);
    }
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
