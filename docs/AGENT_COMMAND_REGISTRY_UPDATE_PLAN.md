# Agent Command Registry Update - Implementation Complete

## Summary

This document tracks the successful implementation of agent command updates to work with the
workspace registry system. Users can now run agent commands from any directory using the
`--workspace` flag.

## Implementation Details

### Changes Made

1. **Added Workspace Resolution Logic**
   - Created `resolveWorkspace()` helper function that:
     - Finds workspaces by ID or name from the registry
     - Falls back to current directory if no workspace specified
     - Auto-registers unregistered workspaces with `workspace.yml`
     - Provides clear error messages

2. **Added Configuration Loading Helper**
   - Created `loadWorkspaceConfig()` that safely loads workspace configuration from any directory
   - Properly handles directory switching to ensure relative paths work

3. **Updated All Agent Subcommands**
   - `handleList()` - Now uses the new resolution logic
   - `handleDescribe()` - Added workspace parameter support
   - `handleTest()` - Added workspace parameter support

4. **Improved Type Safety**
   - Replaced all `any` types with proper TypeScript interfaces
   - Used existing types from `config-loader.ts` (`NewWorkspaceConfig`, `WorkspaceAgentConfig`)
   - Created `CommandFlags` and `OutputData` interfaces

5. **Enhanced Error Messages**
   - Clear guidance when workspace not found
   - Helpful suggestions to use `--workspace` flag
   - Instructions to run `atlas workspace list` to see available workspaces

## Required Changes

### 1. Command Interface Updates

Add consistent `--workspace` flag support across all agent subcommands:

```bash
# List agents in a specific workspace
atlas agent list --workspace=fervent_einstein

# Describe an agent in a specific workspace
atlas agent describe my-agent --workspace=fervent_einstein

# Test an agent in a specific workspace
atlas agent test my-agent --message "Hello" --workspace=fervent_einstein

# Default behavior (current directory)
atlas agent list  # Uses current directory workspace if exists
```

### 2. Function Signature Updates

Update all handler functions to accept an optional workspace identifier:

```typescript
async function handleList(workspaceId?: string);
async function handleDescribe(agentName: string, workspaceId?: string);
async function handleTest(agentName: string, flags: any, workspaceId?: string);
```

### 3. Workspace Resolution Logic

Implement a consistent workspace resolution pattern:

```typescript
async function resolveWorkspace(workspaceId?: string): Promise<{
  path: string;
  id: string;
  name: string;
}> {
  const registry = getWorkspaceRegistry();

  if (workspaceId) {
    // Find by ID or name in registry
    const workspace = await registry.findById(workspaceId) ||
      await registry.findByName(workspaceId);

    if (!workspace) {
      throw new Error(
        `Workspace '${workspaceId}' not found. ` +
          `Run 'atlas workspace list' to see available workspaces.`,
      );
    }

    return {
      path: workspace.path,
      id: workspace.id,
      name: workspace.name,
    };
  } else {
    // Try current directory
    const currentWorkspace = await registry.getCurrentWorkspace();

    if (currentWorkspace) {
      return {
        path: currentWorkspace.path,
        id: currentWorkspace.id,
        name: currentWorkspace.name,
      };
    }

    // Fallback to checking for workspace.yml in current directory
    if (await exists("workspace.yml")) {
      // Register this workspace if not already registered
      const workspace = await registry.findOrRegister(Deno.cwd());
      return {
        path: workspace.path,
        id: workspace.id,
        name: workspace.name,
      };
    }

    throw new Error(
      "No workspace specified and not in a workspace directory. " +
        "Use --workspace flag or run from a workspace directory.",
    );
  }
}
```

## Implementation Approach

### Phase 1: Refactor Common Logic

1. **Extract workspace resolution** - Create a shared `resolveWorkspace` function
2. **Create config loading helper** - Extract the configuration loading logic with proper directory
   switching
3. **Standardize error messages** - Consistent messaging for workspace not found scenarios

### Phase 2: Update Handler Functions

1. **Update handleList** - Refactor to use the new resolution logic (minimal changes needed)
2. **Update handleDescribe** - Add workspace parameter and resolution
3. **Update handleTest** - Add workspace parameter and resolution

### Phase 3: CLI Integration

1. **Update command props** - Ensure flags are properly passed through
2. **Update meow configuration** - Add workspace flag definition if not present
3. **Update help text** - Document the new --workspace flag

## Code Structure Modifications

### 1. Updated AgentCommand Component

```typescript
export function AgentCommand({ subcommand, args, flags }: AgentCommandProps) {
  const workspaceId = flags.workspace || flags.w;

  useEffect(() => {
    const execute = async () => {
      try {
        switch (subcommand) {
          case "list":
            await handleList(workspaceId);
            break;
          case "describe":
            await handleDescribe(args[0], workspaceId);
            break;
          case "test":
            await handleTest(args[0], flags, workspaceId);
            break;
            // ...
        }
      } catch (err) {
        // error handling
      }
    };
    execute();
  }, []);

  // ... rest of component
}
```

### 2. Configuration Loading Helper

```typescript
async function loadWorkspaceConfig(workspacePath: string): Promise<any> {
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);
    const configLoader = new ConfigLoader();
    const mergedConfig = await configLoader.load();
    return mergedConfig.workspace;
  } finally {
    Deno.chdir(originalCwd);
  }
}
```

### 3. Updated Handler Example (handleDescribe)

```typescript
async function handleDescribe(agentName: string | undefined, workspaceId?: string) {
  if (!agentName) {
    throw new Error("Agent name required. Usage: atlas agent describe <name> [--workspace=<id>]");
  }

  const workspace = await resolveWorkspace(workspaceId);
  const config = await loadWorkspaceConfig(workspace.path);

  const agentConfig = config.agents?.[agentName];

  if (!agentConfig) {
    throw new Error(
      `Agent '${agentName}' not found in workspace '${workspace.name}' (${workspace.id})`,
    );
  }

  setData({
    type: "detail",
    agent: {
      name: agentName,
      workspace: workspace.name,
      workspaceId: workspace.id,
      ...agentConfig,
      model: agentConfig.model || config.supervisor?.model || "claude-3-5-sonnet-20241022",
    },
  });
  setStatus("ready");
}
```

## Error Handling Strategy

### 1. Clear Error Messages

- **Workspace not found**: "Workspace 'xyz' not found. Use 'atlas workspace list' to see available
  workspaces."
- **Not in workspace**: "No workspace specified and not in a workspace directory. Use --workspace
  flag or run from a workspace directory."
- **Agent not found**: "Agent 'abc' not found in workspace 'fervent_einstein'"

### 2. Graceful Fallbacks

- If no workspace specified, try current directory
- If current directory has workspace.yml, auto-register it if needed
- Provide helpful suggestions in error messages

## Testing Strategy

### 1. Integration Tests (Primary Focus)

Create comprehensive integration tests that exercise the full command flow with real workspaces:

```typescript
// src/cli/tests/agent-registry.test.ts
Deno.test("agent list - works from outside workspace with --workspace flag", async () => {
  // Setup: Create and register a test workspace
  const testDir = await Deno.makeTempDir();
  const workspaceConfig = createTestWorkspaceConfig();
  await Deno.writeTextFile(join(testDir, "workspace.yml"), yaml.stringify(workspaceConfig));

  const registry = getWorkspaceRegistry();
  const workspace = await registry.register(testDir, { name: "test-workspace" });

  // Test: Run command from different directory
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(Deno.env.get("HOME")!);

    // Execute agent list command
    const result = await runCliCommand(["agent", "list", "--workspace", workspace.id]);

    // Assert: Command succeeds and shows agents
    assertEquals(result.status, 0);
    assertStringIncludes(result.stdout, "test-agent");
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(testDir, { recursive: true });
    await registry.unregister(workspace.id);
  }
});

Deno.test("agent describe - resolves workspace by name", async () => {
  // Test using workspace name instead of ID
  const workspace = await setupTestWorkspace("my-test-workspace");

  const result = await runCliCommand([
    "agent",
    "describe",
    "my-agent",
    "--workspace",
    "my-test-workspace",
  ]);

  assertEquals(result.status, 0);
  assertStringIncludes(result.stdout, "Agent Details");
});

Deno.test("agent commands - fallback to current directory", async () => {
  // Test that commands work without --workspace when in workspace dir
  const testDir = await createTestWorkspace();
  const originalCwd = Deno.cwd();

  try {
    Deno.chdir(testDir);
    const result = await runCliCommand(["agent", "list"]);

    assertEquals(result.status, 0);
    assertStringIncludes(result.stdout, "Agents in workspace");
  } finally {
    Deno.chdir(originalCwd);
  }
});

Deno.test("agent test - error handling for missing workspace", async () => {
  const result = await runCliCommand([
    "agent",
    "test",
    "my-agent",
    "--message",
    "Hello",
    "--workspace",
    "nonexistent_workspace",
  ]);

  assertNotEquals(result.status, 0);
  assertStringIncludes(result.stderr, "Workspace 'nonexistent_workspace' not found");
  assertStringIncludes(result.stderr, "atlas workspace list");
});
```

### 2. End-to-End Testing Scenarios

Test complete workflows that mimic real user behavior:

```typescript
Deno.test("complete agent workflow across workspaces", async () => {
  // Create multiple workspaces
  const workspace1 = await createAndRegisterWorkspace("project-alpha");
  const workspace2 = await createAndRegisterWorkspace("project-beta");

  // List agents across workspaces
  const list1 = await runCliCommand(["agent", "list", "--workspace", workspace1.id]);
  const list2 = await runCliCommand(["agent", "list", "--workspace", workspace2.id]);

  // Verify different agents appear
  assertStringIncludes(list1.stdout, "alpha-agent");
  assertStringIncludes(list2.stdout, "beta-agent");

  // Test agent operations
  const describe = await runCliCommand([
    "agent",
    "describe",
    "alpha-agent",
    "--workspace",
    workspace1.id,
  ]);

  assertEquals(describe.status, 0);
});
```

### 3. Error Scenario Integration Tests

```typescript
Deno.test("helpful error messages guide users", async () => {
  // Not in workspace, no --workspace flag
  const result = await runCliCommand(["agent", "list"], { cwd: Deno.env.get("HOME") });

  assertStringIncludes(result.stderr, "No workspace specified and not in a workspace directory");
  assertStringIncludes(result.stderr, "Use --workspace flag");
});

Deno.test("agent not found in specified workspace", async () => {
  const workspace = await setupTestWorkspace();

  const result = await runCliCommand([
    "agent",
    "describe",
    "nonexistent-agent",
    "--workspace",
    workspace.id,
  ]);

  assertStringIncludes(result.stderr, `Agent 'nonexistent-agent' not found in workspace`);
  assertStringIncludes(result.stderr, workspace.name);
});
```

### 4. Manual Testing Checklist

Before release, manually verify these scenarios:

- [ ] Run `atlas agent list --workspace=<id>` from home directory
- [ ] Run `atlas agent describe <agent> --workspace=<name>` using workspace name
- [ ] Run `atlas agent test` with --workspace flag
- [ ] Verify commands work without flag when in workspace directory
- [ ] Test auto-registration of unregistered workspaces
- [ ] Verify error messages are helpful and actionable
- [ ] Test with workspaces that have spaces in paths
- [ ] Test concurrent access (multiple commands at once)

## Documentation Updates

- Update CLI help text for agent command
- Add examples showing --workspace usage
- Update user documentation with new capabilities

## Future Enhancements

### 1. Short Aliases

```bash
atlas agent list -w fervent_einstein
```

### 2. Default Workspace Configuration

Allow users to set a default workspace in their environment or config file

### 3. Multi-Workspace Operations

```bash
atlas agent list --all-workspaces
atlas agent list --workspace=workspace1,workspace2
```

### 4. Interactive Workspace Selection

If no workspace specified and not in a workspace directory, show an interactive selector

## Implementation Timeline

1. **Phase 1** (2-3 hours): Refactor common logic and helpers
2. **Phase 2** (3-4 hours): Update all handler functions
3. **Phase 3** (1-2 hours): CLI integration and testing
4. **Phase 4** (1-2 hours): Documentation and cleanup

Total estimated time: 7-11 hours

## Success Criteria

1. All agent subcommands work from any directory with --workspace flag
2. Backward compatibility maintained for existing usage patterns
3. Clear, helpful error messages guide users
4. Consistent behavior across all subcommands
5. Tests pass and cover main scenarios
6. Documentation updated to reflect new capabilities

## Notes

- The `handleList` function already has a good foundation for this change
- Consider applying similar patterns to other CLI commands (session, signal, etc.)
- This change aligns with the broader workspace registry vision of managing multiple workspaces from
  anywhere
