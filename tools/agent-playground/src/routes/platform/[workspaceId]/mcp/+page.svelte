<!--
  Workspace MCP manager page — two primary sections showing enabled and available
  MCP servers, styled after the skills page card/row layout.

  Each enabled server card includes a Test button that opens an inline
  test-chat panel scoped to the current workspace.

  @component
-->

<script lang="ts">
  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";
  import { toast } from "@atlas/ui";
  import WorkspaceBreadcrumb from "$lib/components/workspace/workspace-breadcrumb.svelte";
  import {
    workspaceMcpQueries,
    useEnableMCPServer,
    useDisableMCPServer,
    testChatEventStream,
  } from "$lib/queries";
  import type { EnrichedMCPServer, TestChatEvent } from "$lib/queries";

  const workspaceId = $derived(page.params.workspaceId ?? null);

  const statusQuery = createQuery(() => workspaceMcpQueries.status(workspaceId));

  const enableMut = useEnableMCPServer();
  const disableMut = useDisableMCPServer();

  let searchQuery = $state("");
  let pending = $state<Record<string, boolean>>({});

  // Inline test-chat state
  let testingServerId = $state<string | null>(null);
  let testMessage = $state("");
  let testEvents = $state<TestChatEvent[]>([]);
  let testRunning = $state(false);

  const enabled = $derived(statusQuery.data?.enabled ?? []);
  const available = $derived(statusQuery.data?.available ?? []);

  const filteredAvailable = $derived(
    searchQuery.trim().length === 0
      ? available
      : available.filter(
          (s) =>
            s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (s.description ?? "").toLowerCase().includes(searchQuery.toLowerCase()),
        ),
  );

  async function enableServer(serverId: string) {
    if (!workspaceId) return;
    pending = { ...pending, [serverId]: true };
    try {
      await enableMut.mutateAsync({ workspaceId, serverId });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      toast({ title: "Enable failed", description: err.message, error: true });
    } finally {
      const { [serverId]: _, ...rest } = pending;
      pending = rest;
    }
  }

  async function disableServer(serverId: string) {
    if (!workspaceId) return;
    pending = { ...pending, [serverId]: true };
    try {
      await disableMut.mutateAsync({ workspaceId, serverId });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      toast({ title: "Disable failed", description: err.message, error: true });
    } finally {
      const { [serverId]: _, ...rest } = pending;
      pending = rest;
    }
  }

  function openTestPanel(serverId: string) {
    testingServerId = serverId;
    testMessage = "";
    testEvents = [];
    testRunning = false;
  }

  function closeTestPanel() {
    testingServerId = null;
    testMessage = "";
    testEvents = [];
    testRunning = false;
  }

  async function runTest(serverId: string) {
    if (!workspaceId || !testMessage.trim()) return;
    testRunning = true;
    testEvents = [];
    try {
      const stream = testChatEventStream(serverId, testMessage.trim(), workspaceId);
      for await (const event of stream) {
        testEvents = [...testEvents, event];
        if (event.type === "done" || event.type === "error") break;
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      toast({ title: "Test chat failed", description: err.message, error: true });
    } finally {
      testRunning = false;
    }
  }

  function configuredDotClass(configured: boolean): string {
    return configured ? "dot-configured" : "dot-missing";
  }

  function referenceSummary(server: EnrichedMCPServer): string {
    const parts: string[] = [];
    if (server.agentIds && server.agentIds.length > 0) {
      parts.push(`${server.agentIds.length} agent${server.agentIds.length > 1 ? "s" : ""}`);
    }
    if (server.jobIds && server.jobIds.length > 0) {
      parts.push(`${server.jobIds.length} job${server.jobIds.length > 1 ? "s" : ""}`);
    }
    return parts.join(" · ");
  }
</script>

<div class="mcp-page">
  {#if workspaceId}
    <WorkspaceBreadcrumb {workspaceId} section="MCP" />
  {/if}

  <!-- Search / filter available servers -->
  <section class="search-section">
    <div class="search-row">
      <input
        class="search-input"
        type="text"
        bind:value={searchQuery}
        placeholder="Filter available servers…"
        autocomplete="off"
      />
    </div>
  </section>

  {#if statusQuery.isLoading}
    <div class="empty-state"><p>Loading MCP servers…</p></div>
  {:else if statusQuery.isError}
    <div class="empty-state">
      <p>Failed to load MCP servers</p>
      <span class="empty-hint">{statusQuery.error?.message ?? ""}</span>
    </div>
  {:else}
    <!-- Enabled in this workspace -->
    <section class="section">
      <header>
        <h2>Enabled in this workspace</h2>
        <span class="count">{enabled.length}</span>
      </header>
      {#if enabled.length === 0}
        <p class="empty-hint">No MCP servers enabled. Enable one from the catalog below.</p>
      {:else}
        <div class="server-list">
          {#each enabled as server (server.id)}
            <div class="server-row">
              <a class="row-main" href="/mcp/{server.id}">
                <span class="server-dot {configuredDotClass(server.configured)}"></span>
                <span class="server-name">{server.name}</span>
                {#if server.source === "workspace"}
                  <span class="badge-custom">Custom</span>
                {/if}
              </a>

              <div class="row-actions">
                <button
                  type="button"
                  class="row-action test"
                  disabled={testingServerId === server.id}
                  onclick={() => openTestPanel(server.id)}
                >
                  {testingServerId === server.id ? "Testing…" : "Test"}
                </button>
                <button
                  type="button"
                  class="row-action detach"
                  disabled={pending[server.id]}
                  onclick={() => disableServer(server.id)}
                >
                  {pending[server.id] ? "Disabling…" : "Disable"}
                </button>
              </div>

              {#if server.description}
                <p class="row-description">{server.description}</p>
              {/if}

              {#if referenceSummary(server)}
                <p class="row-refs">{referenceSummary(server)}</p>
              {/if}

              {#if testingServerId === server.id}
                <div class="test-panel">
                  <div class="test-input-row">
                    <input
                      class="test-input"
                      type="text"
                      bind:value={testMessage}
                      placeholder="Ask something using this server's tools…"
                      disabled={testRunning}
                      onkeydown={(e) => {
                        if (e.key === "Enter" && !testRunning) {
                          e.preventDefault();
                          runTest(server.id);
                        }
                      }}
                    />
                    <button
                      type="button"
                      class="test-send"
                      disabled={testRunning || !testMessage.trim()}
                      onclick={() => runTest(server.id)}
                    >
                      {testRunning ? "Running…" : "Send"}
                    </button>
                    <button type="button" class="test-close" onclick={closeTestPanel}>
                      Close
                    </button>
                  </div>

                  <div class="test-output">
                    {#each testEvents as event, i (i)}
                      {#if event.type === "chunk"}
                        <span class="test-chunk">{event.text}</span>
                      {:else if event.type === "tool_call"}
                        <div class="test-tool-call">
                          <span class="tool-label">Tool call</span>
                          <span class="tool-name">{event.toolName}</span>
                        </div>
                      {:else if event.type === "tool_result"}
                        <div class="test-tool-result">
                          <span class="tool-label">Result</span>
                          <pre class="tool-json">{JSON.stringify(event.output, null, 2)}</pre>
                        </div>
                      {:else if event.type === "error"}
                        <div class="test-error">
                          <span class="error-label">Error</span>
                          <span class="error-text">{event.error}</span>
                          {#if event.phase}
                            <span class="error-phase">({event.phase})</span>
                          {/if}
                        </div>
                      {:else if event.type === "done"}
                        <span class="test-done">Done</span>
                      {/if}
                    {/each}
                    {#if testRunning && testEvents.length === 0}
                      <span class="test-running">Waiting for response…</span>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Available from catalog -->
    <section class="section">
      <header>
        <h2>Available from catalog</h2>
        <span class="count">{filteredAvailable.length}</span>
      </header>
      {#if available.length === 0}
        <p class="empty-hint">No catalog servers available. Install one from the MCP registry.</p>
      {:else if filteredAvailable.length === 0}
        <p class="empty-hint">No servers match your filter.</p>
      {:else}
        <div class="server-list">
          {#each filteredAvailable as server (server.id)}
            <div class="server-row">
              <a class="row-main" href="/mcp/{server.id}">
                <span class="server-dot {configuredDotClass(server.configured)}"></span>
                <span class="server-name">{server.name}</span>
              </a>
              <button
                type="button"
                class="row-action attach"
                disabled={pending[server.id]}
                onclick={() => enableServer(server.id)}
              >
                {pending[server.id] ? "Enabling…" : "Enable"}
              </button>
              {#if server.description}
                <p class="row-description">{server.description}</p>
              {/if}
              {#if !server.configured}
                <p class="row-config-hint">
                  Missing credentials —
                  <a href="/mcp/{server.id}">connect on detail page →</a>
                </p>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .mcp-page {
    display: flex;
    flex-direction: column;
    gap: var(--size-6);
    padding: var(--size-8) var(--size-10);
  }

  .search-section {
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-4);
  }

  .search-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
  }

  .search-input {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    font-family: var(--font-family-mono, monospace);
    font-size: var(--font-size-1);
    inline-size: 100%;
    padding: var(--size-2) var(--size-3);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section > header {
    align-items: baseline;
    display: flex;
    gap: var(--size-3);
  }

  .section h2 {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .count {
    color: color-mix(in srgb, var(--color-text), transparent 45%);
    font-size: var(--font-size-1);
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-16) 0;
  }

  .empty-hint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    margin: 0;
    padding-block-start: var(--size-2);
  }

  .server-list {
    display: flex;
    flex-direction: column;
  }

  .server-row {
    align-items: center;
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    column-gap: var(--size-3);
    display: grid;
    grid-template-columns: 1fr auto;
    padding: var(--size-3) var(--size-1);
    position: relative;
    z-index: 1;
  }

  .server-row::before {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-4);
    content: "";
    inset: 0;
    opacity: 0;
    position: absolute;
    transition: opacity 150ms ease;
    z-index: -1;
  }

  .server-row:hover::before {
    opacity: 1;
  }

  .row-main {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--size-3);
    text-decoration: none;
  }

  /* Stretched link */
  .row-main::after {
    content: "";
    cursor: pointer;
    inset: 0;
    position: absolute;
    z-index: 0;
  }

  .row-description,
  .row-refs,
  .row-config-hint,
  .badge-custom {
    pointer-events: none;
    position: relative;
    user-select: text;
    z-index: 1;
  }

  .row-actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    pointer-events: auto;
    position: relative;
    z-index: 2;
  }

  .row-action {
    pointer-events: auto;
    position: relative;
    z-index: 2;
    background-color: transparent;
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-1) var(--size-3);
    transition: background-color 120ms ease;
  }

  .row-action:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 20%);
  }

  .row-action:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .row-action.attach:hover:not(:disabled) {
    border-color: var(--color-success, #238636);
    color: var(--color-success, #238636);
  }

  .row-action.detach:hover:not(:disabled) {
    border-color: var(--color-error, #dc5c5c);
    color: var(--color-error, #dc5c5c);
  }

  .row-action.test:hover:not(:disabled) {
    border-color: var(--color-primary, #6272ff);
    color: var(--color-primary, #6272ff);
  }

  .server-dot {
    block-size: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 8px;
  }

  .server-dot.dot-configured {
    background-color: var(--color-success);
  }

  .server-dot.dot-missing {
    background-color: var(--color-warning);
  }

  .server-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .badge-custom {
    background-color: color-mix(in srgb, var(--color-accent), transparent 85%);
    border-radius: var(--radius-1);
    color: color-mix(in srgb, var(--color-accent), var(--color-text) 40%);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.04em;
    padding: 1px 5px;
    text-transform: uppercase;
  }

  .row-description {
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: -webkit-box;
    font-size: var(--font-size-1);
    grid-column: 1 / -1;
    line-height: 1.4;
    margin: 0;
    overflow: hidden;
    padding-block-start: var(--size-1);
    padding-inline-start: calc(8px + var(--size-3));
  }

  .row-refs {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    grid-column: 1 / -1;
    margin: 0;
    padding-inline-start: calc(8px + var(--size-3));
  }

  .row-config-hint {
    color: color-mix(in srgb, var(--color-warning), transparent 20%);
    font-size: var(--font-size-0);
    grid-column: 1 / -1;
    margin: 0;
    padding-block-start: var(--size-1);
    padding-inline-start: calc(8px + var(--size-3));
  }

  .row-config-hint a {
    color: var(--color-accent);
    pointer-events: auto;
    position: relative;
    text-decoration: none;
    z-index: 2;
  }

  .row-config-hint a:hover {
    text-decoration: underline;
  }

  /* ─── Inline test-chat panel ───────────────────────────────────────────── */

  .test-panel {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    grid-column: 1 / -1;
    margin-block-start: var(--size-2);
    padding: var(--size-3) var(--size-4);
    position: relative;
    z-index: 2;
  }

  .test-input-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .test-input {
    background: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    flex: 1;
    font-size: var(--font-size-1);
    min-inline-size: 0;
    padding: var(--size-2) var(--size-3);
  }

  .test-send {
    background: var(--color-primary, #6272ff);
    border: none;
    border-radius: var(--radius-2);
    color: #fff;
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-2) var(--size-4);
  }

  .test-send:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .test-close {
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-2) var(--size-3);
  }

  .test-close:hover {
    background-color: color-mix(in srgb, var(--color-surface-2), transparent 20%);
  }

  .test-output {
    color: var(--color-text);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-1);
    gap: var(--size-2);
    line-height: 1.5;
    max-block-size: 320px;
    overflow-y: auto;
  }

  .test-chunk {
    white-space: pre-wrap;
  }

  .test-tool-call {
    background: color-mix(in srgb, var(--color-primary), transparent 90%);
    border-radius: var(--radius-1);
    display: flex;
    gap: var(--size-2);
    padding: var(--size-1) var(--size-2);
  }

  .test-tool-result {
    background: color-mix(in srgb, var(--color-success), transparent 90%);
    border-radius: var(--radius-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-1) var(--size-2);
  }

  .tool-label {
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    opacity: 0.7;
    text-transform: uppercase;
  }

  .tool-name {
    font-family: var(--font-family-mono, monospace);
    font-weight: var(--font-weight-5);
  }

  .tool-json {
    font-size: var(--font-size-0);
    margin: 0;
    max-block-size: 120px;
    overflow: auto;
    white-space: pre-wrap;
  }

  .test-error {
    background: color-mix(in srgb, var(--color-error), transparent 90%);
    border-radius: var(--radius-1);
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1) var(--size-2);
    padding: var(--size-1) var(--size-2);
  }

  .error-label {
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    opacity: 0.7;
    text-transform: uppercase;
  }

  .error-text {
    color: var(--color-error);
  }

  .error-phase {
    color: color-mix(in srgb, var(--color-error), transparent 40%);
    font-size: var(--font-size-0);
  }

  .test-done {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    font-style: italic;
  }

  .test-running {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    font-style: italic;
  }
</style>
