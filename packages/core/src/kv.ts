import { openKv as denoKvOpen, type Kv } from "@deno/kv";

declare const Deno: { openKv?: (path?: string) => Promise<Kv> } | undefined;

/**
 * Opens a KV store, working in both Deno and Node.js.
 * In Deno, uses built-in Deno.openKv. In Node, uses @deno/kv polyfill.
 */
export function openKv(path?: string): Promise<Kv> {
  if (typeof Deno !== "undefined" && Deno.openKv) {
    return Deno.openKv(path);
  }
  return denoKvOpen(path);
}

export type { Kv };
