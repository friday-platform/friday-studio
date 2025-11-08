import "@tanstack/svelte-table";
import type { RowData } from "@tanstack/svelte-table";

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  /**
   * Build-time constant indicating whether this is a Tauri desktop build.
   * - `true` in production desktop builds (TAURI_FAMILY env var set during `tauri build`)
   * - `false` in web builds and dev mode (`tauri dev`)
   *
   * Note: In dev mode, use runtime detection instead:
   * `typeof window !== 'undefined' && '__TAURI__' in window`
   */
  const __TAURI_BUILD__: boolean;
}

declare module "@tanstack/svelte-table" {
  // biome-ignore lint/correctness/noUnusedVariables: required by svelte table
  interface ColumnMeta<TData extends RowData, TValue> {
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

// biome-ignore lint/complexity/noUselessEmptyExport: <necessary?>
export {};
