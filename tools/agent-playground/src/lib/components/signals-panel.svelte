<!--
  Signals section for the cockpit center column.

  Shows the workspace's external API surface — endpoints, input schemas,
  and which jobs each signal triggers. Wrapped in CollapsibleSection.

  @component
  @param {import("@atlas/config/signal-details").SignalDetail[]} signals - Derived signal details
  @param {string} workspaceId - Workspace ID for collapsible state persistence
-->

<script lang="ts">
  import type { SignalDetail } from "@atlas/config/signal-details";
  import CollapsibleSection from "$lib/components/collapsible-section.svelte";

  type Props = {
    signals: SignalDetail[];
    workspaceId: string;
    /** When set, signals triggering this job get a highlighted border. */
    highlightedJobId?: string | null;
  };

  let { signals, workspaceId, highlightedJobId }: Props = $props();

  /** Whether a signal triggers the currently highlighted job. */
  function triggersHighlightedJob(signal: SignalDetail): boolean {
    if (!highlightedJobId) return false;
    return signal.triggeredJobs.includes(highlightedJobId);
  }

  const summaryText = $derived.by(() => {
    const count = `${signals.length} ${signals.length === 1 ? "signal" : "signals"}`;
    const providers = [...new Set(signals.map((s) => s.provider.toUpperCase()))];
    return providers.length > 0 ? `${count} · ${providers.join(", ")}` : count;
  });

  /** Extract schema properties for rendering as a table. */
  function schemaFields(schema: object | null): Array<{ name: string; type: string; required: boolean; description?: string }> {
    if (!schema) return [];
    const s = schema as Record<string, unknown>;
    const props = s.properties;
    if (!props || typeof props !== "object") return [];

    const requiredSet = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);

    return Object.entries(props as Record<string, Record<string, unknown>>).map(([name, def]) => ({
      name,
      type: typeof def?.type === "string" ? def.type : "unknown",
      required: requiredSet.has(name),
      ...(typeof def?.description === "string" ? { description: def.description } : {}),
    }));
  }

  function providerBadgeClass(provider: string): string {
    if (provider === "http") return "badge--http";
    if (provider === "schedule") return "badge--cron";
    return "badge--manual";
  }

  function providerLabel(provider: string): string {
    if (provider === "http") return "HTTP";
    if (provider === "schedule") return "Cron";
    return "Manual";
  }
</script>

{#if signals.length > 0}
  <CollapsibleSection
    title="Signals"
    {summaryText}
    sectionKey="signals"
    {workspaceId}
  >
    <div class="signals-list">
      {#each signals as signal (signal.name)}
        {@const fields = schemaFields(signal.schema)}
        <div class="signal-entry" class:signal-entry--highlighted={triggersHighlightedJob(signal)}>
          <div class="signal-header">
            <span class="signal-name">{signal.title ?? signal.name}</span>
            <span class="provider-badge {providerBadgeClass(signal.provider)}">{providerLabel(signal.provider)}</span>
            {#if signal.endpoint}
              <span class="endpoint">POST {signal.endpoint}</span>
            {:else if signal.schedule}
              <span class="endpoint">{signal.schedule}</span>
            {/if}
          </div>

          {#if fields.length > 0}
            <div class="schema-table">
              {#each fields as field (field.name)}
                <div class="schema-row">
                  <span class="field-name">{field.name}</span>
                  <span class="field-type">{field.type}</span>
                  {#if field.required}
                    <span class="field-required">required</span>
                  {/if}
                  {#if field.description}
                    <span class="field-desc">{field.description}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if signal.triggeredJobs.length > 0}
            <div class="triggered-jobs">
              <span class="triggers-label">Triggers:</span>
              {#each signal.triggeredJobs as jobId (jobId)}
                <span class="job-name">{jobId}</span>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </CollapsibleSection>
{/if}

<style>
  .signals-list {
    display: flex;
    flex-direction: column;
  }

  .signal-entry {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-4);
  }

  .signal-entry:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .signal-entry--highlighted {
    background-color: color-mix(in srgb, var(--color-info), transparent 92%);
    border-inline-start: 2px solid var(--color-info);
  }

  .signal-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .signal-name {
    color: var(--color-text);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .provider-badge {
    border-radius: var(--radius-1);
    font-family: var(--font-family-monospace);
    font-size: 9px;
    font-weight: var(--font-weight-6);
    letter-spacing: var(--font-letterspacing-1);
    padding: var(--size-0-5) var(--size-1);
    text-transform: uppercase;
  }

  .badge--http {
    background-color: color-mix(in srgb, var(--color-info), transparent 85%);
    color: var(--color-info);
  }

  .badge--cron {
    background-color: color-mix(in srgb, var(--color-warning), transparent 85%);
    color: var(--color-warning);
  }

  .badge--manual {
    background-color: color-mix(in srgb, var(--color-accent), transparent 85%);
    color: var(--color-accent);
  }

  .endpoint {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  /* ---- Schema table ---- */

  .schema-table {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-inline-start: var(--size-2);
  }

  .schema-row {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .field-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .field-type {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
  }

  .field-required {
    color: var(--color-warning);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
  }

  .field-desc {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- Triggered jobs ---- */

  .triggered-jobs {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .triggers-label {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-0);
  }

  .job-name {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
  }
</style>
