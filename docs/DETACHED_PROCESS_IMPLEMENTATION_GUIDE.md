# Detached Process Implementation Guide

## Executive Summary

With the workspace registry foundation complete, Atlas needs true background process support to enable multiple concurrent workspaces. This guide provides a detailed implementation plan for the remaining work.

## Critical Path Analysis

### 🎯 Core Requirements for MVP

1. **Process Detachment**: Workspaces must survive terminal closure
2. **Lifecycle Management**: Start, stop, restart operations
3. **Visibility**: List running workspaces and their status
4. **Debugging**: Access logs from detached processes
5. **Reliability**: Graceful shutdown and crash recovery

### 🚧 Current Gaps

1. **No Detachment**: `workspace serve` always runs in foreground
2. **No Process Control**: Can't stop/restart running workspaces
3. **No Background Logs**: Logger outputs to console only
4. **No Health Endpoint**: Can't verify workspace health remotely
5. **Incomplete CLI**: Missing stop, restart, status, cleanup commands

## Implementation Strategy

### Phase 1: Core Process Management (Week 1)

#### 1.1 Create WorkspaceProcessManager

Location: `src/core/workspace-process-manager.ts`

```typescript
import { getWorkspaceRegistry } from "./workspace-registry.ts";
import { findAvailablePort } from "../utils/port-finder.ts";
import { getAtlasHome } from "../utils/paths.ts";
import { ensureDir } from "@std/fs";
import { join, dirname } from "@std/path";

export interface ProcessStartOptions {
  port?: number;
  env?: Record<string, string>;
  logLevel?: string;
  additionalFlags?: string[];
}

export class WorkspaceProcessManager {
  private registry = getWorkspaceRegistry();

  async startDetached(
    workspaceIdOrPath: string,
    options: ProcessStartOptions = {}
  ): Promise<number> {
    // Find or register workspace
    let workspace = await this.registry.findById(workspaceIdOrPath);
    if (!workspace) {
      workspace = await this.registry.findByName(workspaceIdOrPath);
    }
    if (!workspace) {
      // Try as path
      workspace = await this.registry.findOrRegister(workspaceIdOrPath);
    }

    // Check if already running
    if (workspace.status === "running" || workspace.status === "starting") {
      throw new Error(`Workspace ${workspace.name} is already running`);
    }

    // Find available port
    const port = options.port || await findAvailablePort();
    
    // Prepare log file
    const logDir = join(getAtlasHome(), "logs", "workspaces");
    await ensureDir(logDir);
    const logFile = join(logDir, `${workspace.id}.log`);
    
    // Build command
    const args = [
      "run",
      "--allow-all",
      "--unstable-broadcast-channel",
      "--unstable-worker-options",
      join(Deno.cwd(), "src/cli.tsx"),
      "workspace",
      "serve",
      workspace.id,
      "--internal-detached",
      "--port", port.toString(),
      "--log-file", logFile,
    ];
    
    if (options.logLevel) {
      args.push("--log-level", options.logLevel);
    }
    
    if (options.additionalFlags) {
      args.push(...options.additionalFlags);
    }
    
    // Spawn detached process
    const cmd = new Deno.Command(Deno.execPath(), {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
      env: {
        ...Deno.env.toObject(),
        ATLAS_WORKSPACE_ID: workspace.id,
        ATLAS_WORKSPACE_NAME: workspace.name,
        ATLAS_WORKSPACE_PATH: workspace.path,
        ATLAS_DETACHED: "true",
        ATLAS_LOG_FILE: logFile,
        ...options.env,
      },
    });
    
    const child = cmd.spawn();
    
    // Update registry immediately
    await this.registry.updateStatus(workspace.id, "starting", {
      pid: child.pid,
      port,
      startedAt: new Date().toISOString(),
    });
    
    // Detach from parent
    child.unref();
    
    // Wait briefly for process to start
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Verify process started
    if (!await this.isProcessRunning(child.pid)) {
      await this.registry.updateStatus(workspace.id, "crashed");
      throw new Error("Failed to start workspace process");
    }
    
    return child.pid;
  }

  async stop(workspaceId: string, force = false): Promise<void> {
    const workspace = await this.registry.findById(workspaceId) ||
                     await this.registry.findByName(workspaceId);
    
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    
    if (workspace.status !== "running" || !workspace.pid) {
      throw new Error(`Workspace ${workspace.name} is not running`);
    }
    
    // Update status
    await this.registry.updateStatus(workspace.id, "stopping");
    
    try {
      if (force) {
        // Force kill
        Deno.kill(workspace.pid, "SIGKILL");
      } else {
        // Graceful shutdown
        Deno.kill(workspace.pid, "SIGTERM");
        
        // Wait for process to exit (max 30 seconds)
        const timeout = 30000;
        const start = Date.now();
        
        while (await this.isProcessRunning(workspace.pid)) {
          if (Date.now() - start > timeout) {
            // Timeout - force kill
            Deno.kill(workspace.pid, "SIGKILL");
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      await this.registry.updateStatus(workspace.id, "stopped", {
        pid: undefined,
        port: undefined,
        stoppedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.registry.updateStatus(workspace.id, "crashed");
      throw error;
    }
  }

  async restart(workspaceId: string): Promise<number> {
    const workspace = await this.registry.findById(workspaceId) ||
                     await this.registry.findByName(workspaceId);
    
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    
    // Stop if running
    if (workspace.status === "running" && workspace.pid) {
      await this.stop(workspace.id);
    }
    
    // Start again with same port if available
    return await this.startDetached(workspace.id, {
      port: workspace.port,
    });
  }

  async isProcessRunning(pid: number): Promise<boolean> {
    try {
      // Signal 0 checks if process exists without killing it
      Deno.kill(pid, "SIGCONT");
      return true;
    } catch {
      return false;
    }
  }

  async waitForReady(
    workspaceId: string, 
    timeout = 30000
  ): Promise<boolean> {
    const workspace = await this.registry.findById(workspaceId);
    if (!workspace || !workspace.port) return false;
    
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      try {
        const response = await fetch(
          `http://localhost:${workspace.port}/api/health`
        );
        if (response.ok) {
          await this.registry.updateStatus(workspace.id, "running");
          return true;
        }
      } catch {
        // Not ready yet
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return false;
  }
}

export const workspaceProcessManager = new WorkspaceProcessManager();
```

#### 1.2 Enhance Workspace Server for Detached Mode

Location: `src/core/workspace-server.ts`

Add to the `start()` method:

```typescript
// Add detached mode support
if (Deno.env.get("ATLAS_DETACHED") === "true") {
  const workspaceId = Deno.env.get("ATLAS_WORKSPACE_ID")!;
  const logFile = Deno.env.get("ATLAS_LOG_FILE");
  
  // Initialize logger for file output
  if (logFile) {
    await this.logger.initializeDetached(logFile);
  }
  
  // Set up signal handlers
  this.setupDetachedSignalHandlers(workspaceId);
  
  // Add health endpoint
  this.server.addRoute("/api/health", this.createHealthHandler());
}

private setupDetachedSignalHandlers(workspaceId: string): void {
  const registry = getWorkspaceRegistry();
  
  const shutdown = async (signal: string) => {
    this.logger.info(`Received ${signal}, shutting down gracefully...`, {
      workspaceId,
      signal,
    });
    
    await registry.updateStatus(workspaceId, "stopping");
    
    try {
      await this.shutdown();
      await registry.updateStatus(workspaceId, "stopped", {
        stoppedAt: new Date().toISOString(),
        pid: undefined,
        port: undefined,
      });
    } catch (error) {
      this.logger.error("Error during shutdown", { error: error.message });
      await registry.updateStatus(workspaceId, "crashed");
    } finally {
      Deno.exit(0);
    }
  };

  Deno.addSignalListener("SIGTERM", () => shutdown("SIGTERM"));
  Deno.addSignalListener("SIGINT", () => shutdown("SIGINT"));
}

private createHealthHandler() {
  return async (req: Request): Promise<Response> => {
    const runtime = this.workspaceRuntime;
    const stats = runtime ? await runtime.getStats() : null;
    
    return new Response(
      JSON.stringify({
        status: "healthy",
        workspaceId: Deno.env.get("ATLAS_WORKSPACE_ID"),
        workspaceName: Deno.env.get("ATLAS_WORKSPACE_NAME"),
        uptime: Date.now() - this.startTime,
        sessions: stats?.activeSessions || 0,
        memory: Deno.memoryUsage(),
        timestamp: new Date().toISOString(),
        version: Deno.version,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  };
}
```

#### 1.3 Update Logger for File Output

Location: `src/utils/logger.ts`

Add to AtlasLogger class:

```typescript
private fileHandle?: Deno.FsFile;
private isDetached = false;

async initializeDetached(logFile: string): Promise<void> {
  this.isDetached = true;
  
  // Open log file
  this.fileHandle = await Deno.open(logFile, {
    create: true,
    write: true,
    append: true,
  });
  
  // Write startup message
  await this.writeToFile({
    level: "info",
    message: "Workspace starting in detached mode",
    timestamp: new Date().toISOString(),
    context: {
      pid: Deno.pid,
      workspaceId: Deno.env.get("ATLAS_WORKSPACE_ID"),
      workspaceName: Deno.env.get("ATLAS_WORKSPACE_NAME"),
    },
  });
}

private async writeToFile(entry: LogEntry): Promise<void> {
  if (this.fileHandle) {
    const line = JSON.stringify(entry) + "\n";
    const encoded = new TextEncoder().encode(line);
    await this.fileHandle.write(encoded);
  }
}

protected async writeLog(
  category: string,
  message: string | LogEntry
): Promise<void> {
  const entry = typeof message === "string" 
    ? this.createLogEntry(category, message)
    : message;
  
  if (this.isDetached) {
    // Write to file instead of console
    await this.writeToFile(entry);
  } else {
    // Existing console output
    await super.writeLog(category, message);
  }
}
```

### Phase 2: CLI Command Implementation (Week 1-2)

#### 2.1 Add Detached Flag to CLI

Location: `src/cli.tsx`

Add flag definition:

```typescript
flags: {
  // ... existing flags ...
  detached: {
    type: "boolean",
    shortFlag: "d",
    default: false,
    description: "Run workspace in background",
  },
  "internal-detached": {
    type: "boolean",
    default: false,
    isRequired: false,
  },
  "workspace-id": {
    type: "string",
    isRequired: false,
  },
  "log-file": {
    type: "string",
    isRequired: false,
  },
}
```

#### 2.2 Update Workspace Serve Command

Location: `src/cli/commands/workspace.tsx`

In the `handleServe` function:

```typescript
async function handleServe(args: string[], flags: any) {
  const workspaceIdOrPath = args[0] || Deno.cwd();
  
  if (flags.detached || flags.d) {
    // Detached mode
    const processManager = new WorkspaceProcessManager();
    
    try {
      setState({ status: "starting", message: "Starting workspace in background..." });
      
      const pid = await processManager.startDetached(workspaceIdOrPath, {
        port: flags.port,
        logLevel: flags.logLevel,
      });
      
      // Wait for workspace to be ready
      const workspace = await workspaceRegistry.findById(workspaceIdOrPath) ||
                       await workspaceRegistry.findByName(workspaceIdOrPath) ||
                       await workspaceRegistry.getCurrentWorkspace();
      
      if (workspace && await processManager.waitForReady(workspace.id)) {
        setState({
          status: "success",
          message: `Workspace '${workspace.name}' started in background`,
          details: {
            id: workspace.id,
            pid,
            port: workspace.port,
            logs: `atlas logs ${workspace.id}`,
          },
        });
      } else {
        throw new Error("Workspace failed to start");
      }
      
      // Exit CLI
      setTimeout(() => Deno.exit(0), 100);
    } catch (error) {
      setState({ status: "error", error: error.message });
    }
  } else if (flags["internal-detached"]) {
    // Internal detached mode - actually run the server
    const workspace = await workspaceRegistry.findById(flags["workspace-id"]);
    if (!workspace) {
      throw new Error(`Workspace ${flags["workspace-id"]} not found`);
    }
    
    // Run server normally but with detached configuration
    await runWorkspaceServer(workspace, flags);
  } else {
    // Normal attached mode
    await runWorkspaceServer(workspaceIdOrPath, flags);
  }
}
```

#### 2.3 Implement Stop Command

Add to workspace command switch:

```typescript
case "stop":
  await handleStop(args, flags);
  break;

async function handleStop(args: string[], flags: any) {
  const workspaceId = args[0];
  if (!workspaceId) {
    throw new Error("Workspace ID or name required");
  }
  
  const processManager = new WorkspaceProcessManager();
  
  try {
    setState({ status: "stopping", message: "Stopping workspace..." });
    
    await processManager.stop(workspaceId, flags.force);
    
    setState({
      status: "success",
      message: `Workspace stopped successfully`,
    });
  } catch (error) {
    setState({ status: "error", error: error.message });
  }
}
```

#### 2.4 Implement Restart Command

```typescript
case "restart":
  await handleRestart(args, flags);
  break;

async function handleRestart(args: string[], flags: any) {
  const workspaceId = args[0];
  if (!workspaceId) {
    throw new Error("Workspace ID or name required");
  }
  
  const processManager = new WorkspaceProcessManager();
  
  try {
    setState({ status: "restarting", message: "Restarting workspace..." });
    
    const pid = await processManager.restart(workspaceId);
    const workspace = await workspaceRegistry.findById(workspaceId) ||
                     await workspaceRegistry.findByName(workspaceId);
    
    if (workspace && await processManager.waitForReady(workspace.id)) {
      setState({
        status: "success",
        message: `Workspace '${workspace.name}' restarted successfully`,
        details: {
          pid,
          port: workspace.port,
        },
      });
    }
  } catch (error) {
    setState({ status: "error", error: error.message });
  }
}
```

#### 2.5 Complete Status Command

```typescript
case "status":
  await handleStatus(args, flags);
  break;

async function handleStatus(args: string[], flags: any) {
  const workspaceId = args[0];
  
  let workspace;
  if (workspaceId) {
    workspace = await workspaceRegistry.findById(workspaceId) ||
                await workspaceRegistry.findByName(workspaceId);
  } else {
    workspace = await workspaceRegistry.getCurrentWorkspace();
  }
  
  if (!workspace) {
    throw new Error("Workspace not found");
  }
  
  // Update health status
  workspace = await workspaceRegistry.checkAndUpdateHealth(workspace);
  
  // Get additional info if running
  let health = null;
  if (workspace.status === "running" && workspace.port) {
    try {
      const response = await fetch(`http://localhost:${workspace.port}/api/health`);
      if (response.ok) {
        health = await response.json();
      }
    } catch {
      // Health check failed
    }
  }
  
  setState({
    status: "success",
    workspace: {
      ...workspace,
      health,
    },
  });
}
```

#### 2.6 Complete Cleanup Command

```typescript
case "cleanup":
  await handleCleanup(flags);
  break;

async function handleCleanup(flags: any) {
  setState({ status: "cleaning", message: "Cleaning up stale workspaces..." });
  
  const all = await workspaceRegistry.listAll();
  let cleaned = 0;
  
  for (const workspace of all) {
    // Check if workspace directory exists
    try {
      await Deno.stat(workspace.path);
    } catch {
      // Directory doesn't exist - remove from registry
      await workspaceRegistry.unregister(workspace.id);
      cleaned++;
      continue;
    }
    
    // Check crashed workspaces
    if (workspace.status === "crashed" && workspace.stoppedAt) {
      const stoppedDate = new Date(workspace.stoppedAt);
      const daysSince = (Date.now() - stoppedDate.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysSince > 7) {
        await workspaceRegistry.unregister(workspace.id);
        cleaned++;
      }
    }
  }
  
  setState({
    status: "success",
    message: `Cleaned up ${cleaned} stale workspace entries`,
  });
}
```

### Phase 3: Log Streaming (Week 2)

#### 3.1 Complete Log Streaming Implementation

The WorkspaceLogsCommand is partially implemented in the registry plan. Complete it:

Location: `src/cli/commands/workspace/logs.tsx`

```typescript
import { Box, Text } from "ink";
import { useEffect, useState, useRef } from "react";
import { WorkspaceLogReader } from "./log-reader.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";

export function WorkspaceLogsCommand({ args, flags }: Props) {
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "streaming" | "done">("loading");
  const readerRef = useRef<WorkspaceLogReader | null>(null);

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const workspaceIdOrName = args[0];
        const registry = getWorkspaceRegistry();
        
        let workspace;
        if (workspaceIdOrName) {
          workspace = await registry.findById(workspaceIdOrName) ||
                     await registry.findByName(workspaceIdOrName);
        } else {
          workspace = await registry.getCurrentWorkspace();
        }
        
        if (!workspace) {
          throw new Error("Workspace not found");
        }
        
        const reader = new WorkspaceLogReader(workspace.id);
        readerRef.current = reader;
        
        if (flags.follow || flags.f) {
          setStatus("streaming");
          
          cleanup = await reader.follow({
            tail: flags.tail || 100,
            onLog: (entry) => {
              const formatted = formatLogEntry(entry, {
                timestamps: flags.timestamps !== false && !flags["no-timestamps"],
                json: flags.json,
              });
              setLogs(prev => [...prev.slice(-1000), formatted]); // Keep last 1000 lines
            },
            filters: {
              level: flags.level,
              since: flags.since ? parseDuration(flags.since) : undefined,
              context: parseContextFilters(flags.context),
            },
          });
        } else {
          const entries = await reader.read({
            tail: flags.tail || 100,
            filters: {
              level: flags.level,
              since: flags.since ? parseDuration(flags.since) : undefined,
              context: parseContextFilters(flags.context),
            },
          });
          
          const formatted = entries.map(entry => 
            formatLogEntry(entry, {
              timestamps: flags.timestamps !== false && !flags["no-timestamps"],
              json: flags.json,
            })
          );
          
          setLogs(formatted);
          setStatus("done");
        }
      } catch (err) {
        setError(err.message);
      }
    })();

    // Cleanup on unmount
    return () => {
      if (readerRef.current) {
        readerRef.current.stop();
      }
      if (cleanup) {
        cleanup();
      }
    };
  }, []);

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {logs.map((log, i) => (
        <Text key={i}>{log}</Text>
      ))}
      {status === "streaming" && logs.length === 0 && (
        <Text color="gray">Waiting for logs...</Text>
      )}
    </Box>
  );
}

// Helper functions
function formatLogEntry(entry: any, options: any): string {
  if (options.json) {
    return JSON.stringify(entry);
  }

  const parts: string[] = [];

  if (options.timestamps) {
    parts.push(entry.timestamp);
  }

  // Color code by level
  const levelColors = {
    error: "red",
    warn: "yellow",
    info: "blue",
    debug: "gray",
    trace: "gray",
  };

  const level = entry.level.toUpperCase().padEnd(5);
  parts.push(`[${level}]`);

  if (entry.context && Object.keys(entry.context).length > 0) {
    const ctx = Object.entries(entry.context)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    parts.push(`{${ctx}}`);
  }

  parts.push(entry.message);

  return parts.join(" ");
}

function parseDuration(duration: string): Date {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(`Invalid duration: ${duration}`);
  }

  const [, amount, unit] = match;
  const value = parseInt(amount, 10);
  const now = new Date();

  switch (unit) {
    case "s": now.setSeconds(now.getSeconds() - value); break;
    case "m": now.setMinutes(now.getMinutes() - value); break;
    case "h": now.setHours(now.getHours() - value); break;
    case "d": now.setDate(now.getDate() - value); break;
  }

  return now;
}

function parseContextFilters(filters?: string[]): Record<string, string> | undefined {
  if (!filters) return undefined;

  const result: Record<string, string> = {};
  for (const filter of filters) {
    const [key, value] = filter.split("=");
    if (key && value) {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
```

### Phase 4: Testing and Polish (Week 2-3)

#### 4.1 Integration Tests

Create `tests/integration/detached-process.test.ts`:

```typescript
import { assertEquals, assertExists } from "@std/assert";
import { WorkspaceProcessManager } from "../../src/core/workspace-process-manager.ts";
import { getWorkspaceRegistry } from "../../src/core/workspace-registry.ts";

Deno.test("Detached process lifecycle", async () => {
  const processManager = new WorkspaceProcessManager();
  const registry = getWorkspaceRegistry();
  
  // Create test workspace
  const testDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(testDir, "workspace.yml"),
    "name: test-detached\njobs: []"
  );
  
  // Register workspace
  const workspace = await registry.register(testDir, {
    name: "test-detached",
  });
  
  try {
    // Start detached
    const pid = await processManager.startDetached(workspace.id);
    assertExists(pid);
    
    // Verify running
    const running = await processManager.isProcessRunning(pid);
    assertEquals(running, true);
    
    // Check registry status
    const updated = await registry.findById(workspace.id);
    assertEquals(updated?.status, "starting");
    
    // Wait for ready
    const ready = await processManager.waitForReady(workspace.id, 10000);
    assertEquals(ready, true);
    
    // Stop process
    await processManager.stop(workspace.id);
    
    // Verify stopped
    const stopped = await registry.findById(workspace.id);
    assertEquals(stopped?.status, "stopped");
    
  } finally {
    // Cleanup
    try {
      await processManager.stop(workspace.id, true);
    } catch {
      // Already stopped
    }
    await registry.unregister(workspace.id);
    await Deno.remove(testDir, { recursive: true });
  }
});
```

#### 4.2 Error Handling

Add comprehensive error handling throughout:

1. **Port conflicts**: Automatically retry with different ports
2. **Process crashes**: Update registry status and provide clear errors
3. **Missing workspaces**: Helpful error messages with suggestions
4. **Permission errors**: Check write permissions for log directory
5. **Signal failures**: Fallback to force kill if graceful shutdown fails

#### 4.3 User Experience Improvements

1. **Progress indicators**: Show startup progress for detached processes
2. **Colorized output**: Use Ink's color support for better visibility
3. **Tab completion**: Add shell completion for workspace IDs/names
4. **Help text**: Comprehensive help for all new commands
5. **Examples**: Add example usage in help output

## Risk Mitigation

### Technical Risks

1. **Process Zombies**: Implement proper signal handling and cleanup
2. **Port Exhaustion**: Smart port allocation with configurable ranges
3. **Log File Growth**: Implement log rotation (future enhancement)
4. **Memory Leaks**: Careful resource management in long-running processes
5. **Race Conditions**: Use atomic registry operations

### Operational Risks

1. **Data Loss**: Registry backup before modifications
2. **Security**: Validate all inputs, especially workspace paths
3. **Compatibility**: Test on macOS, Linux, and Windows
4. **Performance**: Lazy loading and efficient registry queries
5. **Debugging**: Comprehensive logging and error messages

## Success Criteria

1. **Functionality**: All commands work as specified
2. **Reliability**: 99% success rate for start/stop operations
3. **Performance**: < 2s to start a detached workspace
4. **Usability**: Clear feedback and error messages
5. **Testing**: > 80% code coverage for new code

## Timeline

- **Week 1**: Core process management + Basic CLI commands
- **Week 2**: Complete CLI commands + Log streaming
- **Week 3**: Testing, error handling, and polish

## Conclusion

This implementation plan provides a clear path to add detached process support to Atlas. The modular approach allows for incremental development and testing, while the comprehensive error handling ensures reliability. With the registry foundation already in place, the remaining work focuses on process lifecycle management and user experience.