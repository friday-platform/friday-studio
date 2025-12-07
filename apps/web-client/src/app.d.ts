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

  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
    clarity: ((...args: unknown[]) => void) & { q?: unknown[] };
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

  /** Build-time constant: true in development mode, false in production */
  const __DEV_MODE__: boolean;

  /** Sentry environment: "local", "sandbox", or "production" */
  const __SENTRY_ENVIRONMENT__: string;

  /** Sentry release identifier for deployment tracking */
  const __SENTRY_RELEASE__: string;
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
