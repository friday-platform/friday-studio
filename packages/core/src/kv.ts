import type { Kv } from "@deno/kv";

declare const Deno: { openKv?: (path?: string) => Promise<Kv> } | undefined;

/**
 * Opens a KV store, working in both Deno and Node.js.
 * In Deno, uses built-in Deno.openKv. In Node, uses @deno/kv polyfill.
 *
 * Uses dynamic import for @deno/kv to avoid bundling native addons
 * in deno compile scenarios.
 */
export async function openKv(path?: string): Promise<Kv> {
  // biome-ignore lint/complexity/useOptionalChain: typeof required for undeclared globals (Node.js)
  if (typeof Deno !== "undefined" && Deno.openKv) {
    return Deno.openKv(path);
  }
  // Dynamic import - only loaded when running in Node.js
  const { openKv: denoKvOpen } = await import("@deno/kv");
  return denoKvOpen(path);
}

export type { Kv };
