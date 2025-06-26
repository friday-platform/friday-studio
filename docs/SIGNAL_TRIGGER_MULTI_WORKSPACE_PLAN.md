# Signal Trigger Multi-Workspace Support Plan

## Overview

This document outlines the plan to extend the `atlas signal trigger` command to support emitting
signals to multiple running workspaces. With the new multi-workspace background process
architecture, we need a clean implementation that can target multiple workspaces efficiently.

## Current State Analysis

### Current Implementation Limitations

1. **Single Workspace Only**: The current `trigger.ts` implementation can only send signals to one
   workspace at a time
2. **Hardcoded Port**: Uses a default port of 8080 or requires explicit port specification
3. **No Multi-Workspace Awareness**: Doesn't leverage the workspace registry to discover running
   workspaces
4. **Manual Port Tracking**: Users must remember which port each workspace is running on

### Available Infrastructure

From `workspace-registry.ts` analysis:

- **Registry Tracking**: All workspaces are tracked in `~/.atlas/registry.json`
- **Port Information**: Each running workspace has its port stored in the registry
- **Status Tracking**: Registry tracks workspace status (RUNNING, STOPPED, etc.)
- **Query Methods**: `getRunning()` returns all running workspaces
- **Lazy Health Checks**: Registry performs health checks when querying workspaces

## Design Goals

1. **Smart Defaults**: When no workspace is specified, trigger on current workspace if running,
   otherwise all workspaces
2. **Flexible Filtering**: Support filtering to specific workspaces via CLI flags
3. **Port Discovery**: Automatically use the correct port for each workspace from the registry
4. **Parallel Execution**: Always trigger signals in parallel for performance
5. **Clear Feedback**: Show which workspaces received the signal and which failed

## Implementation Plan

### 1. CLI Interface Changes

Update the command builder to support new filtering options:

```typescript
export const builder = {
  // Existing options...
  workspace: {
    type: "string" as const,
    alias: "w",
    describe: "Workspace ID(s) or name(s) to target (comma-separated for multiple)",
    coerce: (value: string) => value.split(",").map((v) => v.trim()),
  },
  all: {
    type: "boolean" as const,
    alias: "a",
    describe: "Trigger signal on all running workspaces",
    default: false,
  },
  exclude: {
    type: "string" as const,
    alias: "x",
    describe: "Workspace ID(s) or name(s) to exclude (comma-separated)",
    coerce: (value: string) => value ? value.split(",").map((v) => v.trim()) : [],
  },
};
```

### 2. Core Logic Refactoring

#### 2.1 Workspace Resolution Logic

```typescript
interface TargetWorkspace {
  id: string;
  name: string;
  port: number;
  path: string;
}

async function resolveTargetWorkspaces(args: TriggerArgs): Promise<TargetWorkspace[]> {
  const registry = getWorkspaceRegistry();
  await registry.initialize();

  let targetWorkspaces: WorkspaceEntry[] = [];

  if (args.all) {
    // Get all running workspaces
    targetWorkspaces = await registry.getRunning();
  } else if (args.workspace && args.workspace.length > 0) {
    // Get specific workspaces by ID or name
    for (const identifier of args.workspace) {
      const workspace = await registry.findById(identifier) ||
        await registry.findByName(identifier);

      if (workspace && workspace.status === WorkspaceStatus.RUNNING) {
        targetWorkspaces.push(workspace);
      } else if (workspace) {
        console.warn(`Workspace '${identifier}' is not running (status: ${workspace.status})`);
      } else {
        console.warn(`Workspace '${identifier}' not found in registry`);
      }
    }
  } else {
    // Default: current workspace or all running
    const currentWorkspace = await registry.getCurrentWorkspace();
    if (currentWorkspace && currentWorkspace.status === WorkspaceStatus.RUNNING) {
      targetWorkspaces = [currentWorkspace];
    } else {
      // No current workspace or it's not running - trigger on all
      targetWorkspaces = await registry.getRunning();
    }
  }

  // Apply exclusions
  if (args.exclude && args.exclude.length > 0) {
    const excludeSet = new Set(args.exclude);
    targetWorkspaces = targetWorkspaces.filter((w) =>
      !excludeSet.has(w.id) && !excludeSet.has(w.name)
    );
  }

  // Validate and map to target format
  return targetWorkspaces
    .filter((w) => w.port) // Must have a port
    .map((w) => ({
      id: w.id,
      name: w.name,
      port: w.port!,
      path: w.path,
    }));
}
```

#### 2.2 Signal Validation

```typescript
async function validateSignalInWorkspaces(
  signalName: string,
  workspaces: TargetWorkspace[],
): Promise<Map<string, boolean>> {
  const validationResults = new Map<string, boolean>();

  for (const workspace of workspaces) {
    try {
      const originalCwd = Deno.cwd();
      Deno.chdir(workspace.path);

      const configLoader = new ConfigLoader();
      const config = await configLoader.load();
      const signals = config.workspace.signals as Record<string, unknown>;

      validationResults.set(workspace.id, !!(signals && signals[signalName]));

      Deno.chdir(originalCwd);
    } catch {
      validationResults.set(workspace.id, false);
    }
  }

  return validationResults;
}
```

#### 2.3 Multi-Workspace Triggering

```typescript
interface TriggerResult {
  workspace: TargetWorkspace;
  success: boolean;
  sessionId?: string;
  error?: string;
  duration: number;
}

async function triggerSignalOnWorkspace(
  workspace: TargetWorkspace,
  signalName: string,
  payload: Record<string, unknown>,
): Promise<TriggerResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(
      `http://localhost:${workspace.port}/signals/${signalName}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000), // 5 second timeout per workspace
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`${response.status} ${response.statusText}: ${errorText}`);
    }

    const result = await response.json();

    return {
      workspace,
      success: true,
      sessionId: result.sessionId,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    return {
      workspace,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime,
    };
  }
}

async function triggerSignalOnMultipleWorkspaces(
  workspaces: TargetWorkspace[],
  signalName: string,
  payload: Record<string, unknown>,
): Promise<TriggerResult[]> {
  // Always trigger all workspaces in parallel for performance
  return await Promise.all(
    workspaces.map((w) => triggerSignalOnWorkspace(w, signalName, payload)),
  );
}
```

### 3. Enhanced Output Formatting

```typescript
function formatTriggerResults(
  results: TriggerResult[],
  signalName: string,
  json: boolean,
): void {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (json) {
    const output = {
      signal: signalName,
      timestamp: new Date().toISOString(),
      summary: {
        total: results.length,
        successful: successful.length,
        failed: failed.length,
      },
      results: results.map((r) => ({
        workspaceId: r.workspace.id,
        workspaceName: r.workspace.name,
        port: r.workspace.port,
        success: r.success,
        sessionId: r.sessionId,
        error: r.error,
        durationMs: r.duration,
      })),
    };

    console.log(JSON.stringify(output, null, 2));
  } else {
    // Human-readable output
    console.log(`\n✨ Signal '${signalName}' triggered on ${results.length} workspace(s)\n`);

    if (successful.length > 0) {
      console.log(`✅ Successful (${successful.length}):`);
      for (const result of successful) {
        console.log(`   • ${result.workspace.name} (${result.workspace.id})`);
        console.log(`     Port: ${result.workspace.port}, Session: ${result.sessionId}`);
        console.log(`     Duration: ${result.duration}ms`);
      }
    }

    if (failed.length > 0) {
      console.log(`\n❌ Failed (${failed.length}):`);
      for (const result of failed) {
        console.log(`   • ${result.workspace.name} (${result.workspace.id})`);
        console.log(`     Port: ${result.workspace.port}`);
        console.log(`     Error: ${result.error}`);
      }
    }

    // Monitoring hints
    if (successful.length > 0) {
      console.log("\n📊 Monitor sessions:");
      console.log("   • All workspaces: atlas ps");
      for (const result of successful.slice(0, 3)) { // Show first 3
        console.log(`   • ${result.workspace.name}: atlas logs ${result.sessionId}`);
      }
      if (successful.length > 3) {
        console.log(`   • ... and ${successful.length - 3} more`);
      }
    }
  }
}
```

### 4. Updated Handler Implementation

```typescript
export const handler = async (argv: TriggerArgs): Promise<void> => {
  try {
    // Resolve target workspaces
    const targetWorkspaces = await resolveTargetWorkspaces(argv);

    if (targetWorkspaces.length === 0) {
      errorOutput("No running workspaces found to trigger signal on.");
      if (!argv.all && argv.workspace) {
        infoOutput(
          "Specified workspaces may not be running. Use 'atlas workspace list' to check status.",
        );
      }
      Deno.exit(1);
    }

    // Validate signal exists in workspaces
    const validationResults = await validateSignalInWorkspaces(argv.name, targetWorkspaces);
    const validWorkspaces = targetWorkspaces.filter((w) => validationResults.get(w.id));
    const invalidWorkspaces = targetWorkspaces.filter((w) => !validationResults.get(w.id));

    if (invalidWorkspaces.length > 0) {
      // Just warn about invalid workspaces, don't fail
      console.warn(
        `Signal '${argv.name}' not found in ${invalidWorkspaces.length} workspace(s):\n` +
          invalidWorkspaces.map((w) => `  - ${w.name} (${w.id})`).join("\n"),
      );
    }

    if (validWorkspaces.length === 0) {
      errorOutput(`Signal '${argv.name}' not found in any target workspace.`);
      Deno.exit(1);
    }

    // Get payload data
    const payload = await getSignalPayload(argv);

    // Show what we're about to do
    if (!argv.json) {
      const s = p.spinner();
      s.start(
        `Triggering signal '${argv.name}' on ${validWorkspaces.length} workspace(s)...`,
      );

      // Trigger signals
      const results = await triggerSignalOnMultipleWorkspaces(
        validWorkspaces,
        argv.name,
        payload,
      );

      s.stop();

      // Format and display results
      formatTriggerResults(results, argv.name, false);
    } else {
      // JSON mode - no spinner
      const results = await triggerSignalOnMultipleWorkspaces(
        validWorkspaces,
        argv.name,
        payload,
      );

      formatTriggerResults(results, argv.name, true);
    }

    // Exit with appropriate code (always exit 0 - partial success is still success)
    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
```

## Usage Examples

### Basic Usage

```bash
# Trigger on all running workspaces
atlas signal trigger deploy --all

# Trigger on specific workspaces
atlas signal trigger webhook --workspace prod,staging

# Trigger with exclusions
atlas signal trigger test --all --exclude dev

# Trigger with data payload
atlas signal trigger manual --all --data '{"user": "admin", "action": "refresh"}'
```

### Advanced Usage

```bash
# JSON output for scripting
atlas signal trigger health-check --all --json | jq '.results[] | select(.success == false)'

# Target multiple specific workspaces
atlas signal trigger refresh --workspace happy_einstein,fervent_turing,zen_bardeen

# Exclude specific workspaces
atlas signal trigger deploy --all --exclude dev,test
```

## Key Changes from Previous Design

1. **No Backwards Compatibility**: Clean implementation without legacy `--port` support
2. **Simplified Flags**: Removed `--parallel` and `--continue-on-error` flags for simplicity
3. **Smart Defaults**: Current workspace takes precedence, then falls back to all workspaces
4. **Always Parallel**: All signals are sent in parallel for optimal performance

## Error Handling

1. **Partial Success**: Partial failures are considered successful - exit code 0
2. **Connection Errors**: Distinguish between "workspace not running" and "signal not found"
3. **Timeout Protection**: Each workspace trigger has its own timeout (5s) to prevent hanging
4. **Invalid Signals**: Warn about workspaces missing the signal but continue with valid ones

## Performance Considerations

1. **Always Parallel**: All signals sent concurrently for optimal performance
2. **Lazy Loading**: Only load workspace configurations when needed for validation
3. **Timeout Limits**: 5-second timeout per workspace to prevent long waits
4. **Registry Caching**: Leverage registry's existing caching mechanisms

## Security Considerations

1. **Local Only**: Signals can only be triggered on localhost workspaces
2. **No Remote Triggering**: This implementation doesn't support remote workspace triggering
3. **Payload Validation**: JSON payload validation before sending

## Testing Strategy

### Integration Tests

Integration tests will create actual workspaces, start them as background processes, and test signal
triggering across multiple workspaces. Tests will be located in
`tests/integration/multi-workspace-signal.test.ts`.

#### Test 1: Basic Multi-Workspace Signal Triggering

```typescript
Deno.test({
  name: "triggers signal on multiple running workspaces",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Create 3 test workspaces with different configurations
    const testDir = await Deno.makeTempDir();
    const workspaces = await createTestWorkspaces(testDir, [
      { name: "workspace-alpha", port: 9001 },
      { name: "workspace-beta", port: 9002 },
      { name: "workspace-gamma", port: 9003 },
    ]);

    // Start all workspaces
    const servers = await startWorkspaceServers(workspaces);

    try {
      // Create a registry and register all workspaces
      const registry = getWorkspaceRegistry();
      await registry.initialize();

      for (const ws of workspaces) {
        await registry.add({
          id: ws.id,
          name: ws.name,
          path: ws.path,
          port: ws.port,
          pid: ws.pid,
          status: WorkspaceStatus.RUNNING,
        });
      }

      // Trigger signal on all workspaces
      const trigger = new SignalTriggerCommand();
      const results = await trigger.triggerOnMultipleWorkspaces(
        workspaces,
        "test-signal",
        { message: "Hello from test" },
      );

      // Verify all workspaces received the signal
      expect(results.length).toBe(3);
      expect(results.every((r) => r.success)).toBe(true);
      expect(results.every((r) => r.sessionId)).toBe(true);
    } finally {
      await cleanupWorkspaces(servers, testDir);
    }
  },
});
```

#### Test 2: Workspace Filtering and Exclusions

```typescript
Deno.test({
  name: "filters workspaces by name and applies exclusions",
  async fn() {
    const testDir = await Deno.makeTempDir();
    const workspaces = await createTestWorkspaces(testDir, [
      { name: "prod-api", port: 9004, tags: ["production"] },
      { name: "prod-web", port: 9005, tags: ["production"] },
      { name: "dev-api", port: 9006, tags: ["development"] },
      { name: "staging-api", port: 9007, tags: ["staging"] },
    ]);

    const servers = await startWorkspaceServers(workspaces);

    try {
      // Test 1: Target specific workspaces by name pattern
      const prodResults = await triggerWithArgs({
        name: "deploy",
        workspace: ["prod-api", "prod-web"],
      });

      expect(prodResults.length).toBe(2);
      expect(prodResults.every((r) => r.workspace.name.startsWith("prod"))).toBe(true);

      // Test 2: Exclude specific workspaces
      const nonDevResults = await triggerWithArgs({
        name: "health-check",
        all: true,
        exclude: ["dev-api"],
      });

      expect(nonDevResults.length).toBe(3);
      expect(nonDevResults.some((r) => r.workspace.name === "dev-api")).toBe(false);
    } finally {
      await cleanupWorkspaces(servers, testDir);
    }
  },
});
```

#### Test 3: Partial Failures and Error Handling

```typescript
Deno.test({
  name: "handles partial failures gracefully",
  async fn() {
    const testDir = await Deno.makeTempDir();

    // Create workspaces with different signal configurations
    const workspaces = [
      await createWorkspaceWithSignals(testDir, "ws-valid", 9008, ["deploy", "test"]),
      await createWorkspaceWithSignals(testDir, "ws-partial", 9009, ["deploy"]),
      await createWorkspaceWithSignals(testDir, "ws-none", 9010, []),
    ];

    const servers = await startWorkspaceServers(workspaces);

    try {
      // Trigger a signal that only exists in some workspaces
      const results = await triggerWithArgs({
        name: "test",
        all: true,
      });

      // Should warn about workspaces missing the signal
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Signal 'test' not found in 2 workspace(s)"),
      );

      // But should still trigger on valid workspace
      expect(results.some((r) => r.success && r.workspace.name === "ws-valid")).toBe(true);

      // Exit code should be 0 (partial success is success)
      expect(process.exitCode).toBe(0);
    } finally {
      await cleanupWorkspaces(servers, testDir);
    }
  },
});
```

#### Test 4: Connection Timeouts and Unreachable Workspaces

```typescript
Deno.test({
  name: "handles connection timeouts for slow/unreachable workspaces",
  async fn() {
    const testDir = await Deno.makeTempDir();

    // Create workspaces with different response behaviors
    const workspaces = [
      await createWorkspace(testDir, "fast-ws", 9011),
      await createSlowWorkspace(testDir, "slow-ws", 9012, 10000), // 10s delay
      await createWorkspace(testDir, "normal-ws", 9013),
    ];

    // Only start fast and normal workspaces
    const servers = await startWorkspaceServers([workspaces[0], workspaces[2]]);

    // Register all workspaces including the "slow" one
    const registry = getWorkspaceRegistry();
    for (const ws of workspaces) {
      await registry.add({
        ...ws,
        status: WorkspaceStatus.RUNNING,
      });
    }

    try {
      const start = Date.now();
      const results = await triggerWithArgs({
        name: "test-signal",
        all: true,
      });
      const elapsed = Date.now() - start;

      // Should timeout after 5 seconds, not wait for slow workspace
      expect(elapsed).toBeLessThan(6000);

      // Fast and normal workspaces should succeed
      expect(results.filter((r) => r.success).length).toBe(2);

      // Slow workspace should fail with timeout
      const slowResult = results.find((r) => r.workspace.name === "slow-ws");
      expect(slowResult?.success).toBe(false);
      expect(slowResult?.error).toContain("timeout");
    } finally {
      await cleanupWorkspaces(servers, testDir);
    }
  },
});
```

#### Test 5: Current Workspace Priority

```typescript
Deno.test({
  name: "prioritizes current workspace when no target specified",
  async fn() {
    const testDir = await Deno.makeTempDir();
    const originalCwd = Deno.cwd();

    // Create multiple workspaces
    const workspaces = await createTestWorkspaces(testDir, [
      { name: "current-ws", port: 9014 },
      { name: "other-ws-1", port: 9015 },
      { name: "other-ws-2", port: 9016 },
    ]);

    const servers = await startWorkspaceServers(workspaces);

    try {
      // Change to current-ws directory
      Deno.chdir(workspaces[0].path);

      // Trigger without specifying workspace
      const results = await triggerWithArgs({
        name: "test-signal",
        // No --all or --workspace flags
      });

      // Should only trigger on current workspace
      expect(results.length).toBe(1);
      expect(results[0].workspace.name).toBe("current-ws");
      expect(results[0].success).toBe(true);
    } finally {
      Deno.chdir(originalCwd);
      await cleanupWorkspaces(servers, testDir);
    }
  },
});
```

#### Test 6: JSON Output Format

```typescript
Deno.test({
  name: "outputs results in JSON format for scripting",
  async fn() {
    const testDir = await Deno.makeTempDir();
    const workspaces = await createTestWorkspaces(testDir, [
      { name: "ws-success", port: 9017 },
      { name: "ws-failure", port: 9018 }, // Will be configured to fail
    ]);

    const servers = await startWorkspaceServers(workspaces);

    try {
      // Capture stdout
      const output = await captureStdout(async () => {
        await triggerWithArgs({
          name: "test-signal",
          all: true,
          json: true,
        });
      });

      // Parse JSON output
      const result = JSON.parse(output);

      // Verify JSON structure
      expect(result.signal).toBe("test-signal");
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.summary.total).toBe(2);
      expect(result.summary.successful).toBeGreaterThanOrEqual(1);
      expect(result.results).toBeInstanceOf(Array);
      expect(result.results[0]).toHaveProperty("workspaceId");
      expect(result.results[0]).toHaveProperty("workspaceName");
      expect(result.results[0]).toHaveProperty("port");
      expect(result.results[0]).toHaveProperty("success");
      expect(result.results[0]).toHaveProperty("durationMs");
    } finally {
      await cleanupWorkspaces(servers, testDir);
    }
  },
});
```

### Test Utilities

```typescript
// Helper functions for tests
async function createTestWorkspaces(
  baseDir: string,
  configs: WorkspaceConfig[],
): Promise<TestWorkspace[]> {
  const workspaces = [];
  for (const config of configs) {
    const wsDir = path.join(baseDir, config.name);
    await Deno.mkdir(wsDir, { recursive: true });

    // Create workspace.yml
    await Deno.writeTextFile(
      path.join(wsDir, "workspace.yml"),
      generateWorkspaceYaml(config),
    );

    // Create atlas.yml
    await Deno.writeTextFile(
      path.join(wsDir, "atlas.yml"),
      generateAtlasYaml(),
    );

    workspaces.push({
      id: crypto.randomUUID(),
      name: config.name,
      path: wsDir,
      port: config.port,
      config,
    });
  }
  return workspaces;
}

async function startWorkspaceServers(workspaces: TestWorkspace[]): Promise<WorkspaceServer[]> {
  const servers = [];
  for (const ws of workspaces) {
    const runtime = await createWorkspaceRuntime(ws);
    const server = new WorkspaceServer(runtime, { port: ws.port });

    // Start server in background
    server.start();

    // Wait for server to be ready
    await waitForServerReady(ws.port);

    servers.push(server);
  }
  return servers;
}

async function cleanupWorkspaces(servers: WorkspaceServer[], testDir: string) {
  // Shutdown all servers
  await Promise.all(servers.map((s) => s.shutdown()));

  // Clean up test directory
  await Deno.remove(testDir, { recursive: true });
}
```

### Performance Benchmarks

```typescript
Deno.test({
  name: "performance: triggers 10 workspaces in parallel under 1 second",
  async fn() {
    const testDir = await Deno.makeTempDir();

    // Create 10 workspaces
    const configs = Array.from({ length: 10 }, (_, i) => ({
      name: `perf-ws-${i}`,
      port: 9100 + i,
    }));

    const workspaces = await createTestWorkspaces(testDir, configs);
    const servers = await startWorkspaceServers(workspaces);

    try {
      const start = performance.now();

      const results = await triggerWithArgs({
        name: "test-signal",
        all: true,
      });

      const elapsed = performance.now() - start;

      // All should succeed
      expect(results.every((r) => r.success)).toBe(true);
      expect(results.length).toBe(10);

      // Should complete in under 1 second (parallel execution)
      expect(elapsed).toBeLessThan(1000);

      // Log performance metrics
      console.log(`Triggered ${results.length} workspaces in ${elapsed.toFixed(2)}ms`);
      console.log(`Average per workspace: ${(elapsed / results.length).toFixed(2)}ms`);
    } finally {
      await cleanupWorkspaces(servers, testDir);
    }
  },
});
```

## Implementation Status

### Task List

#### Phase 1: CLI Interface Changes ✅ COMPLETED

- [x] Update `TriggerArgs` interface to support arrays
- [x] Add `--all/-a` flag for all workspaces
- [x] Add `--exclude/-x` flag for exclusions
- [x] Update `--workspace/-w` to accept comma-separated values
- [x] Add coerce functions for comma-separated parsing
- [x] Update CLI examples with new usage patterns
- [x] Fix type errors in initial implementation

#### Phase 2: Core Logic Refactoring ✅ COMPLETED

- [x] Add `TargetWorkspace` interface
- [x] Add `TriggerResult` interface
- [x] Implement `resolveTargetWorkspaces()` function
- [x] Implement `validateSignalInWorkspaces()` function
- [x] Implement `triggerSignalOnWorkspace()` with 5s timeout
- [x] Implement `triggerSignalOnMultipleWorkspaces()` for parallel execution
- [x] Implement `formatTriggerResults()` for output formatting
- [x] Implement `getSignalPayload()` for data handling
- [x] Replace old handler with multi-workspace handler
- [x] Remove deprecated helper functions
- [x] Fix workspace status enum usage
- [x] Ensure all linting and type checks pass

#### Phase 3: Testing & Documentation ✅ COMPLETED

- [x] Create integration test file `tests/integration/signal-trigger-multi-workspace.test.ts`
- [x] Implement workspace setup and configuration tests
- [x] Implement workspace resolution logic tests
- [x] Implement parallel execution pattern tests
- [x] Implement timeout handling tests
- [x] Implement result formatting tests
- [x] Create manual test script for real-world testing
- [x] Verify all tests pass without type errors or leaks
- [x] Document test approach and patterns

## Implementation Timeline

1. **Phase 1**: Core multi-workspace support (1-2 days) ✅ COMPLETED
   - Workspace resolution logic
   - Multi-workspace triggering
   - Basic output formatting

2. **Phase 2**: Enhanced features (1 day) ✅ COMPLETED
   - Advanced filtering (exclusions)
   - JSON output format
   - Error handling improvements

3. **Phase 3**: Polish and testing (1 day) ✅ COMPLETED
   - Performance optimization
   - Documentation updates
   - Integration testing

## Success Metrics

1. **Functionality**: Can trigger signals on multiple workspaces with one command
2. **Performance**: Parallel triggering completes in < 1 second for 10 workspaces
3. **Usability**: Clear feedback about which workspaces received signals
4. **Reliability**: Graceful handling of partial failures
5. **Discoverability**: Intuitive CLI interface with helpful examples

## Next Steps

1. Review and approve this plan
2. Create feature branch for implementation
3. Implement core functionality with tests
4. Update CLI documentation and examples
5. Test with real multi-workspace scenarios
6. Deploy as part of CLI v2 improvements
