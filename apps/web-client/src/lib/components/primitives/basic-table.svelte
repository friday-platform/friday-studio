<script lang="ts">
  type Props = { headers: string[]; rows: Record<string, string | number>[] };

  const { headers, rows }: Props = $props();
</script>

<table>
  <thead>
    <tr>
      {#each headers as header (header)}
        <th>{header}</th>
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
    border-collapse: separate;
    border-spacing: 0;
    border-radius: var(--radius-3);
    font-size: var(--font-size-3);
    inline-size: max-content;
  }

  th,
  td {
    border: var(--size-px) solid var(--color-border-1);
    border-inline-start: none;
    border-block-start: none;
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
    min-inline-size: var(--size-32);
  }

  th:last-child,
  td:last-child {
    border-inline-end: none;
  }

  th:not(:first-child) {
    border-inline-start: none;
  }

  th {
    font-weight: var(--font-weight-5);
    text-align: left;
  }

  td {
    border-block-start: none;
  }

  tr:last-child {
    td {
      border-block-end: none;
    }
  }
</style>
