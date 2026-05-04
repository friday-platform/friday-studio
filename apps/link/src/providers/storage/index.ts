import { join } from "node:path";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { ProviderStorageAdapter } from "./adapter.ts";
import { LocalProviderStorageAdapter } from "./local-adapter.ts";

export type { ProviderStorageAdapter } from "./adapter.ts";

let cachedAdapter: ProviderStorageAdapter | null = null;
let cachedKv: Deno.Kv | null = null;

/**
 * Get or create provider storage adapter.
 *
 * Local-only since the Cortex variant was deleted 2026-05-02 (speculative
 * remote backend, never reached). When a real cloud-backend story for
 * Link returns, build it against the redesigned data layout — don't
 * resurrect the env-gated dual-adapter pattern.
 */
export async function getProviderStorageAdapter(): Promise<ProviderStorageAdapter> {
  if (cachedAdapter) return cachedAdapter;
  if (!cachedKv) {
    cachedKv = await Deno.openKv(join(getFridayHome(), "link-providers.db"));
  }
  cachedAdapter = new LocalProviderStorageAdapter(cachedKv);
  return cachedAdapter;
}
