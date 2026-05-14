<!--
  MCP Tools section — lists the tools a server exposes.

  Loading the list connects to the server (a probe), so it is behind an
  explicit "Load tools" button rather than firing on every page view. Each
  tool row expands to show its input schema.

  @component
-->

<script lang="ts">
  import { IconSmall } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { mcpQueries } from "$lib/queries/mcp-queries";

  interface Props {
    serverId: string;
  }

  const { serverId }: Props = $props();

  let loadRequested = $state(false);

  const probeQuery = createQuery(() => ({
    ...mcpQueries.toolsProbe(serverId),
    enabled: loadRequested,
  }));

  const result = $derived(probeQuery.data);
  const tools = $derived(result?.ok ? result.tools : []);

  let expanded = $state<Record<string, boolean>>({});

  function schemaJson(schema: Record<string, unknown> | null | undefined): string {
    if (!schema) return "";
    return JSON.stringify(schema, null, 2);
  }
</script>

<div class="tools-section">
  {#if !loadRequested}
    <div class="load-prompt">
      <p class="load-hint">
        Listing this server's tools opens a connection to it. Load them when you want to
        inspect what it exposes.
      </p>
      <button type="button" class="load-btn" onclick={() => (loadRequested = true)}>
        Load tools
      </button>
    </div>
  {:else if probeQuery.isLoading || probeQuery.isFetching}
    <p class="status-line">
      <span class="spinner"><IconSmall.Progress /></span>
      Connecting to the server…
    </p>
  {:else if probeQuery.isError}
    <div class="error-box" role="alert">
      <p>Couldn't load tools: {probeQuery.error?.message ?? "unknown error"}</p>
      <button type="button" class="retry-btn" onclick={() => probeQuery.refetch()}>Retry</button>
    </div>
  {:else if result && !result.ok}
    <div class="error-box" role="alert">
      <p>{result.error}</p>
      <button type="button" class="retry-btn" onclick={() => probeQuery.refetch()}>
        {result.retryable ? "Try again" : "Retry"}
      </button>
    </div>
  {:else if tools.length === 0}
    <p class="status-line muted">This server exposes no tools.</p>
  {:else}
    <p class="status-line muted">{tools.length} tool{tools.length === 1 ? "" : "s"}</p>
    <ul class="tool-list">
      {#each tools as tool (tool.name)}
        <li class="tool-row">
          <button
            type="button"
            class="tool-head"
            aria-expanded={expanded[tool.name] ?? false}
            onclick={() => {
              expanded = { ...expanded, [tool.name]: !expanded[tool.name] };
            }}
          >
            <span class="chevron" class:open={expanded[tool.name]}>
              <IconSmall.ChevronRight />
            </span>
            <code class="tool-name">{tool.name}</code>
            {#if tool.description}
              <span class="tool-desc">{tool.description}</span>
            {/if}
          </button>
          {#if expanded[tool.name]}
            <div class="tool-body">
              {#if tool.inputSchema}
                <span class="schema-label">Input schema</span>
                <pre class="schema-block">{schemaJson(tool.inputSchema)}</pre>
              {:else}
                <span class="schema-label muted">No input schema declared.</span>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tools-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .load-prompt {
    align-items: flex-start;
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .load-hint {
    color: var(--text);
    font-size: var(--font-size-3);
    margin: 0;
    max-inline-size: 64ch;
  }

  .load-btn {
    background-color: var(--surface-bright);
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-2);
    color: var(--text-bright);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    padding: var(--size-1-5) var(--size-3);
  }

  .load-btn:hover {
    background-color: var(--highlight);
  }

  .status-line {
    align-items: center;
    color: var(--text);
    display: flex;
    font-size: var(--font-size-3);
    gap: var(--size-1-5);
    margin: 0;
  }

  .status-line.muted,
  .schema-label.muted {
    color: var(--text-faded);
  }

  .spinner {
    align-items: center;
    display: inline-flex;
  }

  .spinner :global(svg) {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-box {
    background-color: color-mix(in srgb, var(--red-primary), transparent 92%);
    border: 1px solid color-mix(in srgb, var(--red-primary), transparent 70%);
    border-radius: var(--radius-2);
    color: var(--text);
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-3);
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .error-box p {
    margin: 0;
  }

  .retry-btn {
    align-self: flex-start;
    background: none;
    border: 1px solid var(--border-bright);
    border-radius: var(--radius-1);
    color: var(--text);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-2);
    padding: var(--size-0-5) var(--size-2);
  }

  .tool-list {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tool-row {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
  }

  .tool-head {
    align-items: baseline;
    background: none;
    border: none;
    cursor: pointer;
    display: flex;
    gap: var(--size-2);
    inline-size: 100%;
    padding: var(--size-2) var(--size-2-5);
    text-align: start;
  }

  .chevron {
    align-self: center;
    color: var(--text-faded);
    display: inline-flex;
    flex-shrink: 0;
    transition: transform 0.12s ease;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .tool-name {
    color: var(--text-bright);
    flex-shrink: 0;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
  }

  .tool-desc {
    color: var(--text);
    font-size: var(--font-size-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-body {
    border-block-start: 1px solid color-mix(in srgb, var(--border), transparent 40%);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-2) var(--size-2-5);
  }

  .schema-label {
    color: var(--text-faded);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .schema-block {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    color: var(--text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    margin: 0;
    overflow-x: auto;
    padding: var(--size-2);
  }
</style>
