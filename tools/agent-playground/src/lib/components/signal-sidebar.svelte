<!--
  Signal detail sidebar shown when a signal node is selected.

  Displays signal type badge, configuration details, input schema,
  and a manual trigger button. All fields are read-only for v1.

  @component
  @param {import("@atlas/config").TopologyNode} node - Selected signal node
  @param {string} workspaceId - Active workspace ID
-->

<script lang="ts">
  import type { TopologyNode } from "@atlas/config";
  import { Button, JsonHighlight } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import { getDaemonClient } from "$lib/daemon-client";

  type Props = {
    node: TopologyNode;
    workspaceId: string;
  };

  let { node, workspaceId }: Props = $props();

  const client = getDaemonClient();

  /** Strip the "signal:" prefix from the topology node ID to get the config key. */
  const signalId = $derived(node.id.replace(/^signal:/, ""));

  const provider = $derived(
    typeof node.metadata.provider === "string" ? node.metadata.provider : "unknown",
  );

  const signalQuery = createQuery(() => ({
    queryKey: ["daemon", "workspace", workspaceId, "config", "signal", signalId],
    queryFn: async () => {
      const configClient = client.workspaceConfig(workspaceId);
      const res = await configClient.signals[":signalId"].$get({
        param: { signalId },
      });
      if (!res.ok) throw new Error(`Failed to fetch signal: ${res.status}`);
      return res.json();
    },
    enabled: Boolean(workspaceId && signalId),
  }));

  const signal = $derived(signalQuery.data ?? null);
  const config: Record<string, unknown> | null = $derived.by(() => {
    if (!signal || !("config" in signal)) return null;
    const c = signal.config;
    if (typeof c !== "object" || c === null) return null;
    return Object.fromEntries(Object.entries(c));
  });
  const schema = $derived(
    signal && "schema" in signal ? signal.schema : null,
  );

  let triggering = $state(false);
  let triggerError = $state<string | null>(null);
  let triggerSuccess = $state(false);

  // Reset trigger state when node changes
  $effect(() => {
    // Access signalId to track node changes
    void signalId;
    triggerError = null;
    triggerSuccess = false;
  });

  async function handleTrigger() {
    triggering = true;
    triggerError = null;
    triggerSuccess = false;

    try {
      const res = await client.workspace[":workspaceId"].signals[":signalId"].$post({
        param: { workspaceId, signalId },
        json: {},
      });
      if (!res.ok) {
        const body = await res.text();
        triggerError = `Trigger failed: ${body}`;
        return;
      }
      triggerSuccess = true;
      setTimeout(() => { triggerSuccess = false; }, 3000);
    } catch (e) {
      triggerError = e instanceof Error ? e.message : "Trigger failed";
    } finally {
      triggering = false;
    }
  }

  const PROVIDER_LABELS: Record<string, string> = {
    http: "HTTP",
    schedule: "Cron",
    "fs-watch": "File Watch",
    system: "System",
  };

  function providerLabel(p: string): string {
    return PROVIDER_LABELS[p] ?? p;
  }

  function formatJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
</script>

<div class="signal-sidebar">
  <div class="section">
    <h3 class="section-title">Signal</h3>
    <p class="signal-name">{node.label}</p>
    <span class="type-badge" data-provider={provider}>
      {providerLabel(provider)}
    </span>
    {#if signal && "description" in signal && signal.description}
      <p class="description">{signal.description}</p>
    {/if}
  </div>

  {#if signalQuery.isPending}
    <p class="loading">Loading signal config...</p>
  {:else if signalQuery.isError}
    <p class="error">{signalQuery.error?.message ?? "Failed to load"}</p>
  {:else if config}
    <div class="section">
      <h3 class="section-title">Configuration</h3>
      <div class="config-fields">
        {#each Object.entries(config) as [key, value] (key)}
          <div class="config-field">
            <span class="field-key">{key}</span>
            <span class="field-value">
              {typeof value === "string" ? value : JSON.stringify(value)}
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if schema}
    <div class="section">
      <h3 class="section-title">Input Schema</h3>
      <div class="schema-block">
        <JsonHighlight code={formatJson(schema)} />
      </div>
    </div>
  {/if}

  <div class="section">
    <Button size="small" onclick={handleTrigger} disabled={triggering}>
      {triggering ? "Triggering..." : "Trigger Signal"}
    </Button>

    {#if triggerSuccess}
      <p class="trigger-success">Signal triggered</p>
    {/if}
    {#if triggerError}
      <p class="trigger-error">{triggerError}</p>
    {/if}
  </div>
</div>

<style>
  .signal-sidebar {
    display: flex;
    flex-direction: column;
    gap: var(--size-5);
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-title {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    letter-spacing: var(--font-letterspacing-2);
    text-transform: uppercase;
  }

  .signal-name {
    color: var(--color-text);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    word-break: break-all;
  }

  .type-badge {
    align-self: flex-start;
    border: 1px solid var(--color-border-2);
    border-radius: var(--radius-round);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-0-5) var(--size-3);
  }

  .type-badge[data-provider="http"] {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    border-color: color-mix(in srgb, var(--color-info), transparent 60%);
  }

  .type-badge[data-provider="schedule"] {
    background-color: color-mix(in srgb, var(--color-accent), transparent 85%);
    border-color: color-mix(in srgb, var(--color-accent), transparent 60%);
  }

  .type-badge[data-provider="fs-watch"] {
    background-color: color-mix(in srgb, var(--color-success), transparent 85%);
    border-color: color-mix(in srgb, var(--color-success), transparent 60%);
  }

  .description {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-2);
    line-height: 1.5;
  }

  .loading {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-2);
  }

  .error {
    color: var(--color-error);
    font-size: var(--font-size-2);
  }

  .config-fields {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .config-field {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  .field-key {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .field-value {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    word-break: break-all;
  }

  .schema-block {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    max-block-size: 300px;
    overflow-y: auto;
    padding: var(--size-3);
    scrollbar-width: thin;
  }

  .trigger-success {
    color: var(--color-success);
    font-size: var(--font-size-1);
  }

  .trigger-error {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }
</style>
