import type { NatsConnection } from "nats";
import type { MCPRegistryStorageAdapter } from "./adapter.ts";
import { JetStreamMCPRegistryAdapter } from "./jetstream-adapter.ts";

export type { MCPRegistryStorageAdapter, UpdatableMCPServerMetadata } from "./adapter.ts";
export { JetStreamMCPRegistryAdapter, MCP_REGISTRY_BUCKET } from "./jetstream-adapter.ts";
export { LocalMCPRegistryAdapter } from "./local-adapter.ts";

let cachedAdapter: MCPRegistryStorageAdapter | null = null;

/**
 * Initialize the MCP registry adapter with a NATS connection. Daemon
 * calls this once at startup, before any route or background job
 * touches the registry. Subsequent zero-arg `getMCPRegistryAdapter()`
 * calls return the cached instance.
 *
 * Migration path: legacy `~/.atlas/mcp-registry.db` (Deno KV) data
 * lands in the JS KV bucket via `m_<sha>_mcp_registry_to_jetstream`
 * migration entry. After that migration ships, the SQLite file is
 * deleted by the cleanup migration. The dispatcher never touches
 * Deno KV — that's a one-shot migration concern.
 */
export function initMCPRegistryAdapter(nc: NatsConnection): void {
  cachedAdapter = new JetStreamMCPRegistryAdapter(nc);
}

/**
 * Get the configured MCP registry adapter. Throws if `initMCPRegistryAdapter`
 * hasn't been called yet — that's a daemon-startup-order bug, not
 * something to silently work around.
 */
export function getMCPRegistryAdapter(): Promise<MCPRegistryStorageAdapter> {
  if (!cachedAdapter) {
    throw new Error(
      "MCP registry adapter not initialized — call initMCPRegistryAdapter(nc) at daemon startup",
    );
  }
  return Promise.resolve(cachedAdapter);
}
