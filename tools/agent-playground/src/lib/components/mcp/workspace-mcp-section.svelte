<!--
  Workspace MCP section for the settings page.

  Enable/disable MCP servers for this workspace and, per enabled server, edit
  that workspace's settings and credentials. Setting values resolve from the
  workspace `.env` (edited inline here); Link-backed env vars get a per-server
  credential picker. There is no discovery surface — a quick-add dropdown lists
  what is installable, and a link points to chat-driven setup.

  @component
-->

<script lang="ts">
  import type { LinkCredentialRef } from "@atlas/agent-sdk";
  import { Button, Icons, toast } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import {
    useDisableMCPServer,
    useEnableMCPServer,
    useSetWorkspaceEnvVar,
    workspaceEnvQueries,
    workspaceMcpQueries,
    workspaceQueries,
  } from "$lib/queries";
  import McpCredentialPicker from "./mcp-credential-picker.svelte";

  interface Props {
    workspaceId: string;
  }

  const { workspaceId }: Props = $props();

  const statusQuery = createQuery(() => workspaceMcpQueries.status(workspaceId));
  const configQuery = createQuery(() => workspaceQueries.config(workspaceId));
  const envQuery = createQuery(() => workspaceEnvQueries.list(workspaceId));

  const enabled = $derived(statusQuery.data?.enabled ?? []);
  const available = $derived(statusQuery.data?.available ?? []);
  const envMap = $derived(envQuery.data ?? {});

  /** Per-server env blocks from the workspace config copy. */
  const serverEnv = $derived.by((): Record<string, Record<string, unknown>> => {
    const servers = (
      configQuery.data?.config as
        | { tools?: { mcp?: { servers?: Record<string, { env?: Record<string, unknown> }> } } }
        | undefined
    )?.tools?.mcp?.servers;
    if (!servers) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, server] of Object.entries(servers)) {
      out[id] = server.env ?? {};
    }
    return out;
  });

  /** Key-name heuristic — kept in sync with the env tools' shared.ts. */
  const SECRET_KEY_RE = /password|secret|token|key|credential/i;
  const isSecretKey = (key: string): boolean => SECRET_KEY_RE.test(key);

  type EnvRow =
    | { kind: "env-backed"; key: string }
    | { kind: "literal"; key: string; value: string }
    | { kind: "link"; key: string; providerId: string; credentialId?: string };

  function classifyEnv(env: Record<string, unknown>): EnvRow[] {
    const rows: EnvRow[] = [];
    for (const [key, raw] of Object.entries(env)) {
      if (typeof raw === "string") {
        if (raw === "from_environment" || raw === "auto") {
          rows.push({ kind: "env-backed", key });
        } else {
          rows.push({ kind: "literal", key, value: raw });
        }
        continue;
      }
      if (typeof raw === "object" && raw !== null && (raw as { from?: unknown }).from === "link") {
        const ref = raw as LinkCredentialRef;
        if (ref.provider) {
          rows.push({ kind: "link", key, providerId: ref.provider, credentialId: ref.id });
        }
      }
    }
    return rows;
  }

  // ── Enable / disable ───────────────────────────────────────────────────
  const enableMut = useEnableMCPServer();
  const disableMut = useDisableMCPServer();
  let busyServer = $state<string | null>(null);
  let quickAddId = $state("");

  async function enableServer(serverId: string): Promise<void> {
    if (!serverId) return;
    busyServer = serverId;
    try {
      await enableMut.mutateAsync({ workspaceId, serverId });
      quickAddId = "";
      toast({ title: "MCP server enabled" });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      toast({ title: "Enable failed", description: err.message, error: true });
    } finally {
      busyServer = null;
    }
  }

  async function disableServer(serverId: string): Promise<void> {
    busyServer = serverId;
    try {
      await disableMut.mutateAsync({ workspaceId, serverId });
      toast({ title: "MCP server disabled" });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      toast({ title: "Disable failed", description: err.message, error: true });
    } finally {
      busyServer = null;
    }
  }

  // ── Per-key setting edits (workspace `.env`) ───────────────────────────
  let edits = $state<Record<string, string>>({});
  let revealed = $state<Record<string, boolean>>({});

  function currentValue(key: string): string {
    return edits[key] ?? envMap[key] ?? "";
  }
  function isKeyDirty(key: string): boolean {
    return key in edits && edits[key] !== (envMap[key] ?? "");
  }

  const setEnvVar = useSetWorkspaceEnvVar();
  let savingKey = $state<string | null>(null);

  async function saveEnvKey(key: string): Promise<void> {
    if (!isKeyDirty(key)) return;
    savingKey = key;
    try {
      await setEnvVar.mutateAsync({ workspaceId, key, value: edits[key] ?? "" });
      const { [key]: _saved, ...rest } = edits;
      edits = rest;
      toast({ title: `${key} saved` });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      toast({ title: `Failed to save ${key}`, description: err.message, error: true });
    } finally {
      savingKey = null;
    }
  }
</script>

<section class="section">
  <header>
    <h2>MCP servers</h2>
    <p class="section-sub">
      Enable MCP servers for this workspace and configure each one. Setting values are stored in
      this workspace's <code>.env</code>; credentials point at connected integrations. Enabling
      snapshots the server into this workspace — edits never touch other workspaces.
    </p>
  </header>

  <!-- Quick add -->
  <div class="quick-add">
    <select class="quick-add-select" bind:value={quickAddId} disabled={enableMut.isPending}>
      <option value="">Add a server…</option>
      {#each available as server (server.id)}
        <option value={server.id}>{server.name}</option>
      {/each}
    </select>
    <Button
      variant="secondary"
      onclick={() => enableServer(quickAddId)}
      disabled={!quickAddId || enableMut.isPending}
    >
      {enableMut.isPending ? "Enabling…" : "Enable"}
    </Button>
    <a class="chat-link" href="/platform/{workspaceId}/chat">or set one up in chat →</a>
  </div>

  {#if statusQuery.isLoading}
    <p class="empty-hint">Loading MCP servers…</p>
  {:else if statusQuery.isError}
    <div class="error-banner" role="alert">
      <span>Failed to load MCP servers: {statusQuery.error?.message ?? ""}</span>
      <button type="button" class="retry" onclick={() => statusQuery.refetch()}>Retry</button>
    </div>
  {:else if enabled.length === 0}
    <p class="empty-hint">No MCP servers enabled in this workspace yet.</p>
  {:else}
    <div class="server-list">
      {#each enabled as server (server.id)}
        {@const rows = classifyEnv(serverEnv[server.id] ?? {})}
        <div class="server-block">
          <div class="server-head">
            <span class="server-name">{server.name}</span>
            <Button
              variant="destructive"
              onclick={() => disableServer(server.id)}
              disabled={busyServer === server.id}
            >
              {busyServer === server.id && disableMut.isPending ? "Disabling…" : "Disable"}
            </Button>
          </div>

          {#if rows.length === 0}
            <p class="empty-hint indent">No configurable settings or credentials.</p>
          {:else}
            <div class="env-rows">
              {#each rows as row (row.key)}
                <div class="env-row">
                  <code class="env-key">{row.key}</code>
                  {#if row.kind === "env-backed"}
                    {@const secret = isSecretKey(row.key)}
                    <input
                      class="env-value"
                      type={secret && !revealed[row.key] ? "password" : "text"}
                      value={currentValue(row.key)}
                      oninput={(e) => {
                        edits = { ...edits, [row.key]: e.currentTarget.value };
                      }}
                      placeholder={envQuery.isLoading ? "Loading…" : "Not set"}
                      autocomplete="off"
                      spellcheck="false"
                    />
                    {#if secret}
                      <button
                        type="button"
                        class="reveal"
                        aria-label={revealed[row.key] ? "Hide value" : "Show value"}
                        onclick={() => {
                          revealed = { ...revealed, [row.key]: !revealed[row.key] };
                        }}
                      >
                        {#if revealed[row.key]}<Icons.Eye />{:else}<Icons.EyeClosed />{/if}
                      </button>
                    {/if}
                    <Button
                      variant="secondary"
                      onclick={() => saveEnvKey(row.key)}
                      disabled={!isKeyDirty(row.key) || savingKey === row.key}
                    >
                      {savingKey === row.key ? "Saving…" : "Save"}
                    </Button>
                  {:else if row.kind === "link"}
                    <McpCredentialPicker
                      {workspaceId}
                      serverId={server.id}
                      envVar={row.key}
                      providerId={row.providerId}
                      currentCredentialId={row.credentialId}
                    />
                  {:else}
                    <span class="env-readonly">
                      <span class="badge">Literal</span>
                      <code>{row.value}</code>
                    </span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
    max-inline-size: 80ch;
  }

  .section > header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .section h2 {
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .section-sub {
    color: var(--text);
    font-size: var(--font-size-3);
    margin: 0;
    max-inline-size: 70ch;
  }

  .section-sub code {
    font-size: var(--font-size-2);
  }

  .quick-add {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
  }

  .quick-add-select {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    font: inherit;
    font-size: var(--font-size-3);
    padding: var(--size-2) var(--size-3);
  }

  .chat-link {
    color: var(--blue-primary);
    font-size: var(--font-size-2);
    text-decoration: none;
  }

  .chat-link:hover {
    text-decoration: underline;
  }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .server-block {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .server-head {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .server-name {
    color: var(--text-bright);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .env-rows {
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
  }

  .env-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .env-key {
    color: var(--text-bright);
    flex-shrink: 0;
    font-size: var(--font-size-3);
    inline-size: 24ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .env-value {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    color: var(--text);
    flex: 1;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-3);
    min-inline-size: 0;
    padding: var(--size-1) var(--size-1-5);
  }

  .reveal {
    align-items: center;
    background: none;
    border: none;
    color: var(--text-faded);
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    inline-size: 16px;
    block-size: 16px;
    padding: 0;
  }

  .reveal :global(svg) {
    inline-size: 100%;
    block-size: 100%;
  }

  .env-readonly {
    align-items: center;
    color: var(--text);
    display: flex;
    flex: 1;
    gap: var(--size-2);
    font-size: var(--font-size-3);
    min-inline-size: 0;
  }

  .env-readonly code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    background-color: color-mix(in srgb, var(--text), transparent 88%);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--text), transparent 25%);
    flex-shrink: 0;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    padding: 1px var(--size-1-5);
  }

  .empty-hint {
    color: var(--text);
    font-size: var(--font-size-3);
  }

  .empty-hint.indent {
    color: color-mix(in srgb, var(--text), transparent 35%);
  }

  .error-banner {
    align-items: center;
    background-color: color-mix(in srgb, var(--red-primary), transparent 90%);
    border: 1px solid color-mix(in srgb, var(--red-primary), transparent 65%);
    border-radius: var(--radius-2);
    color: var(--text);
    display: flex;
    font-size: var(--font-size-3);
    gap: var(--size-2);
    justify-content: space-between;
    padding: var(--size-2) var(--size-3);
  }

  .retry {
    background: none;
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    color: var(--text);
    cursor: pointer;
    font-size: var(--font-size-2);
    padding: var(--size-0-5) var(--size-2);
  }
</style>
