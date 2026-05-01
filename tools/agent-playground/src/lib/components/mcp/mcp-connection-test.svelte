<!--
  MCP Connection Test — probes a server and shows available tools or error.

  @component
  @prop serverId - The MCP server ID to probe
-->

<script lang="ts">
  import { Button, IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { mcpQueries } from "../../queries/mcp-queries";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();

  let shouldTest = $state(false);

  const probeQuery = createQuery(() => ({
    ...mcpQueries.toolsProbe(serverId),
    enabled: shouldTest,
  }));

  function phaseLabel(phase: string): string {
    switch (phase) {
      case "dns":
        return "DNS resolution failed";
      case "connect":
        return "Connection failed";
      case "auth":
        return "Authentication failed";
      case "tools":
        return "Tool discovery timed out";
      default:
        return phase;
    }
  }

  function phaseColor(phase: string): string {
    switch (phase) {
      case "dns":
        return "var(--color-warning)";
      case "connect":
        return "var(--color-error)";
      case "auth":
        return "var(--color-warning)";
      case "tools":
        return "var(--color-info)";
      default:
        return "var(--color-text)";
    }
  }

  function runTest() {
    shouldTest = true;
  }
</script>

<section class="connection-test-section">
  <h3 class="section-title">Connection Test</h3>

  {#if !shouldTest || (!probeQuery.isLoading && !probeQuery.isPending)}
    <Button variant="secondary" size="small" onclick={runTest} disabled={probeQuery.isLoading}>
      {#snippet prepend()}
        <IconSmall.CheckCircle />
      {/snippet}
      {probeQuery.isLoading ? "Testing…" : "Test Connection"}
    </Button>
  {/if}

  {#if probeQuery.isLoading}
    <div class="loading-state">
      <span class="spinner"></span>
      <span>Probing server…</span>
    </div>
  {:else if probeQuery.error}
    <div class="error-state">
      <span class="error-icon"><IconSmall.XCircle /></span>
      <div class="error-body">
        <div class="error-title">Probe failed</div>
        <div class="error-detail">{probeQuery.error.message}</div>
      </div>
    </div>
  {:else if probeQuery.data}
    {@const result = probeQuery.data}
    {#if result.ok}
      <div class="success-state">
        <span class="success-icon"><IconSmall.CheckCircle /></span>
        <div class="success-body">
          <div class="success-title">
            Connected — {result.tools.length}
            {result.tools.length === 1 ? "tool" : "tools"} available
          </div>
          {#if result.tools.length > 0}
            <ul class="tool-list">
              {#each result.tools as tool (tool.name)}
                <li class="tool-item">
                  <code class="tool-name">{tool.name}</code>
                  {#if tool.description}
                    <span class="tool-desc">{tool.description}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
    {:else}
      <div class="error-state">
        <span class="error-icon"><IconSmall.XCircle /></span>
        <div class="error-body">
          <div class="error-title" style:color={phaseColor(result.phase)}>
            {phaseLabel(result.phase)}
          </div>
          <div class="error-detail">{result.error}</div>
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .connection-test-section {
    border-block-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding-block-start: var(--size-4);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .loading-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
  }

  .spinner {
    animation: spin 1s linear infinite;
    block-size: 16px;
    border: 2px solid color-mix(in srgb, var(--color-text), transparent 80%);
    border-block-start-color: var(--color-accent);
    border-radius: 50%;
    display: inline-block;
    inline-size: 16px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .success-state {
    align-items: flex-start;
    background: color-mix(in srgb, var(--color-success), transparent 92%);
    border: 1px solid color-mix(in srgb, var(--color-success), transparent 70%);
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .success-icon {
    color: var(--color-success);
    flex-shrink: 0;
  }

  .success-body {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .success-title {
    color: var(--color-success);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .tool-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tool-item {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .tool-name {
    background: var(--color-surface-2);
    border-radius: var(--radius-1);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    padding: 1px 4px;
  }

  .tool-desc {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-2);
  }

  .error-state {
    align-items: flex-start;
    background: color-mix(in srgb, var(--color-error), transparent 92%);
    border: 1px solid color-mix(in srgb, var(--color-error), transparent 70%);
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .error-icon {
    color: var(--color-error);
    flex-shrink: 0;
  }

  .error-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .error-title {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .error-detail {
    color: color-mix(in srgb, var(--color-text), transparent 15%);
    font-size: var(--font-size-2);
  }
</style>
