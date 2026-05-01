import type { MCPServerMetadata } from "../schemas.ts";

/**
 * Fields that can be updated on an existing MCP registry entry.
 * Excludes immutable fields: id, source.
 */
export type UpdatableMCPServerMetadata = Omit<MCPServerMetadata, "id" | "source">;

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

  /**
   * Atomically update an existing entry.
   * Only updates provided fields - omitted fields keep their current values.
   * Returns the updated entry, or null if not found.
   * Throws if the entry was modified concurrently (version conflict).
   */
  update(
    id: string,
    changes: Partial<UpdatableMCPServerMetadata>,
  ): Promise<MCPServerMetadata | null>;
}
