import { logger } from "@atlas/logger";
import { debounce } from "@std/async";
import { resolve } from "@std/path";
import type { WorkspaceEntry } from "@atlas/workspace";

interface WorkspaceFileWatcherOptions {
  onConfigChange: (workspaceId: string, filePath: string) => Promise<void>;
  debounceMs?: number;
  maxConfigSize?: number; // Maximum config file size in bytes
}

export class WorkspaceFileWatcher {
  private watchers = new Map<string, Deno.FsWatcher>();
  private debouncedHandlers = new Map<string, (event: Deno.FsEvent) => void>();
  private watcherTasks = new Map<string, Promise<void>>();
  private fileHashes = new Map<string, string>();
  private workspaceConfigPaths = new Map<string, string>();
  private readonly maxConfigSize: number;

  constructor(private options: WorkspaceFileWatcherOptions) {
    // Default to 1MB max config size
    this.maxConfigSize = options.maxConfigSize || 1024 * 1024;
  }

  async watchWorkspace(workspace: WorkspaceEntry) {
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
      // Initialize hash for existing file to prevent initial change detection
      try {
        await this.hasFileChanged(configPath);
      } catch (_error) {
        // File might not exist yet, that's okay
      }

      // Create watcher for the workspace directory
      const watcher = Deno.watchFs(workspace.path, { recursive: false });
      this.watchers.set(workspace.id, watcher);

      // Create debounced handler for this workspace
      const debouncedHandler = debounce(
        async (event: Deno.FsEvent) => {
          // Check if any of the changed paths match the workspace's config file
          // Normalize all paths for consistent comparison
          const matchingPath = event.paths.find((p) => {
            const normalizedEventPath = resolve(p);
            return normalizedEventPath === absoluteConfigPath;
          });

          if (matchingPath) {
            const hasChanged = await this.hasFileChanged(configPath);
            if (hasChanged) {
              await this.handleConfigChange(workspace.id, configPath);
            }
          }
        },
        this.options.debounceMs || 1000,
      );

      this.debouncedHandlers.set(workspace.id, debouncedHandler);

      // Start watching in background task
      const watchTask = this.startWatching(workspace.id, watcher, debouncedHandler);
      this.watcherTasks.set(workspace.id, watchTask);

      logger.info("Started watching workspace configuration", {
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

  private async startWatching(
    workspaceId: string,
    watcher: Deno.FsWatcher,
    handler: (event: Deno.FsEvent) => void,
  ) {
    try {
      for await (const event of watcher) {
        // Check if watcher has been removed (stopped)
        if (!this.watchers.has(workspaceId)) {
          break;
        }
        // Some file systems emit "create" events when files are replaced/rewritten
        // So we need to handle both modify and create events
        if (event.kind === "modify" || event.kind === "create") {
          handler(event);
        }
      }
    } catch (error) {
      // Watcher was closed, this is expected when unwatching
      if (error instanceof Error && error.message !== "FS watcher closed") {
        logger.error("Watcher error", { workspaceId, error: error.message });
      }
    }
  }

  async unwatchWorkspace(workspaceId: string) {
    // Close watcher
    const watcher = this.watchers.get(workspaceId);
    if (watcher) {
      try {
        watcher.close();
      } catch (_error) {
        // Ignore errors on close
      }
      this.watchers.delete(workspaceId);
    }

    // Cancel debounced handler
    this.debouncedHandlers.delete(workspaceId);

    // Wait for watcher task to complete
    const task = this.watcherTasks.get(workspaceId);
    if (task) {
      await task;
      this.watcherTasks.delete(workspaceId);
    }

    // Clear file hash for this workspace's config file
    const configPath = this.workspaceConfigPaths.get(workspaceId);
    if (configPath) {
      this.fileHashes.delete(configPath);
      this.workspaceConfigPaths.delete(workspaceId);
    }

    logger.info("Stopped watching workspace configuration", { workspaceId });
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
      const { parse } = await import("@std/yaml");
      const config = parse(configContent);

      // Use existing validation
      const { WorkspaceConfigSchema } = await import("@atlas/config");
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

  private async hasFileChanged(filePath: string): Promise<boolean> {
    try {
      // Check file size first
      const stats = await Deno.stat(filePath);
      if (stats.size > this.maxConfigSize) {
        logger.warn("Config file too large for hash check", {
          filePath,
          size: stats.size,
          maxSize: this.maxConfigSize,
        });
        return false;
      }

      const content = await Deno.readTextFile(filePath);
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(content),
      );
      const hashHex = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const previousHash = this.fileHashes.get(filePath);
      this.fileHashes.set(filePath, hashHex);

      return previousHash !== hashHex;
    } catch (error) {
      logger.error("Error checking file hash", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async stop() {
    // Stop all watchers
    const workspaceIds = Array.from(this.watchers.keys());
    await Promise.all(workspaceIds.map((id) => this.unwatchWorkspace(id)));
  }
}
