# Immediate Next Steps for Atlas Multi-Workspace Support

## 🎯 Priority 1: Minimal Viable Detachment (Day 1-2)

### Step 1: Create WorkspaceProcessManager (2-3 hours)
```bash
# Create the file
touch src/core/workspace-process-manager.ts

# Implement core methods:
# - startDetached()
# - stop()
# - isProcessRunning()
```

**Key Implementation Details:**
- Use `child.unref()` for true detachment
- Set stdio to "null" for all streams
- Pass workspace ID via environment variables
- Update registry immediately after spawn

### Step 2: Add Detached Mode to Logger (1 hour)
```typescript
// In src/utils/logger.ts
async initializeDetached(logFile: string): Promise<void> {
  // Open file handle
  // Redirect all output to file
  // Write startup message
}
```

### Step 3: Update Workspace Server (1-2 hours)
```typescript
// In src/core/workspace-server.ts
// Add at start of start() method:
if (Deno.env.get("ATLAS_DETACHED") === "true") {
  // Initialize detached logging
  // Set up signal handlers
  // Add health endpoint
}
```

### Step 4: Add CLI Flag (30 min)
```typescript
// In src/cli.tsx
detached: {
  type: "boolean",
  shortFlag: "d",
  default: false,
}
```

### Step 5: Update Workspace Serve Command (1-2 hours)
```typescript
// In src/cli/commands/workspace.tsx
if (flags.detached) {
  const pid = await processManager.startDetached(workspace.id);
  console.log(`Started in background (PID: ${pid})`);
  Deno.exit(0);
}
```

## 🚀 Priority 2: Core Management Commands (Day 2-3)

### Step 6: Implement Stop Command (1 hour)
```bash
atlas workspace stop <id|name>
```
- Send SIGTERM for graceful shutdown
- Update registry status
- Handle missing/crashed processes

### Step 7: Implement Status Command (1 hour)
```bash
atlas workspace status [id|name]
```
- Show detailed workspace info
- Include health check if running
- Format output nicely

### Step 8: Basic Log Viewing (2 hours)
```bash
atlas logs <id|name> [--tail 50]
```
- Read from workspace log files
- Basic tail functionality
- JSON parsing for structured output

## 📋 Priority 3: Robustness (Day 3-4)

### Step 9: Health Endpoint (1 hour)
```typescript
// Add to workspace-server.ts
server.addRoute("/api/health", async (req) => {
  return new Response(JSON.stringify({
    status: "healthy",
    workspaceId: Deno.env.get("ATLAS_WORKSPACE_ID"),
    uptime: Date.now() - startTime,
  }));
});
```

### Step 10: Process Verification (1 hour)
- Add `waitForReady()` after starting
- Verify process didn't crash immediately
- Update status to "running" only after health check

### Step 11: Error Handling (2 hours)
- Port conflicts → auto-retry
- Missing workspace → clear error
- Permission issues → helpful message
- Crash recovery → update status

## 🧪 Priority 4: Testing (Day 4-5)

### Step 12: Manual Testing Checklist
```bash
# Start detached
atlas workspace serve -d

# Verify running
atlas workspace list
atlas workspace status

# Check logs
atlas logs <workspace-id>

# Stop workspace
atlas workspace stop <workspace-id>

# Verify stopped
atlas workspace list
```

### Step 13: Integration Tests
- Test full lifecycle
- Test error conditions
- Test concurrent workspaces
- Test signal handling

## Quick Start Commands

```bash
# For testing during development
cd ~/code/tempest/atlas

# Test detached mode
deno task atlas workspace serve -d

# Check if it's running
deno task atlas workspace list

# View logs
deno task atlas logs fervent_einstein

# Stop it
deno task atlas workspace stop fervent_einstein
```

## Code Snippets to Get Started

### 1. Minimal startDetached Implementation
```typescript
async startDetached(workspaceId: string): Promise<number> {
  const workspace = await this.registry.findById(workspaceId);
  if (!workspace) throw new Error("Workspace not found");
  
  const port = await findAvailablePort();
  const logFile = join(getAtlasHome(), "logs", "workspaces", `${workspaceId}.log`);
  
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run", "--allow-all",
      "src/cli.tsx", "workspace", "serve", workspaceId,
      "--internal-detached", "--port", port.toString(),
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
    env: {
      ATLAS_WORKSPACE_ID: workspaceId,
      ATLAS_DETACHED: "true",
      ATLAS_LOG_FILE: logFile,
    },
  });
  
  const child = cmd.spawn();
  child.unref();
  
  await this.registry.updateStatus(workspaceId, "starting", { pid: child.pid, port });
  return child.pid;
}
```

### 2. Minimal Signal Handler
```typescript
if (Deno.env.get("ATLAS_DETACHED") === "true") {
  Deno.addSignalListener("SIGTERM", async () => {
    await registry.updateStatus(workspaceId, "stopping");
    await server.shutdown();
    await registry.updateStatus(workspaceId, "stopped");
    Deno.exit(0);
  });
}
```

### 3. Minimal Health Check
```typescript
async checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/health`);
    return res.ok;
  } catch {
    return false;
  }
}
```

## Common Pitfalls to Avoid

1. **Don't forget `child.unref()`** - Without this, parent process won't exit
2. **Always set stdio to "null"** - Otherwise process stays attached
3. **Update registry immediately** - Before any async operations
4. **Handle SIGTERM gracefully** - For clean shutdowns
5. **Check process exists** - PIDs can be reused by OS

## Definition of Done

- [ ] Can start workspace with `-d` flag
- [ ] Parent process exits immediately
- [ ] Workspace continues running
- [ ] Can list running workspaces
- [ ] Can stop running workspaces
- [ ] Logs are written to files
- [ ] Basic error handling works
- [ ] Manual testing passes

## Questions to Answer Early

1. Should we use a specific port range for workspaces?
2. How should we handle log rotation?
3. Do we need a max workspace limit?
4. Should crashed workspaces auto-restart?
5. How to handle workspace updates while running?

Start with Step 1 and work through sequentially. The first 5 steps will give you a working detached mode in a few hours!