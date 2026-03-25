<!--
  Reference sidebar for a bundled agent workbench.

  Displays agent summary, constraints, I/O schema toggles, and credential
  preflight status. Pure display — no execution state coupling.

  @component
  @param {AgentMetadata} agent - The agent whose reference info to display
  @param {AgentPreflightCredential[]} credentials - Credential preflight status
  @param {Record<string, string>} manualOverrides - Manual credential overrides (bindable)
  @param {(provider: string) => void} onOAuthConnect - Trigger OAuth flow
  @param {(provider: string) => void} onApiKeyConnect - Trigger API key / app install flow
-->

<script lang="ts">
  import { Icons } from "@atlas/ui";
  import CredentialPanel from "$lib/components/agents/credential-panel.svelte";
  import SchemaPropertyStack from "$lib/components/shared/schema-property-stack.svelte";
  import type { AgentMetadata, AgentPreflightCredential } from "$lib/queries";

  type Props = {
    agent: AgentMetadata;
    credentials: AgentPreflightCredential[];
    manualOverrides: Record<string, string>;
    onOAuthConnect: (provider: string) => void;
    onApiKeyConnect: (provider: string) => void;
  };

  let {
    agent,
    credentials,
    manualOverrides = $bindable(),
    onOAuthConnect,
    onApiKeyConnect,
  }: Props = $props();

  let inputSchemaOpen = $state(false);
  let outputSchemaOpen = $state(false);
</script>

<aside class="reference-panel">
  <div class="explainer">
    <p class="explainer-text">
      Built-in agents ship with Friday — tested, versioned, and ready to use. They run in a
      sandboxed environment with their own tool access and credentials. You can't modify their
      behavior, but you can test them here with real inputs to verify they work as expected.
    </p>
  </div>

  {#if agent.summary}
    <div class="sidebar-section">
      <span class="section-label">Summary</span>
      <p class="sidebar-description">{agent.summary}</p>
    </div>
  {/if}

  {#if agent.constraints}
    <div class="sidebar-section">
      <span class="section-label">Constraints</span>
      <p class="sidebar-constraints">{agent.constraints}</p>
    </div>
  {/if}

  {#if agent.inputSchema}
    <div class="sidebar-section">
      <button
        class="schema-toggle"
        type="button"
        onclick={() => (inputSchemaOpen = !inputSchemaOpen)}
      >
        <span class="toggle-icon" class:open={inputSchemaOpen}>
          <Icons.TriangleRight />
        </span>
        <span class="section-label">Input Schema</span>
      </button>
      {#if inputSchemaOpen}
        <div class="schema-body">
          <SchemaPropertyStack schema={agent.inputSchema as object} />
        </div>
      {/if}
    </div>
  {/if}

  {#if agent.outputSchema}
    <div class="sidebar-section">
      <button
        class="schema-toggle"
        type="button"
        onclick={() => (outputSchemaOpen = !outputSchemaOpen)}
      >
        <span class="toggle-icon" class:open={outputSchemaOpen}>
          <Icons.TriangleRight />
        </span>
        <span class="section-label">Output Schema</span>
      </button>
      {#if outputSchemaOpen}
        <div class="schema-body">
          <SchemaPropertyStack schema={agent.outputSchema as object} />
        </div>
      {/if}
    </div>
  {/if}

  {#if credentials.length > 0}
    <CredentialPanel
      {credentials}
      bind:manualOverrides
      onconnect={onOAuthConnect}
      onapikey={onApiKeyConnect}
    />
  {/if}
</aside>

<style>
  .reference-panel {
    background-color: var(--color-surface-1);
    border-inline-start: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-5);
    inline-size: 280px;
    overflow-y: auto;
    padding-block: var(--size-5);
    padding-inline: var(--size-4);
  }

  .explainer {
    border-block-end: 1px solid var(--color-border-1);
    padding-block-end: var(--size-4);
  }

  .explainer-text {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .sidebar-description {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  .sidebar-constraints {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-style: italic;
    line-height: var(--font-lineheight-3);
    margin: 0;
  }

  .schema-toggle {
    align-items: center;
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    gap: var(--size-1);
    padding: 0;
  }

  .schema-toggle:hover .section-label {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
  }

  .toggle-icon {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: inline-flex;
    transition: transform 150ms ease;
  }

  .toggle-icon :global(svg) {
    block-size: 10px;
    inline-size: 10px;
  }

  .toggle-icon.open {
    transform: rotate(90deg);
  }

  .schema-body {
    padding-inline-start: var(--size-3);
  }
</style>
