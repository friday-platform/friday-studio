<!--
  Data Contracts section for the cockpit center column.

  Shows document type flows between pipeline steps — the pipeline's internal
  API surface. Each row displays producer→consumer with document type name
  and inline schema preview.

  @component
  @param {import("@atlas/config/data-contracts").DataContract[]} contracts - Derived data contracts
  @param {string} workspaceId - Workspace ID for collapsible state persistence
  @param {(jobId: string, stepId: string) => void} [onStepClick] - Navigate to a pipeline step
-->

<script lang="ts">
  import type { DataContract } from "@atlas/config/data-contracts";
  import CollapsibleSection from "$lib/components/shared/collapsible-section.svelte";

  type Props = {
    contracts: DataContract[];
    workspaceId: string;
    onStepClick?: (jobId: string, stepId: string) => void;
  };

  let { contracts, workspaceId, onStepClick }: Props = $props();

  const summaryText = $derived(`${contracts.length} ${contracts.length === 1 ? "type" : "types"}`);

  /** Extract preview fields from a JSON Schema object. Returns first 3 field names + types. */
  function schemaPreview(schema: object | null): { fields: string[]; remaining: number } {
    if (!schema) return { fields: [], remaining: 0 };
    if (!("properties" in schema) || typeof schema.properties !== "object" || !schema.properties) {
      return { fields: [], remaining: 0 };
    }

    const entries = Object.entries(schema.properties);
    const maxFields = 3;
    const fields = entries.slice(0, maxFields).map(([name, def]) => {
      const type =
        typeof def === "object" && def !== null && "type" in def && typeof def.type === "string"
          ? def.type
          : "unknown";
      return `${name}: ${type}`;
    });
    const remaining = Math.max(0, entries.length - maxFields);
    return { fields, remaining };
  }
</script>

{#if contracts.length > 0}
  <CollapsibleSection
    title="Data Contracts"
    {summaryText}
    sectionKey="data-contracts"
    {workspaceId}
  >
    <div class="contracts-list">
      {#each contracts as contract (contract.jobId + ":" + contract.fromStepId + ":" + contract.documentType)}
        {@const preview = schemaPreview(contract.schema)}
        <div class="contract-row">
          <div class="contract-flow">
            <button
              class="step-link"
              onclick={() => onStepClick?.(contract.jobId, contract.fromStepId)}
            >
              {contract.fromStepName}
            </button>
            <span class="arrow">&rarr;</span>
            {#if contract.toStepId}
              <button
                class="step-link"
                onclick={() => onStepClick?.(contract.jobId, contract.toStepId ?? "")}
              >
                {contract.toStepName}
              </button>
            {:else}
              <span class="terminal-label">{contract.toStepName}</span>
            {/if}
          </div>
          <div class="contract-detail">
            <span class="doc-type">{contract.documentType}</span>
            {#if preview.fields.length > 0}
              <span class="schema-preview">
                {"{ "}{preview.fields.join(", ")}{#if preview.remaining > 0}, +{preview.remaining}{/if}{" }"}
              </span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </CollapsibleSection>
{/if}

<style>
  .contracts-list {
    display: flex;
    flex-direction: column;
  }

  .contract-row {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding: var(--size-2) var(--size-4);
  }

  .contract-row:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .contract-flow {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .step-link {
    background: none;
    border: none;
    color: var(--color-info);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: 0;
  }

  .step-link:hover {
    text-decoration: underline;
  }

  .arrow {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
  }

  .terminal-label {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-1);
    font-style: italic;
  }

  .contract-detail {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
    padding-inline-start: var(--size-2);
  }

  .doc-type {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .schema-preview {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-0);
  }
</style>
