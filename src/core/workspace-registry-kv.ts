import { basename, join } from "@std/path";
import { exists } from "@std/fs";
import * as yaml from "@std/yaml";
import { z } from "zod/v4";
import {
  WorkspaceEntry,
  WorkspaceEntrySchema,
  WorkspaceStatus,
} from "./workspace-registry-types.ts";
import { generateUniqueWorkspaceName } from "./utils/id-generator.ts";
import { NewWorkspaceConfig, NewWorkspaceConfigSchema } from "./config-loader.ts";

/**
 * Deno KV-based Workspace Registry Manager
 * Replaces the JSON file-based registry with atomic operations and real-time updates
 */
export class WorkspaceRegistryManager {
  private kv: Deno.Kv | null = null;
  private kvPath: string;
  private readonly REGISTRY_VERSION = "2.0.0";

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
        // Don't pass searchPath so it uses git root discovery
        const imported = await this.importExistingWorkspaces();
        if (imported > 0) {
          console.log(`Imported ${imported} workspace(s) into registry`);
        }
      } catch (error) {
        // Don't fail initialization if import fails
        console.warn("Failed to auto-import workspaces:", error);
      }
    }
  }

  private async updateLastUpdated(): Promise<void> {
    if (!this.kv) throw new Error("Registry not initialized");
    await this.kv.set(["registry", "lastUpdated"], new Date().toISOString());
  }

  // Core operations
  async register(
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
    const existingIds = new Set((await this.listAll()).map((w) => w.id));
    const id = generateUniqueWorkspaceName(existingIds);

    // Create new entry
    const entry: WorkspaceEntry = {
      id,
      name: options?.name || basename(workspacePath),
      path: await Deno.realPath(workspacePath),
      configPath: join(workspacePath, "workspace.yml"),
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

    return validatedEntry;
  }

  async unregister(id: string): Promise<void> {
    if (!this.kv) await this.initialize();

    const result = await this.kv!.atomic()
      .delete(["workspaces", id])
      .set(["registry", "lastUpdated"], new Date().toISOString())
      .commit();

    if (!result.ok) {
      throw new Error(`Failed to unregister workspace ${id}`);
    }
  }

  async updateStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    if (!this.kv) await this.initialize();

    // Get current workspace entry
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
      .check(current) // Ensure no concurrent updates
      .set(["workspaces", id], workspace)
      .set(["registry", "lastUpdated"], new Date().toISOString())
      .commit();

    if (!result.ok) {
      throw new Error(`Failed to update workspace ${id} status`);
    }
  }

  // Query operations with lazy health checks
  async findById(id: string): Promise<WorkspaceEntry | null> {
    if (!this.kv) await this.initialize();

    const result = await this.kv!.get<WorkspaceEntry>(["workspaces", id]);
    return result.value ? await this.checkAndUpdateHealth(result.value) : null;
  }

  async findByName(name: string): Promise<WorkspaceEntry | null> {
    if (!this.kv) await this.initialize();

    const workspaces = await this.listAll();
    const workspace = workspaces.find((w) => w.name === name);
    return workspace ? await this.checkAndUpdateHealth(workspace) : null;
  }

  async findByPath(path: string): Promise<WorkspaceEntry | null> {
    if (!this.kv) await this.initialize();

    const normalizedPath = await Deno.realPath(path).catch(() => path);
    const workspaces = await this.listAll();
    const workspace = workspaces.find((w) => w.path === normalizedPath);
    return workspace ? await this.checkAndUpdateHealth(workspace) : null;
  }

  // Internal version without health check for use within locked operations
  private async findByPathUnsafe(path: string): Promise<WorkspaceEntry | null> {
    const normalizedPath = await Deno.realPath(path).catch(() => path);
    const workspaces = await this.listAll();
    return workspaces.find((w) => w.path === normalizedPath) || null;
  }

  async listAll(): Promise<WorkspaceEntry[]> {
    if (!this.kv) await this.initialize();

    const workspaces: WorkspaceEntry[] = [];
    const iter = this.kv!.list<WorkspaceEntry>({ prefix: ["workspaces"] });

    for await (const entry of iter) {
      workspaces.push(entry.value);
    }

    // Check health of all workspaces
    const healthCheckedWorkspaces = await Promise.all(
      workspaces.map((w) => this.checkAndUpdateHealth(w)),
    );

    return healthCheckedWorkspaces;
  }

  async getRunning(): Promise<WorkspaceEntry[]> {
    const all = await this.listAll();
    return all.filter((w) => w.status === WorkspaceStatus.RUNNING);
  }

  // Lazy health check - core of our approach
  private async checkAndUpdateHealth(
    workspace: WorkspaceEntry,
    useHttpCheck = false,
  ): Promise<WorkspaceEntry> {
    // Check if status indicates it should have a running process
    if (
      (workspace.status === WorkspaceStatus.RUNNING ||
        workspace.status === WorkspaceStatus.STOPPING ||
        workspace.status === WorkspaceStatus.STARTING) &&
      workspace.pid
    ) {
      try {
        // First check if process exists
        const isRunning = await this.isProcessRunning(workspace.pid);

        if (!isRunning) {
          // Process died - update status based on previous state
          let newStatus: WorkspaceStatus;
          if (workspace.status === WorkspaceStatus.STOPPING) {
            newStatus = WorkspaceStatus.STOPPED;
          } else if (workspace.status === WorkspaceStatus.STARTING) {
            newStatus = WorkspaceStatus.CRASHED; // Starting but process died = crashed
          } else {
            newStatus = WorkspaceStatus.CRASHED; // Running but process died = crashed
          }

          await this.updateStatus(workspace.id, newStatus, {
            stoppedAt: new Date().toISOString(),
            pid: undefined,
            port: undefined,
          });
          // Update the returned workspace object to reflect the changes
          workspace.status = newStatus;
          workspace.pid = undefined;
          workspace.port = undefined;
          workspace.stoppedAt = new Date().toISOString();
        } else if (useHttpCheck && workspace.port && workspace.status === WorkspaceStatus.RUNNING) {
          // Process exists, optionally check HTTP health for more accuracy
          try {
            const response = await fetch(`http://localhost:${workspace.port}/api/health`, {
              signal: AbortSignal.timeout(2000), // 2 second timeout
            });

            if (!response.ok) {
              // HTTP check failed but process exists - might be starting up
              workspace.status = WorkspaceStatus.STARTING;
            }
          } catch {
            // HTTP check failed but process exists - might be starting up
            workspace.status = WorkspaceStatus.STARTING;
          }
        }
      } catch {
        // Error checking process - mark as unknown
        workspace.status = WorkspaceStatus.UNKNOWN;
      }
    }

    return workspace;
  }

  private async isProcessRunning(pid: number): Promise<boolean> {
    try {
      // Use ps command to reliably check if process exists
      // This matches the implementation in WorkspaceProcessManager
      const proc = new Deno.Command("ps", {
        args: ["-p", pid.toString()],
        stdout: "piped",
        stderr: "piped",
      });

      const output = await proc.output();
      return output.success;
    } catch {
      return false;
    }
  }

  // Utility methods
  async getCurrentWorkspace(): Promise<WorkspaceEntry | null> {
    // Find workspace for current directory
    const cwd = Deno.cwd();
    return await this.findByPath(cwd);
  }

  async findOrRegister(
    path: string,
    options?: {
      name?: string;
      description?: string;
    },
  ): Promise<WorkspaceEntry> {
    const existing = await this.findByPath(path);
    if (existing) return existing;

    return await this.register(path, options);
  }

  // Cleanup methods
  async cleanup(): Promise<number> {
    if (!this.kv) await this.initialize();

    const workspaces = await this.listAll();
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

    // Remove non-existent workspaces using atomic transaction
    if (toRemove.length > 0) {
      let atomic = this.kv!.atomic();
      for (const id of toRemove) {
        atomic = atomic.delete(["workspaces", id]);
      }
      atomic = atomic.set(["registry", "lastUpdated"], new Date().toISOString());

      const result = await atomic.commit();
      if (!result.ok) {
        throw new Error("Failed to cleanup workspaces");
      }
    }

    return cleaned;
  }

  async vacuum(): Promise<void> {
    if (!this.kv) await this.initialize();

    const workspaces = await this.listAll();
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

    if (toRemove.length > 0) {
      let atomic = this.kv!.atomic();
      for (const id of toRemove) {
        atomic = atomic.delete(["workspaces", id]);
      }
      atomic = atomic.set(["registry", "lastUpdated"], new Date().toISOString());

      const result = await atomic.commit();
      if (!result.ok) {
        throw new Error("Failed to vacuum workspaces");
      }
    }
  }

  // Watch for real-time updates (new capability with Deno KV)
  watchWorkspaces(): ReadableStream<WorkspaceEntry[]> {
    if (!this.kv) throw new Error("Registry not initialized");

    const stream = new ReadableStream<WorkspaceEntry[]>({
      start: async (controller) => {
        // Send initial state
        controller.enqueue(await this.listAll());

        // Watch for changes
        const watcher = this.kv!.watch([["workspaces"]]);

        for await (const entries of watcher) {
          // On any workspace change, send updated list
          controller.enqueue(await this.listAll());
        }
      },
    });

    return stream;
  }

  // Migration methods
  async discoverWorkspaces(searchPath?: string): Promise<string[]> {
    const workspaces: string[] = [];
    const rootPath = searchPath || Deno.cwd();

    // If searchPath is explicitly provided (e.g., in tests), only search within that path
    if (searchPath) {
      // Check common workspace locations within the search path
      const commonPaths = [
        join(rootPath, "examples", "workspaces"),
        join(rootPath, "workspaces"),
        rootPath, // Root itself might have workspace.yml
      ];

      for (const basePath of commonPaths) {
        if (await exists(basePath)) {
          await this.scanDirectory(basePath, workspaces, 3); // Max depth of 3
        }
      }
    } else {
      // No explicit search path - use git root discovery for real usage
      try {
        const gitRoot = new Deno.Command("git", {
          args: ["rev-parse", "--show-toplevel"],
          cwd: rootPath,
        }).outputSync();

        if (gitRoot.success) {
          const gitRootPath = new TextDecoder().decode(gitRoot.stdout).trim();

          // Check common workspace locations
          const commonPaths = [
            join(gitRootPath, "examples", "workspaces"),
            join(gitRootPath, "workspaces"),
            gitRootPath, // Root itself might have workspace.yml
          ];

          for (const basePath of commonPaths) {
            if (await exists(basePath)) {
              await this.scanDirectory(basePath, workspaces, 3); // Max depth of 3
            }
          }
        }
      } catch {
        // Not in a git repo, scan common locations in current directory
        const commonPaths = [
          join(rootPath, "examples", "workspaces"),
          join(rootPath, "workspaces"),
          rootPath, // Root itself might have workspace.yml
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

          await this.register(workspacePath, { name, description });
          imported++;
        }
      } catch (error) {
        // Skip workspaces that can't be registered
        console.warn(`Failed to import workspace at ${workspacePath}:`, error);
      }
    }

    return imported;
  }

  // Convenience method to get workspace configuration by slug
  async getWorkspaceConfigBySlug(workspaceSlug: string): Promise<NewWorkspaceConfig | null> {
    if (!this.kv) await this.initialize();

    // Find workspace by ID or name
    let workspace = await this.findById(workspaceSlug);
    if (!workspace) {
      workspace = await this.findByName(workspaceSlug);
    }

    if (!workspace) {
      return null;
    }

    try {
      // Read and parse the workspace.yml file
      const workspaceContent = await Deno.readTextFile(workspace.configPath);
      const rawConfig = yaml.parse(workspaceContent);

      // Validate with Zod schema
      const config = NewWorkspaceConfigSchema.parse(rawConfig);
      return config;
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error(`Invalid workspace configuration for ${workspaceSlug}:`, error.issues);
      } else {
        console.error(`Failed to load workspace config for ${workspaceSlug}:`, error);
      }
      return null;
    }
  }

  // Close KV database connection
  async close(): Promise<void> {
    if (this.kv) {
      this.kv.close();
      this.kv = null;
    }
  }
}

// Global singleton instance - lazy initialization
let _workspaceRegistry: WorkspaceRegistryManager | null = null;

export function getWorkspaceRegistry(): WorkspaceRegistryManager {
  if (!_workspaceRegistry) {
    _workspaceRegistry = new WorkspaceRegistryManager();
  }
  return _workspaceRegistry;
}
