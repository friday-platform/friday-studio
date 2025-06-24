# Signal Trigger Multi-Workspace Support Plan

## Overview

This document outlines the plan to extend the `atlas signal trigger` command to support emitting
signals to multiple running workspaces. With the new multi-workspace background process
architecture, the current implementation that only targets a single workspace on a hardcoded port is
insufficient.

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

1. **Broadcast by Default**: When no workspace is specified, trigger the signal on all running
   workspaces
2. **Flexible Filtering**: Support filtering to specific workspaces via CLI flags
3. **Port Discovery**: Automatically use the correct port for each workspace from the registry
4. **Error Resilience**: Handle partial failures gracefully when some workspaces are unavailable
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
  port: {
    type: "number" as const,
    alias: "p",
    describe: "Port of the workspace server (deprecated - use workspace filtering instead)",
    deprecated: true,
  },
  exclude: {
    type: "string" as const,
    alias: "x",
    describe: "Workspace ID(s) or name(s) to exclude (comma-separated)",
    coerce: (value: string) => value ? value.split(",").map((v) => v.trim()) : [],
  },
  parallel: {
    type: "boolean" as const,
    describe: "Send signals in parallel (default: true)",
    default: true,
  },
  continueOnError: {
    type: "boolean" as const,
    describe: "Continue triggering remaining workspaces if one fails",
    default: true,
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
  } else if (args.port) {
    // Legacy: single workspace by port
    console.warn("Using --port is deprecated. Use --workspace or --all instead.");
    // Handle legacy port-based triggering
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
  parallel: boolean = true,
  continueOnError: boolean = true,
): Promise<TriggerResult[]> {
  if (parallel) {
    // Trigger all workspaces in parallel
    return await Promise.all(
      workspaces.map((w) => triggerSignalOnWorkspace(w, signalName, payload)),
    );
  } else {
    // Trigger sequentially
    const results: TriggerResult[] = [];

    for (const workspace of workspaces) {
      const result = await triggerSignalOnWorkspace(workspace, signalName, payload);
      results.push(result);

      if (!result.success && !continueOnError) {
        break;
      }
    }

    return results;
  }
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

    if (invalidWorkspaces.length > 0 && !argv.continueOnError) {
      errorOutput(
        `Signal '${argv.name}' not found in ${invalidWorkspaces.length} workspace(s):\n` +
          invalidWorkspaces.map((w) => `  - ${w.name} (${w.id})`).join("\n"),
      );
      Deno.exit(1);
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
        argv.parallel,
        argv.continueOnError,
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
        argv.parallel,
        argv.continueOnError,
      );

      formatTriggerResults(results, argv.name, true);
    }

    // Exit with appropriate code
    const hasFailures = results.some((r) => !r.success);
    Deno.exit(hasFailures && !argv.continueOnError ? 1 : 0);
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
# Sequential triggering with stop-on-error
atlas signal trigger critical-update --all --no-parallel --no-continue-on-error

# JSON output for scripting
atlas signal trigger health-check --all --json | jq '.results[] | select(.success == false)'

# Target multiple specific workspaces
atlas signal trigger refresh --workspace happy_einstein,fervent_turing,zen_bardeen
```

## Migration Considerations

1. **Backward Compatibility**: The `--port` flag will be deprecated but still functional
2. **Default Behavior Change**: When no workspace is specified, the new behavior will attempt to use
   the current workspace first, then fall back to all running workspaces
3. **Warning Messages**: Clear deprecation warnings for `--port` usage

## Error Handling

1. **Partial Failures**: By default, continue triggering remaining workspaces even if some fail
2. **Connection Errors**: Distinguish between "workspace not running" and "signal not found"
3. **Timeout Protection**: Each workspace trigger has its own timeout to prevent hanging
4. **Health Check Integration**: Optionally update workspace status in registry if connection fails

## Performance Considerations

1. **Parallel by Default**: Send signals to all workspaces concurrently for better performance
2. **Lazy Loading**: Only load workspace configurations when needed for validation
3. **Timeout Limits**: 5-second timeout per workspace to prevent long waits
4. **Registry Caching**: Leverage registry's existing caching mechanisms

## Security Considerations

1. **Local Only**: Signals can only be triggered on localhost workspaces
2. **No Remote Triggering**: This implementation doesn't support remote workspace triggering
3. **Payload Validation**: JSON payload validation before sending

## Testing Strategy

1. **Unit Tests**: Test workspace resolution, filtering, and result formatting
2. **Integration Tests**: Test with multiple mock workspace servers
3. **Error Scenarios**: Test partial failures, timeouts, and invalid signals
4. **Performance Tests**: Verify parallel triggering with many workspaces

## Implementation Timeline

1. **Phase 1**: Core multi-workspace support (2-3 days)
   - Workspace resolution logic
   - Multi-workspace triggering
   - Basic output formatting

2. **Phase 2**: Enhanced features (1-2 days)
   - Parallel/sequential control
   - Advanced filtering (exclusions)
   - JSON output format

3. **Phase 3**: Polish and testing (1 day)
   - Error handling improvements
   - Performance optimization
   - Documentation updates

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
