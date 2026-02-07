import type { MCPServerMetadata } from "../schemas.ts";

/**
 * Storage adapter interface for dynamic MCP registry entries.
 */
export interface MCPRegistryStorageAdapter {
  /** Add a new entry. Throws if ID already exists. */
  add(entry: MCPServerMetadata): Promise<void>;

  /** Get entry by ID. Returns null if not found. */
  get(id: string): Promise<MCPServerMetadata | null>;

  /** List all dynamic entries (excludes static registry). */
  list(): Promise<MCPServerMetadata[]>;

  /** Delete entry. Returns true if deleted, false if not found. */
  delete(id: string): Promise<boolean>;
}
