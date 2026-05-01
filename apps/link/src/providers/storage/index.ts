import { join } from "node:path";
import process from "node:process";
import { getFridayHome } from "@atlas/utils/paths.server";
import { getAuthToken } from "../../auth-context.ts";
import type { ProviderStorageAdapter } from "./adapter.ts";
import { CortexProviderStorageAdapter } from "./cortex-adapter.ts";
import { LocalProviderStorageAdapter } from "./local-adapter.ts";

export type { ProviderStorageAdapter } from "./adapter.ts";

let cachedAdapter: ProviderStorageAdapter | null = null;
let cachedKv: Deno.Kv | null = null;

/**
 * Get or create provider storage adapter.
 *
 * Auto-detects adapter from CORTEX_URL presence:
 * - If CORTEX_URL is set: Uses Cortex adapter with per-request auth from AsyncLocalStorage
 * - Otherwise: Uses local Deno KV adapter (local dev only)
 *
 * The adapter is cached as a singleton for the process lifetime.
 *
 * @example
 * ```typescript
 * const adapter = await getProviderStorageAdapter();
 * await adapter.add(providerInput);
 * ```
 */
export async function getProviderStorageAdapter(): Promise<ProviderStorageAdapter> {
  if (cachedAdapter) return cachedAdapter;

  const cortexUrl = process.env.CORTEX_URL;

  if (cortexUrl) {
    cachedAdapter = new CortexProviderStorageAdapter(cortexUrl, getAuthToken);
  } else if (process.env.LINK_DEV_MODE === "true") {
    if (!cachedKv) {
      cachedKv = await Deno.openKv(join(getFridayHome(), "link-providers.db"));
    }
    cachedAdapter = new LocalProviderStorageAdapter(cachedKv);
  } else {
    throw new Error("CORTEX_URL is required in non-dev environments");
  }

  return cachedAdapter;
}
