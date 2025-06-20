# Multi-Workspace Background Process Architecture

## Overview

This document outlines the architecture for extending Atlas to support running multiple workspaces
as background processes. Currently, Atlas can only serve a single workspace attached to the
terminal. This enhancement will enable users to run multiple workspaces concurrently as detached
processes with proper lifecycle management.

## Goals

- Enable detached workspace execution with `atlas workspace serve -d`
- Support multiple concurrent workspace instances
- Provide comprehensive workspace lifecycle management (start, stop, restart)
- Implement robust logging and monitoring for background processes
- Enable easy debugging and troubleshooting of detached workspaces

## Architecture Components

### 1. Workspace Registry

A persistent registry stored at `~/.atlas/registry.json` that tracks all registered workspaces and
their current state.

#### Schema

```typescript
interface WorkspaceRegistry {
  version: string; // Registry schema version for future migrations
  workspaces: WorkspaceEntry[];
  lastUpdated: string; // ISO timestamp
}

interface WorkspaceEntry {
  // Identification
  id: string; // UUID for unique identification
  name: string; // Human-readable name

  // Location
  path: string; // Absolute path to workspace directory
  configPath: string; // Path to workspace.yml

  // Runtime state
  status: WorkspaceStatus;
  pid?: number; // Process ID when running
  port?: number; // HTTP server port

  // Timestamps
  createdAt: string; // When workspace was registered
  startedAt?: string; // Last start time
  stoppedAt?: string; // Last stop time
  lastHealthCheck?: string;

  // Metadata
  metadata?: {
    version?: string; // Atlas version that started it
    environment?: Record<string, string>;
    tags?: string[];
  };
}

enum WorkspaceStatus {
  STOPPED = "stopped", // Not running
  STARTING = "starting", // Process spawned, waiting for ready
  RUNNING = "running", // Process running and healthy
  STOPPING = "stopping", // Shutdown signal sent
  CRASHED = "crashed", // Process died unexpectedly
  UNKNOWN = "unknown", // State cannot be determined
}
```

### 2. Process Management

#### 2.1 WorkspaceRegistryManager

Handles all registry operations with file locking to prevent race conditions.

```typescript
class WorkspaceRegistryManager {
  private registryPath: string;
  private lockFile: string;

  constructor() {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
    this.registryPath = join(homeDir, ".atlas", "registry.json");
    this.lockFile = `${this.registryPath}.lock`;
  }

  // Core operations
  async initialize(): Promise<void>;
  async register(entry: Omit<WorkspaceEntry, "id" | "createdAt">): Promise<WorkspaceEntry>;
  async unregister(id: string): Promise<void>;
  async updateStatus(
    id: string,
    status: WorkspaceStatus,
    updates?: Partial<WorkspaceEntry>,
  ): Promise<void>;

  // Query operations
  async findById(id: string): Promise<WorkspaceEntry | null>;
  async findByName(name: string): Promise<WorkspaceEntry | null>;
  async findByPath(path: string): Promise<WorkspaceEntry | null>;
  async listAll(): Promise<WorkspaceEntry[]>;
  async getRunning(): Promise<WorkspaceEntry[]>;

  // Maintenance
  async cleanupStale(): Promise<void>; // Remove entries for non-existent processes
  async backup(): Promise<void>; // Create registry backup
}
```

#### 2.2 WorkspaceProcessManager

Manages the lifecycle of workspace processes.

```typescript
class WorkspaceProcessManager {
  constructor(private registry: WorkspaceRegistryManager) {}

  // Process control
  async startDetached(entry: WorkspaceEntry, options: StartOptions): Promise<number>;
  async stop(id: string, graceful: boolean = true): Promise<void>;
  async restart(id: string): Promise<void>;

  // Process monitoring
  async isRunning(pid: number): Promise<boolean>;
  async getProcessInfo(pid: number): Promise<ProcessInfo | null>;
  async waitForReady(id: string, timeout: number = 30000): Promise<boolean>;

  // Port management
  async findAvailablePort(preferred?: number): Promise<number>;
  async isPortAvailable(port: number): Promise<boolean>;
}

interface StartOptions {
  port?: number;
  env?: Record<string, string>;
  logLevel?: string;
  additionalFlags?: string[];
}

interface ProcessInfo {
  pid: number;
  ppid: number;
  cpu: number;
  memory: number;
  uptime: number;
}
```

### 3. Detached Process Implementation

Based on the research in `deno-background-output.md`, implement proper process detachment:

```typescript
async startDetached(entry: WorkspaceEntry, options: StartOptions): Promise<number> {
  const logFile = join(this.getLogDir(), "workspaces", `${entry.id}.log`);
  
  // Prepare command arguments
  const args = [
    "run",
    "--allow-read",
    "--allow-write", 
    "--allow-net",
    "--allow-env",
    "--unstable-broadcast-channel",
    "--unstable-worker-options",
    join(Deno.cwd(), "src/cli.tsx"),
    "workspace",
    "serve",
    "--internal-detached",  // Special flag for detached mode
    "--workspace-id", entry.id,
    "--workspace-path", entry.path,
    "--port", (options.port || entry.port).toString(),
    "--log-file", logFile,
  ];
  
  if (options.additionalFlags) {
    args.push(...options.additionalFlags);
  }
  
  // Create detached process
  const cmd = new Deno.Command(Deno.execPath(), {
    args,
    stdin: "null",    // Critical for detachment
    stdout: "null",   // Redirect to /dev/null
    stderr: "null",   // Redirect to /dev/null
    env: {
      ...Deno.env.toObject(),
      ATLAS_WORKSPACE_ID: entry.id,
      ATLAS_WORKSPACE_NAME: entry.name,
      ATLAS_DETACHED: "true",
      ...options.env,
    },
  });
  
  const child = cmd.spawn();
  child.unref();  // Detach from parent process
  
  // Update registry immediately
  await this.registry.updateStatus(entry.id, WorkspaceStatus.STARTING, {
    pid: child.pid,
    startedAt: new Date().toISOString(),
  });
  
  return child.pid;
}
```

### 4. Enhanced CLI Commands

#### 4.1 CLI Integration

The CLI uses a meow-based parser in `src/cli.tsx`. We need to:

1. Add new flags to the meow configuration:

```typescript
// In src/cli.tsx
flags: {
  // ... existing flags ...
  detached: {
    type: "boolean",
    shortFlag: "d",
    default: false,
  },
  "internal-detached": {
    type: "boolean",
    default: false,
  },
  "workspace-id": {
    type: "string",
  },
  "workspace-path": {
    type: "string",
  },
  "log-file": {
    type: "string",
  },
}
```

2. The CLI already routes `workspace` commands properly, so detached mode will work with existing
   shortcuts:

```bash
# All of these will work for detached mode:
atlas workspace serve -d
atlas work serve -d
atlas w serve -d
atlas work -d  # defaults to serve
```

#### 4.2 Workspace Serve Command

Modify the existing workspace serve command to support detached mode:

```bash
# Attached mode (current behavior)
atlas workspace serve

# Detached mode
atlas workspace serve -d
atlas workspace serve --detached
atlas workspace serve -d --name "my-workspace" --port 8080

# Options
--detached, -d         Run workspace in background
--name <name>         Set workspace name (default: directory name)
--port <port>         HTTP server port (default: auto-assign)
--log-level <level>   Set log level (error, warn, info, debug)
```

#### 4.2 New Workspace Management Commands

```bash
# List all workspaces
atlas workspace list [--format json|table]
atlas workspace ls

# Output example:
# ID        NAME           STATUS    PORT   PID     UPTIME
# a1b2c3    my-workspace   running   8080   12345   2h 15m
# d4e5f6    test-ws       stopped   -      -       -

# Stop a workspace
atlas workspace stop <id|name> [--force]

# Get workspace status
atlas workspace status <id|name> [--format json|yaml]

# Restart a workspace
atlas workspace restart <id|name>

# Remove workspace from registry
atlas workspace remove <id|name> [--force]

# Show workspace information
atlas workspace info <id|name>
```

#### 4.3 Enhanced Logs Command

```bash
# Tail logs from detached workspace
atlas logs <workspace-id|name> [options]

# Options
--follow, -f          Follow log output
--lines, -n <num>     Number of lines to show (default: 100)
--since <duration>    Show logs since duration (e.g., "5m", "1h")
--level <level>       Filter by log level
--format <format>     Output format (text, json)
```

### 5. Internal Process Communication

#### 5.1 Health Check Endpoint

Each workspace server will expose a health endpoint:

```typescript
// In workspace server
if (Deno.env.get("ATLAS_DETACHED") === "true") {
  server.addRoute("/health", async (req) => {
    return new Response(
      JSON.stringify({
        status: "healthy",
        workspaceId: Deno.env.get("ATLAS_WORKSPACE_ID"),
        uptime: process.uptime(),
        memory: Deno.memoryUsage(),
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  });
}
```

#### 5.2 Graceful Shutdown

Handle signals properly in detached mode:

```typescript
if (Deno.env.get("ATLAS_DETACHED") === "true") {
  const workspaceId = Deno.env.get("ATLAS_WORKSPACE_ID")!;
  const registry = new WorkspaceRegistryManager();

  // Handle SIGTERM for graceful shutdown
  Deno.addSignalListener("SIGTERM", async () => {
    await registry.updateStatus(workspaceId, WorkspaceStatus.STOPPING);
    logger.info("Received SIGTERM, shutting down gracefully...");

    // Shutdown server and workers
    await server.shutdown();
    await workerManager.terminateAll();

    // Update final status
    await registry.updateStatus(workspaceId, WorkspaceStatus.STOPPED, {
      stoppedAt: new Date().toISOString(),
      pid: undefined,
    });

    Deno.exit(0);
  });

  // Handle SIGINT (Ctrl+C) - should not happen in detached mode
  Deno.addSignalListener("SIGINT", async () => {
    logger.warn("Received SIGINT in detached mode");
    // Same shutdown procedure
  });
}
```

### 6. Monitoring and Recovery

#### 6.1 Health Monitor Approaches

Since we don't maintain state across system restarts (workspaces will appear as CRASHED after a
reboot), health monitoring is implemented through two complementary approaches:

##### Approach A: Lazy Health Checks (Recommended)

Perform health checks on-demand when users interact with workspaces:

```typescript
class WorkspaceRegistryManager {
  // Called before any operation that displays workspace status
  async checkAndUpdateHealth(workspace: WorkspaceEntry): Promise<WorkspaceEntry> {
    if (workspace.status === WorkspaceStatus.RUNNING && workspace.pid) {
      const isRunning = await this.processManager.isRunning(workspace.pid);

      if (!isRunning) {
        await this.updateStatus(workspace.id, WorkspaceStatus.CRASHED, {
          stoppedAt: new Date().toISOString(),
          pid: undefined,
        });
        workspace.status = WorkspaceStatus.CRASHED;
      } else if (workspace.port) {
        // Optionally check HTTP health
        const healthy = await this.checkHttpHealth(workspace.port);
        workspace.lastHealthCheck = new Date().toISOString();
      }
    }

    return workspace;
  }

  // Enhanced listAll with health checks
  async listAllWithHealthCheck(): Promise<WorkspaceEntry[]> {
    const workspaces = await this.listAll();
    return Promise.all(workspaces.map((ws) => this.checkAndUpdateHealth(ws)));
  }
}
```

##### Approach B: Optional Daemon Process

For users who want active monitoring, provide an optional monitoring daemon:

```bash
# Start the health monitor daemon
atlas monitor start [-d|--daemon]

# Stop the monitor
atlas monitor stop

# Check monitor status
atlas monitor status
```

Implementation:

```typescript
// src/cli/commands/monitor.tsx
class MonitorCommand {
  async start(flags: { daemon?: boolean }): Promise<void> {
    if (flags.daemon) {
      // Start as detached process
      const cmd = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-all",
          join(Deno.cwd(), "src/cli.tsx"),
          "monitor",
          "start",
          "--internal-daemon",
        ],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      });

      const child = cmd.spawn();
      child.unref();

      console.log(`Monitor daemon started with PID: ${child.pid}`);
    } else {
      // Run in foreground
      const monitor = new WorkspaceHealthMonitor();
      await monitor.startMonitoring();
    }
  }
}

class WorkspaceHealthMonitor {
  private checkInterval = 30000; // 30 seconds
  private registry: WorkspaceRegistryManager;
  private processManager: WorkspaceProcessManager;

  constructor() {
    this.registry = new WorkspaceRegistryManager();
    this.processManager = new WorkspaceProcessManager(this.registry);
  }

  async startMonitoring(): Promise<void> {
    console.log("Starting workspace health monitor...");

    // Initial check
    await this.checkAllWorkspaces();

    // Set up interval
    setInterval(async () => {
      await this.checkAllWorkspaces();
    }, this.checkInterval);

    // Keep process alive
    await new Promise(() => {});
  }

  private async checkAllWorkspaces(): Promise<void> {
    const running = await this.registry.getRunning();

    for (const workspace of running) {
      try {
        await this.registry.checkAndUpdateHealth(workspace);
      } catch (error) {
        logger.error(`Health check failed for ${workspace.name}: ${error}`);
      }
    }
  }
}
```

### 7. Logging Architecture

#### 7.1 Log File Management

Enhance the existing logger to support explicit log files for detached processes:

```typescript
// In AtlasLogger
async initializeDetached(options: DetachedLogOptions): Promise<void> {
  const { logFile, workspaceId, workspaceName } = options;
  
  // Set up file writer for detached mode
  this.fileWriter = await Deno.open(logFile, {
    create: true,
    write: true,
    append: true,
  });
  
  // Write startup entry
  await this.writeLog("workspace", {
    level: "info",
    message: `Workspace ${workspaceName} starting in detached mode`,
    timestamp: new Date().toISOString(),
    pid: Deno.pid,
    context: {
      workspaceId,
      workspaceName,
      mode: "detached",
    },
  });
}

interface DetachedLogOptions {
  logFile: string;
  workspaceId: string;
  workspaceName: string;
}
```

#### 7.2 Log Rotation

Implement log rotation for long-running processes:

```typescript
class LogRotator {
  private maxSize = 10 * 1024 * 1024; // 10MB
  private maxFiles = 5;

  async rotateIfNeeded(logFile: string): Promise<void> {
    const stat = await Deno.stat(logFile);

    if (stat.size > this.maxSize) {
      // Rotate files: .log -> .log.1, .log.1 -> .log.2, etc.
      for (let i = this.maxFiles - 1; i > 0; i--) {
        const oldFile = `${logFile}.${i}`;
        const newFile = `${logFile}.${i + 1}`;

        try {
          await Deno.rename(oldFile, newFile);
        } catch {
          // File doesn't exist, skip
        }
      }

      // Move current to .1
      await Deno.rename(logFile, `${logFile}.1`);
    }
  }
}
```

### 8. Implementation Phases

#### Phase 1: Core Infrastructure (Priority: High)

1. Implement WorkspaceRegistry and WorkspaceRegistryManager
2. Create WorkspaceProcessManager with basic start/stop
3. Modify workspace serve command to support -d flag
4. Implement detached process spawning with proper stdio handling

#### Phase 2: Process Management (Priority: High)

1. Implement workspace list command with lazy health checks
2. Add workspace stop command with graceful shutdown
3. Create workspace status command
4. Add process existence checking during registry operations

#### Phase 3: Monitoring & Logs (Priority: Medium)

1. Enhance logs command for detached workspaces
2. Implement health check endpoint in workspace server
3. Add optional monitor daemon command
4. Create log rotation mechanism

#### Phase 4: Advanced Features (Priority: Low)

1. Implement workspace restart command
2. Add configurable health check intervals
3. Create workspace batch operations
4. Add workspace resource usage tracking

### 9. Security Considerations

1. **Process Isolation**: Each workspace runs with the same permissions as the user
2. **Port Security**: Validate port assignments to prevent conflicts
3. **Log Access**: Ensure log files have appropriate permissions
4. **Registry Integrity**: Use file locking to prevent corruption
5. **Signal Handling**: Prevent unauthorized process termination

### 10. Error Handling

1. **Port Conflicts**: Automatically find available ports
2. **Stale PIDs**: Clean up registry entries for dead processes
3. **Disk Space**: Monitor log file growth and implement rotation
4. **Permission Errors**: Provide clear error messages for permission issues
5. **Network Errors**: Retry health checks with exponential backoff

### 11. Future Enhancements

1. **Systemd Integration**: Generate systemd service files for Linux
2. **LaunchAgent Integration**: Create launchd configuration for macOS
3. **Web UI**: Dashboard for managing workspaces
4. **Remote Management**: API for managing workspaces remotely
5. **Clustering**: Support for distributed workspace deployment
6. **Resource Limits**: CPU and memory constraints per workspace
7. **Workspace Templates**: Quick workspace creation from templates
8. **Backup/Restore**: Workspace state snapshots

## Conclusion

This architecture provides a robust foundation for running multiple Atlas workspaces as background
processes. The design prioritizes reliability, debuggability, and user experience while maintaining
the existing single-workspace functionality. The phased implementation approach allows for
incremental development and testing of each component.
