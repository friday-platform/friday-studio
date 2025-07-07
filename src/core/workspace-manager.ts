/**
 * Unified WorkspaceManager - Single source of truth for workspace lifecycle
 * Combines persistence (storage adapter) with runtime instance tracking
 * Replaces the dual WorkspaceRegistry + WorkspaceRuntimeRegistry architecture
 *
 * This implementation uses the storage adapter pattern to completely hide
 * storage implementation details behind clean domain-specific interfaces.
 */

import { basename, join } from "@std/path";
import { exists } from "@std/fs";
import * as yaml from "@std/yaml";
import { logger } from "../utils/logger.ts";
import { generateUniqueWorkspaceName } from "./utils/id-generator.ts";
import { ConfigLoader, WorkspaceConfig } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import type { WorkspaceRuntime } from "./workspace-runtime.ts";
import type { IWorkspace } from "../types/core.ts";
import { createRegistryStorage, RegistryStorageAdapter, StorageConfigs } from "./storage/index.ts";

// Re-export types from workspace-registry-types for unified API
export {
  type WorkspaceEntry,
  WorkspaceEntrySchema,
  WorkspaceStatus,
  type WorkspaceStatus as WorkspaceStatusType,
} from "./workspace-registry-types.ts";

import {
  type WorkspaceEntry,
  WorkspaceEntrySchema,
  WorkspaceStatus,
} from "./workspace-registry-types.ts";

export interface RuntimeWorkspaceInfo {
  id: string;
  name: string;
  description?: string;
  runtime: WorkspaceRuntime;
  status: string;
  startedAt: Date;
  sessions: number;
  workers: number;
}

export interface WorkspaceCreateConfig {
  name: string;
  description?: string;
  template?: string;
  config?: Record<string, unknown>;
}

/**
 * Unified WorkspaceManager - handles both persistence and runtime tracking
 *
 * This class uses the RegistryStorageAdapter to provide clean separation
 * between business logic and storage implementation details.
 */
export class WorkspaceManager {
  private registry: RegistryStorageAdapter | null = null;

  // Runtime tracking (in-memory)
  private runtimes = new Map<string, RuntimeWorkspaceInfo>();

  constructor(registry?: RegistryStorageAdapter) {
    this.registry = registry || null;
  }

  async initialize(options?: { skipAutoImport?: boolean }): Promise<void> {
    // Create default registry if not provided
    if (!this.registry) {
      this.registry = await createRegistryStorage(StorageConfigs.defaultKV());
    }

    // Auto-import existing workspaces unless explicitly skipped (skip in tests and signal processing)
    const isTestMode = Deno.env.get("DENO_TEST") === "true" ||
      await exists(join(Deno.env.get("HOME") || Deno.cwd(), ".atlas", ".test-mode"));

    if (!isTestMode && !options?.skipAutoImport) {
      try {
        // Import any new workspaces
        const imported = await this.importExistingWorkspaces();
        if (imported > 0) {
          logger.info(`Imported ${imported} workspace(s) into registry`);
        }

        // Validate existing workspaces and show cache status
        await this.validateExistingWorkspaces();
      } catch (error) {
        logger.warn("Failed to auto-import workspaces", { error });
      }
    }
  }

  // ============================================================================
  // PERSISTENCE LAYER (KV Storage)
  // ============================================================================

  /**
   * Register a workspace in persistent storage
   */
  async registerWorkspace(
    workspacePath: string,
    options?: {
      name?: string;
      description?: string;
      tags?: string[];
    },
  ): Promise<WorkspaceEntry> {
    if (!this.registry) await this.initialize();

    // Resolve to absolute path for consistent lookups
    const absolutePath = await Deno.realPath(workspacePath);

    // Check if already registered
    const existing = await this.registry!.findWorkspaceByPath(absolutePath);
    if (existing) {
      // Check if config has changed by comparing file hash
      const workspaceName = existing.name;

      try {
        // Calculate current config hash
        const adapter = new FilesystemConfigAdapter();
        const configLoader = new ConfigLoader(adapter, existing.path);
        const loadedConfig = await configLoader.load();
        const config = loadedConfig.workspace;

        const configJson = JSON.stringify(config, Object.keys(config).sort());
        const encoder = new TextEncoder();
        const data = encoder.encode(configJson);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const currentHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

        if (existing.configHash === currentHash) {
          logger.info(`Workspace '${workspaceName}' loaded from cache (no changes detected)`, {
            workspaceId: existing.id,
            configHash: currentHash.substring(0, 8) + "...",
          });
        } else {
          // Config has changed, refresh the cache
          logger.info(`Workspace '${workspaceName}' config changed, refreshing cache`, {
            workspaceId: existing.id,
            oldHash: existing.configHash?.substring(0, 8) + "...",
            newHash: currentHash.substring(0, 8) + "...",
          });

          await this.refreshWorkspaceConfig(existing.id);
        }
      } catch (error) {
        logger.warn(`Failed to check config changes for '${workspaceName}', using cached version`, {
          workspaceId: existing.id,
          error: error.message,
        });
      }

      return existing;
    }

    // Generate unique Docker-style ID
    const existingWorkspaces = await this.registry!.listWorkspaces();
    const existingIds = new Set(existingWorkspaces.map((w) => w.id));
    const id = generateUniqueWorkspaceName(existingIds);

    // Load and cache workspace configuration
    const configPath = join(absolutePath, "workspace.yml");

    let config: WorkspaceConfig | undefined;
    let configHash: string | undefined;

    try {
      // Load configuration using absolute path
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, absolutePath);
      const loadedConfig = await configLoader.load();

      // Cache the workspace config from merged config
      config = loadedConfig.workspace; // Extract workspace portion from MergedConfig

      // Generate config hash for change detection
      const configJson = JSON.stringify(config, Object.keys(config).sort());
      const encoder = new TextEncoder();
      const data = encoder.encode(configJson);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      configHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

      logger.debug("Workspace config loaded and cached", {
        workspaceId: id,
        configHash: configHash.substring(0, 8) + "...",
      });
    } catch (error) {
      const workspaceName = basename(absolutePath);

      // Create a compact error message for console display
      let errorSummary = error.message;

      if (error.message.includes("Configuration validation failed")) {
        // Extract the actual field error from validation messages
        const lines = error.message.split("\n");
        const errorLine = lines.find((line) => line.includes("•"));
        if (errorLine) {
          // Extract field path and error type
          const match = errorLine.match(/• ([^:]+): (.+)/);
          if (match) {
            const fieldPath = match[1];
            const errorType = match[2].split(",")[0]; // Take first part before comma
            errorSummary = `${fieldPath}: ${errorType}`;
          }
        }
      } else if (error.issues && Array.isArray(error.issues)) {
        // Handle Zod validation errors directly
        const issueCount = error.issues.length;
        const firstIssue = error.issues[0];
        const issuePath = firstIssue?.path?.join?.(".") || "root";
        const shortMessage = firstIssue?.message?.split(".")[0] || "validation error";
        errorSummary = `${issueCount} error${
          issueCount > 1 ? "s" : ""
        } (${issuePath}: ${shortMessage})`;
      } else {
        // For other errors, use the original message
        errorSummary = error.message;
      }

      logger.warn(`Failed to load workspace config for '${workspaceName}': ${errorSummary}`, {
        workspace: workspaceName,
        workspacePath: absolutePath,
        error: error.message,
        reason: error.name || "ConfigurationError",
      });

      // Log additional validation details if available
      if (error.issues && Array.isArray(error.issues)) {
        logger.debug("Workspace config validation issues", {
          workspace: workspaceName,
          issues: error.issues.map((issue: {
            path?: (string | number)[];
            message: string;
            code?: string;
          }) => ({
            path: issue.path?.join(".") || "root",
            message: issue.message,
            code: issue.code,
          })),
        });
      }

      // Continue registration without config cache - will be loaded on-demand if needed
    }

    // Create new entry
    const entry: WorkspaceEntry = {
      id,
      name: options?.name || config?.workspace.name || basename(workspacePath),
      path: absolutePath,
      configPath,
      config,
      configHash,
      status: WorkspaceStatus.STOPPED,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      metadata: {
        atlasVersion: Deno.version.deno,
        description: options?.description || config?.workspace.description,
        tags: options?.tags,
      },
    };

    // Validate entry with Zod
    const validatedEntry = WorkspaceEntrySchema.parse(entry);

    // Register using storage adapter
    await this.registry!.registerWorkspace(validatedEntry);

    // Log registration result with appropriate context
    if (config) {
      logger.info(`Workspace '${validatedEntry.name}' registered successfully`, {
        id: validatedEntry.id,
        name: validatedEntry.name,
      });
    } else {
      logger.warn(
        `Workspace '${validatedEntry.name}' registered with config errors (will load on-demand)`,
        {
          id: validatedEntry.id,
          name: validatedEntry.name,
        },
      );
    }
    return validatedEntry;
  }

  /**
   * Unregister a workspace from persistent storage
   */
  async unregisterWorkspace(id: string): Promise<void> {
    if (!this.registry) await this.initialize();

    await this.registry!.unregisterWorkspace(id);
    logger.info("Workspace unregistered", { id });
  }

  /**
   * List all persisted workspaces
   */
  async listAllPersisted(): Promise<WorkspaceEntry[]> {
    if (!this.registry) await this.initialize();
    return await this.registry!.listWorkspaces();
  }

  /**
   * Find workspace by ID in persistent storage
   */
  async findById(id: string): Promise<WorkspaceEntry | null> {
    if (!this.registry) await this.initialize();
    return await this.registry!.getWorkspace(id);
  }

  /**
   * Find workspace by name in persistent storage
   */
  async findByName(name: string): Promise<WorkspaceEntry | null> {
    if (!this.registry) await this.initialize();
    return await this.registry!.findWorkspaceByName(name);
  }

  /**
   * Find workspace by path in persistent storage
   */
  async findByPath(path: string): Promise<WorkspaceEntry | null> {
    if (!this.registry) await this.initialize();
    const normalizedPath = await Deno.realPath(path).catch(() => path);
    return await this.registry!.findWorkspaceByPath(normalizedPath);
  }

  /**
   * Update workspace status in persistent storage
   */
  async updateWorkspaceStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    if (!this.registry) await this.initialize();

    await this.registry!.updateWorkspaceStatus(id, status, updates);
    logger.debug("Workspace status updated", { id, status });
  }

  /**
   * Register a virtual workspace (no filesystem path)
   * Used for system workspaces with embedded configurations
   */
  async registerVirtualWorkspace(
    id: string,
    config: WorkspaceConfig,
    metadata?: {
      name?: string;
      description?: string;
      system?: boolean;
      tags?: string[];
    },
  ): Promise<WorkspaceEntry> {
    if (!this.registry) await this.initialize();

    // Check if already registered
    const existing = await this.findById(id);
    if (existing) {
      logger.info(`Virtual workspace '${id}' already registered`);
      return existing;
    }

    // Create workspace entry with embedded config
    const workspaceName = metadata?.name || config.workspace.name || id;

    // Generate config hash for change detection
    const configJson = JSON.stringify(config, Object.keys(config).sort());
    const encoder = new TextEncoder();
    const data = encoder.encode(configJson);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const configHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    const entry: WorkspaceEntry = {
      id,
      name: workspaceName,
      path: `virtual://${id}`, // Special path format for virtual workspaces
      configPath: `virtual://${id}/workspace.yml`,
      status: WorkspaceStatus.STOPPED,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      configHash,
      config, // Store the entire config
      metadata: {
        description: metadata?.description || config.workspace.description,
        system: metadata?.system || false,
        tags: metadata?.tags || [],
        virtual: true, // Flag to indicate virtual workspace
      },
    };

    // Store in registry
    await this.registry!.registerWorkspace(entry);

    logger.info("Virtual workspace registered", {
      id: entry.id,
      name: entry.name,
      system: entry.metadata?.system,
    });

    return entry;
  }

  /**
   * Register all system workspaces
   * Called during daemon initialization
   */
  async registerSystemWorkspaces(): Promise<void> {
    logger.info("Registering system workspaces...");

    // Import conversation workspace config
    const { ATLAS_CONVERSATION_CONFIG } = await import(
      "@atlas/system-workspaces"
    );

    await this.registerVirtualWorkspace(
      "atlas-conversation", // Fixed ID matching workspace name
      ATLAS_CONVERSATION_CONFIG,
      {
        name: "Atlas Conversation",
        description: "System workspace for Atlas conversations",
        system: true,
        tags: ["system", "conversation", "interactive"],
      },
    );

    // Future system workspaces can be added here
    // const { ATLAS_MONITORING_CONFIG } = await import("./system-workspaces/monitoring-config.ts");
    // await this.registerVirtualWorkspace("atlas-monitoring", ATLAS_MONITORING_CONFIG, {...});

    logger.info("System workspaces registered successfully");
  }

  // ============================================================================
  // RUNTIME LAYER (In-Memory Tracking)
  // ============================================================================

  /**
   * Register an active workspace runtime
   */
  registerRuntime(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    _workspace: IWorkspace,
    metadata?: { name?: string; description?: string },
  ): void {
    const info: RuntimeWorkspaceInfo = {
      id: workspaceId,
      name: metadata?.name || workspaceId,
      description: metadata?.description,
      runtime,
      status: runtime.getState(),
      startedAt: new Date(),
      sessions: runtime.getSessions().length,
      workers: runtime.getWorkers().length,
    };

    this.runtimes.set(workspaceId, info);

    logger.info("Workspace runtime registered", {
      workspaceId,
      name: info.name,
      status: info.status,
    });
  }

  /**
   * Unregister an active workspace runtime
   */
  unregisterRuntime(workspaceId: string): void {
    const info = this.runtimes.get(workspaceId);
    if (info) {
      this.runtimes.delete(workspaceId);
      logger.info("Workspace runtime unregistered", {
        workspaceId,
        name: info.name,
      });
    }
  }

  /**
   * Get all active workspace runtimes
   */
  listActiveRuntimes(): Array<{
    id: string;
    name: string;
    description?: string;
    status: string;
    startedAt: string;
    sessions: number;
    workers: number;
  }> {
    return Array.from(this.runtimes.values()).map((info) => ({
      id: info.id,
      name: info.name,
      description: info.description,
      status: info.runtime.getState(),
      startedAt: info.startedAt.toISOString(),
      sessions: info.runtime.getSessions().length,
      workers: info.runtime.getWorkers().length,
    }));
  }

  /**
   * Get a specific active runtime
   */
  getRuntime(workspaceId: string): RuntimeWorkspaceInfo | undefined {
    return this.runtimes.get(workspaceId);
  }

  /**
   * Check if a workspace runtime is active
   */
  isRuntimeActive(workspaceId: string): boolean {
    return this.runtimes.has(workspaceId);
  }

  /**
   * Get count of active runtimes
   */
  getActiveRuntimeCount(): number {
    return this.runtimes.size;
  }

  // ============================================================================
  // UNIFIED WORKSPACE OPERATIONS (Public API)
  // ============================================================================

  /**
   * List all workspaces (combines persisted + runtime info)
   */
  async listWorkspaces(): Promise<
    Array<{
      id: string;
      name: string;
      description?: string;
      status: WorkspaceStatus;
      path: string;
      hasActiveRuntime: boolean;
      createdAt: string;
      lastSeen: string;
    }>
  > {
    const persisted = await this.listAllPersisted();

    return persisted.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      description: workspace.metadata?.description,
      status: workspace.status,
      path: workspace.path,
      hasActiveRuntime: this.isRuntimeActive(workspace.id),
      createdAt: workspace.createdAt,
      lastSeen: workspace.lastSeen,
    }));
  }

  /**
   * Create a new workspace
   */
  async createWorkspace(config: WorkspaceCreateConfig): Promise<{ id: string; name: string }> {
    if (!this.registry) await this.initialize();

    // Create workspace directory
    const workspacePath = join(Deno.cwd(), config.name);
    await Deno.mkdir(workspacePath, { recursive: true });

    // Create basic workspace.yml file (no ID - it's generated during registration)
    const workspaceConfig = {
      version: "1.0.0",
      workspace: {
        name: config.name,
        description: config.description,
      },
      jobs: {},
      signals: {},
      agents: {},
      ...(config.config || {}),
    };

    const workspaceYmlPath = join(workspacePath, "workspace.yml");
    await Deno.writeTextFile(workspaceYmlPath, yaml.stringify(workspaceConfig));

    // Register in persistent storage
    const entry = await this.registerWorkspace(workspacePath, {
      name: config.name,
      description: config.description,
    });

    logger.info("Workspace created", { id: entry.id, name: entry.name, path: workspacePath });

    return {
      id: entry.id,
      name: entry.name,
    };
  }

  /**
   * Refresh cached config for a workspace
   */
  async refreshWorkspaceConfig(id: string): Promise<void> {
    if (!this.registry) await this.initialize();

    const workspace = await this.findById(id);
    if (!workspace) {
      throw new Error(`Workspace ${id} not found`);
    }

    try {
      // Load configuration using absolute path
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, workspace.path);
      const loadedConfig = await configLoader.load();

      // Cache the workspace config from merged config
      const config = loadedConfig.workspace; // Extract workspace portion from MergedConfig

      // Generate new config hash
      const configJson = JSON.stringify(config, Object.keys(config).sort());
      const encoder = new TextEncoder();
      const data = encoder.encode(configJson);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const configHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

      // Update workspace entry
      const updatedWorkspace = { ...workspace, config, configHash };

      // Update workspace in separate atomic operation
      const workspaceAtomic = this.registry!.getStorage().atomic();
      workspaceAtomic.set(["workspaces", id], updatedWorkspace);
      await workspaceAtomic.commit();

      // Update registry metadata in separate atomic operation
      const metadataAtomic = this.registry!.getStorage().atomic();
      metadataAtomic.set(["registry", "lastUpdated"], new Date().toISOString());
      await metadataAtomic.commit();

      logger.info("Workspace config cache refreshed", {
        id,
        oldHash: workspace.configHash?.substring(0, 8) + "...",
        newHash: configHash.substring(0, 8) + "...",
      });
    } catch (error) {
      logger.error("Failed to refresh workspace config", { id, error: error.message });
      throw error;
    }
  }

  /**
   * Delete a workspace (shutdown runtime + remove persistence)
   */
  async deleteWorkspace(id: string, force: boolean = false): Promise<void> {
    // Find persisted workspace
    const workspace = await this.findById(id);
    if (!workspace) {
      throw new Error(`Workspace ${id} not found`);
    }

    // Shutdown runtime if active
    const runtimeInfo = this.getRuntime(id);
    if (runtimeInfo) {
      if (!force && runtimeInfo.runtime.getState() === "running") {
        throw new Error(`Workspace ${id} is running. Use force=true to delete anyway.`);
      }

      await runtimeInfo.runtime.shutdown();
      this.unregisterRuntime(id);
    }

    // Remove from persistent storage
    await this.unregisterWorkspace(id);

    // Optionally remove workspace directory if force is true
    if (force) {
      try {
        await Deno.remove(workspace.path, { recursive: true });
        logger.info("Workspace directory removed", { id, path: workspace.path });
      } catch (error) {
        logger.warn("Failed to remove workspace directory", { id, path: workspace.path, error });
      }
    }

    logger.info("Workspace deleted", { id, name: workspace.name, force });
  }

  /**
   * Get detailed workspace information
   */
  async describeWorkspace(id: string): Promise<{
    id: string;
    name: string;
    description?: string;
    path: string;
    status: WorkspaceStatus;
    createdAt: string;
    lastSeen: string;
    hasActiveRuntime: boolean;
    config: WorkspaceConfig;
    runtime?: {
      status: string;
      startedAt: string;
      sessions: number;
      workers: number;
    };
  }> {
    const workspace = await this.findById(id);
    if (!workspace) {
      throw new Error(`Workspace ${id} not found`);
    }

    const runtimeInfo = this.getRuntime(id);

    // Get workspace configuration for MCP settings and other config
    let config;
    try {
      config = await this.getWorkspaceConfigBySlug(id);
    } catch (error) {
      logger.warn("Failed to load workspace configuration for describe", {
        workspaceId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      config = null;
    }

    return {
      id: workspace.id,
      name: workspace.name,
      description: workspace.metadata?.description,
      path: workspace.path,
      status: workspace.status,
      createdAt: workspace.createdAt,
      lastSeen: workspace.lastSeen,
      hasActiveRuntime: !!runtimeInfo,
      config,
      runtime: runtimeInfo
        ? {
          status: runtimeInfo.runtime.getState(),
          startedAt: runtimeInfo.startedAt.toISOString(),
          sessions: runtimeInfo.runtime.getSessions().length,
          workers: runtimeInfo.runtime.getWorkers().length,
        }
        : undefined,
    };
  }

  /**
   * Get workspace configuration by slug (ID or name)
   */
  async getWorkspaceConfigBySlug(workspaceSlug: string): Promise<WorkspaceConfig | null> {
    if (!this.registry) await this.initialize();

    // Find workspace by ID or name
    let workspace = await this.findById(workspaceSlug);
    if (!workspace) {
      workspace = await this.findByName(workspaceSlug);
    }

    if (!workspace) {
      return null;
    }

    try {
      // Use ConfigLoader for consistent configuration loading
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, workspace.path);
      const mergedConfig = await configLoader.load();

      // Return just the workspace portion
      return mergedConfig.workspace;
    } catch (error) {
      logger.error(`Failed to load workspace config for ${workspaceSlug}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get the current workspace (for current directory)
   */
  async getCurrentWorkspace(): Promise<WorkspaceEntry | null> {
    const cwd = Deno.cwd();
    return await this.findByPath(cwd);
  }

  /**
   * Find or register a workspace
   */
  async findOrRegisterWorkspace(
    path: string,
    options?: {
      name?: string;
      description?: string;
    },
  ): Promise<WorkspaceEntry> {
    const existing = await this.findByPath(path);
    if (existing) return existing;

    return await this.registerWorkspace(path, options);
  }

  /**
   * Get running workspaces
   */
  async getRunningWorkspaces(): Promise<WorkspaceEntry[]> {
    const all = await this.listAllPersisted();
    return all.filter((w) => w.status === WorkspaceStatus.RUNNING);
  }

  /**
   * Cleanup stale workspace entries
   */
  async cleanupWorkspaces(): Promise<number> {
    if (!this.registry) await this.initialize();

    const workspaces = await this.listAllPersisted();
    let cleaned = 0;
    const toRemove: string[] = [];

    for (const workspace of workspaces) {
      // Check if workspace directory still exists
      const exists = await Deno.stat(workspace.path).catch(() => null);

      if (!exists) {
        toRemove.push(workspace.id);
        cleaned++;
      }
    }

    // Remove non-existent workspaces
    for (const id of toRemove) {
      await this.unregisterWorkspace(id);
    }

    logger.info(`Cleaned up ${cleaned} stale workspace entries`);
    return cleaned;
  }

  /**
   * Vacuum old stopped workspaces
   */
  async vacuumWorkspaces(): Promise<void> {
    if (!this.registry) await this.initialize();

    const workspaces = await this.listAllPersisted();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30); // 30 days

    const toRemove = workspaces
      .filter((w) => {
        if (w.status === WorkspaceStatus.STOPPED && w.stoppedAt) {
          return new Date(w.stoppedAt) <= cutoff;
        }
        return false;
      })
      .map((w) => w.id);

    for (const id of toRemove) {
      await this.unregisterWorkspace(id);
    }

    logger.info(`Vacuumed ${toRemove.length} old workspace entries`);
  }

  /**
   * Watch for workspace changes (real-time updates)
   */
  watchWorkspaces(): ReadableStream<WorkspaceEntry[]> {
    if (!this.registry) throw new Error("Registry not initialized");

    // Simple polling implementation
    const stream = new ReadableStream<WorkspaceEntry[]>({
      start: async (controller) => {
        let isActive = true;

        // Send initial state
        controller.enqueue(await this.listAllPersisted());

        // Simple polling for updates
        const interval = setInterval(async () => {
          if (!isActive) {
            clearInterval(interval);
            return;
          }

          try {
            controller.enqueue(await this.listAllPersisted());
          } catch (error) {
            controller.error(error);
            isActive = false;
            clearInterval(interval);
          }
        }, 5000); // Poll every 5 seconds

        // Cleanup function
        return () => {
          isActive = false;
          clearInterval(interval);
        };
      },
    });

    return stream;
  }

  // ============================================================================
  // MIGRATION & UTILITY METHODS
  // ============================================================================

  async discoverWorkspaces(searchPath?: string): Promise<string[]> {
    const workspaces: string[] = [];
    const rootPath = searchPath || Deno.cwd();

    if (searchPath) {
      // Explicit search path
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
    } else {
      // Git root discovery
      try {
        const gitRoot = new Deno.Command("git", {
          args: ["rev-parse", "--show-toplevel"],
          cwd: rootPath,
        }).outputSync();

        if (gitRoot.success) {
          const gitRootPath = new TextDecoder().decode(gitRoot.stdout).trim();
          const commonPaths = [
            join(gitRootPath, "examples", "workspaces"),
            join(gitRootPath, "workspaces"),
            gitRootPath,
          ];

          for (const basePath of commonPaths) {
            if (await exists(basePath)) {
              await this.scanDirectory(basePath, workspaces, 3);
            }
          }
        }
      } catch {
        // Not in git repo, scan current directory
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
      }
    }

    return [...new Set(workspaces)]; // Remove duplicates
  }

  private async scanDirectory(
    path: string,
    results: string[],
    maxDepth: number,
    currentDepth: number = 0,
  ): Promise<void> {
    if (currentDepth > maxDepth) return;

    try {
      // Skip template storage directory
      if (path.includes(join("packages", "starters"))) {
        return;
      }

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

  async importExistingWorkspaces(searchPath?: string): Promise<number> {
    const discovered = await this.discoverWorkspaces(searchPath);
    let imported = 0;

    for (const workspacePath of discovered) {
      try {
        const existing = await this.findByPath(workspacePath);
        if (!existing) {
          // Try to load workspace config using ConfigLoader
          let name = basename(workspacePath);
          let description: string | undefined;

          try {
            const adapter = new FilesystemConfigAdapter();
            const configLoader = new ConfigLoader(adapter, workspacePath);
            const mergedConfig = await configLoader.load();

            // Extract name and description from validated config
            if (mergedConfig.workspace.workspace.name) {
              name = mergedConfig.workspace.workspace.name;
            }
            if (mergedConfig.workspace.workspace.description) {
              description = mergedConfig.workspace.workspace.description;
            }
          } catch {
            // Ignore parsing errors, use defaults
          }

          await this.registerWorkspace(workspacePath, { name, description });
          imported++;
        }
      } catch (error) {
        logger.warn("Failed to import workspace", { workspacePath, error });
      }
    }

    return imported;
  }

  /**
   * Validate existing workspaces and show cache status during startup
   */
  async validateExistingWorkspaces(): Promise<void> {
    const workspaces = await this.listAllPersisted();
    if (workspaces.length === 0) {
      return;
    }

    logger.info(`Validating ${workspaces.length} existing workspace(s)...`);

    for (const workspace of workspaces) {
      try {
        // Check if workspace directory still exists
        const dirExists = await Deno.stat(workspace.path).catch(() => null);
        if (!dirExists) {
          logger.warn(`Workspace '${workspace.name}' directory not found: ${workspace.path}`);
          continue;
        }

        // Check config file and cache status
        const workspaceYmlPath = join(workspace.path, "workspace.yml");
        const configExists = await Deno.stat(workspaceYmlPath).catch(() => null);
        if (!configExists) {
          logger.warn(`Workspace '${workspace.name}' missing workspace.yml file`);
          continue;
        }

        // Check if cached config is still valid
        try {
          const adapter = new FilesystemConfigAdapter();
          const configLoader = new ConfigLoader(adapter, workspace.path);
          const loadedConfig = await configLoader.load();
          const config = loadedConfig.workspace;

          // Calculate current config hash
          const configJson = JSON.stringify(config, Object.keys(config).sort());
          const encoder = new TextEncoder();
          const data = encoder.encode(configJson);
          const hashBuffer = await crypto.subtle.digest("SHA-256", data);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const currentHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

          if (workspace.configHash === currentHash) {
            logger.info(`Workspace '${workspace.name}' loaded from cache (no changes detected)`, {
              workspaceId: workspace.id,
              configHash: currentHash.substring(0, 8) + "...",
            });
          } else {
            logger.info(`Workspace '${workspace.name}' config changed since last startup`, {
              workspaceId: workspace.id,
              oldHash: workspace.configHash?.substring(0, 8) + "...",
              newHash: currentHash.substring(0, 8) + "...",
            });
          }
        } catch (error) {
          // Create compact error message for validation failures
          let compactError = error.message;

          if (error.message.includes("Configuration validation failed")) {
            // Extract the actual field error from validation messages
            const lines = error.message.split("\n");
            const errorLine = lines.find((line) => line.includes("•"));
            if (errorLine) {
              // Extract field path and error type
              const match = errorLine.match(/• ([^:]+): (.+)/);
              if (match) {
                const fieldPath = match[1];
                const errorType = match[2].split(",")[0]; // Take first part before comma
                compactError = `${fieldPath}: ${errorType}`;
              }
            }
          } else if (error.issues && Array.isArray(error.issues)) {
            // Handle Zod validation errors directly
            const issueCount = error.issues.length;
            const firstIssue = error.issues[0];
            const issuePath = firstIssue?.path?.join?.(".") || "root";
            const shortMessage = firstIssue?.message?.split(".")[0] || "validation error";
            compactError = `${issueCount} error${
              issueCount > 1 ? "s" : ""
            } (${issuePath}: ${shortMessage})`;
          } else {
            compactError = error.message;
          }

          logger.warn(`Failed to validate config for '${workspace.name}': ${compactError}`, {
            workspaceId: workspace.id,
            workspacePath: workspace.path,
          });
        }
      } catch (error) {
        logger.warn(`Failed to validate workspace '${workspace.name}': ${error.message}`, {
          workspaceId: workspace.id,
        });
      }
    }
  }

  /**
   * Close storage connection and cleanup
   */
  async close(): Promise<void> {
    if (this.registry) {
      await this.registry.close();
      this.registry = null;
    }
    this.runtimes.clear();
    logger.debug("WorkspaceManager closed");
  }
}

// Global singleton instance - lazy initialization with new storage
let _workspaceManager: WorkspaceManager | null = null;

export function getWorkspaceManager(): WorkspaceManager {
  if (!_workspaceManager) {
    // Use new storage adapter architecture
    _workspaceManager = new WorkspaceManager();
  }
  return _workspaceManager;
}

// Factory function for custom storage (testing, etc.)
export function createWorkspaceManager(registry?: RegistryStorageAdapter): WorkspaceManager {
  return new WorkspaceManager(registry);
}

// Reset singleton (useful for tests and cleanup)
export function resetWorkspaceManager(): void {
  if (_workspaceManager) {
    _workspaceManager.close().catch(() => {}); // Silent cleanup
    _workspaceManager = null;
  }
}

// Graceful shutdown handler
if (typeof Deno !== "undefined") {
  Deno.addSignalListener("SIGINT", () => {
    resetWorkspaceManager();
  });
  Deno.addSignalListener("SIGTERM", () => {
    resetWorkspaceManager();
  });
}
