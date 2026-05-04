/** Single source of truth for workspace lifecycle and state. */

import { existsSync, readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { env } from "node:process";
import type { MemoryAdapter } from "@atlas/agent-sdk";
import { ConfigLoader, ConfigNotFoundError, type MergedConfig } from "@atlas/config";
import { MissingEnvironmentError } from "@atlas/core";
import { logger } from "@atlas/logger";
import { seedMemories } from "@atlas/memory";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { SYSTEM_WORKSPACES } from "@atlas/system/workspaces";
import { randomColor } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { parse as parseDotenv } from "@std/dotenv";
import { getCanonicalKind } from "./canonical.ts";
import { ensureDefaultUserWorkspace } from "./first-run-bootstrap.ts";
import { generateUniqueWorkspaceName } from "./id-generator.ts";
import type { WorkspaceRuntime } from "./runtime.ts";
import type { RegistryStorageAdapter } from "./storage.ts";
import type { WorkspaceEntry, WorkspaceSignalRegistrar, WorkspaceStatus } from "./types.ts";
import { WorkspaceConfigWatcher } from "./watchers/index.ts";

/** Called when a runtime needs to be destroyed (config changed, workspace deleted) */
export type RuntimeInvalidateCallback = (workspaceId: string) => Promise<void>;

/** @internal Exported for testing. */
export function validateMCPEnvironmentForWorkspace(
  config: MergedConfig,
  workspacePath: string,
): void {
  const mcpServers = config.workspace.tools?.mcp?.servers;
  if (!mcpServers) return;

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

  const missingVars: Array<{ serverId: string; varName: string }> = [];

  for (const [serverId, serverConfig] of Object.entries(mcpServers)) {
    if (!serverConfig.env) continue;

    for (const [key, value] of Object.entries(serverConfig.env)) {
      if (value === "auto" || value === "from_environment") {
        const systemValue = env[key];
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

    throw new MissingEnvironmentError(
      `Missing required environment variables for workspace:\n${formatted}\n\n` +
        `Set these in:\n` +
        `  - ${workspaceEnvHint}\n` +
        `  - ${join(getFridayHome(), ".env")}\n` +
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
  private memoryAdapter?: MemoryAdapter & {
    ensureRoot(workspaceId: string, name: string): Promise<void>;
  };

  /**
   * Cache of parsed workspace configs keyed by workspaceId. Each entry pins
   * the workspace.yml mtime that produced it; on a stat mismatch we evict
   * and re-parse. Cuts the per-signal YAML parse + Zod validation cost from
   * ~5–20ms to a single file stat. Bounded only by the number of workspaces
   * the daemon has touched.
   */
  private configCache = new Map<string, { mtimeMs: number; config: MergedConfig }>();

  /**
   * Pending watcher events for workspaces that had active sessions when the
   * config file changed on disk. Keyed by workspaceId. Re-applied by
   * processPendingWatcherChange when the daemon detects the workspace has
   * gone idle. Prevents the FAST self-modification failure mode where a
   * config edit mid-session kills the running session via runtime tear-down.
   */
  private pendingWatcherChanges = new Map<
    string,
    { filePath: string } | { oldPath: string; newPath?: string }
  >();

  constructor(registry: RegistryStorageAdapter) {
    this.registry = registry;
  }

  /**
   * Inject the memory adapter used to seed `memory.own` directories on
   * workspace registration. AtlasDaemon constructs a JetStreamMemoryAdapter
   * after NATS is up and passes it in. Tests can pass a mock or omit it
   * (seeding becomes a no-op).
   */
  setMemoryAdapter(
    adapter: MemoryAdapter & { ensureRoot(workspaceId: string, name: string): Promise<void> },
  ): void {
    this.memoryAdapter = adapter;
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

    await this.registerSystemWorkspaces();
    await this.migrateFastLoopToSystem();

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
        await ensureDefaultUserWorkspace(this);
      } catch (error) {
        logger.error("Failed to bootstrap default user workspace", { error });
      }
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
    options?: {
      id?: string;
      name?: string;
      description?: string;
      tags?: string[];
      createdBy?: string;
      skipEnvValidation?: boolean;
      canonical?: "personal" | "system";
    },
  ): Promise<{ workspace: WorkspaceEntry; created: boolean }> {
    if (options?.id) {
      const existingById = await this.registry.getWorkspace(options.id);
      if (existingById) return { workspace: existingById, created: false };
    }

    const absolutePath = await Deno.realPath(workspacePath);

    const existing = await this.registry.findWorkspaceByPath(absolutePath);
    if (existing) {
      return { workspace: existing, created: false };
    }

    const adapter = new FilesystemConfigAdapter(absolutePath);
    const configLoader = new ConfigLoader(adapter, absolutePath);

    let config: MergedConfig;

    try {
      config = await configLoader.load();
    } catch (error) {
      logger.error("Invalid workspace configuration", { path: absolutePath, error });
      throw error;
    }

    // Validate that all "auto" env vars are available before allowing registration.
    // Skip during import when credentials are unresolved — the route sets
    // requires_setup so the user is prompted to connect them post-creation.
    if (!options?.skipEnvValidation) {
      validateMCPEnvironmentForWorkspace(config, absolutePath);
    }

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

    const id = options?.id ?? (await this.generateUniqueId());

    const entry: WorkspaceEntry = {
      id,
      name: options?.name || config.workspace.workspace.name || basename(absolutePath),
      path: absolutePath,
      configPath,
      status: "inactive",
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      metadata: {
        description: options?.description || config.workspace.workspace.description,
        tags: options?.tags,
        atlasVersion: Deno.version.deno,
        createdBy: options?.createdBy,
        color: randomColor(),
        ephemeral: isEphemeral,
        expiresAt: isEphemeral
          ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          : undefined,
        canonical: options?.canonical,
      },
    };

    await this.registry.registerWorkspace(entry);
    logger.info(`Workspace registered: ${entry.name}`, { id: entry.id });

    const ownEntries = config.workspace.memory?.own ?? [];
    if (ownEntries.length > 0 && this.memoryAdapter) {
      try {
        await seedMemories(this.memoryAdapter, entry.id, ownEntries);
      } catch (error) {
        logger.warn("Failed to seed workspace memories", { workspaceId: entry.id, error });
      }
    }

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

    const systemIds = new Set(Object.keys(SYSTEM_WORKSPACES));

    for (const [id, config] of Object.entries(SYSTEM_WORKSPACES)) {
      const entry: WorkspaceEntry = {
        id,
        name: config.workspace.name,
        path: `system://${id}`, // Clean system prefix
        configPath: `system://${id}/workspace.yml`,
        status: "inactive",
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        metadata: {
          description: config.workspace.description,
          system: true,
          canonical: getCanonicalKind(id),
          tags: ["system"],
          color: randomColor(),
        },
      };

      const existing = await this.registry.getWorkspace(id);
      if (!existing) {
        await this.registry.registerWorkspace(entry);
        logger.info(`System workspace registered: ${entry.name}`);
      } else if (
        existing.name !== entry.name ||
        !existing.metadata?.system ||
        existing.metadata?.canonical !== entry.metadata?.canonical
      ) {
        await this.registry.updateWorkspaceStatus(id, existing.status, {
          name: entry.name,
          metadata: {
            ...existing.metadata,
            system: true,
            canonical: getCanonicalKind(id),
            description: entry.metadata?.description,
          },
        });
        logger.info(`System workspace reconciled: ${existing.name} → ${entry.name}`);
      }

      try {
        const mergedConfig = await this.getWorkspaceConfig(id);
        if (mergedConfig) {
          await this.registerWithRegistrars(id, entry.path, mergedConfig);
        }
      } catch (error) {
        logger.warn("Failed to register system workspace signals", { workspaceId: id, error });
      }
    }

    const allWorkspaces = await this.registry.listWorkspaces();
    for (const ws of allWorkspaces) {
      if (ws.metadata?.system && !systemIds.has(ws.id)) {
        logger.info(`Removing orphaned system workspace: ${ws.id} (${ws.name})`);
        // Pair registry unregister with registrar cleanup so cron timers
        // (and fs watchers) for the orphaned workspace don't survive as
        // ghosts that fire every tick against a missing workspace.
        await this.unregisterWithRegistrars(ws.id);
        await this.registry.unregisterWorkspace(ws.id);
      }
    }
  }

  /**
   * Migrate legacy fast-loop workspace to system.
   *
   * Existing installs may have a workspace registered under an ID or name
   * containing "fast-loop". This migration updates the registry entry to
   * point to the new system system workspace. Idempotent: no-op if
   * no fast-loop workspace exists or if system is already registered.
   */
  private async migrateFastLoopToSystem(): Promise<void> {
    const allWorkspaces = await this.registry.listWorkspaces();
    const fastLoopEntry = allWorkspaces.find(
      (ws) =>
        ws.id.includes("fast-loop") ||
        ws.name.includes("fast-loop") ||
        ws.path.includes("fast-loop"),
    );

    if (!fastLoopEntry) return;

    // system is already registered by registerSystemWorkspaces — just
    // remove the stale fast-loop entry.
    logger.info("Migrating fast-loop workspace to system", {
      oldId: fastLoopEntry.id,
      oldName: fastLoopEntry.name,
      oldPath: fastLoopEntry.path,
    });

    // Pair registry unregister with registrar cleanup so cron timers
    // and fs watchers tied to the old fast-loop id don't outlive it.
    await this.unregisterWithRegistrars(fastLoopEntry.id);
    await this.registry.unregisterWorkspace(fastLoopEntry.id);
    logger.info("Fast-loop workspace entry removed (replaced by system)");
  }

  /** Return workspace config; use embedded config for system workspaces. */
  async getWorkspaceConfig(workspaceId: string): Promise<MergedConfig | null> {
    const workspace = await this.registry.getWorkspace(workspaceId);
    if (!workspace) return null;

    if (workspace.metadata?.system && workspace.id in SYSTEM_WORKSPACES) {
      const config = SYSTEM_WORKSPACES[workspace.id];
      if (!config) {
        logger.error(`Missing configuration for system workspace: ${workspace.id}`);
        return null;
      }
      return { atlas: null, workspace: config };
    }

    const cached = this.configCache.get(workspaceId);
    const yamlPath = join(workspace.path, "workspace.yml");
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await stat(yamlPath)).mtimeMs;
    } catch {
      // File missing — fall through to load() which surfaces the right error.
    }
    if (cached && mtimeMs !== null && cached.mtimeMs === mtimeMs) {
      return cached.config;
    }

    try {
      const adapter = new FilesystemConfigAdapter(workspace.path);
      const configLoader = new ConfigLoader(adapter, workspace.path);
      const config = await configLoader.load();
      if (mtimeMs !== null) {
        this.configCache.set(workspaceId, { mtimeMs, config });
      } else {
        this.configCache.delete(workspaceId);
      }
      return config;
    } catch (error) {
      this.configCache.delete(workspaceId);
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

    if (workspace) {
      const runtime = this.runtimes.get(workspace.id);
      if (runtime) {
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

    if (workspace.metadata?.canonical && !options?.force) {
      throw new Error(`Cannot delete canonical workspace '${id}'.`);
    }

    if (workspace.metadata?.system && !options?.force) {
      throw new Error(`Cannot delete system workspace '${id}'. Use force=true to override.`);
    }

    await this.unregisterWithRegistrars(id);

    const runtime = this.runtimes.get(id);
    if (runtime) {
      await runtime.shutdown();
      this.runtimes.delete(id);
    }

    await this.registry.unregisterWorkspace(id);

    try {
      this.fileWatcher?.unwatchWorkspace(id);
    } catch (error) {
      logger.debug("Error stopping watcher during workspace deletion", { id, error });
    }

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

  /**
   * Rename a workspace.
   *
   * Canonical system workspaces cannot be renamed. Canonical personal
   * workspaces are renamable. Non-canonical workspaces rename freely.
   */
  async renameWorkspace(id: string, newName: string): Promise<void> {
    const workspace = await this.registry.getWorkspace(id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }

    if (workspace.metadata?.canonical === "system") {
      throw new Error(`Cannot rename system canonical workspace '${id}'.`);
    }

    await this.registry.updateWorkspaceStatus(id, workspace.status, { name: newName });
  }

  /** Register active runtime and persist status=running. */
  async registerRuntime(workspaceId: string, runtime: WorkspaceRuntime): Promise<void> {
    this.runtimes.set(workspaceId, runtime);
    logger.info("Runtime registered", { workspaceId });

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

      try {
        await this.registry.updateWorkspaceStatus(workspaceId, "stopped");
        logger.info("Workspace status updated to stopped", { workspaceId });
      } catch (error) {
        logger.error("Failed to update workspace status", { workspaceId, error });
      }
    }
  }

  async updateWorkspaceLastSeen(workspaceId: string): Promise<void> {
    await this.registry.updateWorkspaceLastSeen(workspaceId);
  }

  async updateWorkspaceStatus(
    workspaceId: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    await this.registry.updateWorkspaceStatus(workspaceId, status, updates);
  }

  private async generateUniqueId(): Promise<string> {
    const existingWorkspaces = await this.registry.listWorkspaces();
    const existingIds = new Set(existingWorkspaces.map((w) => w.id));
    return generateUniqueWorkspaceName(existingIds);
  }

  private isTestMode(): boolean {
    return env.DENO_TEST === "true";
  }

  /**
   * Auto-import user workspaces from ~/.friday/local/workspaces.
   *
   * Searches a small depth for directories containing workspace.yml, de-dupes, validates
   * configs, logs and skips invalid ones. Never throws; returns import count.
   */
  private async importExistingWorkspaces(): Promise<number> {
    const workspaces: string[] = [];
    const atlasWorkspacesDir = join(getFridayHome(), "workspaces");
    const commonPaths = [atlasWorkspacesDir];

    for (const basePath of commonPaths) {
      if (existsSync(basePath)) {
        await this.scanDirectory(basePath, workspaces, 3);
      }
    }

    const discovered = [...new Set(workspaces)];
    let imported = 0;
    let skipped = 0;

    for (const workspacePath of discovered) {
      const existing = await this.find({ path: workspacePath });
      if (!existing) {
        try {
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
      const workspaceYmlPath = join(path, "workspace.yml");
      const ephWorkspaceYmlPath = join(path, "eph_workspace.yml");
      if (existsSync(workspaceYmlPath)) {
        results.push(path);
        return;
      }
      if (existsSync(ephWorkspaceYmlPath)) {
        results.push(path);
        return;
      }

      const skipDirs = new Set([
        ".git",
        "node_modules",
        ".atlas",
        ".friday",
        "dist",
        "build",
        ".next",
        "target",
      ]);
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
    try {
      const all = await this.list({ includeSystem: false });
      for (const ws of all) {
        await this.unregisterWithRegistrars(ws.id);
      }
    } catch (error) {
      logger.debug("Error unregistering workspace signals during manager close", { error });
    }

    const shutdownPromises = Array.from(this.runtimes.values()).map(async (runtime) => {
      try {
        await runtime.shutdown();
      } catch (error) {
        logger.error("Error shutting down workspace runtime", { error });
      }
    });

    await Promise.all(shutdownPromises);
    this.runtimes.clear();

    if (this.fileWatcher) {
      try {
        this.fileWatcher.stop();
      } catch (error) {
        logger.debug("Error stopping workspace config watcher", { error });
      }
      this.fileWatcher = null;
    }

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
   * INTENTIONAL HOT-RELOAD: The file watcher detects workspace.yml changes and
   * destroys the active runtime so it re-creates from the updated config on the
   * next signal/request. This is a deliberate design choice, not a bug. API route
   * handlers in config.ts do the same via destroyWorkspaceRuntime.
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

    // Active-session guard. If the workspace has a running runtime with active
    // sessions OR in-flight orchestrator executions, defer the reload by
    // stashing the change in pendingWatcherChanges. AtlasDaemon calls
    // processPendingWatcherChange after sessions complete (see
    // atlas-daemon.ts session-complete handler) to re-apply the change at a
    // safe moment. Prevents the FAST self-modification failure mode.
    const runtime = this.runtimes.get(workspaceId);
    if (runtime) {
      const sessions = runtime.getSessions();
      const hasActiveSessions = sessions.some(
        (s: { session: { status: string } }) => s.session.status === "active",
      );
      let hasActiveExecutions = false;
      if ("getOrchestrator" in runtime && typeof runtime.getOrchestrator === "function") {
        const orchestrator = runtime.getOrchestrator();
        hasActiveExecutions = orchestrator.hasActiveExecutions();
      }
      if (hasActiveSessions || hasActiveExecutions) {
        logger.info("deferring workspace config reload until active sessions complete", {
          workspaceId,
          change,
        });
        this.pendingWatcherChanges.set(workspaceId, change);
        return;
      }
    }

    if ("filePath" in change) {
      logger.debug("processing filePath change", { workspaceId, filePath: change.filePath });
      await this.handleWorkspaceConfigChange(workspace, change.filePath);
      return;
    }

    const { oldPath, newPath } = change;
    logger.debug("processing rename change", { workspaceId, oldPath, newPath });

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
   * Re-apply a deferred watcher change. Called by AtlasDaemon when a session
   * completes and the workspace is observed idle. No-op if no deferred change
   * exists. Should be called AFTER the session-complete handler has confirmed
   * !hasActiveSessions && !hasActiveExecutions.
   */
  async processPendingWatcherChange(workspaceId: string): Promise<void> {
    const change = this.pendingWatcherChanges.get(workspaceId);
    if (!change) return;

    // Re-check active sessions; another session may have started since the
    // defer. If still busy, leave the change pending.
    const runtime = this.runtimes.get(workspaceId);
    if (runtime) {
      const sessions = runtime.getSessions();
      const hasActiveSessions = sessions.some(
        (s: { session: { status: string } }) => s.session.status === "active",
      );
      let hasActiveExecutions = false;
      if ("getOrchestrator" in runtime && typeof runtime.getOrchestrator === "function") {
        const orchestrator = runtime.getOrchestrator();
        hasActiveExecutions = orchestrator.hasActiveExecutions();
      }
      if (hasActiveSessions || hasActiveExecutions) {
        logger.debug("pending watcher change still blocked by active sessions", { workspaceId });
        return;
      }
    }

    this.pendingWatcherChanges.delete(workspaceId);
    logger.info("re-applying deferred workspace config change", { workspaceId, change });
    await this.handleWatcherChange(workspaceId, change);
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
      const adapter = new FilesystemConfigAdapter(newWorkspaceDir);
      const loader = new ConfigLoader(adapter, newWorkspaceDir);
      const config = await loader.load();

      await this.stopRuntimeIfActive(workspaceId);

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
    this.configCache.delete(workspaceId);
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
      await this.registry.updateWorkspaceStatus(
        workspaceId,
        "inactive",
        metadata !== undefined ? { metadata } : undefined,
      );
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

    await this.stopRuntimeIfActive(id);

    try {
      this.fileWatcher?.unwatchWorkspace(id);
    } catch {
      logger.debug("Error unwatching before persistence update", { id });
    }

    try {
      if (existsSync(fromPath)) {
        await Deno.rename(fromPath, toPath);
      } else if (!existsSync(toPath)) {
        throw new Error(`Neither ${fromName} nor ${toName} exists in ${workspace.path}`);
      }

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
