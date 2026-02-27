<script lang="ts" generics="T extends unknown">
  import { FlexRender, type Row, type Table } from "@tanstack/svelte-table";
  import TableCell from "./cell.svelte";
  import Header from "./header.svelte";

  type Props = {
    table: Table<T>;
    padded?: boolean;
    rowSize?: "small" | "large" | "medium" | "auto";
    grow?: boolean;
    hideHeader?: boolean;
    onRowClick?: (item: T, index: number) => void;
    rowPath?: (item: T, parent?: T) => string | undefined;
  };

  let {
    padded = false,
    rowSize = "small",
    grow,
    onRowClick,
    rowPath,
    table,
    hideHeader = false,
  }: Props = $props();

  function getColumnLayout() {
    let lengths = table.getVisibleLeafColumns().map((item) => {
      let minWidth = item.columnDef.meta?.minWidth ?? "min-content";
      let maxWidth = item.columnDef.meta?.maxWidth ?? "100%";

      if (item.columnDef.meta?.shrink) {
        return "min-content";
      }

      if (item.columnDef.meta?.width) {
        return item.columnDef.meta.width;
      }

      return `minmax(${minWidth}, ${maxWidth})`;
    });

    return lengths.join(" ");
  }

  /**
   * reset selection when the escape key is selected
   * modifying state within an effect is dangerous and
   * ill performat, so this check is heavily guarded by
   * if conditions to ensure it only fires in very
   * specific circumstances
   */
</script>

{#snippet row({ item, href, index }: { item: Row<T>; href: string | undefined; index: number })}
  <svelte:element
    this={href !== undefined && !item.getCanExpand() ? "a" : "div"}
    role={href !== undefined && !item.getCanExpand() ? "link" : "row"}
    class="row"
    class:padded
    class:highlight={href !== undefined || onRowClick !== undefined}
    class:selected={item.getIsSelected()}
    href={!item.getCanExpand() ? href : undefined}
    onclick={() => {
      if (onRowClick) {
        onRowClick(item.original, index);
      }
    }}
  >
    {#each item.getVisibleCells() as cell, cellIndex (cell.id)}
      <TableCell
        role="cell"
        align={cell.column.columnDef.meta?.align ? cell.column.columnDef.meta.align : "left"}
        weight={cell.column.columnDef.meta?.bold ? "bold" : "regular"}
        variant={cell.column.columnDef.meta?.faded ? "faded" : "regular"}
        maxWidth={cell.column.columnDef.meta?.maxWidth}
        width={cell.column.columnDef.meta?.width}
        size={cell.column.columnDef.meta?.size ?? "regular"}
        inset={cellIndex === 0 ? item.depth : 0}
      >
        <FlexRender content={cell.column.columnDef.cell} context={cell.getContext()} />
      </TableCell>
    {/each}
  </svelte:element>
{/snippet}

<div data-tempest class="tempest-component__data-table rowSize--{rowSize}" class:padded class:grow>
  <div class="component" style:grid-template-columns={getColumnLayout()} role="table">
    {#if table.getRowModel().rows.length > 0 && !hideHeader}
      <header role="rowgroup">
        {#each table.getHeaderGroups() as headerGroup (headerGroup)}
          {#each headerGroup.headers as header, headerIndex (headerIndex)}
            <Header
              role="columnheader"
              align={header.column.columnDef.meta?.align
                ? header.column.columnDef.meta.align
                : "left"}
              maxWidth={header.column.columnDef.meta?.maxWidth}
              width={header.column.columnDef.meta?.width}
            >
              <FlexRender content={header.column.columnDef.header} context={header.getContext()} />
            </Header>
          {/each}
        {/each}
      </header>
    {/if}

    {#each table.getRowModel().rows as item, index (item.id)}
      {@render row({ item, href: rowPath ? rowPath(item.original) : undefined, index })}
    {/each}
  </div>
</div>

<style>
  .tempest-component__data-table {
    & {
      display: flex;
      flex-direction: column;
    }

    &.grow {
      flex: 1 0 auto;
    }

    &.has-actions {
      inline-size: calc(100% + var(--size-14));
    }

    .component {
      display: grid;
      min-inline-size: 100%;
      grid-auto-columns: 100%;
      overflow-x: auto;
      overflow-y: clip;

      header {
        display: grid;
        grid-column: 1 / -1;
        grid-template-columns: subgrid;
        position: sticky;
        inset-block-start: 0;
        z-index: var(--layer-1);

        & :global(.header) {
          border-block-end: var(--size-px) solid var(--border-1s);

          &:global(:is(.background--gray)) {
            background-color: var(--highlight-2s);
            border-block-end: transparent;
          }
        }
      }
    }
  }

  header {
    & :global(.header) {
      padding-inline: var(--size-2);

      &:first-child {
        padding-inline-start: var(--size-3);

        &.padded {
          padding-inline-start: var(--size-2);
        }
      }
    }
  }

  .row {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    position: relative;
    z-index: 1;

    & :global(.cell) {
      border-block-end: var(--size-px) solid var(--color-border-1);
      padding-inline: var(--size-2);
      transition: border-color 250ms ease;

      &:first-child {
        padding-inline-start: calc(0 + var(--cell-additional-padding, 0));
      }

      .padded &:first-child {
        padding-inline-start: calc(var(--size-2) + var(--cell-additional-padding, 0));
      }

      .padded &:last-child {
        padding-inline-end: calc(var(--size-2) + var(--cell-additional-padding, 0));
      }

      &:last-child {
        padding-inline-end: var(--size-px);
      }
    }

    .rowSize--medium & {
      :global(.cell) {
        block-size: var(--size-13);
      }
    }

    .rowSize--large & {
      :global(.cell) {
        block-size: var(--size-16);
      }
    }

    .rowSize--auto & {
      :global(.cell) {
        block-size: auto;
      }
    }

    &:before {
      background-color: var(--color-surface-2);
      border-radius: var(--size-3);
      content: "";
      inset: 0;
      position: absolute;
      transition: all 150ms ease;
      opacity: 0;
      z-index: -1;
    }

    &.highlight:focus,
    &.highlight:hover {
      outline: none;

      & :global(.cell) {
        border-color: transparent;
      }

      &:before {
        opacity: 1;
      }
    }

    &:has(+ .row.highlight:focus),
    &:has(+ .row.highlight:hover) {
      & :global(.cell) {
        border-color: transparent;
      }
    }
  }

  .empty-state {
    align-items: center;
    display: flex;
    justify-content: center;
    flex: 1 1 auto;
    min-block-size: var(--size-96);
  }
</style>
