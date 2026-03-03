<script lang="ts">
  import { humanizeFieldName } from "$lib/utils/field-helpers";

  type Props = {
    headers: string[];
    rows: Record<string, unknown>[];
    /** Display headers as-is without humanizing. */
    rawHeaders?: boolean;
  };

  const { headers, rows, rawHeaders = false }: Props = $props();
</script>

<table>
  <thead>
    <tr>
      {#each headers as header (header)}
        <th>{rawHeaders ? header : humanizeFieldName(header)}</th>
      {/each}
    </tr>
  </thead>
  <tbody>
    {#each rows as row, i (i)}
      <tr>
        {#each headers as header (header)}
          <td>{row[header]}</td>
        {/each}
      </tr>
    {/each}
  </tbody>
</table>

<style>
  table {
    border-collapse: collapse;
    font-size: var(--font-size-3);
    inline-size: auto;
  }

  th,
  td {
    border-block-end: var(--size-px) solid var(--color-border-1);
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    padding-block: var(--size-2-5);
    padding-inline: var(--size-3);
    min-inline-size: var(--size-32);
  }

  th {
    background-color: var(--accent-1);
    border: none;
    font-weight: var(--font-weight-5);
    text-align: start;
  }

  th:first-of-type {
    border-start-start-radius: var(--radius-3);
    border-end-start-radius: var(--radius-3);
  }

  th:last-of-type {
    border-start-end-radius: var(--radius-3);
    border-end-end-radius: var(--radius-3);
  }

  tr:last-child td {
    border-block-end: none;
  }
</style>
