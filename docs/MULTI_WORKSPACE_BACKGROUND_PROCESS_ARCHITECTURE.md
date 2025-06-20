# Multi-Workspace Background Process Architecture

## Overview

This document outlines the architecture for extending Atlas to support running multiple workspaces
as background processes. Currently, Atlas can only serve a single workspace attached to the
terminal. This enhancement will enable users to run multiple workspaces concurrently as detached
processes with proper lifecycle management.

## Current Status (December 2024)

### ✅ Completed Foundation Work

From the Workspace Registry Implementation Plan, the following has been completed:

1. **Core Registry Implementation (100% Complete)**
   - Full registry types and schemas with Zod validation
   - Docker-style naming system (e.g., `fervent_einstein`, `happy_turing`)
   - WorkspaceRegistryManager with all CRUD operations
   - Lazy health checks with proper status transitions
   - Auto-discovery and import of existing workspaces
   - Singleton pattern with `getWorkspaceRegistry()`

2. **CLI Integration (80% Complete)**
   - ✅ `workspace init` - Fully integrated with registry
   - ✅ `workspace list` - Shows all registered workspaces with status
   - ✅ `workspace serve` - Accepts workspace ID/name, dynamic port assignment
   - ✅ `workspace remove` - Removes workspaces from registry
   - ⏳ `workspace status` - Command exists but needs implementation
   - ⏳ `workspace cleanup` - Command exists but needs implementation

3. **Key Improvements Implemented**
   - Dynamic port assignment prevents conflicts between workspaces
   - Enhanced status tracking (STOPPED, STARTING, RUNNING, STOPPING, CRASHED)
   - Non-blocking server start with `startNonBlocking()` method
   - Simplified architecture without file-based locking

### 🚧 Remaining Work for Background Process Support

While the registry foundation is solid, true detached/background process support requires:

1. **Detached Process Spawning** - The `-d` flag implementation
2. **Process Lifecycle Management** - Start, stop, restart operations
3. **Signal Handling** - Graceful shutdown in detached mode
4. **Health Monitoring** - HTTP health endpoint and monitoring
5. **Log Management** - Streaming logs from detached processes
6. **Complete CLI Commands** - status, cleanup, enhanced logs

## Goals

- Enable detached workspace execution with `atlas workspace serve -d`
- Support multiple concurrent workspace instances
- Provide comprehensive workspace lifecycle management (start, stop, restart)
- Implement robust logging and monitoring for background processes
- Enable easy debugging and troubleshooting of detached workspaces

## Architecture Components

### 1. Workspace Registry (✅ COMPLETED)

The persistent registry at `~/.atlas/registry.json` is fully implemented with:

- Zod-validated schemas for type safety
- Docker-style naming for memorable workspace IDs
- Lazy health checks on read operations
- Atomic file operations (no lockfile needed)
- Auto-discovery of existing workspaces

### 2. Process Management (🚧 TO BE IMPLEMENTED)

#### 2.1 WorkspaceProcessManager

Manages the lifecycle of workspace processes.

```typescript
class WorkspaceProcessManager {
  constructor(private registry: WorkspaceRegistryManager) {}

  // Process control
  async startDetached(workspaceId: string, options: StartOptions): Promise<number>;
  async stop(id: string, graceful: boolean = true): Promise<void>;
  async restart(id: string): Promise<void>;

  // Process monitoring
  async isRunning(pid: number): Promise<boolean>;
  async getProcessInfo(pid: number): Promise<ProcessInfo | null>;
  async waitForReady(id: string, timeout: number = 30000): Promise<boolean>;

  // Health checks
  async checkHttpHealth(port: number): Promise<boolean>;
}

interface StartOptions {
  port?: number;
  env?: Record<string, string>;
  logLevel?: string;
  additionalFlags?: string[];
}

interface ProcessInfo {
  pid: number;
  cpu: number;
  memory: number;
  uptime: number;
}
```

### 3. Detached Process Implementation

#### 3.1 Process Spawning Strategy

Based on Deno's process model, implement proper detachment:

```typescript
async startDetached(workspaceId: string, options: StartOptions): Promise<number> {
  const registry = getWorkspaceRegistry();
  const workspace = await registry.findById(workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} not found`);

  // Find available port if not specified
  const port = options.port || await findAvailablePort();
  
  // Prepare log file
  const logFile = join(getAtlasHome(), "logs", "workspaces", `${workspaceId}.log`);
  await ensureDir(dirname(logFile));
  
  // Build command arguments
  const args = [
    "run",
    "--allow-all",
    "--unstable-broadcast-channel",
    "--unstable-worker-options",
    join(Deno.cwd(), "src/cli.tsx"),
    "workspace",
    "serve",
    workspaceId,
    "--internal-detached",
    "--port", port.toString(),
    "--log-file", logFile,
  ];
  
  // Spawn detached process
  const cmd = new Deno.Command(Deno.execPath(), {
    args,
    stdin: "null",
    stdout: "null", 
    stderr: "null",
    env: {
      ...Deno.env.toObject(),
      ATLAS_WORKSPACE_ID: workspaceId,
      ATLAS_DETACHED: "true",
      ...options.env,
    },
  });
  
  const child = cmd.spawn();
  
  // Update registry
  await registry.updateStatus(workspaceId, "starting", {
    pid: child.pid,
    port,
    startedAt: new Date().toISOString(),
  });
  
  // Detach from parent
  child.unref();
  
  return child.pid;
}
```

#### 3.2 Signal Handling in Detached Mode

Enhance workspace server to handle signals properly when detached:

```typescript
// In workspace-server.ts
if (Deno.env.get("ATLAS_DETACHED") === "true") {
  const workspaceId = Deno.env.get("ATLAS_WORKSPACE_ID")!;
  const registry = getWorkspaceRegistry();

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    await registry.updateStatus(workspaceId, "stopping");

    try {
      await server.shutdown();
      await registry.updateStatus(workspaceId, "stopped", {
        stoppedAt: new Date().toISOString(),
        pid: undefined,
      });
    } catch (error) {
      await registry.updateStatus(workspaceId, "crashed");
      throw error;
    }

    Deno.exit(0);
  };

  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
}
```

### 4. Enhanced CLI Commands

#### 4.1 Detached Mode Support

Modify workspace serve command to support detached flag:

```typescript
// In workspace.tsx
if (flags.detached || flags.d) {
  // Start in detached mode
  const processManager = new WorkspaceProcessManager(registry);
  const pid = await processManager.startDetached(workspace.id, {
    port: flags.port,
    logLevel: flags.logLevel,
  });

  console.log(`Workspace '${workspace.name}' started in background`);
  console.log(`  ID: ${workspace.id}`);
  console.log(`  PID: ${pid}`);
  console.log(`  Port: ${workspace.port}`);
  console.log(`  Logs: atlas logs ${workspace.id}`);

  process.exit(0);
} else {
  // Existing attached mode
  await server.start();
}
```

#### 4.2 New Management Commands

```bash
# Stop a running workspace
atlas workspace stop <id|name> [--force]

# Restart a workspace  
atlas workspace restart <id|name>

# Get detailed workspace status
atlas workspace status <id|name>

# Clean up stale registry entries
atlas workspace cleanup

# Tail logs from detached workspace
atlas logs <workspace-id|name> [--follow] [--tail 100]
```

### 5. Health Monitoring

#### 5.1 HTTP Health Endpoint

Add health endpoint to workspace server:

```typescript
// In workspace-server.ts
server.addRoute("/api/health", async (req) => {
  const runtime = server.getRuntime();
  const stats = await runtime.getStats();

  return new Response(
    JSON.stringify({
      status: "healthy",
      workspaceId: Deno.env.get("ATLAS_WORKSPACE_ID"),
      uptime: Date.now() - server.startTime,
      sessions: stats.activeSessions,
      memory: Deno.memoryUsage(),
      timestamp: new Date().toISOString(),
    }),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
});
```

#### 5.2 Health Check Integration

The existing lazy health check system will be enhanced:

```typescript
// In workspace-registry.ts
async checkAndUpdateHealth(workspace: WorkspaceEntry): Promise<WorkspaceEntry> {
  if (workspace.status === "running" && workspace.pid) {
    // First check process existence
    const processExists = await this.isProcessRunning(workspace.pid);
    
    if (!processExists) {
      await this.updateStatus(workspace.id, "crashed");
      workspace.status = "crashed";
    } else if (workspace.port) {
      // Then check HTTP health
      try {
        const response = await fetch(`http://localhost:${workspace.port}/api/health`);
        if (response.ok) {
          workspace.lastSeen = new Date().toISOString();
        }
      } catch {
        // HTTP check failed but process exists - mark as unhealthy
        workspace.status = "unhealthy";
      }
    }
  }
  
  return workspace;
}
```

### 6. Log Management

#### 6.1 Detached Logging

Enhance AtlasLogger for explicit file output:

```typescript
// In logger.ts
class AtlasLogger {
  private fileHandle?: Deno.FsFile;

  async initializeDetached(logFile: string): Promise<void> {
    this.fileHandle = await Deno.open(logFile, {
      create: true,
      write: true,
      append: true,
    });

    // Redirect all log output to file
    this.addTransport({
      write: async (entry: LogEntry) => {
        const line = JSON.stringify(entry) + "\n";
        await this.fileHandle!.write(new TextEncoder().encode(line));
      },
    });
  }
}
```

#### 6.2 Log Streaming Command

Implement the workspace logs functionality (partially done in registry plan):

```typescript
// Complete the WorkspaceLogsCommand implementation
export function WorkspaceLogsCommand({ args, flags }: Props) {
  const [workspaceId] = args;
  const reader = new WorkspaceLogReader(workspaceId);

  if (flags.follow) {
    // Stream logs in real-time
    await reader.follow({
      tail: flags.tail || 100,
      onLog: (entry) => console.log(formatLogEntry(entry)),
    });
  } else {
    // Show recent logs
    const entries = await reader.read({ tail: flags.tail || 100 });
    entries.forEach((entry) => console.log(formatLogEntry(entry)));
  }
}
```

## Implementation Plan

### Phase 1: Core Detached Process Support (🔥 IMMEDIATE PRIORITY)

1. **Implement WorkspaceProcessManager**
   - [ ] Create process manager class
   - [ ] Add startDetached method with proper stdio handling
   - [ ] Implement stop/restart functionality
   - [ ] Add process existence checking

2. **Modify Workspace Server**
   - [ ] Add signal handlers for detached mode
   - [ ] Implement health endpoint
   - [ ] Update registry on shutdown
   - [ ] Handle detached-specific initialization

3. **CLI Integration**
   - [ ] Add -d/--detached flag to workspace serve
   - [ ] Implement workspace stop command
   - [ ] Implement workspace restart command
   - [ ] Complete workspace status implementation

### Phase 2: Monitoring and Logs (📋 NEXT PRIORITY)

1. **Log Management**
   - [ ] Complete WorkspaceLogsCommand implementation
   - [ ] Add log rotation for long-running processes
   - [ ] Implement log filtering and formatting
   - [ ] Add --follow support for real-time streaming

2. **Health Monitoring**
   - [ ] Enhance lazy health checks with HTTP endpoint
   - [ ] Add health status to workspace list output
   - [ ] Implement cleanup command for stale entries
   - [ ] Add automatic recovery options

### Phase 3: Advanced Features (🚀 FUTURE)

1. **Process Management**
   - [ ] Resource usage tracking
   - [ ] Batch operations (stop all, restart all)
   - [ ] Process priority management
   - [ ] Automatic restart on crash

2. **Integration**
   - [ ] systemd service file generation (Linux)
   - [ ] launchd plist generation (macOS)
   - [ ] Windows service support
   - [ ] Docker container support

## Key Design Decisions

1. **No Daemon Required**: Use lazy health checks instead of a monitoring daemon
2. **Atomic Operations**: Registry updates use atomic file operations, no locking needed
3. **Process Detachment**: Use Deno's `child.unref()` for true detachment
4. **Log Files**: Each workspace gets its own log file in `~/.atlas/logs/workspaces/`
5. **Port Management**: Dynamic port assignment prevents conflicts

## Security Considerations

1. **Process Isolation**: Each workspace runs with user permissions
2. **Port Validation**: Ensure ports are available and within valid range
3. **Signal Protection**: Only allow authorized signal handling
4. **Log Permissions**: Secure log file access

## Success Metrics

- **Reliability**: Workspaces survive terminal closure
- **Performance**: Minimal overhead for registry operations
- **Usability**: Simple commands for common operations
- **Debuggability**: Clear logs and status information
- **Scalability**: Support 10+ concurrent workspaces

## Next Steps

1. Implement WorkspaceProcessManager class
2. Add detached mode support to workspace serve
3. Complete remaining CLI commands (stop, restart, status, cleanup)
4. Add health endpoint to workspace server
5. Finish log streaming implementation

The foundation is solid with the registry implementation complete. The remaining work focuses on the
actual process management and lifecycle operations needed for true background process support.
