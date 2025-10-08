# File Watching Auto-Reload Plan for Workspace Configuration

## Overview

Implement automatic runtime reload when `workspace.yml` files are modified, ensuring consistency
between configuration files and running workspaces without manual intervention.

## Architecture Design

### 1. File Watcher Component

Create a new `WorkspaceFileWatcher` class in the daemon that:

- Monitors ONLY active workspace runtimes for `workspace.yml` changes
- Starts watching when a runtime is created
- Stops watching when a runtime is destroyed
- Uses Deno's native file watching API (`Deno.watchFs`)
- Implements debouncing to handle rapid successive changes
- Integrates with existing runtime destruction/recreation logic

### 2. Integration Points

```typescript
// In AtlasDaemon class
class AtlasDaemon {
  private fileWatcher?: WorkspaceFileWatcher;

  async start() {
    // ... existing code ...

    // Initialize file watcher (but don't start watching yet)
    this.fileWatcher = new WorkspaceFileWatcher({
      onConfigChange: this.handleWorkspaceConfigChange.bind(this),
      debounceMs: 1000, // Wait 1 second after last change
    });
  }

  // Modified getOrCreateWorkspaceRuntime to start watching
  async getOrCreateWorkspaceRuntime(workspaceId: string): Promise<WorkspaceRuntime> {
    // ... existing runtime creation code ...

    // Start watching this workspace's config file
    if (this.fileWatcher && !this.runtimes.has(workspaceId)) {
      const workspace = await this.workspaceManager.find({ id: workspaceId });
      if (workspace) {
        await this.fileWatcher.watchWorkspace(workspace);
      }
    }

    // ... rest of method ...
  }

  // Modified destroyWorkspaceRuntime to stop watching
  async destroyWorkspaceRuntime(workspaceId: string) {
    // Stop watching before destroying
    if (this.fileWatcher) {
      await this.fileWatcher.unwatchWorkspace(workspaceId);
    }

    // ... existing destruction code ...
  }

  private async handleWorkspaceConfigChange(workspaceId: string, filePath: string) {
    logger.info("Workspace configuration changed, reloading runtime", {
      workspaceId,
      filePath,
    });

    // Reuse existing runtime destruction logic
    await this.destroyWorkspaceRuntime(workspaceId);
  }
}
```

### 3. WorkspaceFileWatcher Implementation

```typescript
// New file: apps/atlasd/src/workspace-file-watcher.ts
import { logger } from "@atlas/logger";
import { debounce } from "@std/async";
import { join } from "@std/path";

interface WorkspaceFileWatcherOptions {
  onConfigChange: (workspaceId: string, filePath: string) => Promise<void>;
  debounceMs?: number;
}

export class WorkspaceFileWatcher {
  private watchers = new Map<string, Deno.FsWatcher>();
  private debouncedHandlers = new Map<string, (...args: any[]) => void>();
  private watcherTasks = new Map<string, Promise<void>>();

  constructor(private options: WorkspaceFileWatcherOptions) {}

  async watchWorkspace(workspace: Workspace) {
    // Don't watch if already watching
    if (this.watchers.has(workspace.id)) {
      return;
    }

    const configPath = join(workspace.path, "workspace.yml");

    try {
      // Create watcher for the workspace directory
      const watcher = Deno.watchFs(workspace.path, { recursive: false });
      this.watchers.set(workspace.id, watcher);

      // Create debounced handler for this workspace
      const debouncedHandler = debounce(
        async (event: Deno.FsEvent) => {
          if (event.paths.some((p) => p.endsWith("workspace.yml"))) {
            await this.handleConfigChange(workspace.id, configPath);
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
      logger.error("Failed to watch workspace", {
        workspaceId: workspace.id,
        error: error.message,
      });
    }
  }

  private async startWatching(
    workspaceId: string,
    watcher: Deno.FsWatcher,
    handler: (...args: any[]) => void,
  ) {
    try {
      for await (const event of watcher) {
        if (event.kind === "modify" || event.kind === "create") {
          handler(event);
        }
      }
    } catch (error) {
      // Watcher was closed, this is expected when unwatching
      if (error.message !== "FS watcher closed") {
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
      } catch (error) {
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

    logger.info("Stopped watching workspace configuration", { workspaceId });
  }

  private async handleConfigChange(workspaceId: string, filePath: string) {
    try {
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
        error: error.message,
      });
    }
  }

  async stop() {
    // Stop all watchers
    const workspaceIds = Array.from(this.watchers.keys());
    await Promise.all(workspaceIds.map((id) => this.unwatchWorkspace(id)));
  }
}
```

### 4. Enhanced Features

#### 4.1 Selective Reloading

- Only reload if the runtime is currently active
- Check for active sessions and wait/warn appropriately
- Implement same logic as HTTP update endpoint

#### 4.2 Change Detection Optimization

```typescript
// Store file hashes to detect actual changes vs touch events
private fileHashes = new Map<string, string>();

private async hasFileChanged(filePath: string): Promise<boolean> {
  const content = await Deno.readTextFile(filePath);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content)
  );
  const hashHex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  const previousHash = this.fileHashes.get(filePath);
  this.fileHashes.set(filePath, hashHex);

  return previousHash !== hashHex;
}
```

#### 4.3 Notification System

```typescript
// Notify about reload events via SSE
private async notifyReload(workspaceId: string, status: "started" | "completed" | "failed") {
  const event = {
    type: "workspace.reload",
    workspaceId,
    status,
    timestamp: new Date().toISOString(),
  };

  // Broadcast to SSE clients
  this.broadcastToSSEClients(workspaceId, event);
}
```

### 5. Configuration Options

Add to daemon configuration:

```typescript
interface DaemonConfig {
  // ... existing config ...
  fileWatcher?: {
    enabled: boolean;
    debounceMs: number;
    ignorePatterns?: string[]; // e.g., ["*.tmp", "*.backup-*"]
  };
}
```

### 6. Error Handling & Edge Cases

1. **Rapid successive changes**: Debouncing prevents reload storms
2. **Invalid configurations**: Validate before reload, log errors
3. **Missing permissions**: Gracefully handle watch permission errors
4. **Workspace addition/removal**: Update watchers dynamically
5. **Circular reload prevention**: Ensure our own writes don't trigger reloads

### 7. Testing Strategy

1. **Unit tests**: Mock file system events, test debouncing
2. **Integration tests**: Real file changes, verify runtime reload
3. **Error scenarios**: Invalid configs, permission issues
4. **Performance tests**: Many workspaces, rapid changes

### 8. Implementation

✅ **COMPLETED** - Single cohesive implementation including:

- ✅ WorkspaceFileWatcher with debouncing (`apps/atlasd/src/workspace-file-watcher.ts`)
- ✅ Integration with runtime lifecycle in AtlasDaemon
- ✅ Hash-based change detection to avoid unnecessary reloads
- ✅ Error handling with proper TypeScript types
- ✅ Comprehensive test suite (`apps/atlasd/src/workspace-file-watcher_test.ts`)

#### Implementation Details:

1. **WorkspaceFileWatcher Class**: Created with debouncing, hash-based change detection, and proper
   cleanup
2. **AtlasDaemon Integration**:
   - File watcher initialized during daemon startup
   - Starts watching when runtime is created
   - Stops watching when runtime is destroyed
   - Properly cleaned up on daemon shutdown
   - Uses actual configPath from workspace entry instead of hardcoded "workspace.yml"
3. **Tests**: 7 comprehensive tests covering all major functionality:
   - Change detection
   - Invalid configuration handling
   - Debouncing of rapid changes
   - Hash-based duplicate detection
   - Proper cleanup on unwatch
   - Race condition handling during workspace destruction
   - Path discrimination to prevent false matches
4. **Recent Improvements**:
   - Added race condition protection in handleConfigChange
   - Improved path resolution using consistent normalization
   - Removed fragile endsWith fallback to prevent false matches
   - Added test to verify correct file discrimination

## Benefits

1. **Seamless experience**: Changes via any tool automatically reflected
2. **Consistency**: No more config/runtime mismatches
3. **Developer friendly**: Edit with any editor, see immediate results
4. **Backward compatible**: Works with existing tools and workflows

## Potential Concerns & Mitigations

1. **Performance**: Minimal overhead with debouncing and hash checks
2. **Stability**: Validate configs before reload, handle errors gracefully
3. **User awareness**: SSE notifications keep users informed
4. **Opt-out option**: Can be disabled via configuration

This approach provides automatic synchronization between configuration files and running workspaces
while maintaining system stability and performance.
