<!--
  Workspace MCP section for the settings page.

  Enable/disable MCP servers for this workspace and, per enabled server, edit
  that workspace's setting values and pick Link credentials for its Link-backed
  env vars. Setting values resolve from the workspace `.env`; saving a value
  also migrates a legacy literal entry to `from_environment` wiring. There is
  no discovery surface — a quick-add dropdown lists what is installable, and a
  link points to chat-driven setup.

  @component
-->

<script lang="ts">
  import type { LinkCredentialRef } from "@atlas/agent-sdk";
  import { Button, Icons, toast } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import {
    useDisableMCPServer,
    useEnableMCPServer,
    useSetMCPServerEnvVar,
    workspaceEnvQueries,
    workspaceMcpQueries,
    workspaceQueries,
  } from "$lib/queries";
  import Combobox from "$lib/components/shared/combobox.svelte";
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
  const availableOptions = $derived(available.map((s) => ({ value: s.id, label: s.name })));
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
    | { kind: "value"; key: string; initialValue: string }
    | { kind: "link"; key: string; providerId: string; credentialId?: string };

  /**
   * Classify a server's env block into editable value rows and credential
   * rows. A string value is editable regardless of whether it is already
   * `from_environment` wiring (value comes from the workspace `.env`) or a
   * legacy literal (value comes from the config copy — saving migrates it).
   */
  function classifyEnv(env: Record<string, unknown>): EnvRow[] {
    const rows: EnvRow[] = [];
    for (const [key, raw] of Object.entries(env)) {
      if (typeof raw === "string") {
        const wired = raw === "from_environment" || raw === "auto";
        rows.push({
          kind: "value",
          key,
          initialValue: wired ? (envMap[key] ?? "") : raw,
        });
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

  // ── Per-key setting edits ──────────────────────────────────────────────
  // Edit + reveal state keyed by `${serverId}:${key}` so two servers sharing
  // an env var name don't share an input box.
  let edits = $state<Record<string, string>>({});
  let revealed = $state<Record<string, boolean>>({});

  const setEnvVar = useSetMCPServerEnvVar();
  let savingKey = $state<string | null>(null);

  async function saveEnvKey(serverId: string, key: string, initialValue: string): Promise<void> {
    const editKey = `${serverId}:${key}`;
    const next = edits[editKey] ?? initialValue;
    if (next === initialValue) return;
    savingKey = editKey;
    try {
      await setEnvVar.mutateAsync({ workspaceId, serverId, key, value: next });
      const { [editKey]: _saved, ...rest } = edits;
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
    <div class="quick-add-head">
      <h3>Add a server</h3>
      <p class="quick-add-desc">
        These are the MCP servers installed in your
        <a href="/mcp">MCP Catalog</a>. Pick one to turn it on for this workspace — a copy of its
        setup is made here, so configuring it never affects other workspaces. To install a server
        that isn't listed, browse the <a href="/mcp">MCP Catalog</a>, or
        <a href="/platform/{workspaceId}/chat">set one up in chat</a>.
      </p>
    </div>
    <Combobox
      bind:value={quickAddId}
      options={availableOptions}
      placeholder={available.length === 0 ? "No servers available to add" : "Search servers…"}
      disabled={enableMut.isPending || available.length === 0}
      ariaLabel="Add an MCP server"
    />
    <div class="quick-add-action">
      <Button
        variant="primary"
        onclick={() => enableServer(quickAddId)}
        disabled={!quickAddId || enableMut.isPending}
      >
        {enableMut.isPending ? "Enabling…" : "Enable server"}
      </Button>
    </div>
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
            <a class="server-name" href="/mcp/{server.id}">{server.name}</a>
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
                {@const editKey = `${server.id}:${row.key}`}
                <div class="env-row">
                  <code class="env-key" title={row.key}>{row.key}</code>
                  {#if row.kind === "value"}
                    {@const secret = isSecretKey(row.key)}
                    {@const value = edits[editKey] ?? row.initialValue}
                    {@const dirty = editKey in edits && edits[editKey] !== row.initialValue}
                    <div class="env-control">
                      <input
                        class="env-input"
                        type={secret && !revealed[editKey] ? "password" : "text"}
                        {value}
                        oninput={(e) => {
                          edits = { ...edits, [editKey]: e.currentTarget.value };
                        }}
                        placeholder={envQuery.isLoading ? "Loading…" : "Not set"}
                        autocomplete="off"
                        spellcheck="false"
                      />
                      {#if secret}
                        <button
                          type="button"
                          class="reveal"
                          aria-label={revealed[editKey] ? "Hide value" : "Show value"}
                          onclick={() => {
                            revealed = { ...revealed, [editKey]: !revealed[editKey] };
                          }}
                        >
                          {#if revealed[editKey]}<Icons.Eye />{:else}<Icons.EyeClosed />{/if}
                        </button>
                      {/if}
                      <Button
                        variant="secondary"
                        onclick={() => saveEnvKey(server.id, row.key, row.initialValue)}
                        disabled={!dirty || savingKey === editKey}
                      >
                        {savingKey === editKey ? "Saving…" : "Save"}
                      </Button>
                    </div>
                  {:else}
                    <div class="env-control">
                      <McpCredentialPicker
                        {workspaceId}
                        serverId={server.id}
                        envVar={row.key}
                        providerId={row.providerId}
                        currentCredentialId={row.credentialId}
                      />
                    </div>
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
    gap: var(--size-6);
    max-inline-size: 80ch;
  }

  .section > header {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section h2 {
    font-size: var(--font-size-8);
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
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-3);
  }

  .quick-add-head {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .quick-add-head h3 {
    color: var(--text-bright);
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .quick-add-desc {
    color: var(--text);
    font-size: var(--font-size-3);
    margin: 0;
    max-inline-size: 70ch;
  }

  .quick-add-desc a {
    color: var(--blue-primary);
    text-decoration: none;
  }

  .quick-add-desc a:hover {
    text-decoration: underline;
  }

  .quick-add-action {
    display: flex;
  }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .server-block {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-3);
    display: flex;
    flex-direction: column;
  }

  .server-head {
    align-items: center;
    border-block-end: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    padding: var(--size-3);
  }

  .server-name {
    color: var(--text-bright);
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    overflow: hidden;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .server-name:hover {
    text-decoration: underline;
  }

  .env-rows {
    display: flex;
    flex-direction: column;
  }

  .env-row {
    align-items: center;
    display: flex;
    gap: var(--size-3);
    padding: var(--size-2) var(--size-3);
  }

  .env-row:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--border), transparent 45%);
  }

  .env-key {
    color: var(--text-bright);
    flex-shrink: 0;
    font-size: var(--font-size-2);
    inline-size: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .env-control {
    align-items: center;
    display: flex;
    flex: 1;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .env-input {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    flex: 1;
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-3);
    min-inline-size: 0;
    padding: var(--size-1-5) var(--size-2);
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

  .empty-hint {
    color: var(--text);
    font-size: var(--font-size-3);
  }

  .empty-hint.indent {
    color: color-mix(in srgb, var(--text), transparent 35%);
    padding: var(--size-3);
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
