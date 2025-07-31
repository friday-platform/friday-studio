/**
 * Registry Storage Adapter
 *
 * Domain-specific storage adapter for workspace registry operations.
 * Built on top of the KVStorage interface to provide semantic workspace operations
 * while maintaining complete storage backend independence.
 */

import { type KVStorage } from "./kv-storage.ts";
import { WorkspaceEntry, WorkspaceEntrySchema, WorkspaceStatusEnum } from "@atlas/workspace";
import type { WorkspaceStatus } from "@atlas/workspace";

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

    const workspaceAtomic = this.storage.atomic();
    workspaceAtomic.set(["workspaces", validatedWorkspace.id], validatedWorkspace);
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
    // Delete workspace in separate atomic operation
    const workspaceAtomic = this.storage.atomic();
    workspaceAtomic.delete(["workspaces", id]);
    const workspaceSuccess = await workspaceAtomic.commit();
    if (!workspaceSuccess) {
      throw new Error(`Failed to unregister workspace ${id} - atomic operation failed`);
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
   * Update workspace last seen time with retry logic
   */
  async updateWorkspaceLastSeen(id: string): Promise<void> {
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const current = await this.getWorkspace(id);
        if (!current) {
          return; // Workspace doesn't exist, skip update
        }

        const updatedWorkspace = { ...current };
        updatedWorkspace.lastSeen = new Date().toISOString();

        // Validate updated workspace
        const validatedWorkspace = WorkspaceEntrySchema.parse(updatedWorkspace);

        // Use simple atomic operation without concurrency check
        // The retry logic handles any potential race conditions
        const atomic = this.storage.atomic();
        atomic.set(["workspaces", id], validatedWorkspace);

        const success = await atomic.commit();
        if (success) {
          // Success - return immediately
          return;
        }

        // Atomic commit failed - prepare for retry
        if (attempt < maxRetries - 1) {
          const backoffMs = 10 * Math.pow(2, attempt);
          console.warn(
            `Failed to update lastSeen for workspace ${id} (attempt ${
              attempt + 1
            }/${maxRetries}), retrying in ${backoffMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      } catch (error) {
        if (attempt === maxRetries - 1) {
          // Don't throw error for lastSeen updates to avoid disrupting workspace operations
          console.warn(
            `Failed to update lastSeen for workspace ${id} after ${maxRetries} attempts:`,
            error,
          );
          return;
        }
        // Wait before retry
        const backoffMs = 10 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    // If we get here, all retries failed - log warning but don't throw
    console.warn(`Failed to update lastSeen for workspace ${id} after ${maxRetries} attempts`);
  }

  /**
   * Update workspace status and metadata with retry logic
   */
  async updateWorkspaceStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
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
        if (status === WorkspaceStatusEnum.RUNNING) {
          updatedWorkspace.startedAt = new Date().toISOString();
        } else if (
          status === WorkspaceStatusEnum.STOPPED || status === WorkspaceStatusEnum.CRASHED
        ) {
          updatedWorkspace.stoppedAt = new Date().toISOString();
          updatedWorkspace.pid = undefined;
          updatedWorkspace.port = undefined;
        }

        // Validate updated workspace
        const validatedWorkspace = WorkspaceEntrySchema.parse(updatedWorkspace);

        // Use simple atomic operation without concurrency check
        // The retry logic handles any potential race conditions
        const atomic = this.storage.atomic();
        atomic.set(["workspaces", id], validatedWorkspace);
        atomic.set(["registry", "lastUpdated"], new Date().toISOString());

        const success = await atomic.commit();
        if (success) {
          // Success - return immediately
          return;
        }

        // Atomic commit failed - prepare for retry
        const error = new Error(
          `Failed to update workspace ${id} status (attempt ${
            attempt + 1
          }/${maxRetries}) - concurrent modification detected`,
        );
        lastError = error;

        // Exponential backoff: wait 10ms, 20ms, 40ms
        if (attempt < maxRetries - 1) {
          const backoffMs = 10 * Math.pow(2, attempt);
          console.warn(`${error.message}, retrying in ${backoffMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxRetries - 1) {
          throw lastError;
        }
        // Wait before retry for other types of errors too
        const backoffMs = 10 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    // If we get here, all retries failed
    throw lastError ||
      new Error(`Failed to update workspace ${id} status after ${maxRetries} attempts`);
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
    const runningWorkspaces =
      workspaces.filter((w) => w.status === WorkspaceStatusEnum.RUNNING).length;
    const stoppedWorkspaces =
      workspaces.filter((w) => w.status === WorkspaceStatusEnum.STOPPED).length;

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
