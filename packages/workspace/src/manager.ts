/**
 * WorkspaceManager: single source of truth for workspace lifecycle/state.
 *
 * - System workspaces are embedded at build time
 * - No virtual workspaces or atlas.yml special cases
 * - Separation of system vs user workspaces is explicit
 */

import { existsSync, readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { env } from "node:process";
import { ConfigLoader, ConfigNotFoundError, type MergedConfig } from "@atlas/config";
import { logger } from "@atlas/logger";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { SYSTEM_WORKSPACES } from "@atlas/system/workspaces";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { parse as parseDotenv } from "@std/dotenv";
import { basename, dirname, join } from "@std/path";
import {
  createRegistryStorage,
  type RegistryStorageAdapter,
  StorageConfigs,
} from "../../../src/core/storage/index.ts";
import { generateUniqueWorkspaceName } from "../../../src/core/utils/id-generator.ts";
import type { WorkspaceRuntime } from "../../../src/core/workspace-runtime.ts";
import type { WorkspaceEntry, WorkspaceSignalRegistrar, WorkspaceStatus } from "./types.ts";
import { WorkspaceConfigWatcher } from "./watchers/index.ts";

/** Called when a runtime needs to be destroyed (config changed, workspace deleted) */
export type RuntimeInvalidateCallback = (workspaceId: string) => Promise<void>;

/**
 * Validates that all "auto" environment variables required by MCP servers are available.
 * Checks both system environment and workspace .env file.
 * Throws if any required env vars are missing.
 *
 * @internal Exported for testing
 */
export function validateMCPEnvironmentForWorkspace(
  config: MergedConfig,
  workspacePath: string,
): void {
  const mcpServers = config.workspace.tools?.mcp?.servers;
  if (!mcpServers) return;

  // Load workspace .env file if it exists
  const workspaceEnvPath = join(workspacePath, ".env");
  let workspaceEnv: Record<string, string> = {};
  if (existsSync(workspaceEnvPath)) {
    try {
      const envContent = readFileSync(workspaceEnvPath, "utf-8");
      workspaceEnv = parseDotenv(envContent);
    } catch (error) {
      logger.debug("Could not parse workspace .env file", { workspacePath, error });
    }
  }

  // Collect all missing "auto" env vars
  const missingVars: Array<{ serverId: string; varName: string }> = [];

  for (const [serverId, serverConfig] of Object.entries(mcpServers)) {
    if (!serverConfig.env) continue;

    for (const [key, value] of Object.entries(serverConfig.env)) {
      if (value === "auto" || value === "from_environment") {
        // Check system env (includes ~/.atlas/.env loaded by daemon)
        const systemValue = env[key];
        // Check workspace .env
        const workspaceValue = workspaceEnv[key];

        if (!systemValue && !workspaceValue) {
          missingVars.push({ serverId, varName: key });
        }
      }
    }

    // Also check auth config
    if (serverConfig.auth?.token_env) {
      const tokenEnv = serverConfig.auth.token_env;

      // Skip if env config has any entry for token_env:
      // - Link refs are resolved at runtime
      // - Literal strings provide the value directly
      // - "auto"/"from_environment" are already validated in the loop above
      if (serverConfig.env?.[tokenEnv] !== undefined) {
        continue;
      }

      const systemValue = env[tokenEnv];
      const workspaceValue = workspaceEnv[tokenEnv];

      if (!systemValue && !workspaceValue) {
        missingVars.push({ serverId, varName: tokenEnv });
      }
    }
  }

  if (missingVars.length > 0) {
    const formatted = missingVars
      .map((m) => `  - ${m.varName} (required by MCP server '${m.serverId}')`)
      .join("\n");

    const workspaceEnvHint = existsSync(workspaceEnvPath)
      ? `workspace .env (${workspaceEnvPath})`
      : `workspace .env (create ${workspaceEnvPath})`;

    throw new Error(
      `Cannot add workspace: missing required environment variables:\n${formatted}\n\n` +
        `Set these in:\n` +
        `  - ${workspaceEnvHint}\n` +
        `  - ~/.atlas/.env\n` +
        `  - System environment`,
    );
  }
}

export class WorkspaceManager {
  private registry: RegistryStorageAdapter;
  private runtimes = new Map<string, WorkspaceRuntime>();
  private signalRegistrars: WorkspaceSignalRegistrar[] = [];
  private fileWatcher: WorkspaceConfigWatcher | null = null;
  private onRuntimeInvalidate?: RuntimeInvalidateCallback;

  constructor(registry: RegistryStorageAdapter) {
    this.registry = registry;
  }

  /** Set callback for when runtime needs invalidation. Called by AtlasDaemon. */
  setRuntimeInvalidateCallback(cb: RuntimeInvalidateCallback): void {
    this.onRuntimeInvalidate = cb;
  }

  /**
   * Initialize registry and observers.
   *
   * - Registers system workspaces (idempotent)
   * - Auto-imports user workspaces from common roots; failures never block startup
   * - Registers existing user workspaces with signal registrars
   * - Starts config file watching for user workspaces
   */
  async initialize(signalRegistrars: WorkspaceSignalRegistrar[]): Promise<void> {
    await this.registry.initialize();

    this.signalRegistrars = signalRegistrars;

    this.fileWatcher = new WorkspaceConfigWatcher({
      onConfigChange: async (
        workspaceId: string,
        change: { filePath: string } | { oldPath: string; newPath?: string },
      ) => {
        await this.handleWatcherChange(workspaceId, change);
      },
      debounceMs: 1000,
    });

    // System workspaces should never fail - if they do, it's a build/code issue
    await this.registerSystemWorkspaces();

    // Watch existing non-system workspaces
    try {
      const existingNonSystem = (await this.list({ includeSystem: false })) || [];
      for (const workspace of existingNonSystem) {
        const cfg = await this.getWorkspaceConfig(workspace.id);
        if (!cfg) {
          logger.warn("Workspace config not found", { workspaceId: workspace.id });
          continue;
        }
        // Only register signals for persistent workspaces
        const isEphemeral =
          Boolean(workspace.metadata?.ephemeral) ||
          workspace.configPath.endsWith("eph_workspace.yml");
        if (!isEphemeral) {
          await this.registerWithRegistrars(workspace.id, workspace.path, cfg);
        }
        await this.fileWatcher?.watchWorkspace(workspace);
      }
    } catch (error) {
      logger.error("Failed to register existing workspaces", { error: error });
    }

    if (!this.isTestMode()) {
      try {
        const imported = await this.importExistingWorkspaces();
        if (imported > 0) {
          logger.info(`Auto-imported ${imported} workspace(s)`);
        }
      } catch (error) {
        logger.error("Failed during workspace auto-import", { error: error });
        // Don't throw - auto-import failure shouldn't prevent daemon startup
      }
    }
  }

  /**
   * Register workspace by filesystem path.
   *
   * Validates config via ConfigLoader. On first registration, attaches watcher and
   * registers signals (non-system only). Returns the entry and whether it was created.
   */
  async registerWorkspace(
    workspacePath: string,
    metadata?: { name?: string; description?: string; tags?: string[] },
  ): Promise<{ workspace: WorkspaceEntry; created: boolean }> {
    const absolutePath = await Deno.realPath(workspacePath);

    // Check if already registered
    const existing = await this.registry.findWorkspaceByPath(absolutePath);
    if (existing) {
      return { workspace: existing, created: false };
    }

    // Load and validate configuration using v2
    const adapter = new FilesystemConfigAdapter(absolutePath);
    const configLoader = new ConfigLoader(adapter, absolutePath);

    let config: MergedConfig;

    try {
      config = await configLoader.load();
    } catch (error) {
      logger.error("Invalid workspace configuration", { path: absolutePath, error });
      throw error;
    }

    // Validate that all "auto" env vars are available before allowing registration
    validateMCPEnvironmentForWorkspace(config, absolutePath);

    // Determine config filename and ephemeral status
    const persistentPath = join(absolutePath, "workspace.yml");
    const ephemeralPath = join(absolutePath, "eph_workspace.yml");
    const hasPersistent = existsSync(persistentPath);
    const hasEphemeral = existsSync(ephemeralPath);
    const isEphemeral = !hasPersistent && hasEphemeral;
    const configPath = hasPersistent
      ? persistentPath
      : hasEphemeral
        ? ephemeralPath
        : join(absolutePath, "workspace.yml");

    const id = await this.generateUniqueId();

    const entry: WorkspaceEntry = {
      id,
      name: metadata?.name || config.workspace.workspace.name || basename(absolutePath),
      path: absolutePath,
      configPath,
      status: "inactive",
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      metadata: {
        description: metadata?.description || config.workspace.workspace.description,
        tags: metadata?.tags,
        atlasVersion: Deno.version.deno,
        ephemeral: isEphemeral,
        expiresAt: isEphemeral
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          : undefined,
      },
    };

    await this.registry.registerWorkspace(entry);
    logger.info(`Workspace registered: ${entry.name}`, { id: entry.id });

    // Register signals for persistent workspaces (including system workspaces)
    if (!entry.metadata?.ephemeral) {
      try {
        await this.registerWithRegistrars(entry.id, entry.path, config);
      } catch (error) {
        logger.warn("Failed to register workspace signals", {
          workspaceId: entry.id,
          error: error,
        });
      }
    }

    // Attach file watcher for non-system workspaces only
    if (this.fileWatcher && !entry.metadata?.system) {
      try {
        await this.fileWatcher.watchWorkspace(entry);
      } catch (error) {
        logger.warn("Failed to watch workspace", { workspaceId: entry.id, error: error });
      }
    }

    return { workspace: entry, created: true };
  }

  /** Register embedded system workspaces in the registry (idempotent). */
  private async registerSystemWorkspaces(): Promise<void> {
    logger.info("Registering system workspaces...");

    for (const [id, config] of Object.entries(SYSTEM_WORKSPACES)) {
      const entry: WorkspaceEntry = {
        id,
        name: config.workspace.name,
        path: `system://${id}`, // Clean system prefix
        configPath: `system://${id}/workspace.yml`,
        status: "inactive",
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: { description: config.workspace.description, system: true, tags: ["system"] },
      };

      // Check if already registered
      const existing = await this.registry.getWorkspace(id);
      if (!existing) {
        await this.registry.registerWorkspace(entry);
        logger.info(`System workspace registered: ${entry.name}`);
      }

      // Register with signal registrars (system workspaces can have signals!)
      try {
        const mergedConfig = await this.getWorkspaceConfig(id);
        if (mergedConfig) {
          await this.registerWithRegistrars(id, entry.path, mergedConfig);
        }
      } catch (error) {
        logger.warn("Failed to register system workspace signals", { workspaceId: id, error });
      }
    }
  }

  /** Return workspace config; use embedded config for system workspaces. */
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
      // Missing config is expected (deleted workspace, moved directory) - log at warn level
      // Other errors (validation, IO) are unexpected - log at error level
      if (error instanceof ConfigNotFoundError) {
        logger.warn("Workspace config not found", { workspaceId, path: workspace.path });
      } else {
        logger.error("Failed to load workspace config", { workspaceId, error });
      }
      return null;
    }
  }

  /** Find by id/name/path; reflect running status if a runtime is registered. */
  async find(query: { id?: string; name?: string; path?: string }): Promise<WorkspaceEntry | null> {
    let workspace: WorkspaceEntry | null = null;

    if (query.id) {
      workspace = await this.registry.getWorkspace(query.id);
    } else if (query.name) {
      workspace = await this.registry.findWorkspaceByName(query.name);
    } else if (query.path) {
      const normalizedPath = await Deno.realPath(query.path).catch(() => query.path ?? "");
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

  /** List workspaces; filter by status; exclude system by default. */
  async list(options?: {
    status?: WorkspaceStatus;
    includeSystem?: boolean;
  }): Promise<WorkspaceEntry[]> {
    let workspaces = await this.registry.listWorkspaces();

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
   * Delete workspace entry.
   *
   * Blocks deletion of system workspaces unless force. Unregisters signals, shuts down
   * runtime, stops watcher, optionally removes directory.
   */
  async deleteWorkspace(
    id: string,
    options?: { force?: boolean; removeDirectory?: boolean },
  ): Promise<void> {
    const workspace = await this.registry.getWorkspace(id);
    if (!workspace) {
      logger.info("Workspace already deleted", { id });
      return;
    }

    // Prevent deletion of system workspaces
    if (workspace.metadata?.system && !options?.force) {
      throw new Error(`Cannot delete system workspace '${id}'. Use force=true to override.`);
    }

    // Unregister from signal registrars first
    await this.unregisterWithRegistrars(id);
    // Stop runtime if active
    const runtime = this.runtimes.get(id);
    if (runtime) {
      await runtime.shutdown();
      this.runtimes.delete(id);
    }

    // Remove from registry
    await this.registry.unregisterWorkspace(id);

    // Ensure we stop file watching for this workspace (idempotent)
    try {
      this.fileWatcher?.unwatchWorkspace(id);
    } catch (error) {
      logger.debug("Error stopping watcher during workspace deletion", { id, error });
    }

    // Optionally remove directory
    if (options?.removeDirectory && !workspace.path.startsWith("system://")) {
      try {
        await rm(workspace.path, { recursive: true });
        logger.info("Workspace directory removed", { id, path: workspace.path });
      } catch (error) {
        logger.warn("Failed to remove workspace directory", { id, path: workspace.path, error });
      }
    }

    logger.info("Workspace deleted", { id, name: workspace.name });
  }

  /** Register active runtime and persist status=running. */
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

  /** Unregister runtime and persist status=stopped. */
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

  // Update last-seen timestamp in registry
  async updateWorkspaceLastSeen(workspaceId: string): Promise<void> {
    await this.registry.updateWorkspaceLastSeen(workspaceId);
  }

  // Update status and optional partial entry fields in registry
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

  private isTestMode(): boolean {
    return env.DENO_TEST === "true";
  }

  /**
   * Auto-import user workspaces from ~/.atlas/workspaces.
   *
   * Searches a small depth for directories containing workspace.yml, de-dupes, validates
   * configs, logs and skips invalid ones. Never throws; returns import count.
   */
  private async importExistingWorkspaces(): Promise<number> {
    const workspaces: string[] = [];
    const atlasWorkspacesDir = join(getAtlasHome(), "workspaces");
    const commonPaths = [atlasWorkspacesDir];

    for (const basePath of commonPaths) {
      if (existsSync(basePath)) {
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
          // Ephemeral expiration pre-check and cleanup
          if (await this.cleanupExpiredEphemeralConfig(workspacePath)) {
            continue;
          }
          await this.registerWorkspace(workspacePath);
          imported++;
        } catch (error) {
          skipped++;
          logger.warn("Skipping invalid workspace during auto-import", {
            path: workspacePath,
            error: error,
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

  /**
   * Check for expired eph_workspace.yml and remove it if past TTL.
   * Returns true if the workspace should be skipped from import (expired), false otherwise.
   */
  private async cleanupExpiredEphemeralConfig(workspacePath: string): Promise<boolean> {
    const ephPath = join(workspacePath, "eph_workspace.yml");
    if (!existsSync(ephPath)) return false;
    try {
      const info = await stat(ephPath);
      const mtime = info.mtime ?? new Date();
      const ageMs = Date.now() - mtime.getTime();
      const ttlMs = 30 * 24 * 60 * 60 * 1000;
      if (ageMs > ttlMs) {
        logger.info("Skipping expired ephemeral workspace during auto-import", {
          path: workspacePath,
        });
        try {
          await rm(ephPath);
          logger.info("Removed expired eph_workspace.yml", { path: ephPath });
        } catch (removeError) {
          logger.warn("Failed to remove expired eph_workspace.yml", {
            path: ephPath,
            error: removeError,
          });
        }
        return true;
      }
    } catch (error) {
      logger.debug("auto-import: failed to stat eph_workspace.yml; treating as non-expired", {
        path: ephPath,
        error,
      });
    }
    return false;
  }

  /**
   * Collect directories containing workspace.yml up to maxDepth.
   *
   * Skips common non-workspace dirs. Does not recurse into a directory once identified
   * as a workspace.
   */
  private async scanDirectory(
    path: string,
    results: string[],
    maxDepth: number,
    currentDepth: number = 0,
  ): Promise<void> {
    if (currentDepth > maxDepth) return;

    try {
      // Check if this directory has workspace.yml or eph_workspace.yml
      const workspaceYmlPath = join(path, "workspace.yml");
      const ephWorkspaceYmlPath = join(path, "eph_workspace.yml");
      if (existsSync(workspaceYmlPath)) {
        results.push(path);
        return; // Don't scan subdirectories of a workspace
      }
      if (existsSync(ephWorkspaceYmlPath)) {
        results.push(path);
        return; // Treat as workspace root as well
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
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !skipDirs.has(entry.name)) {
          await this.scanDirectory(join(path, entry.name), results, maxDepth, currentDepth + 1);
        }
      }
    } catch (error) {
      logger.debug("scanDirectory: unable to read path; skipping", { path, error });
    }
  }

  /**
   * Gracefully shut down manager.
   *
   * Unregisters signals, shuts down runtimes, stops watcher, shuts down registrars,
   * then closes the registry. Best-effort: logs errors and continues.
   */
  async close(): Promise<void> {
    // Unregister all signals via registrars for all known workspaces
    try {
      const all = await this.list({ includeSystem: false });
      for (const ws of all) {
        await this.unregisterWithRegistrars(ws.id);
      }
    } catch (error) {
      logger.debug("Error unregistering workspace signals during manager close", { error });
    }

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

    // Stop file watcher if present
    if (this.fileWatcher) {
      try {
        this.fileWatcher.stop();
      } catch (error) {
        logger.debug("Error stopping workspace config watcher", { error });
      }
      this.fileWatcher = null;
    }

    // Gracefully shutdown signal registrars
    if (this.signalRegistrars.length > 0) {
      for (const registrar of this.signalRegistrars) {
        try {
          await registrar.shutdown?.();
        } catch (error) {
          logger.debug("Error shutting down signal registrar in manager close", { error });
        }
      }
      this.signalRegistrars = [];
    }

    // Close registry last
    await this.registry.close();
  }

  /** Register workspace with all signal registrars (best-effort). */
  private async registerWithRegistrars(
    workspaceId: string,
    workspacePath: string,
    config: MergedConfig,
  ): Promise<void> {
    if (this.signalRegistrars.length === 0) return;
    for (const registrar of this.signalRegistrars) {
      try {
        await registrar.registerWorkspace(workspaceId, workspacePath, config);
      } catch (error) {
        logger.error("Signal registrar registerWorkspace failed", {
          workspaceId,
          workspacePath,
          error: error,
        });
      }
    }
  }

  /** Unregister workspace from all signal registrars (best-effort). */
  private async unregisterWithRegistrars(workspaceId: string): Promise<void> {
    if (this.signalRegistrars.length === 0) return;
    for (const registrar of this.signalRegistrars) {
      try {
        await registrar.unregisterWorkspace(workspaceId);
      } catch (error) {
        logger.error("Signal registrar unregisterWorkspace failed", { workspaceId, error: error });
      }
    }
  }

  /**
   * React to workspace config change.
   *
   * If config is missing, delete the workspace entry. If invalid, mark inactive and
   * record error metadata. Otherwise, stop runtime, restart signals, and mark inactive
   * (ready state; runtime is started elsewhere).
   */
  async handleWorkspaceConfigChange(workspace: WorkspaceEntry, filePath: string): Promise<void> {
    logger.info("Handling workspace configuration change", {
      workspaceId: workspace.id,
      filePath,
      workspacePath: workspace.path,
    });

    const changeType = await this.determineChangeType(workspace);
    if (changeType === "deleted") {
      await this.unregisterWorkspaceStates(workspace.id, workspace);
      return;
    }

    const validation = await this.validateWorkspaceConfig(workspace);
    if (!validation.ok) {
      await this.markWorkspaceInactive(workspace.id, {
        ...workspace.metadata,
        lastError: validation.error.message,
        lastErrorAt: new Date().toISOString(),
      });
      return;
    }

    await this.stopRuntimeIfActive(workspace.id);
    await this.restartSignalsForWorkspace(workspace.id, workspace.path, validation.config);
    await this.markWorkspaceInactive(workspace.id);
  }

  /**
   * Entry point for watcher events that include renames.
   *
   * For plain file changes, delegate to config-change handler. For renames, adopt
   * new path if it exists and is valid; otherwise, delete the workspace entry.
   */
  private async handleWatcherChange(
    workspaceId: string,
    change: { filePath: string } | { oldPath: string; newPath?: string },
  ): Promise<void> {
    logger.debug("workspace watcher change received", { workspaceId, change });

    const workspace = await this.find({ id: workspaceId });
    if (!workspace) {
      logger.warn("Change for unknown workspace", { workspaceId });
      return;
    }

    if ("filePath" in change) {
      logger.debug("processing filePath change", { workspaceId, filePath: change.filePath });
      await this.handleWorkspaceConfigChange(workspace, change.filePath);
      return;
    }

    // Rename branch: attempt to adopt newPath if valid; otherwise process deletion
    const { oldPath, newPath } = change;
    logger.debug("processing rename change", { workspaceId, oldPath, newPath });

    // If no newPath or the newPath doesn't exist, treat as missing config
    if (!newPath || !existsSync(newPath)) {
      logger.debug("rename with missing or nonexistent newPath; handling as missing config", {
        workspaceId,
        oldPath,
        newPath,
      });
      await this.unregisterWorkspaceStates(workspaceId, workspace);
      return;
    }
    await this.adoptRenamedWorkspace(workspaceId, workspace, newPath);
  }

  /**
   * Adopt a renamed config path.
   *
   * Validates new config first, then: stop runtime, atomically update registry paths,
   * restart signals, reattach watcher, and mark inactive. On failure, delete entry.
   */
  private async adoptRenamedWorkspace(
    workspaceId: string,
    workspace: WorkspaceEntry,
    newPath: string,
  ): Promise<void> {
    const newWorkspaceDir = dirname(newPath);

    try {
      this.fileWatcher?.unwatchWorkspace(workspaceId);
    } catch (error) {
      logger.debug("Error unwatching before rename reattach", { workspaceId, error });
    }

    try {
      // Validate the new config before adopting and keep it to pass to registrars
      const adapter = new FilesystemConfigAdapter(newWorkspaceDir);
      const loader = new ConfigLoader(adapter, newWorkspaceDir);
      const config = await loader.load();

      // Stop runtime if active
      await this.stopRuntimeIfActive(workspaceId);

      // Update registry status and paths atomically via updateWorkspaceStatus with partial updates
      const becameEphemeral = newPath.endsWith("eph_workspace.yml");
      const updatedMetadata = {
        ...workspace.metadata,
        ephemeral: becameEphemeral,
        expiresAt: becameEphemeral
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          : undefined,
      };
      await this.registry.updateWorkspaceStatus(workspaceId, workspace.status, {
        path: newWorkspaceDir,
        configPath: newPath,
        metadata: updatedMetadata,
      });

      logger.debug("workspace registry updated for rename", {
        workspaceId,
        newWorkspaceDir,
        newPath,
      });

      // Rewire signals to the new path with validated config (skip for ephemeral)
      if (!becameEphemeral) {
        await this.restartSignalsForWorkspace(workspaceId, newWorkspaceDir, config);
      } else {
        try {
          await this.unregisterWithRegistrars(workspaceId);
        } catch (err) {
          logger.debug("Error unregistering signals after becoming ephemeral", {
            workspaceId,
            err,
          });
        }
      }

      if (this.fileWatcher) {
        const updated = { ...workspace, path: newWorkspaceDir, configPath: newPath };
        logger.debug("reattaching workspace config watcher after rename", {
          workspaceId,
          configPath: updated.configPath,
        });
        await this.fileWatcher.watchWorkspace(updated);
      }

      // Mark workspace inactive (ready state) after adoption
      await this.markWorkspaceInactive(workspaceId);
    } catch (error) {
      logger.error("Failed to adopt renamed workspace config; deleting entry", {
        workspaceId,
        oldPath: workspace.configPath,
        newPath,
        error: error,
      });
      await this.deleteWorkspace(workspaceId, { removeDirectory: false });
    }
  }

  private determineChangeType(workspace: WorkspaceEntry): "deleted" | "updated" {
    const dirExists = existsSync(workspace.path);
    const cfgExists = existsSync(workspace.configPath);
    return !dirExists || !cfgExists ? "deleted" : "updated";
  }

  private async validateWorkspaceConfig(
    workspace: WorkspaceEntry,
  ): Promise<{ ok: true; config: MergedConfig } | { ok: false; error: Error }> {
    try {
      const adapter = new FilesystemConfigAdapter(workspace.path);
      const configLoader = new ConfigLoader(adapter, workspace.path);
      const config = await configLoader.load();
      return { ok: true, config };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  private async stopRuntimeIfActive(workspaceId: string): Promise<void> {
    // If daemon callback set, let daemon handle full cleanup (both maps)
    if (this.onRuntimeInvalidate) {
      await this.onRuntimeInvalidate(workspaceId);
      return;
    }
    // Fallback: local cleanup only (for tests without daemon)
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;
    try {
      await runtime.shutdown();
    } catch (error) {
      logger.warn("Error shutting down runtime", { workspaceId, error });
    }
    this.runtimes.delete(workspaceId);
  }

  /** Unregister then register signals for a workspace (best-effort). */
  private async restartSignalsForWorkspace(
    workspaceId: string,
    workspacePath: string,
    config: MergedConfig,
  ): Promise<void> {
    // Skip for ephemeral workspaces
    const ws = await this.registry.getWorkspace(workspaceId);
    if (ws?.metadata?.ephemeral) return;
    try {
      await this.unregisterWithRegistrars(workspaceId);
    } catch (error) {
      logger.debug("Error during signal unregister", { workspaceId, error });
    }
    try {
      await this.registerWithRegistrars(workspaceId, workspacePath, config);
    } catch (error) {
      logger.error("Error during signal register", { workspaceId, error });
    }
  }

  /** Set status to inactive; optionally replace metadata. */
  private async markWorkspaceInactive(
    workspaceId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.registry.updateWorkspaceStatus(workspaceId, "inactive", { metadata });
    } catch (error) {
      logger.debug("Failed to update workspace status to inactive", { workspaceId, error });
    }
  }

  /** Unregister workspace states: signals + runtime, mark inactive */
  private async unregisterWorkspaceStates(
    workspaceId: string,
    workspace: WorkspaceEntry,
  ): Promise<void> {
    try {
      await this.unregisterWithRegistrars(workspaceId);
    } catch (error) {
      logger.debug("Error during signal unregister after config removal", { workspaceId, error });
    }

    await this.stopRuntimeIfActive(workspaceId);

    await this.markWorkspaceInactive(workspaceId, {
      ...workspace.metadata,
      lastError: "Workspace configuration file removed",
      lastErrorAt: new Date().toISOString(),
    });

    try {
      this.fileWatcher?.unwatchWorkspace(workspaceId);
    } catch (error) {
      logger.debug("Error unwatching before reattach after config removal", { workspaceId, error });
    }
  }

  /**
   * Toggle persistence of a workspace by renaming config file and updating metadata.
   */
  async updateWorkspacePersistence(id: string, makePersistent: boolean): Promise<void> {
    const workspace = await this.registry.getWorkspace(id);
    if (!workspace) throw new Error(`Workspace not found: ${id}`);

    const currentIsEphemeral =
      Boolean(workspace.metadata?.ephemeral) || workspace.configPath.endsWith("eph_workspace.yml");

    if (makePersistent === !currentIsEphemeral) {
      return;
    }

    const fromName = makePersistent ? "eph_workspace.yml" : "workspace.yml";
    const toName = makePersistent ? "workspace.yml" : "eph_workspace.yml";
    const fromPath = join(workspace.path, fromName);
    const toPath = join(workspace.path, toName);

    // Stop runtime before changing
    await this.stopRuntimeIfActive(id);

    // Detach watcher before filesystem rename/registry updates
    try {
      this.fileWatcher?.unwatchWorkspace(id);
    } catch {
      logger.debug("Error unwatching before persistence update", { id });
    }

    try {
      // Rename config file if source exists; otherwise, if target exists, use it
      if (existsSync(fromPath)) {
        await Deno.rename(fromPath, toPath);
      } else if (!existsSync(toPath)) {
        // If neither exists, throw
        throw new Error(`Neither ${fromName} nor ${toName} exists in ${workspace.path}`);
      }

      // Update registry paths and metadata
      const newMetadata: Record<string, unknown> = { ...workspace.metadata };
      if (makePersistent) {
        newMetadata.ephemeral = false;
        newMetadata.expiresAt = undefined;
      } else {
        newMetadata.ephemeral = true;
        newMetadata.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      }

      await this.registry.updateWorkspaceStatus(id, "inactive", {
        configPath: toPath,
        metadata: newMetadata,
      });

      if (this.fileWatcher) {
        const updated: WorkspaceEntry = {
          ...workspace,
          configPath: toPath,
          metadata: newMetadata,
          status: "inactive",
        };
        await this.fileWatcher.watchWorkspace(updated);
      }

      // Update signals according to persistence
      if (makePersistent) {
        const adapter = new FilesystemConfigAdapter(workspace.path);
        const loader = new ConfigLoader(adapter, workspace.path);
        const cfg = await loader.load();
        await this.registerWithRegistrars(id, workspace.path, cfg);
      } else {
        await this.unregisterWithRegistrars(id);
      }
    } catch (error) {
      logger.error("Failed to update workspace persistence", { id, error });
      throw error;
    }
  }
}

// Singleton manager; lazily initialized
let _workspaceManager: WorkspaceManager | null = null;

export async function getWorkspaceManager(): Promise<WorkspaceManager> {
  if (!_workspaceManager) {
    // Create default registry adapter
    const registry = await createRegistryStorage(StorageConfigs.defaultKV());
    _workspaceManager = new WorkspaceManager(registry);
  }
  return _workspaceManager;
}
