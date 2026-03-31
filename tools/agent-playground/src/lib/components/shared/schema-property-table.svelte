<!--
  Renders a JSON Schema as a flat property table (Stripe API docs style).

  Displays property name (monospace), type, description, and required indicator.
  Handles 1-2 levels of nesting via dot-notation for nested object properties.

  @component
  @param {object | null} schema - A JSON Schema object (type: "object" with properties)
  @param {string} [emptyMessage="No schema defined"] - Message when schema is null/empty
-->

<script lang="ts">
  import { schemaToRows } from "$lib/schema-utils";

  type Props = { schema: object | null; emptyMessage?: string };

  let { schema, emptyMessage = "No schema defined" }: Props = $props();

  const rows = $derived(schemaToRows(schema));
  const isEmpty = $derived(!schema || rows.length === 0);
</script>

{#if isEmpty}
  <p class="empty-message">{emptyMessage}</p>
{:else}
  <table class="schema-table">
    <thead>
      <tr>
        <th class="col-name">Property</th>
        <th class="col-type">Type</th>
        <th class="col-desc">Description</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.name)}
        <tr class="schema-row" class:nested={row.depth > 0}>
          <td class="cell-name">
            {#if row.depth > 0}
              <span class="indent"></span>
            {/if}
            <code class="prop-name">{row.name}</code>
            {#if row.required}
              <span class="required-indicator" title="Required">*</span>
            {/if}
          </td>
          <td class="cell-type">{row.type}</td>
          <td class="cell-desc">{row.description}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .empty-message {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-1);
    font-style: italic;
    margin: 0;
    padding: var(--size-2) 0;
  }

  .schema-table {
    border-collapse: collapse;
    font-size: var(--font-size-3);
    inline-size: auto;
  }

  thead th {
    background-color: var(--color-highlight-1, hsl(221 88% 20% / 0.06));
    border: none;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-3);
    min-inline-size: var(--size-32);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
    text-align: start;
  }

  thead th:first-of-type {
    border-start-start-radius: var(--radius-3);
    border-end-start-radius: var(--radius-3);
  }

  thead th:last-of-type {
    border-start-end-radius: var(--radius-3);
    border-end-end-radius: var(--radius-3);
  }

  .schema-row td {
    border-block-end: var(--size-px) solid var(--color-border-1);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
    vertical-align: baseline;
  }

  .schema-row:last-child td {
    border-block-end: none;
  }

  .schema-row.nested td {
    padding-block: var(--size-1-5);
  }

  .col-name {
    inline-size: 35%;
  }

  .col-type {
    inline-size: 15%;
  }

  .col-desc {
    inline-size: 50%;
  }

  .cell-name {
    align-items: baseline;
    display: flex;
    gap: var(--size-1);
  }

  .indent {
    border-inline-start: 1px solid color-mix(in srgb, var(--color-border-1), transparent 30%);
    flex-shrink: 0;
    inline-size: var(--size-3);
    margin-inline-start: var(--size-2);
  }

  .prop-name {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .required-indicator {
    color: var(--color-error);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-6);
    line-height: 1;
  }

  .cell-type {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
  }

  .cell-desc {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
  }
</style>
