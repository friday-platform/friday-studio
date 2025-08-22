/**
 * Unified WorkspaceManager - Single source of truth for workspace lifecycle
 *
 * This refactored implementation:
 * - Uses embedded system workspaces from build-time imports
 * - Removes virtual workspace complexity
 * - Uses ConfigLoader for configuration loading
 * - Removes atlas.yml special handling
 * - Provides clean separation between system and user workspaces
 */

import { ConfigLoader, MergedConfig, WorkspaceConfig } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import {
  createRegistryStorage,
  RegistryStorageAdapter,
  StorageConfigs,
} from "../../../src/core/storage/index.ts";
import { SYSTEM_WORKSPACES } from "@packages/system/workspaces";
import { exists } from "@std/fs";
import { basename, join } from "@std/path";
import { generateUniqueWorkspaceName } from "../../../src/core/utils/id-generator.ts";
import type { WorkspaceRuntime } from "../../../src/core/workspace-runtime.ts";
import { logger } from "@atlas/logger";
import { WorkspaceEntry, WorkspaceStatus } from "./types.ts";

export interface WorkspaceManagerOptions {
  autoImport?: boolean;
  registerSystemWorkspaces?: boolean;
}

/**
 * Hook function called after workspace registration
 * Receives the registered workspace entry
 * Should not throw - errors are logged but don't fail registration
 */
export type WorkspaceRegistrationHook = (entry: WorkspaceEntry) => Promise<void>;

export class WorkspaceManager {
  private registry: RegistryStorageAdapter;
  private runtimes = new Map<string, WorkspaceRuntime>();
  private registrationHooks: WorkspaceRegistrationHook[] = [];

  constructor(registry: RegistryStorageAdapter) {
    this.registry = registry;
  }

  /**
   * Add a hook to be called after workspace registration
   * Hooks are called in the order they were added
   * Hook errors are logged but don't fail the registration
   */
  public addRegistrationHook(hook: WorkspaceRegistrationHook): void {
    this.registrationHooks.push(hook);
    logger.debug("Added workspace registration hook", {
      totalHooks: this.registrationHooks.length,
    });
  }

  /**
   * Execute all registration hooks for a workspace
   * Errors are logged but don't propagate
   */
  private async executeRegistrationHooks(entry: WorkspaceEntry): Promise<void> {
    if (this.registrationHooks.length === 0) return;

    for (const [index, hook] of this.registrationHooks.entries()) {
      try {
        await hook(entry);
        logger.debug("Registration hook executed successfully", {
          hookIndex: index,
          workspaceId: entry.id,
        });
      } catch (error) {
        // Log error but continue with other hooks
        logger.error("Registration hook failed", {
          hookIndex: index,
          workspaceId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async initialize(options: WorkspaceManagerOptions = {}): Promise<void> {
    await this.registry.initialize();

    if (options.registerSystemWorkspaces !== false) {
      // System workspaces should never fail - if they do, it's a build/code issue
      await this.registerSystemWorkspaces();
    }

    if (options.autoImport !== false && !this.isTestMode()) {
      try {
        const imported = await this.importExistingWorkspaces();
        if (imported > 0) {
          logger.info(`Auto-imported ${imported} workspace(s)`);
        }
      } catch (error) {
        logger.error("Failed during workspace auto-import", {
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't throw - auto-import failure shouldn't prevent daemon startup
      }
    }
  }

  /**
   * Register a workspace from filesystem path
   */
  async registerWorkspace(
    workspacePath: string,
    metadata?: {
      name?: string;
      description?: string;
      tags?: string[];
    },
  ): Promise<WorkspaceEntry> {
    const absolutePath = await Deno.realPath(workspacePath);

    // Check if already registered
    const existing = await this.registry.findWorkspaceByPath(absolutePath);
    if (existing) {
      return existing;
    }

    // Load and validate configuration using v2
    const adapter = new FilesystemConfigAdapter(absolutePath);
    const configLoader = new ConfigLoader(adapter, absolutePath);

    let config: MergedConfig;
    let configHash: string;

    try {
      config = await configLoader.load();
      configHash = await this.hashConfig(config.workspace);
    } catch (error) {
      const errorDetails = error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error) };
      logger.error("Invalid workspace configuration", {
        path: absolutePath,
        error: errorDetails,
      });
      throw error;
    }

    const id = await this.generateUniqueId();

    const entry: WorkspaceEntry = {
      id,
      name: metadata?.name || config.workspace.workspace.name || basename(absolutePath),
      path: absolutePath,
      configPath: join(absolutePath, "workspace.yml"),
      configHash,
      status: "inactive",
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      metadata: {
        description: metadata?.description || config.workspace.workspace.description,
        tags: metadata?.tags,
        atlasVersion: Deno.version.deno,
      },
    };

    await this.registry.registerWorkspace(entry);
    logger.info(`Workspace registered: ${entry.name}`, { id: entry.id });

    // Execute post-registration hooks
    await this.executeRegistrationHooks(entry);

    return entry;
  }

  /**
   * Register all system workspaces
   */
  private async registerSystemWorkspaces(): Promise<void> {
    logger.info("Registering system workspaces...");

    for (const [id, config] of Object.entries(SYSTEM_WORKSPACES)) {
      const configHash = await this.hashConfig(config);

      const entry: WorkspaceEntry = {
        id,
        name: config.workspace.name,
        path: `system://${id}`, // Clean system prefix
        configPath: `system://${id}/workspace.yml`,
        configHash,
        status: "inactive",
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {
          description: config.workspace.description,
          system: true,
          tags: ["system"],
        },
      };

      // Check if already registered
      const existing = await this.registry.getWorkspace(id);
      if (!existing) {
        await this.registry.registerWorkspace(entry);
        logger.info(`System workspace registered: ${entry.name}`);

        // Execute post-registration hooks for system workspaces too
        await this.executeRegistrationHooks(entry);
      }
    }
  }

  /**
   * Get workspace configuration (handles system workspaces)
   */
  async getWorkspaceConfig(workspaceId: string): Promise<MergedConfig | null> {
    const workspace = await this.registry.getWorkspace(workspaceId);
    if (!workspace) return null;

    // Handle system workspaces
    if (workspace.metadata?.system && workspace.id in SYSTEM_WORKSPACES) {
      const config = SYSTEM_WORKSPACES[workspace.id];
      if (!config) {
        logger.error(`Missing configuration for system workspace: ${workspace.id}`);
        return null;
      }
      return { atlas: null, workspace: config };
    }

    // Regular workspace - load from filesystem
    try {
      const adapter = new FilesystemConfigAdapter(workspace.path);
      const configLoader = new ConfigLoader(adapter, workspace.path);
      return await configLoader.load();
    } catch (error) {
      logger.error(`Failed to load workspace config`, {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Unified find method
   */
  async find(query: {
    id?: string;
    name?: string;
    path?: string;
  }): Promise<WorkspaceEntry | null> {
    let workspace: WorkspaceEntry | null = null;

    if (query.id) {
      workspace = await this.registry.getWorkspace(query.id);
    } else if (query.name) {
      workspace = await this.registry.findWorkspaceByName(query.name);
    } else if (query.path) {
      const normalizedPath = await Deno.realPath(query.path).catch(
        () => query.path ?? "",
      );
      workspace = await this.registry.findWorkspaceByPath(normalizedPath);
    }

    // If workspace found, check runtime status
    if (workspace) {
      const runtime = this.runtimes.get(workspace.id);
      if (runtime) {
        // Runtime exists, workspace is running
        return { ...workspace, status: "running" };
      }
    }

    return workspace;
  }

  /**
   * List workspaces with optional filtering
   */
  async list(options?: {
    status?: WorkspaceStatus;
    includeSystem?: boolean;
  }): Promise<WorkspaceEntry[]> {
    let workspaces = await this.registry.listWorkspaces();

    // Update workspace status based on active runtimes
    workspaces = workspaces.map((workspace) => {
      const runtime = this.runtimes.get(workspace.id);
      if (runtime) {
        // Runtime exists, workspace is running
        return { ...workspace, status: "running" as WorkspaceStatus };
      }
      return workspace;
    });

    if (options?.status) {
      workspaces = workspaces.filter((w) => w.status === options.status);
    }

    // By default, exclude system workspaces unless explicitly requested
    if (options?.includeSystem !== true) {
      workspaces = workspaces.filter((w) => !w.metadata?.system);
    }

    return workspaces;
  }

  /**
   * Delete a workspace
   */
  async deleteWorkspace(
    id: string,
    options?: {
      force?: boolean;
      removeDirectory?: boolean;
    },
  ): Promise<void> {
    const workspace = await this.registry.getWorkspace(id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }

    // Prevent deletion of system workspaces
    if (workspace.metadata?.system && !options?.force) {
      throw new Error(
        `Cannot delete system workspace '${id}'. Use force=true to override.`,
      );
    }

    // Stop runtime if active
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await runtime.shutdown();
      this.runtimes.delete(id);
    }

    // Remove from registry
    await this.registry.unregisterWorkspace(id);

    // Optionally remove directory
    if (options?.removeDirectory && !workspace.path.startsWith("system://")) {
      try {
        await Deno.remove(workspace.path, { recursive: true });
        logger.info("Workspace directory removed", {
          id,
          path: workspace.path,
        });
      } catch (error) {
        logger.warn("Failed to remove workspace directory", {
          id,
          path: workspace.path,
          error,
        });
      }
    }

    logger.info("Workspace deleted", { id, name: workspace.name });
  }

  /**
   * Register an active runtime
   */
  async registerRuntime(workspaceId: string, runtime: WorkspaceRuntime): Promise<void> {
    this.runtimes.set(workspaceId, runtime);
    logger.info("Runtime registered", { workspaceId });

    // Update workspace status to running in registry
    try {
      await this.registry.updateWorkspaceStatus(workspaceId, "running");
      logger.info("Workspace status updated to running", { workspaceId });
    } catch (error) {
      logger.error("Failed to update workspace status", { workspaceId, error });
    }
  }

  /**
   * Unregister a runtime
   */
  async unregisterRuntime(workspaceId: string): Promise<void> {
    if (this.runtimes.delete(workspaceId)) {
      logger.info("Runtime unregistered", { workspaceId });

      // Update workspace status to stopped in registry
      try {
        await this.registry.updateWorkspaceStatus(workspaceId, "stopped");
        logger.info("Workspace status updated to stopped", { workspaceId });
      } catch (error) {
        logger.error("Failed to update workspace status", { workspaceId, error });
      }
    }
  }

  /**
   * Get active runtime
   */
  getRuntime(workspaceId: string): WorkspaceRuntime | undefined {
    return this.runtimes.get(workspaceId);
  }

  /**
   * Get active runtime count
   */
  getActiveRuntimeCount(): number {
    return this.runtimes.size;
  }

  /**
   * Update workspace last seen timestamp
   */
  async updateWorkspaceLastSeen(workspaceId: string): Promise<void> {
    await this.registry.updateWorkspaceLastSeen(workspaceId);
  }

  /**
   * Update workspace status
   */
  async updateWorkspaceStatus(
    workspaceId: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    await this.registry.updateWorkspaceStatus(workspaceId, status, updates);
  }

  // Private helper methods
  private async generateUniqueId(): Promise<string> {
    const existingWorkspaces = await this.registry.listWorkspaces();
    const existingIds = new Set(existingWorkspaces.map((w) => w.id));
    return generateUniqueWorkspaceName(existingIds);
  }

  private async hashConfig(config: WorkspaceConfig): Promise<string> {
    const configJson = JSON.stringify(config, Object.keys(config).sort());
    const encoder = new TextEncoder();
    const data = encoder.encode(configJson);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  private isTestMode(): boolean {
    return Deno.env.get("DENO_TEST") === "true";
  }

  private async importExistingWorkspaces(): Promise<number> {
    const workspaces: string[] = [];
    const rootPath = Deno.cwd();
    const commonPaths = [
      join(rootPath, "examples", "workspaces"),
      join(rootPath, "workspaces"),
      rootPath,
    ];

    for (const basePath of commonPaths) {
      if (await exists(basePath)) {
        await this.scanDirectory(basePath, workspaces, 3);
      }
    }

    const discovered = [...new Set(workspaces)]; // Remove duplicates
    let imported = 0;
    let skipped = 0;

    for (const workspacePath of discovered) {
      const existing = await this.find({ path: workspacePath });
      if (!existing) {
        try {
          await this.registerWorkspace(workspacePath);
          imported++;
        } catch (error) {
          skipped++;
          logger.warn("Skipping invalid workspace during auto-import", {
            path: workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (skipped > 0) {
      logger.info(
        `Auto-import completed: ${imported} imported, ${skipped} skipped due to invalid configuration`,
      );
    }

    return imported;
  }

  private async scanDirectory(
    path: string,
    results: string[],
    maxDepth: number,
    currentDepth: number = 0,
  ): Promise<void> {
    if (currentDepth > maxDepth) return;

    try {
      // Check if this directory has workspace.yml
      const workspaceYmlPath = join(path, "workspace.yml");
      if (await exists(workspaceYmlPath)) {
        results.push(path);
        return; // Don't scan subdirectories of a workspace
      }

      // Skip common non-workspace directories
      const skipDirs = new Set([
        ".git",
        "node_modules",
        ".atlas",
        "dist",
        "build",
        ".next",
        "target",
      ]);
      // Scan subdirectories
      for await (const entry of Deno.readDir(path)) {
        if (entry.isDirectory && !skipDirs.has(entry.name)) {
          await this.scanDirectory(join(path, entry.name), results, maxDepth, currentDepth + 1);
        }
      }
    } catch {
      // Ignore directories we can't read
    }
  }

  async close(): Promise<void> {
    // Shutdown all active workspace runtimes before clearing the map
    const shutdownPromises = Array.from(this.runtimes.values()).map(async (runtime) => {
      try {
        await runtime.shutdown();
      } catch (error) {
        // Log error but don't throw - continue with other cleanup
        logger.error("Error shutting down workspace runtime", { error });
      }
    });

    await Promise.all(shutdownPromises);
    this.runtimes.clear();
    await this.registry.close();
  }
}

// Global singleton instance - lazy initialization with new storage
let _workspaceManager: WorkspaceManager | null = null;

export async function getWorkspaceManager(): Promise<WorkspaceManager> {
  if (!_workspaceManager) {
    // Create default registry adapter
    const registry = await createRegistryStorage(StorageConfigs.defaultKV());
    _workspaceManager = new WorkspaceManager(registry);
  }
  return _workspaceManager;
}
