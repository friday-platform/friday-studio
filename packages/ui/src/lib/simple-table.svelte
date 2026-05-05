<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLTableAttributes } from "svelte/elements";

  type Props = HTMLTableAttributes & { children: Snippet };
  let { children, ...rest }: Props = $props();
</script>

<table {...rest}>{@render children()}</table>

<style>
  table {
    border-collapse: collapse;
    inline-size: fit-content;
    max-inline-size: 100%;
  }

  table :global(th),
  table :global(td) {
    border-inline-end: 1px solid var(--border);
    border-block-end: 1px solid var(--border);
    min-block-size: var(--size-10);
    color: var(--text-faded);
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-4);
    padding-block: var(--size-2);
    padding-inline: var(--size-3);
    text-align: start;
  }

  table :global(th) {
    color: var(--text-faded);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  table :global(tbody th) {
    color: var(--text);
    font-size: var(--font-size-2);
  }

  table :global(th:first-child),
  table :global(td:first-child) {
    padding-inline-start: 0;
  }

  table :global(th:last-child),
  table :global(td:last-child) {
    padding-inline-end: 0;
  }

  table :global(tr *:last-child) {
    border-inline-end: none;
  }
</style>
