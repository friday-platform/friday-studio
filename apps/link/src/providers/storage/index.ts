import { join } from "node:path";
import process from "node:process";
import { getAtlasHome } from "@atlas/utils/paths.server";
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
 * - If CORTEX_URL is set: Uses Cortex adapter (requires ATLAS_KEY)
 * - Otherwise: Uses local Deno KV adapter
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
    const atlasKey = process.env.ATLAS_KEY;
    if (!atlasKey) {
      throw new Error(
        "ATLAS_KEY required when CORTEX_URL is set. Cannot persist provider definitions without credentials.",
      );
    }
    cachedAdapter = new CortexProviderStorageAdapter(cortexUrl, atlasKey);
  } else {
    if (!cachedKv) {
      cachedKv = await Deno.openKv(join(getAtlasHome(), "link-providers.db"));
    }
    cachedAdapter = new LocalProviderStorageAdapter(cachedKv);
  }

  return cachedAdapter;
}
