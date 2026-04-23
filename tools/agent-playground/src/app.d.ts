/// <reference types="@sveltejs/kit" />

declare module "@tanstack/svelte-table" {
  interface ColumnMeta<TData extends import("@tanstack/svelte-table").RowData, TValue> {
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
