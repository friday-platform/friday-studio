/**
 * Registry Storage Adapter
 *
 * Domain-specific storage adapter for workspace registry operations.
 * Built on top of the KVStorage interface to provide semantic workspace operations
 * while maintaining complete storage backend independence.
 */

import { type KVStorage } from "./kv-storage.ts";
import {
  type WorkspaceEntry,
  WorkspaceEntrySchema,
  WorkspaceStatus,
} from "../workspace-manager.ts";
import { type WorkspaceConfig } from "@atlas/config";

/**
 * Registry-specific storage operations
 *
 * This adapter provides high-level workspace registry operations built on
 * the foundational KVStorage interface. It handles schema validation,
 * indexing, and workspace-specific business logic.
 */
export class RegistryStorageAdapter {
  private readonly REGISTRY_VERSION = "2.0.0";

  constructor(private storage: KVStorage) {}

  /**
   * Initialize the registry storage
   * Sets up initial metadata if not present
   */
  async initialize(): Promise<void> {
    await this.storage.initialize();

    // Initialize registry metadata if not exists
    const version = await this.storage.get<string>(["registry", "version"]);
    if (!version) {
      const atomic = this.storage.atomic();
      atomic.set(["registry", "version"], this.REGISTRY_VERSION);
      atomic.set(["registry", "lastUpdated"], new Date().toISOString());
      await atomic.commit();
    }
  }

  /**
   * Register a new workspace
   */
  async registerWorkspace(workspace: WorkspaceEntry): Promise<void> {
    // Validate workspace entry
    const validatedWorkspace = WorkspaceEntrySchema.parse(workspace);

    let workspaceToStore = validatedWorkspace;

    // For virtual workspaces, always embed config regardless of size
    if (validatedWorkspace.metadata?.virtual) {
      // Virtual workspaces must have embedded config since there's no filesystem fallback
      workspaceToStore = validatedWorkspace;
    } else {
      // For regular workspaces, check if workspace is too large and handle separately
      const workspaceSize = new TextEncoder().encode(JSON.stringify(validatedWorkspace)).length;

      // If workspace is too large, store config separately and reference it
      if (workspaceSize > 30000) { // Conservative limit to avoid Deno KV size issues
        // Store config in separate key
        if (validatedWorkspace.config) {
          const configSize =
            new TextEncoder().encode(JSON.stringify(validatedWorkspace.config)).length;

          // For very large configs, skip storing them entirely and rely on runtime loading
          if (configSize > 32000) {
            // Config too large for Deno KV, will be loaded from source at runtime
          } else {
            const configAtomic = this.storage.atomic();
            configAtomic.set(
              ["workspace-configs", validatedWorkspace.id],
              validatedWorkspace.config,
            );
            const configSuccess = await configAtomic.commit();
            if (!configSuccess) {
              throw new Error(`Failed to store config for workspace ${validatedWorkspace.id}`);
            }
          }
        }

        // Store workspace without embedded config, but with a reference
        workspaceToStore = {
          ...validatedWorkspace,
          config: undefined,
          metadata: {
            ...validatedWorkspace.metadata,
            configStoredSeparately: true,
          },
        };
      }
    }

    const workspaceAtomic = this.storage.atomic();
    workspaceAtomic.set(["workspaces", validatedWorkspace.id], workspaceToStore);
    const workspaceSuccess = await workspaceAtomic.commit();
    if (!workspaceSuccess) {
      throw new Error(
        `Failed to register workspace ${validatedWorkspace.id} - atomic operation failed`,
      );
    }

    // Update registry metadata in separate atomic operation
    const metadataAtomic = this.storage.atomic();
    metadataAtomic.set(["registry", "lastUpdated"], new Date().toISOString());
    const metadataSuccess = await metadataAtomic.commit();
    if (!metadataSuccess) {
      throw new Error("Failed to update registry metadata - atomic operation failed");
    }

    // Update workspace list in separate atomic operation
    const workspaceList = await this.getWorkspaceList();
    if (!workspaceList.includes(validatedWorkspace.id)) {
      const listAtomic = this.storage.atomic();
      listAtomic.set(["workspaces", "_list"], [...workspaceList, validatedWorkspace.id]);
      const listSuccess = await listAtomic.commit();
      if (!listSuccess) {
        throw new Error("Failed to update workspace list - atomic operation failed");
      }
    }
  }

  /**
   * Unregister a workspace
   */
  async unregisterWorkspace(id: string): Promise<void> {
    // Check if workspace has separately stored config
    const workspace = await this.storage.get<WorkspaceEntry>(["workspaces", id]);
    const hasSeparateConfig = workspace?.metadata?.configStoredSeparately;

    // Delete workspace in separate atomic operation
    const workspaceAtomic = this.storage.atomic();
    workspaceAtomic.delete(["workspaces", id]);
    const workspaceSuccess = await workspaceAtomic.commit();
    if (!workspaceSuccess) {
      throw new Error(`Failed to unregister workspace ${id} - atomic operation failed`);
    }

    // Delete separately stored config if it exists
    if (hasSeparateConfig) {
      const configAtomic = this.storage.atomic();
      configAtomic.delete(["workspace-configs", id]);
      await configAtomic.commit(); // Don't fail if this fails, workspace is already deleted
    }

    // Update registry metadata in separate atomic operation
    const metadataAtomic = this.storage.atomic();
    metadataAtomic.set(["registry", "lastUpdated"], new Date().toISOString());
    const metadataSuccess = await metadataAtomic.commit();
    if (!metadataSuccess) {
      throw new Error("Failed to update registry metadata - atomic operation failed");
    }

    // Update workspace list in separate atomic operation
    const workspaceList = await this.getWorkspaceList();
    const updatedList = workspaceList.filter((workspaceId) => workspaceId !== id);
    const listAtomic = this.storage.atomic();
    listAtomic.set(["workspaces", "_list"], updatedList);
    const listSuccess = await listAtomic.commit();
    if (!listSuccess) {
      throw new Error("Failed to update workspace list - atomic operation failed");
    }
  }

  /**
   * Get a workspace by ID
   */
  async getWorkspace(id: string): Promise<WorkspaceEntry | null> {
    const workspace = await this.storage.get<WorkspaceEntry>(["workspaces", id]);
    if (!workspace) return null;

    // If config is stored separately, retrieve it
    if (workspace.metadata?.configStoredSeparately) {
      const config = await this.storage.get<WorkspaceConfig>(["workspace-configs", id]);
      return {
        ...workspace,
        config: config || undefined, // Ensure config is undefined if null/empty
        metadata: {
          ...workspace.metadata,
          configStoredSeparately: undefined, // Remove the flag from returned object
        },
      };
    }

    return workspace;
  }

  /**
   * Find workspace by name
   */
  async findWorkspaceByName(name: string): Promise<WorkspaceEntry | null> {
    // Iterate through all workspaces to find by name
    // TODO: Add name index for better performance
    for await (const { value } of this.storage.list<WorkspaceEntry>(["workspaces"])) {
      if (value && value.name === name) {
        return value;
      }
    }
    return null;
  }

  /**
   * Find workspace by path
   */
  async findWorkspaceByPath(path: string): Promise<WorkspaceEntry | null> {
    // Iterate through all workspaces to find by path
    // TODO: Add path index for better performance
    for await (const { value } of this.storage.list<WorkspaceEntry>(["workspaces"])) {
      if (value && value.path === path) {
        return value;
      }
    }
    return null;
  }

  /**
   * List all registered workspaces
   */
  async listWorkspaces(): Promise<WorkspaceEntry[]> {
    const workspaces: WorkspaceEntry[] = [];

    for await (const { key, value } of this.storage.list<WorkspaceEntry>(["workspaces"])) {
      // Skip the special _list key
      if (key.length === 2 && key[1] !== "_list" && value) {
        workspaces.push(value);
      }
    }

    return workspaces;
  }

  /**
   * Get workspaces by status
   */
  async getWorkspacesByStatus(status: WorkspaceStatus): Promise<WorkspaceEntry[]> {
    const workspaces = await this.listWorkspaces();
    return workspaces.filter((workspace) => workspace.status === status);
  }

  /**
   * Update workspace status and metadata
   */
  async updateWorkspaceStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    const current = await this.getWorkspace(id);
    if (!current) {
      throw new Error(`Workspace ${id} not found`);
    }

    const updatedWorkspace = { ...current };
    updatedWorkspace.status = status;
    updatedWorkspace.lastSeen = new Date().toISOString();

    // Apply additional updates
    if (updates) {
      Object.assign(updatedWorkspace, updates);
    }

    // Update timestamps based on status
    if (status === WorkspaceStatus.RUNNING) {
      updatedWorkspace.startedAt = new Date().toISOString();
    } else if (status === WorkspaceStatus.STOPPED || status === WorkspaceStatus.CRASHED) {
      updatedWorkspace.stoppedAt = new Date().toISOString();
      updatedWorkspace.pid = undefined;
      updatedWorkspace.port = undefined;
    }

    // Validate updated workspace
    const validatedWorkspace = WorkspaceEntrySchema.parse(updatedWorkspace);

    // Atomic update with optimistic concurrency
    const atomic = this.storage.atomic();
    atomic.check(["workspaces", id], current); // Ensure no concurrent updates
    atomic.set(["workspaces", id], validatedWorkspace);
    atomic.set(["registry", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error(`Failed to update workspace ${id} status - concurrent modification detected`);
    }
  }

  /**
   * Get registry statistics
   */
  async getRegistryStats(): Promise<{
    totalWorkspaces: number;
    runningWorkspaces: number;
    stoppedWorkspaces: number;
    lastUpdated: string | null;
    version: string | null;
  }> {
    const workspaces = await this.listWorkspaces();
    const runningWorkspaces = workspaces.filter((w) => w.status === WorkspaceStatus.RUNNING).length;
    const stoppedWorkspaces = workspaces.filter((w) => w.status === WorkspaceStatus.STOPPED).length;

    const lastUpdated = await this.storage.get<string>(["registry", "lastUpdated"]);
    const version = await this.storage.get<string>(["registry", "version"]);

    return {
      totalWorkspaces: workspaces.length,
      runningWorkspaces,
      stoppedWorkspaces,
      lastUpdated,
      version,
    };
  }

  /**
   * Watch for workspace changes
   */
  async *watchWorkspaces(): AsyncIterable<WorkspaceEntry[]> {
    for await (const _events of this.storage.watch<WorkspaceEntry>(["workspaces"])) {
      // When any workspace changes, return the full list
      // TODO: Optimize to only return changed workspaces
      yield await this.listWorkspaces();
    }
  }

  /**
   * Cleanup orphaned workspaces (paths that no longer exist)
   */
  async cleanupOrphanedWorkspaces(): Promise<string[]> {
    const workspaces = await this.listWorkspaces();
    const orphanedIds: string[] = [];

    for (const workspace of workspaces) {
      try {
        // Check if workspace directory still exists
        const stat = await Deno.stat(workspace.path);
        if (!stat.isDirectory) {
          orphanedIds.push(workspace.id);
        }
      } catch {
        // Path doesn't exist
        orphanedIds.push(workspace.id);
      }
    }

    // Remove orphaned workspaces
    if (orphanedIds.length > 0) {
      const atomic = this.storage.atomic();

      for (const id of orphanedIds) {
        atomic.delete(["workspaces", id]);
      }

      // Update workspace list
      const workspaceList = await this.getWorkspaceList();
      const updatedList = workspaceList.filter((id) => !orphanedIds.includes(id));
      atomic.set(["workspaces", "_list"], updatedList);
      atomic.set(["registry", "lastUpdated"], new Date().toISOString());

      const success = await atomic.commit();
      if (!success) {
        throw new Error("Failed to cleanup orphaned workspaces - atomic operation failed");
      }
    }

    return orphanedIds;
  }

  /**
   * Get the list of workspace IDs for efficient enumeration
   */
  private async getWorkspaceList(): Promise<string[]> {
    const list = await this.storage.get<string[]>(["workspaces", "_list"]);
    return list || [];
  }

  /**
   * Close the storage adapter
   */
  async close(): Promise<void> {
    await this.storage.close();
  }

  /**
   * Get the underlying storage for advanced operations
   * Use sparingly - prefer domain-specific methods
   */
  getStorage(): KVStorage {
    return this.storage;
  }
}
