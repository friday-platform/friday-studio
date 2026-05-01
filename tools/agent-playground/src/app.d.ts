/// <reference types="@sveltejs/kit" />

import type { CellData, RowData, TableFeatures } from "@tanstack/svelte-table";

declare module "@tanstack/svelte-table" {
  interface ColumnMeta<
    TFeatures extends TableFeatures,
    TData extends RowData,
    TValue extends CellData = CellData,
  > {
    bold?: boolean;
    faded?: boolean;
    align?: "left" | "center" | "right" | "full";
    minWidth?: string;
    maxWidth?: string;
    width?: string;
    shrink?: boolean;
    size?: "small" | "regular";
  }
}

export {};
