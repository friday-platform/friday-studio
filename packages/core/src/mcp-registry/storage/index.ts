import { join } from "node:path";
import { getFridayHome } from "@atlas/utils/paths.server";
import type { MCPRegistryStorageAdapter } from "./adapter.ts";
import { LocalMCPRegistryAdapter } from "./local-adapter.ts";

export type { MCPRegistryStorageAdapter, UpdatableMCPServerMetadata } from "./adapter.ts";
export { LocalMCPRegistryAdapter } from "./local-adapter.ts";

let cachedAdapter: MCPRegistryStorageAdapter | null = null;
let cachedKv: Deno.Kv | null = null;

/**
 * Get or create MCP registry storage adapter.
 *
 * Local-only since the Cortex variant was deleted 2026-05-02 (speculative
 * remote backend, never reached). The plan migrates this whole bucket onto
 * JetStream KV next.
 */
export async function getMCPRegistryAdapter(): Promise<MCPRegistryStorageAdapter> {
  if (cachedAdapter) return cachedAdapter;
  if (!cachedKv) {
    cachedKv = await Deno.openKv(join(getFridayHome(), "mcp-registry.db"));
  }
  cachedAdapter = new LocalMCPRegistryAdapter(cachedKv);
  return cachedAdapter;
}
