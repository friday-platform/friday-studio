import { join } from "node:path";
import process from "node:process";
import { getAtlasHome } from "@atlas/utils/paths.server";
import type { MCPRegistryStorageAdapter } from "./adapter.ts";
import { CortexMCPRegistryAdapter } from "./cortex-adapter.ts";
import { LocalMCPRegistryAdapter } from "./local-adapter.ts";

export type { MCPRegistryStorageAdapter, UpdatableMCPServerMetadata } from "./adapter.ts";
export { CortexMCPRegistryAdapter } from "./cortex-adapter.ts";
export { LocalMCPRegistryAdapter } from "./local-adapter.ts";

let cachedAdapter: MCPRegistryStorageAdapter | null = null;
let cachedKv: Deno.Kv | null = null;

/**
 * Get or create MCP registry storage adapter.
 *
 * Auto-detects adapter from CORTEX_URL presence:
 * - If CORTEX_URL is set: Uses Cortex adapter (requires ATLAS_KEY)
 * - Otherwise: Uses local adapter
 */
export async function getMCPRegistryAdapter(): Promise<MCPRegistryStorageAdapter> {
  if (cachedAdapter) return cachedAdapter;

  const cortexUrl = process.env.CORTEX_URL;

  if (cortexUrl) {
    const atlasKey = process.env.ATLAS_KEY;
    if (!atlasKey) {
      throw new Error("ATLAS_KEY required when CORTEX_URL is set");
    }
    cachedAdapter = new CortexMCPRegistryAdapter(cortexUrl, atlasKey);
  } else {
    if (!cachedKv) {
      cachedKv = await Deno.openKv(join(getAtlasHome(), "mcp-registry.db"));
    }
    cachedAdapter = new LocalMCPRegistryAdapter(cachedKv);
  }

  return cachedAdapter;
}
