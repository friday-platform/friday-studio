/* eslint-disable @typescript-eslint/no-unused-vars */
// see biome-ignore lint/correctness/noUnusedVariables
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

  /** Build-time constant: true in development mode, false in production */
  const __DEV_MODE__: boolean;

  /** Sentry environment: "local", "sandbox", or "production" */
  const __SENTRY_ENVIRONMENT__: string;

  /** Sentry release identifier for deployment tracking */
  const __SENTRY_RELEASE__: string;

  /** Feature flag names enabled via FEATURE_FLAGS env var at build time */
  const __FEATURE_FLAGS__: string[];
}

declare module "@tanstack/svelte-table" {
  // biome-ignore lint/correctness/noUnusedVariables: We aren't using the generic, but it must be typed
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
