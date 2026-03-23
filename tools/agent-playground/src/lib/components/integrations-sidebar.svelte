<!--
  Integrations sidebar panel — shows credential operational status
  from the preflight endpoint.

  Displays green/yellow/gray status dots for connected/degraded/disconnected
  integrations across all credential sources (Link, env vars, config literals).

  @component
  @param {string | null} workspaceId - Current workspace ID
-->

<script lang="ts">
  import { useIntegrationsPreflight, type IntegrationPreflight } from "$lib/queries/integrations-preflight";

  type Props = {
    workspaceId: string | null;
  };

  let { workspaceId }: Props = $props();

  const preflightQuery = useIntegrationsPreflight(() => workspaceId);

  const integrations = $derived(preflightQuery.data?.integrations ?? []);
  const connectedCount = $derived(integrations.filter((i) => i.status === "connected").length);

  /** Humanize credential source labels from the preflight API. */
  const SOURCE_LABELS: Record<string, string> = {
    env: "env var",
    link: "linked",
    config: "inline",
  };

  /** Get the display label for an integration based on its status. */
  function getLabel(entry: IntegrationPreflight): string {
    if (entry.status === "connected") {
      const raw = entry.label ?? "connected";
      return SOURCE_LABELS[raw] ?? raw;
    }
    if (entry.status === "degraded") return entry.detail ?? "Degraded";
    return "Not connected";
  }
</script>

{#if integrations.length > 0}
  <div class="integrations">
    <div class="section-header">
      <h3 class="section-title">Integrations</h3>
      <span class="section-badge">
        {connectedCount} of {integrations.length}
      </span>
    </div>
    <div class="entries">
      {#each integrations as entry (entry.provider)}
        <div class="entry">
          <span
            class="status-dot"
            class:connected={entry.status === "connected"}
            class:degraded={entry.status === "degraded"}
          ></span>
          <span class="provider">{entry.provider}</span>
          <span
            class="status-text"
            class:connected={entry.status === "connected"}
            class:degraded={entry.status === "degraded"}
          >
            {getLabel(entry)}
          </span>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .integrations {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .section-header {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .section-badge {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-0);
    font-variant-numeric: tabular-nums;
    margin-inline-start: auto;
  }

  .entries {
    display: flex;
    flex-direction: column;
  }

  .entry {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    padding-block: var(--size-1-5);
  }

  .entry:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .status-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
  }

  .status-dot.connected {
    background-color: var(--color-success);
  }

  .status-dot.degraded {
    background-color: var(--color-warning);
  }

  .provider {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .status-text {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-0);
    margin-inline-start: auto;
    text-align: end;
  }

  .status-text.connected {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }

  .status-text.degraded {
    color: var(--color-warning);
  }
</style>
