/**
 * Unified WorkspaceManager - Single source of truth for workspace lifecycle
 * Combines persistence (storage adapter) with runtime instance tracking
 * Replaces the dual WorkspaceRegistry + WorkspaceRuntimeRegistry architecture
 *
 * This implementation uses the storage adapter pattern to completely hide
 * storage implementation details behind clean domain-specific interfaces.
 */

import {
  type AtlasConfig,
  ConfigLoader,
  WorkspaceConfig,
  WorkspaceConfigSchema,
} from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { exists } from "@std/fs";
import { basename, join } from "@std/path";
import { z } from "zod/v4";
import type { IWorkspace } from "../types/core.ts";
import { logger } from "../utils/logger.ts";
import { createRegistryStorage, RegistryStorageAdapter, StorageConfigs } from "./storage/index.ts";
import { generateUniqueWorkspaceName } from "./utils/id-generator.ts";
import type { WorkspaceRuntime } from "./workspace-runtime.ts";

// Define types in the same file for better cohesion
export const WorkspaceStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "unknown",
]);

export const WorkspaceEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  configPath: z.string(),
  config: WorkspaceConfigSchema.optional(),
  configHash: z.string().optional(),
  status: WorkspaceStatusSchema,
  createdAt: z.iso.datetime(),
  lastSeen: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  stoppedAt: z.iso.datetime().optional(),
  pid: z.number().optional(),
  port: z.number().optional(),
  metadata: z.object({
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    virtual: z.boolean().optional(),
    atlasVersion: z.string().optional(),
    system: z.boolean().optional(),
    configStoredSeparately: z.boolean().optional(),
  }).optional(),
});

export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

// Export enum for convenience
export const WorkspaceStatus = {
  STOPPED: "stopped",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  CRASHED: "crashed",
  UNKNOWN: "unknown",
} as const;

// Single runtime info type that extends base entry
export interface WorkspaceRuntimeInfo {
  entry: WorkspaceEntry;
  runtime: WorkspaceRuntime;
  startedAt: Date;
}

export interface WorkspaceCreateConfig {
  name: string;
  description?: string;
  template?: string;
  config?: Record<string, unknown>;
}

// Unified workspace info type
export interface WorkspaceInfo extends WorkspaceEntry {
  isActive: boolean;
  runtime?: {
    state: string;
    startedAt: string;
    sessions: number;
    workers: number;
  };
}

/**
 * Unified WorkspaceManager - handles both persistence and runtime tracking
 *
 * This class uses the RegistryStorageAdapter to provide clean separation
 * between business logic and storage implementation details.
 */
export class WorkspaceManager {
  // Remove nullable type - registry is always required
  private registry: RegistryStorageAdapter;

  // Runtime tracking (in-memory)
  private runtimes = new Map<string, WorkspaceRuntimeInfo>();

  // Require registry in constructor
  constructor(registry: RegistryStorageAdapter) {
    this.registry = registry;
  }

  // Helper method to generate unique ID
  private async generateUniqueId(): Promise<string> {
    const existingWorkspaces = await this.registry.listWorkspaces();
    const existingIds = new Set(existingWorkspaces.map((w) => w.id));
    return generateUniqueWorkspaceName(existingIds);
  }

  // Helper method to hash configuration
  private async hashConfig(config: WorkspaceConfig): Promise<string> {
    const configJson = JSON.stringify(config, Object.keys(config).sort());
    const encoder = new TextEncoder();
    const data = encoder.encode(configJson);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Simplify initialize - no need to create default registry
  async initialize(options?: { skipAutoImport?: boolean }): Promise<void> {
    // Just handle auto-import logic
    const isTestMode = Deno.env.get("DENO_TEST") === "true";

    if (!isTestMode && !options?.skipAutoImport) {
      try {
        // Import any new workspaces
        const imported = await this.importExistingWorkspaces();
        if (imported > 0) {
          logger.info(`Imported ${imported} workspace(s) into registry`);
        }

        // NEW: Auto-discover and register atlas.yml
        const atlasConfigPath = await this.discoverAtlasConfig();
        if (atlasConfigPath) {
          await this.registerAtlasConfig(atlasConfigPath);
        }

        // Validate existing workspaces and show cache status
        await this.validateExistingWorkspaces();
      } catch (error) {
        logger.error("Failed to initialize workspace manager", { error: error.message });
        throw error;
      }
      await this.validateExistingWorkspaces();
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
    // Resolve to absolute path for consistent lookups
    const absolutePath = await Deno.realPath(workspacePath);

    // Check if already registered
    const existing = await this.registry.findWorkspaceByPath(absolutePath);
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

          await this.refreshConfig(existing.id);
        }
      } catch (error) {
        logger.warn(`Failed to check config changes for '${workspaceName}', using cached version`, {
          workspaceId: existing.id,
          error: error.message,
        });
      }

      return existing;
    }

    // Generate ID
    const id = await this.generateUniqueId();

    // Load and validate configuration
    let config: WorkspaceConfig | undefined;
    let configHash: string | undefined;
    let validationError: string | undefined;

    try {
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, absolutePath);
      const mergedConfig = await configLoader.load();

      // Use Zod validation directly
      const parseResult = WorkspaceConfigSchema.safeParse(mergedConfig.workspace);
      if (!parseResult.success) {
        // Store formatted error for logging
        validationError = z.prettifyError(parseResult.error);
      } else {
        config = parseResult.data;
        configHash = await this.hashConfig(config);
      }
    } catch (error) {
      // Simple error logging - no complex parsing
      logger.warn(`Failed to load workspace config`, {
        workspace: basename(absolutePath),
        error: error.message,
      });
    }

    // Create entry (register even if config has errors)
    const entry: WorkspaceEntry = {
      id,
      name: options?.name || config?.workspace.name || basename(absolutePath),
      path: absolutePath,
      configPath: join(absolutePath, "workspace.yml"),
      config,
      configHash,
      status: WorkspaceStatus.STOPPED,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      metadata: {
        description: options?.description || config?.workspace.description,
        tags: options?.tags,
        atlasVersion: Deno.version.deno,
      },
    };

    // Validate with schema
    const validatedEntry = WorkspaceEntrySchema.parse(entry);
    await this.registry.registerWorkspace(validatedEntry);

    // Log result
    if (validationError) {
      logger.warn(`Workspace registered with config errors: ${validatedEntry.name}`, {
        id: validatedEntry.id,
        error: validationError,
      });
    } else {
      logger.info(`Workspace registered: ${validatedEntry.name}`, {
        id: validatedEntry.id,
      });
    }

    return validatedEntry;
  }

  /**
   * Unregister a workspace from persistent storage
   */
  async unregisterWorkspace(id: string): Promise<void> {
    await this.registry.unregisterWorkspace(id);
    logger.info("Workspace unregistered", { id });
  }

  /**
   * List all persisted workspaces
   */
  async listAllPersisted(): Promise<WorkspaceEntry[]> {
    return await this.registry.listWorkspaces();
  }

  /**
   * Unified find method for workspaces
   */
  async find(query: { id?: string; name?: string; path?: string }): Promise<WorkspaceEntry | null> {
    if (query.id) {
      return await this.registry.getWorkspace(query.id);
    }
    if (query.name) {
      return await this.registry.findWorkspaceByName(query.name);
    }
    if (query.path) {
      const normalizedPath = await Deno.realPath(query.path).catch(() => query.path);
      return await this.registry.findWorkspaceByPath(normalizedPath);
    }
    return null;
  }

  // Legacy methods for backward compatibility (will deprecate)
  findById(id: string): Promise<WorkspaceEntry | null> {
    return this.find({ id });
  }

  findByName(name: string): Promise<WorkspaceEntry | null> {
    return this.find({ name });
  }

  findByPath(path: string): Promise<WorkspaceEntry | null> {
    return this.find({ path });
  }

  /**
   * Update workspace status in persistent storage
   */
  async updateWorkspaceStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    await this.registry.updateWorkspaceStatus(id, status, updates);
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
    // Check if already registered
    const existing = await this.findById(id);
    if (existing) {
      logger.info(`Virtual workspace '${id}' already registered`);
      return existing;
    }

    // Create workspace entry without embedded config for large configurations
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
      // Don't embed large configs - they will be loaded dynamically via getWorkspaceConfigBySlug
      metadata: {
        description: metadata?.description || config.workspace.description,
        system: metadata?.system || false,
        tags: metadata?.tags || [],
        virtual: true, // Flag to indicate virtual workspace
      },
    };

    // Store in registry
    await this.registry.registerWorkspace(entry);

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
  async registerRuntime(
    workspaceId: string,
    runtime: WorkspaceRuntime,
    _workspace: IWorkspace,
    _metadata?: { name?: string; description?: string },
  ): Promise<void> {
    // Get the workspace entry first
    const entry = await this.findById(workspaceId);
    if (!entry) {
      throw new Error(`Cannot register runtime for unknown workspace: ${workspaceId}`);
    }

    const info: WorkspaceRuntimeInfo = {
      entry,
      runtime,
      startedAt: new Date(),
    };

    this.runtimes.set(workspaceId, info);

    logger.info("Workspace runtime registered", {
      workspaceId,
      name: entry.name,
      status: runtime.getState(),
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
        name: info.entry.name,
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
      id: info.entry.id,
      name: info.entry.name,
      description: info.entry.metadata?.description,
      status: info.runtime.getState(),
      startedAt: info.startedAt.toISOString(),
      sessions: info.runtime.getSessions().length,
      workers: info.runtime.getWorkers().length,
    }));
  }

  /**
   * Get a specific active runtime
   */
  getRuntime(workspaceId: string): WorkspaceRuntimeInfo | undefined {
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
   * List workspaces with optional filtering
   */
  async list(filter?: { status?: WorkspaceStatus }): Promise<
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
    let workspaces = await this.listAllPersisted();

    // Apply status filter if provided
    if (filter?.status) {
      workspaces = workspaces.filter((w) => w.status === filter.status);
    }

    return workspaces.map((workspace) => ({
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

  // Legacy method for backward compatibility
  listWorkspaces(): Promise<
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
    return this.list();
  }

  /**
   * Refresh cached config for a workspace
   */
  async refreshConfig(id: string): Promise<void> {
    const workspace = await this.registry.getWorkspace(id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }

    // Virtual workspaces don't need refresh
    if (workspace.metadata?.virtual) return;

    // Load fresh config
    const adapter = new FilesystemConfigAdapter();
    const configLoader = new ConfigLoader(adapter, workspace.path);
    const mergedConfig = await configLoader.load();

    // Update entry with new config and hash
    const config = mergedConfig.workspace;
    const configHash = await this.hashConfig(config);

    await this.registry.updateWorkspaceStatus(id, workspace.status, { config, configHash });

    logger.info(`Config refreshed for workspace: ${workspace.name}`);
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
   * Get workspace information with runtime details
   */
  async getWorkspace(id: string): Promise<WorkspaceInfo | null> {
    const entry = await this.registry.getWorkspace(id);
    if (!entry) return null;

    const runtime = this.runtimes.get(id);

    return {
      ...entry,
      isActive: !!runtime,
      runtime: runtime
        ? {
          state: runtime.runtime.getState(),
          startedAt: runtime.startedAt.toISOString(),
          sessions: runtime.runtime.getSessions().length,
          workers: runtime.runtime.getWorkers().length,
        }
        : undefined,
    };
  }

  /**
   * Get workspace configuration by slug (ID or name)
   */
  async getWorkspaceConfigBySlug(workspaceSlug: string): Promise<WorkspaceConfig | null> {
    // Find workspace by ID or name
    let workspace = await this.findById(workspaceSlug);
    if (!workspace) {
      workspace = await this.findByName(workspaceSlug);
    }

    if (!workspace) {
      return null;
    }

    try {
      // Handle virtual workspaces differently
      if (workspace.metadata?.virtual) {
        // For virtual workspaces, load configuration from system workspaces module
        if (workspace.id === "atlas-conversation") {
          const { ATLAS_CONVERSATION_CONFIG } = await import("@atlas/system-workspaces");
          return ATLAS_CONVERSATION_CONFIG;
        }

        // For other virtual workspaces, try embedded config
        if (workspace.config) {
          return workspace.config;
        }

        // If no embedded config and unknown virtual workspace, return null
        logger.warn(`Virtual workspace ${workspaceSlug} has no available configuration`);
        return null;
      }

      // For regular workspaces, use ConfigLoader for consistent configuration loading
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

  // ============================================================================
  // MIGRATION & UTILITY METHODS
  // ============================================================================

  private async discoverWorkspaces(searchPath?: string): Promise<string[]> {
    const workspaces: string[] = [];
    const rootPath = searchPath || Deno.cwd();
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

  private async importExistingWorkspaces(searchPath?: string): Promise<number> {
    const discovered = await this.discoverWorkspaces(searchPath);
    let imported = 0;

    for (const workspacePath of discovered) {
      try {
        const existing = await this.find({ path: workspacePath });
        if (!existing) {
          await this.registerWorkspace(workspacePath);
          imported++;
        }
      } catch (error) {
        logger.warn("Failed to import workspace", { workspacePath, error });
      }
    }

    return imported;
  }

  /**
   * Validate existing workspaces on startup
   */
  private async validateExistingWorkspaces(): Promise<void> {
    const workspaces = await this.listAllPersisted();
    if (workspaces.length === 0) return;

    for (const workspace of workspaces) {
      // Skip virtual workspaces
      if (workspace.metadata?.virtual) continue;

      // Check if directory exists
      const exists = await Deno.stat(workspace.path).catch(() => null);
      if (!exists) {
        logger.warn(`Workspace directory not found: ${workspace.name}`);
      }
    }
  }

  /**
   * Discover atlas.yml in current directory or git root
   */
  async discoverAtlasConfig(searchPath?: string): Promise<string | null> {
    const rootPath = searchPath || Deno.env.get("ATLAS_CONFIG_PATH") || Deno.cwd();

    // Check current directory first
    const atlasYmlPath = join(rootPath, "atlas.yml");
    if (await exists(atlasYmlPath)) {
      return rootPath;
    }

    // Check git root (same logic as workspace discovery)
    try {
      const gitRoot = new Deno.Command("git", {
        args: ["rev-parse", "--show-toplevel"],
        cwd: rootPath,
      }).outputSync();

      if (gitRoot.success) {
        const gitRootPath = new TextDecoder().decode(gitRoot.stdout).trim();
        const gitAtlasPath = join(gitRootPath, "atlas.yml");
        if (await exists(gitAtlasPath)) {
          return gitRootPath;
        }
      }
    } catch {
      // Not in git repo or git command failed
    }

    return null;
  }

  /**
   * Register atlas.yml configuration in KV storage
   */
  async registerAtlasConfig(configPath?: string): Promise<void> {
    const basePath = configPath || ".";

    try {
      // Load atlas config using existing ConfigLoader
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, basePath);
      const atlasConfig = await configLoader.loadAtlasConfig();

      // Generate config hash for change detection (same pattern as workspaces)
      const configJson = JSON.stringify(atlasConfig, Object.keys(atlasConfig).sort());
      const encoder = new TextEncoder();
      const data = encoder.encode(configJson);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const configHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

      // Store in KV with special atlas key structure
      const atlasEntry = {
        id: "atlas-platform", // Hardcoded ID for global workspace
        name: atlasConfig.workspace.name, // Use name from config, same as workspace registration
        path: await Deno.realPath(basePath),
        config: atlasConfig, // Store full AtlasConfig, not just workspace portion
        configHash,
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {
          platform: true,
          atlasVersion: Deno.version.deno,
        },
      };

      // Store under ["atlas", "config"] key
      await this.registry!.getStorage().set(["atlas", "config"], atlasEntry);

      logger.info("Atlas configuration registered", {
        path: basePath,
        configHash: configHash.substring(0, 8) + "...",
      });
    } catch (error) {
      logger.error("Failed to register atlas configuration", {
        path: basePath,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get cached atlas configuration from KV storage
   */
  async getAtlasConfig(): Promise<AtlasConfig | null> {
    if (!this.registry) await this.initialize();

    const entry = await this.registry!.getStorage().get(["atlas", "config"]);
    return entry.value?.config || null;
  }

  /**
   * Refresh atlas configuration cache (check for changes and reload)
   */
  async refreshAtlasConfig(): Promise<void> {
    if (!this.registry) await this.initialize();

    const entry = await this.registry!.getStorage().get(["atlas", "config"]);
    if (!entry.value) {
      throw new Error("Atlas configuration not found in registry");
    }

    const currentEntry = entry.value;

    try {
      // Reload from filesystem
      const adapter = new FilesystemConfigAdapter();
      const configLoader = new ConfigLoader(adapter, currentEntry.path);
      const atlasConfig = await configLoader.loadAtlasConfig();

      // Generate new hash
      const configJson = JSON.stringify(atlasConfig, Object.keys(atlasConfig).sort());
      const encoder = new TextEncoder();
      const data = encoder.encode(configJson);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const newConfigHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

      if (currentEntry.configHash === newConfigHash) {
        logger.debug("Atlas config unchanged, using cached version");
        return;
      }

      // Update entry with new config and hash
      const updatedEntry = {
        ...currentEntry,
        config: atlasConfig,
        configHash: newConfigHash,
        lastSeen: new Date().toISOString(),
      };

      await this.registry!.getStorage().set(["atlas", "config"], updatedEntry);

      logger.info("Atlas config cache refreshed", {
        oldHash: currentEntry.configHash?.substring(0, 8) + "...",
        newHash: newConfigHash.substring(0, 8) + "...",
      });
    } catch (error) {
      logger.error("Failed to refresh atlas config", { error: error.message });
      throw error;
    }
  }

  /**
   * Close storage connection and cleanup
   */
  async close(): Promise<void> {
    await this.registry.close();
    this.runtimes.clear();
    logger.debug("WorkspaceManager closed");
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

// Factory function for custom storage (testing, etc.)
export function createWorkspaceManager(registry: RegistryStorageAdapter): WorkspaceManager {
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
