import { readFile, stat } from "node:fs/promises";
import { WorkspaceConfigSchema } from "@atlas/config";
import { createFsWatchRunner, type FsWatchRunner } from "@atlas/fs-watch";
import { logger } from "@atlas/logger";
import { basename, dirname, join, resolve } from "@std/path";
import { parse } from "@std/yaml";
import type { WorkspaceEntry } from "../types.ts";

interface WorkspaceConfigWatcherOptions {
  onConfigChange: (
    workspaceId: string,
    change: { filePath: string } | { oldPath: string; newPath?: string },
  ) => Promise<void>;
  debounceMs?: number;
  maxConfigSize?: number; // Maximum config file size in bytes
}

export class WorkspaceConfigWatcher {
  private watchers = new Map<string, { fileRunner: FsWatchRunner; dirRunner: FsWatchRunner }>();
  private workspaceConfigPaths = new Map<string, string>();
  private readonly maxConfigSize: number;
  private lastConfigHashByWorkspace = new Map<string, string>();

  constructor(private options: WorkspaceConfigWatcherOptions) {
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

    const { absoluteConfigPath, configDir, parentDir, configFileName } =
      this.normalizeConfigPaths(configPath);

    // Store the config path for this workspace
    this.workspaceConfigPaths.set(workspace.id, configPath);

    // Initialize baseline content hash if file exists and is readable
    await this.initializeBaselineHash(workspace.id, absoluteConfigPath);

    try {
      const fileRunner = this.createFileWatcherRunner(workspace.id, absoluteConfigPath);
      const dirRunner = this.createDirWatcherRunner(
        workspace.id,
        configDir,
        parentDir,
        configFileName,
        absoluteConfigPath,
      );

      this.watchers.set(workspace.id, { fileRunner, dirRunner });

      logger.debug("Started watching workspace configuration", {
        workspaceId: workspace.id,
        path: workspace.path,
      });
    } catch (error) {
      // Clean up stored config path if watching fails
      this.workspaceConfigPaths.delete(workspace.id);

      logger.error("Failed to watch workspace", { workspaceId: workspace.id, error: error });
    }
  }

  unwatchWorkspace(workspaceId: string) {
    // Close watchers
    this.stopWatchers(workspaceId);

    // Clear file hash for this workspace's config file
    const configPath = this.workspaceConfigPaths.get(workspaceId);
    if (configPath) {
      this.workspaceConfigPaths.delete(workspaceId);
    }
    this.lastConfigHashByWorkspace.delete(workspaceId);

    logger.info("Stopped watching workspace configuration", { workspaceId });
    // keep async contract
  }

  private stopWatchers(workspaceId: string): void {
    const runners = this.watchers.get(workspaceId);
    if (!runners) return;
    try {
      runners.fileRunner.stop();
    } catch {
      // ignore
    }
    try {
      runners.dirRunner.stop();
    } catch {
      // ignore
    }
    this.watchers.delete(workspaceId);
  }

  private async handleFsEvent(
    workspaceId: string,
    filePath: string,
    kind: Deno.FsEvent["kind"],
  ): Promise<void> {
    logger.debug("Workspace config file watcher event received", { workspaceId, filePath, kind });
    // Ensure we're still watching this workspace
    if (!this.watchers.has(workspaceId)) {
      logger.debug("Workspace no longer watched, skipping fs event", { workspaceId });
      return;
    }

    if (kind === "remove") {
      this.lastConfigHashByWorkspace.delete(workspaceId);
      await this.options.onConfigChange(workspaceId, { filePath });
      return;
    }

    try {
      const tooLarge = await this.isConfigTooLarge(filePath);
      if (tooLarge) {
        return;
      }

      const { content, hash } = await this.readConfigAndHash(filePath);

      const previousHash = this.lastConfigHashByWorkspace.get(workspaceId);
      if (previousHash && previousHash === hash) {
        logger.debug("Workspace config unchanged (hash match), skipping reload", { workspaceId });
        return;
      }

      const isValid = this.validateConfigOrLog(workspaceId, content);
      if (!isValid) {
        return;
      }

      this.lastConfigHashByWorkspace.set(workspaceId, hash);
      await this.options.onConfigChange(workspaceId, { filePath });
    } catch (error) {
      logger.error("Error handling config change", { workspaceId, error: error });
    }
  }

  private async computeSha256Hex(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const byte of bytes) {
      const byteHex = byte.toString(16).padStart(2, "0");
      hex += byteHex;
    }
    return hex;
  }

  stop() {
    // Stop all watchers
    const workspaceIds = Array.from(this.watchers.keys());
    workspaceIds.map((id) => this.unwatchWorkspace(id));
  }

  // ----- Private helpers: path normalization and setup -----
  private normalizeConfigPaths(configPath: string): {
    absoluteConfigPath: string;
    configDir: string;
    parentDir: string;
    configFileName: string;
  } {
    const absoluteConfigPath = resolve(configPath);
    const configDir = dirname(absoluteConfigPath);
    const parentDir = dirname(configDir);
    const configFileName = basename(absoluteConfigPath);
    return { absoluteConfigPath, configDir, parentDir, configFileName };
  }

  private async initializeBaselineHash(
    workspaceId: string,
    absoluteConfigPath: string,
  ): Promise<void> {
    try {
      const initialContent = await readFile(absoluteConfigPath, "utf-8");
      const initialHash = await this.computeSha256Hex(initialContent);
      this.lastConfigHashByWorkspace.set(workspaceId, initialHash);
    } catch (error) {
      logger.debug("Could not initialize workspace config hash", {
        workspaceId,
        path: absoluteConfigPath,
        error: error,
      });
    }
  }

  // ----- Private helpers: watcher creation -----

  private createFileWatcherRunner(workspaceId: string, absoluteConfigPath: string): FsWatchRunner {
    return createFsWatchRunner({
      watchPath: absoluteConfigPath,
      recursive: false,
      debounceMs: this.options.debounceMs || 1000,
      filterKind: (k) => k === "modify" || k === "remove" || k === "rename",
      onEvent: async (event: Deno.FsEvent) => {
        await this.onFileWatcherEvent(workspaceId, absoluteConfigPath, event);
      },
    });
  }

  private createDirWatcherRunner(
    workspaceId: string,
    configDir: string,
    parentDir: string,
    configFileName: string,
    absoluteConfigPath: string,
  ): FsWatchRunner {
    return createFsWatchRunner({
      watchPath: parentDir,
      recursive: false,
      debounceMs: this.options.debounceMs || 1000,
      filterKind: (k) => k === "rename" || k === "remove",
      onEvent: async (event: Deno.FsEvent) => {
        await this.onDirWatcherEvent(
          workspaceId,
          configDir,
          parentDir,
          configFileName,
          absoluteConfigPath,
          event,
        );
      },
    });
  }

  // ----- Private helpers: watcher event handling -----

  private async onFileWatcherEvent(
    workspaceId: string,
    absoluteConfigPath: string,
    event: Deno.FsEvent,
  ): Promise<void> {
    logger.debug("workspace config file fs event", {
      workspaceId,
      kind: event.kind,
      paths: event.paths,
      watchedPath: absoluteConfigPath,
    });

    if (event.kind === "rename") {
      const newPath = this.getRenamedPath(absoluteConfigPath, event);
      logger.debug("workspace config rename detected (file watcher)", {
        workspaceId,
        oldPath: absoluteConfigPath,
        newPath,
      });
      await this.handleRename(workspaceId, absoluteConfigPath, newPath);
      return;
    }

    if (event.kind === "remove") {
      await this.handleRemoval(workspaceId, absoluteConfigPath);
      return;
    }

    await this.handleFsEvent(workspaceId, absoluteConfigPath, event.kind);
  }

  private async onDirWatcherEvent(
    workspaceId: string,
    configDir: string,
    parentDir: string,
    configFileName: string,
    absoluteConfigPath: string,
    event: Deno.FsEvent,
  ): Promise<void> {
    logger.debug("workspace config dir fs event", {
      workspaceId,
      kind: event.kind,
      paths: event.paths,
      watchedPath: parentDir,
    });

    const affectsWorkspaceDir = event.paths.some((p) => resolve(p) === configDir);
    if (!affectsWorkspaceDir) return;

    if (event.kind === "rename") {
      const newDir = event.paths.find((p) => resolve(p) !== configDir);
      const newPath = newDir ? join(resolve(newDir), configFileName) : undefined;
      logger.debug("workspace directory rename detected (dir watcher)", {
        workspaceId,
        oldDir: configDir,
        newDir,
        oldPath: absoluteConfigPath,
        newPath,
      });
      await this.handleRename(workspaceId, absoluteConfigPath, newPath);
      return;
    }

    await this.handleRemoval(workspaceId, absoluteConfigPath);
  }

  private getRenamedPath(oldAbsolutePath: string, event: Deno.FsEvent): string | undefined {
    if (!event.paths || event.paths.length < 2) return undefined;
    const oldNorm = oldAbsolutePath;
    const candidate = event.paths.find((p) => resolve(p) !== oldNorm);
    return candidate;
  }

  private async handleRename(
    workspaceId: string,
    oldPath: string,
    newPath?: string,
  ): Promise<void> {
    // CRITICAL: Atomic save detection
    //
    // ROOT CAUSE CONTEXT:
    // Modern editors (vim, VS Code, etc.) use atomic renames for safe file saves:
    //   1. Write content to workspace.yml.tmp
    //   2. rename(workspace.yml.tmp, workspace.yml) - atomically replaces original
    //
    // On macOS, Deno.watchFs emits a SINGLE-PATH rename event for these atomic saves:
    //   { kind: "rename", paths: ["/path/to/workspace.yml"] }  // Only 1 path!
    //
    // This is different from true renames which provide both old and new paths:
    //   { kind: "rename", paths: ["/old/path", "/new/path"] }  // 2 paths
    //
    // THE BUG CHAIN (before this fix):
    //   1. Watcher receives single-path rename event
    //   2. getRenamedPath() returns undefined (expects 2 paths)
    //   3. handleRename() called with newPath=undefined
    //   4. Watcher calls stopWatchers() - kills all file monitoring
    //   5. Manager treats as deletion via handleWatcherChange()
    //   6. unregisterWorkspaceStates() deletes cron timers from persistent storage
    //   7. Result: zombie workspace (registered but no timers, no watchers)
    //
    // THE FIX:
    // Detect atomic saves by checking newPath === undefined. When detected:
    //   - Treat as file modification (config reload)
    //   - Keep watchers ACTIVE (don't stop them)
    //   - Cron timers get restarted via restartSignalsForWorkspace()
    //   - File watching continues normally
    //
    // WHY NO exists() CHECK:
    // Earlier versions checked `await exists(oldPath)` before treating as atomic save.
    // This was removed because:
    //   1. File deletions emit "remove" events, not "rename" events
    //   2. Manager already handles deletion detection via determineChangeType()
    //   3. Unnecessary I/O on every file save
    //   4. Violates separation of concerns:
    //      - Watcher: Detects filesystem event types (rename vs remove vs modify)
    //      - Manager: Determines actual state (exists vs deleted vs invalid)
    //
    // If the file truly doesn't exist, the manager will detect it and handle cleanup.
    if (!newPath) {
      // Atomic save - treat as modification, keep watchers active
      logger.debug("atomic save detected, treating as modification", {
        workspaceId,
        path: oldPath,
      });
      await this.options.onConfigChange(workspaceId, { filePath: oldPath });
      return;
    }

    // True rename - stop watchers, manager will handle re-attachment
    this.stopWatchers(workspaceId);
    await this.options.onConfigChange(workspaceId, { oldPath, newPath });
  }

  private async handleRemoval(workspaceId: string, filePath: string): Promise<void> {
    // Stop both watchers when file or directory is removed
    this.stopWatchers(workspaceId);
    await this.options.onConfigChange(workspaceId, { filePath });
  }

  // ----- Private helpers: config validation -----

  private async isConfigTooLarge(filePath: string): Promise<boolean> {
    const stats = await stat(filePath);
    if (stats.size > this.maxConfigSize) {
      logger.warn("Config file too large, skipping reload", {
        filePath,
        size: stats.size,
        maxSize: this.maxConfigSize,
      });
      return true;
    }
    return false;
  }

  private async readConfigAndHash(filePath: string): Promise<{ content: string; hash: string }> {
    const content = await readFile(filePath, "utf-8");
    const hash = await this.computeSha256Hex(content);
    return { content, hash };
  }

  private validateConfigOrLog(workspaceId: string, content: string): boolean {
    const config = parse(content);
    const validationResult = WorkspaceConfigSchema.safeParse(config);
    if (!validationResult.success) {
      logger.error("Invalid workspace configuration detected, skipping reload", {
        workspaceId,
        errors: validationResult.error.issues,
      });
      return false;
    }
    return true;
  }
}
