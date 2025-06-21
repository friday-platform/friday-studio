import { basename, join } from "@std/path";
import { ensureDir, exists } from "@std/fs";
import * as yaml from "@std/yaml";
import { z } from "zod/v4";
import {
  WorkspaceEntry,
  WorkspaceEntrySchema,
  WorkspaceRegistry,
  WorkspaceRegistrySchema,
  WorkspaceStatus,
} from "./workspace-registry-types.ts";
import { generateUniqueWorkspaceName } from "./workspace-names.ts";
import { NewWorkspaceConfig, NewWorkspaceConfigSchema } from "./config-loader.ts";

export class WorkspaceRegistryManager {
  private registryPath: string;
  private registry: WorkspaceRegistry | null = null;

  constructor() {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || Deno.cwd();
    const atlasDir = join(homeDir, ".atlas");
    this.registryPath = join(atlasDir, "registry.json");
  }

  async initialize(): Promise<void> {
    // Ensure .atlas directory exists
    const atlasDir = join(this.registryPath, "..");
    await ensureDir(atlasDir);

    // Load or create registry
    if (await exists(this.registryPath)) {
      await this.load();
    } else {
      this.registry = {
        version: "1.0.0",
        workspaces: [],
        lastUpdated: new Date().toISOString(),
      };
      await this.save();
    }

    // Auto-import existing workspaces on every run (skip in tests)
    const isTestMode = Deno.env.get("DENO_TEST") === "true" ||
      await exists(join(atlasDir, ".test-mode"));

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

  private async load(): Promise<void> {
    const content = await Deno.readTextFile(this.registryPath);
    const data = JSON.parse(content);

    // Validate with Zod
    try {
      this.registry = WorkspaceRegistrySchema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid registry format: ${error.message}`);
      }
      throw error;
    }
  }

  private async save(): Promise<void> {
    if (!this.registry) throw new Error("Registry not initialized");

    this.registry.lastUpdated = new Date().toISOString();

    // Validate before saving
    const validatedRegistry = WorkspaceRegistrySchema.parse(this.registry);
    const content = JSON.stringify(validatedRegistry, null, 2);

    // Atomic write with temp file
    const tempPath = `${this.registryPath}.tmp`;
    await Deno.writeTextFile(tempPath, content);
    await Deno.rename(tempPath, this.registryPath);
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
    if (!this.registry) await this.initialize();

    // Check if already registered
    const existing = await this.findByPathUnsafe(workspacePath);
    if (existing) {
      return existing;
    }

    // Generate unique Docker-style ID
    const existingIds = new Set(this.registry!.workspaces.map((w) => w.id));
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

    this.registry!.workspaces.push(validatedEntry);
    await this.save();

    return validatedEntry;
  }

  async unregister(id: string): Promise<void> {
    if (!this.registry) await this.initialize();

    this.registry!.workspaces = this.registry!.workspaces.filter((w) => w.id !== id);
    await this.save();
  }

  async updateStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void> {
    if (!this.registry) await this.initialize();

    const workspace = this.registry!.workspaces.find((w) => w.id === id);
    if (!workspace) {
      throw new Error(`Workspace ${id} not found`);
    }

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

    await this.save();
  }

  // Query operations with lazy health checks
  async findById(id: string): Promise<WorkspaceEntry | null> {
    if (!this.registry) await this.initialize();

    const workspace = this.registry!.workspaces.find((w) => w.id === id);
    return workspace ? await this.checkAndUpdateHealth(workspace) : null;
  }

  async findByName(name: string): Promise<WorkspaceEntry | null> {
    if (!this.registry) await this.initialize();

    const workspace = this.registry!.workspaces.find((w) => w.name === name);
    return workspace ? await this.checkAndUpdateHealth(workspace) : null;
  }

  async findByPath(path: string): Promise<WorkspaceEntry | null> {
    if (!this.registry) await this.initialize();

    const normalizedPath = await Deno.realPath(path).catch(() => path);
    const workspace = this.registry!.workspaces.find((w) => w.path === normalizedPath);
    return workspace ? await this.checkAndUpdateHealth(workspace) : null;
  }

  // Internal version without health check for use within locked operations
  private async findByPathUnsafe(path: string): Promise<WorkspaceEntry | null> {
    const normalizedPath = await Deno.realPath(path).catch(() => path);
    return this.registry!.workspaces.find((w) => w.path === normalizedPath) || null;
  }

  async listAll(): Promise<WorkspaceEntry[]> {
    if (!this.registry) await this.initialize();

    // Check health of all workspaces
    const workspaces = await Promise.all(
      this.registry!.workspaces.map((w) => this.checkAndUpdateHealth(w)),
    );

    return workspaces;
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
          workspace.status = newStatus;
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
    if (!this.registry) await this.initialize();

    let cleaned = 0;
    const toRemove: string[] = [];

    for (const workspace of this.registry!.workspaces) {
      // Check if workspace directory still exists
      const exists = await Deno.stat(workspace.path).catch(() => null);

      if (!exists) {
        toRemove.push(workspace.id);
        cleaned++;
      }
    }

    // Remove non-existent workspaces
    for (const id of toRemove) {
      await this.unregister(id);
    }

    return cleaned;
  }

  async vacuum(): Promise<void> {
    if (!this.registry) await this.initialize();

    // Remove old stopped workspaces
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30); // 30 days

    this.registry!.workspaces = this.registry!.workspaces.filter((w) => {
      if (w.status === WorkspaceStatus.STOPPED && w.stoppedAt) {
        return new Date(w.stoppedAt) > cutoff;
      }
      return true;
    });

    await this.save();
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
}

// Global singleton instance - lazy initialization
let _workspaceRegistry: WorkspaceRegistryManager | null = null;

export function getWorkspaceRegistry(): WorkspaceRegistryManager {
  if (!_workspaceRegistry) {
    _workspaceRegistry = new WorkspaceRegistryManager();
  }
  return _workspaceRegistry;
}
