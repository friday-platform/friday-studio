import { logger } from "@atlas/logger";
import type { WorkspaceEntry } from "../types.ts";
import { resolve } from "@std/path";
import { createFsWatchRunner, type FsWatchRunner } from "@atlas/fs-watch";
import { parse } from "@std/yaml";
import { WorkspaceConfigSchema } from "@atlas/config";

interface WorkspaceConfigWatcherOptions {
  onConfigChange: (workspaceId: string, filePath: string) => Promise<void>;
  debounceMs?: number;
  maxConfigSize?: number; // Maximum config file size in bytes
}

export class WorkspaceConfigWatcher {
  private watchers = new Map<string, FsWatchRunner>();
  private workspaceConfigPaths = new Map<string, string>();
  private readonly maxConfigSize: number;

  constructor(private options: WorkspaceConfigWatcherOptions) {
    // Default to 1MB max config size
    this.maxConfigSize = options.maxConfigSize || 1024 * 1024;
  }

  watchWorkspace(workspace: WorkspaceEntry) {
    // Don't watch if already watching
    if (this.watchers.has(workspace.id)) {
      return;
    }

    // Use the actual config path from the workspace entry
    const configPath = workspace.configPath;

    // Normalize the config path to absolute for comparison with file events
    // Use resolve instead of realPath to avoid issues if file doesn't exist yet
    const absoluteConfigPath = resolve(configPath);

    // Store the config path for this workspace
    this.workspaceConfigPaths.set(workspace.id, configPath);

    try {
      // Create shared runner for the workspace directory
      const runner = createFsWatchRunner({
        watchPath: absoluteConfigPath,
        recursive: false,
        debounceMs: this.options.debounceMs || 1000,
        filterKind: (k) => k === "modify" || k === "remove",
        onEvent: async (_event: Deno.FsEvent) => {
          await this.handleConfigChange(workspace.id, absoluteConfigPath);
        },
      });

      this.watchers.set(workspace.id, runner);

      logger.debug("Started watching workspace configuration", {
        workspaceId: workspace.id,
        path: workspace.path,
      });
    } catch (error) {
      // Clean up stored config path if watching fails
      this.workspaceConfigPaths.delete(workspace.id);

      logger.error("Failed to watch workspace", {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async unwatchWorkspace(workspaceId: string) {
    // Close watcher
    const runner = this.watchers.get(workspaceId);
    if (runner) {
      try {
        runner.stop();
      } catch {
        // Ignore errors on close
      }
      this.watchers.delete(workspaceId);
    }

    // Clear file hash for this workspace's config file
    const configPath = this.workspaceConfigPaths.get(workspaceId);
    if (configPath) {
      this.workspaceConfigPaths.delete(workspaceId);
    }

    logger.info("Stopped watching workspace configuration", { workspaceId });
    // keep async contract
    await Promise.resolve();
  }

  private async handleConfigChange(workspaceId: string, filePath: string) {
    // Check if workspace still exists and is being watched
    if (!this.watchers.has(workspaceId)) {
      logger.debug("Workspace no longer watched, skipping config change", { workspaceId });
      return;
    }

    try {
      // Check file size before processing
      const stats = await Deno.stat(filePath);
      if (stats.size > this.maxConfigSize) {
        logger.warn("Config file too large, skipping reload", {
          workspaceId,
          filePath,
          size: stats.size,
          maxSize: this.maxConfigSize,
        });
        return;
      }

      // Validate the new configuration before reloading
      const configContent = await Deno.readTextFile(filePath);
      const config = parse(configContent);

      // Use existing validation
      const validationResult = WorkspaceConfigSchema.safeParse(config);

      if (!validationResult.success) {
        logger.error("Invalid workspace configuration detected, skipping reload", {
          workspaceId,
          errors: validationResult.error.issues,
        });
        return;
      }

      // Configuration is valid, trigger reload
      await this.options.onConfigChange(workspaceId, filePath);
    } catch (error) {
      logger.error("Error handling config change", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async stop() {
    // Stop all watchers
    const workspaceIds = Array.from(this.watchers.keys());
    await Promise.all(workspaceIds.map((id) => this.unwatchWorkspace(id)));
  }
}
