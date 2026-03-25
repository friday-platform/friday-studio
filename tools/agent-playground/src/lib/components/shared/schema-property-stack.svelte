<!--
  Compact stacked layout for JSON Schema properties, designed for narrow
  containers (sidebar). Each property renders as a vertical block:
  name + type on one line, required badge, description below.

  @component
  @param {object | null} schema - A JSON Schema object (type: "object" with properties)
-->

<script lang="ts">
  import { schemaToRows } from "$lib/schema-utils";

  type Props = { schema: object | null };

  const { schema }: Props = $props();

  const rows = $derived(schemaToRows(schema));
</script>

{#if rows.length > 0}
  <div class="stack">
    {#each rows as row (row.name)}
      <div class="property" class:nested={row.depth > 0}>
        <div class="property-header">
          <code class="prop-name">{row.name}</code>
          <span class="prop-type">{row.type}</span>
          {#if row.required}
            <span class="required-badge">Required</span>
          {/if}
        </div>
        {#if row.description}
          <p class="prop-desc">{row.description}</p>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
  }

  .property {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  .property.nested {
    border-inline-start: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    margin-inline-start: var(--size-2);
    padding-inline-start: var(--size-2);
  }

  .property-header {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-1-5);
  }

  .prop-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
  }

  .prop-type {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-1);
  }

  .required-badge {
    color: var(--color-error);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
  }

  .prop-desc {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-2);
    margin: 0;
  }
</style>
