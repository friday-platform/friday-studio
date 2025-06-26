/**
 * Unified WorkspaceManager - Single source of truth for workspace lifecycle
 * Combines persistence (KV storage) with runtime instance tracking
 * Replaces the dual WorkspaceRegistry + WorkspaceRuntimeRegistry architecture
 */

import { basename, join } from "@std/path";
import { exists } from "@std/fs";
import * as yaml from "@std/yaml";
import { z } from "zod/v4";
import { logger } from "../utils/logger.ts";
import { generateUniqueWorkspaceName } from "./utils/id-generator.ts";
import { NewWorkspaceConfig, NewWorkspaceConfigSchema } from "./config-loader.ts";
import type { WorkspaceRuntime } from "./workspace-runtime.ts";
import type { IWorkspace } from "../types/core.ts";

// Re-export types from workspace-registry-types for compatibility
export {
  type WorkspaceEntry,
  WorkspaceEntrySchema,
  WorkspaceStatus,
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
 */
export class WorkspaceManager {
  private kv: Deno.Kv | null = null;
  private kvPath: string;
  private readonly REGISTRY_VERSION = "2.0.0";

  // Runtime tracking (in-memory)
  private runtimes = new Map<string, RuntimeWorkspaceInfo>();

  constructor() {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || Deno.cwd();
    const atlasDir = join(homeDir, ".atlas");
    this.kvPath = join(atlasDir, "registry.db");
  }

  async initialize(): Promise<void> {
    // Ensure .atlas directory exists
    const atlasDir = join(this.kvPath, "..");
    await Deno.mkdir(atlasDir, { recursive: true });

    // Open Deno KV database
    this.kv = await Deno.openKv(this.kvPath);

    // Initialize registry metadata if not exists
    const versionCheck = await this.kv.get(["registry", "version"]);
    if (!versionCheck.value) {
      await this.kv.set(["registry", "version"], this.REGISTRY_VERSION);
      await this.kv.set(["registry", "lastUpdated"], new Date().toISOString());
    }

    // Auto-import existing workspaces on every run (skip in tests)
    const isTestMode = Deno.env.get("DENO_TEST") === "true" ||
      await exists(join(this.kvPath, "..", ".test-mode"));

    if (!isTestMode) {
      try {
        const imported = await this.importExistingWorkspaces();
        if (imported > 0) {
          logger.info(`Imported ${imported} workspace(s) into registry`);
        }
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
    if (!this.kv) await this.initialize();

    // Check if already registered
    const existing = await this.findByPathUnsafe(workspacePath);
    if (existing) {
      return existing;
    }

    // Generate unique Docker-style ID
    const existingIds = new Set((await this.listAllPersisted()).map((w) => w.id));
    const id = generateUniqueWorkspaceName(existingIds);

    // Load and cache workspace configuration
    const absolutePath = await Deno.realPath(workspacePath);
    const configPath = join(absolutePath, "workspace.yml");

    let config: Record<string, any> | undefined;
    let configHash: string | undefined;

    try {
      // Load configuration using absolute path
      const { ConfigLoader } = await import("./config-loader.ts");
      const configLoader = new ConfigLoader(absolutePath);
      const loadedConfig = await configLoader.load();

      // Cache the full merged config
      config = JSON.parse(JSON.stringify(loadedConfig)); // Deep clone to avoid mutations

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
      logger.warn("Failed to load workspace config during registration", {
        workspacePath: absolutePath,
        error: error.message,
      });
      // Continue registration without config cache - will be loaded on-demand if needed
    }

    // Create new entry
    const entry: WorkspaceEntry = {
      id,
      name: options?.name || basename(workspacePath),
      path: absolutePath,
      configPath,
      config,
      configHash,
      status: WorkspaceStatus.STOPPED,
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      metadata: {
        atlasVersion: Deno.version.deno,
        description: options?.description,
        tags: options?.tags,
      },
    };

    // Validate entry with Zod
    const validatedEntry = WorkspaceEntrySchema.parse(entry);

    // Atomic operation to store workspace
    const result = await this.kv!.atomic()
      .set(["workspaces", validatedEntry.id], validatedEntry)
      .set(["registry", "lastUpdated"], new Date().toISOString())
      .commit();

    if (!result.ok) {
      throw new Error("Failed to register workspace in KV store");
    }

    logger.info("Workspace registered", { id: validatedEntry.id, name: validatedEntry.name });
    return validatedEntry;
  }

  /**
   * Unregister a workspace from persistent storage
   */
  async unregisterWorkspace(id: string): Promise<void> {
    if (!this.kv) await this.initialize();

    const result = await this.kv!.atomic()
      .delete(["workspaces", id])
      .set(["registry", "lastUpdated"], new Date().toISOString())
      .commit();

    if (!result.ok) {
      throw new Error(`Failed to unregister workspace ${id}`);
    }

    logger.info("Workspace unregistered", { id });
  }

  /**
   * List all persisted workspaces
   */
  async listAllPersisted(): Promise<WorkspaceEntry[]> {
    if (!this.kv) await this.initialize();

    const workspaces: WorkspaceEntry[] = [];
    const iter = this.kv!.list<WorkspaceEntry>({ prefix: ["workspaces"] });

    for await (const entry of iter) {
      workspaces.push(entry.value);
    }

    return workspaces;
  }

  /**
   * Find workspace by ID in persistent storage
   */
  async findById(id: string): Promise<WorkspaceEntry | null> {
    if (!this.kv) await this.initialize();

    const result = await this.kv!.get<WorkspaceEntry>(["workspaces", id]);
    return result.value || null;
  }

  /**
   * Find workspace by name in persistent storage
   */
  async findByName(name: string): Promise<WorkspaceEntry | null> {
    if (!this.kv) await this.initialize();

    const workspaces = await this.listAllPersisted();
    return workspaces.find((w) => w.name === name) || null;
  }

  /**
   * Find workspace by path in persistent storage
   */
  async findByPath(path: string): Promise<WorkspaceEntry | null> {
    if (!this.kv) await this.initialize();

    const normalizedPath = await Deno.realPath(path).catch(() => path);
    const workspaces = await this.listAllPersisted();
    return workspaces.find((w) => w.path === normalizedPath) || null;
  }

  private async findByPathUnsafe(path: string): Promise<WorkspaceEntry | null> {
    const normalizedPath = await Deno.realPath(path).catch(() => path);
    const workspaces = await this.listAllPersisted();
    return workspaces.find((w) => w.path === normalizedPath) || null;
  }

  /**
   * Update workspace status in persistent storage
   */
  async updateWorkspaceStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    if (!this.kv) await this.initialize();

    const current = await this.kv!.get<WorkspaceEntry>(["workspaces", id]);
    if (!current.value) {
      throw new Error(`Workspace ${id} not found`);
    }

    const workspace = { ...current.value };
    workspace.status = status;
    workspace.lastSeen = new Date().toISOString();

    // Apply additional updates
    if (updates) {
      Object.assign(workspace, updates);
    }

    // Update timestamps based on status
    if (status === WorkspaceStatus.RUNNING) {
      workspace.startedAt = new Date().toISOString();
    } else if (status === WorkspaceStatus.STOPPED || status === WorkspaceStatus.CRASHED) {
      workspace.stoppedAt = new Date().toISOString();
      workspace.pid = undefined;
      workspace.port = undefined;
    }

    // Atomic update
    const result = await this.kv!.atomic()
      .check(current)
      .set(["workspaces", id], workspace)
      .set(["registry", "lastUpdated"], new Date().toISOString())
      .commit();

    if (!result.ok) {
      throw new Error(`Failed to update workspace ${id} status`);
    }

    logger.debug("Workspace status updated", { id, status });
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
    if (!this.kv) await this.initialize();

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
    if (!this.kv) await this.initialize();

    const workspace = await this.findById(id);
    if (!workspace) {
      throw new Error(`Workspace ${id} not found`);
    }

    try {
      // Load configuration using absolute path
      const { ConfigLoader } = await import("./config-loader.ts");
      const configLoader = new ConfigLoader(workspace.path);
      const loadedConfig = await configLoader.load();

      // Cache the full merged config
      const config = JSON.parse(JSON.stringify(loadedConfig)); // Deep clone

      // Generate new config hash
      const configJson = JSON.stringify(config, Object.keys(config).sort());
      const encoder = new TextEncoder();
      const data = encoder.encode(configJson);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const configHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

      // Update workspace entry
      const updatedWorkspace = { ...workspace, config, configHash };

      // Atomic update
      const result = await this.kv!.atomic()
        .set(["workspaces", id], updatedWorkspace)
        .set(["registry", "lastUpdated"], new Date().toISOString())
        .commit();

      if (!result.ok) {
        throw new Error(`Failed to update workspace ${id} config cache`);
      }

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

    return {
      id: workspace.id,
      name: workspace.name,
      description: workspace.metadata?.description,
      path: workspace.path,
      status: workspace.status,
      createdAt: workspace.createdAt,
      lastSeen: workspace.lastSeen,
      hasActiveRuntime: !!runtimeInfo,
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
          // Try to read workspace.yml to get name and description
          const workspaceYmlPath = join(workspacePath, "workspace.yml");
          let name = basename(workspacePath);
          let description: string | undefined;

          try {
            const yamlContent = await Deno.readTextFile(workspaceYmlPath);
            const config = yaml.parse(yamlContent) as {
              workspace?: { name?: string; description?: string };
            };

            if (config.workspace?.name) {
              name = config.workspace.name;
            }
            if (config.workspace?.description) {
              description = config.workspace.description;
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
   * Close KV database connection and cleanup
   */
  async close(): Promise<void> {
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
    this.runtimes.clear();
    logger.debug("WorkspaceManager closed");
  }
}

// Global singleton instance - lazy initialization
let _workspaceManager: WorkspaceManager | null = null;

export function getWorkspaceManager(): WorkspaceManager {
  if (!_workspaceManager) {
    _workspaceManager = new WorkspaceManager();
  }
  return _workspaceManager;
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
