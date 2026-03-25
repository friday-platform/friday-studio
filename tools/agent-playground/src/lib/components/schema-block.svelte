<!--
  TypeScript-interface-inspired schema block for data contracts.

  Renders a data contract as a typed schema block: document type name as hero,
  producer->consumer flow annotation, and monospace field list with
  required/optional distinction and nested object support.

  @component
  @param {import("@atlas/config/data-contracts").DataContract} contract - Data contract to render
  @param {string} workspaceId - Workspace ID for step navigation
-->

<script lang="ts">
  import type { DataContract } from "@atlas/config/data-contracts";
  import { goto } from "$app/navigation";

  type Props = { contract: DataContract; workspaceId: string };

  let { contract, workspaceId }: Props = $props();

  interface SchemaField {
    name: string;
    type: string;
    required: boolean;
    depth: number;
    isArrayOfObjects: boolean;
  }

  /** Flatten a JSON Schema into a list of fields with depth for nesting. */
  function flattenSchema(schema: object | null): SchemaField[] {
    if (!schema) return [];
    const s = schema as Record<string, unknown>;
    const props = s.properties;
    if (!props || typeof props !== "object") return [];
    const requiredSet = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
    return flattenProperties(props as Record<string, Record<string, unknown>>, requiredSet, 0);
  }

  function flattenProperties(
    props: Record<string, Record<string, unknown>>,
    requiredSet: Set<string>,
    depth: number,
  ): SchemaField[] {
    const fields: SchemaField[] = [];
    for (const [name, def] of Object.entries(props)) {
      const type = typeof def?.type === "string" ? def.type : "unknown";
      const isArrayOfObjects =
        type === "array" &&
        typeof def?.items === "object" &&
        def.items !== null &&
        (def.items as Record<string, unknown>).type === "object";

      fields.push({
        name,
        type: formatType(def),
        required: requiredSet.has(name),
        depth,
        isArrayOfObjects,
      });

      // Nested object properties
      if (type === "object" && def?.properties && typeof def.properties === "object") {
        const nestedRequired = new Set(
          Array.isArray(def.required) ? (def.required as string[]) : [],
        );
        fields.push(
          ...flattenProperties(
            def.properties as Record<string, Record<string, unknown>>,
            nestedRequired,
            depth + 1,
          ),
        );
      }

      // Array of objects — show item properties nested
      if (isArrayOfObjects) {
        const items = def.items as Record<string, unknown>;
        if (items.properties && typeof items.properties === "object") {
          const nestedRequired = new Set(
            Array.isArray(items.required) ? (items.required as string[]) : [],
          );
          fields.push(
            ...flattenProperties(
              items.properties as Record<string, Record<string, unknown>>,
              nestedRequired,
              depth + 1,
            ),
          );
        }
      }
    }
    return fields;
  }

  function formatType(def: Record<string, unknown>): string {
    const type = typeof def?.type === "string" ? def.type : "unknown";
    if (type === "array") {
      if (typeof def?.items === "object" && def.items !== null) {
        const itemType = (def.items as Record<string, unknown>).type;
        if (typeof itemType === "string") return `${itemType}[]`;
      }
      return "array";
    }
    return type;
  }

  function navigateToStep(stepId: string) {
    goto(`/platform/${workspaceId}/agent/${contract.jobId}:${stepId}`);
  }

  const fields = $derived(flattenSchema(contract.schema));
</script>

<div class="schema-block">
  <div class="block-header">
    <span class="doc-type">{contract.documentType}</span>
    <span class="flow-annotation">
      <button class="step-link" onclick={() => navigateToStep(contract.fromStepId)}>
        {contract.fromStepName}
      </button>
      <span class="arrow">&rarr;</span>
      {#if contract.toStepId}
        <button class="step-link" onclick={() => navigateToStep(contract.toStepId ?? "")}>
          {contract.toStepName}
        </button>
      {:else}
        <span class="terminal">(end)</span>
      {/if}
    </span>
  </div>

  {#if fields.length > 0}
    <div class="field-list">
      {#each fields as field (field.name + field.depth)}
        <div
          class="field-row"
          class:optional={!field.required}
          style:padding-inline-start="{field.depth * 16 + (field.depth > 0 ? 8 : 0)}px"
        >
          {#if field.depth > 0}
            <span class="indent-guide" style:left="{(field.depth - 1) * 16 + 4}px"></span>
          {/if}
          <span class="fname">{field.name}</span>
          <span class="ftype">{field.type}</span>
        </div>
      {/each}
    </div>
  {:else}
    <p class="no-schema">No schema defined</p>
  {/if}
</div>

<style>
  .schema-block {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .block-header {
    align-items: baseline;
    display: flex;
    gap: var(--size-3);
  }

  .doc-type {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
  }

  .flow-annotation {
    align-items: baseline;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-1);
    margin-inline-start: auto;
  }

  .step-link {
    background: none;
    border: none;
    color: var(--color-info);
    cursor: pointer;
    font-family: inherit;
    font-size: var(--font-size-1);
    padding: 0;
  }

  .step-link:hover {
    text-decoration: underline;
  }

  .arrow {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
  }

  .terminal {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-style: italic;
  }

  .field-list {
    display: flex;
    flex-direction: column;
  }

  .field-row {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
    padding-block: 2px;
    position: relative;
  }

  .field-row.optional {
    opacity: 0.5;
  }

  .indent-guide {
    background-color: color-mix(in srgb, var(--color-border-1), transparent 30%);
    block-size: 100%;
    inline-size: 1px;
    position: absolute;
    top: 0;
  }

  .fname {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .ftype {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .no-schema {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    font-style: italic;
    margin: 0;
  }
</style>
