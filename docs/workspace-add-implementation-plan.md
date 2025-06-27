# Atlas Workspace Add Command Implementation Plan

## Overview

This document outlines the implementation plan for adding a new CLI command `atlas workspace add`
that allows users to explicitly register existing workspaces by providing paths. The command
supports both single workspace registration and batch registration of multiple workspaces.

## Command Specification

### Usage

```bash
# Single workspace
atlas workspace add <path>
atlas workspace add /path/to/workspace
atlas workspace add ./relative/path
atlas workspace add ~/my-workspace

# Batch registration
atlas workspace add <path1> <path2> <path3>
atlas workspace add ~/project1 ~/project2 ~/project3
atlas workspace add --scan <directory>
```

### Options

- `--name <name>`: Override the workspace name (default: directory basename) - only for single
  workspace
- `--description <desc>`: Add a description to the workspace - only for single workspace
- `--scan <directory>`: Scan directory recursively for workspaces
- `--depth <number>`: Maximum depth for --scan (default: 3, max: 10)
- `--json`: Output results as JSON for scripting

## Implementation Steps

### 1. Create CLI Command File

Create `/src/cli/commands/workspace/add.tsx` following the existing pattern:

```typescript
export const command = "add <paths..>";
export const desc = "Add existing workspace(s) to Atlas registry";
export const aliases = ["register"];
```

### 2. Update Workspace Command Router

Modify `/src/cli/commands/workspace.ts` to include the new add command:

- Import the add command module
- Add it to the command array in the builder function
- Update examples to include the add command

### 3. Extend Atlas Client Package

Add new methods to `/packages/client/src/client.ts`:

```typescript
/**
 * Add a single workspace by path
 */
async addWorkspace(request: WorkspaceAddRequest): Promise<WorkspaceInfo>

/**
 * Add multiple workspaces by paths (batch operation)
 */
async addWorkspaces(request: WorkspaceBatchAddRequest): Promise<WorkspaceBatchAddResponse>
```

Add corresponding types to `/packages/client/src/types/workspace.ts`:

```typescript
export interface WorkspaceAddRequest {
  path: string;
  name?: string;
  description?: string;
}

export interface WorkspaceBatchAddRequest {
  paths: string[];
}

export interface WorkspaceBatchAddResponse {
  added: WorkspaceInfo[];
  failed: Array<{
    path: string;
    error: string;
  }>;
}
```

Add schemas to `/packages/client/src/schemas.ts`:

```typescript
export const WorkspaceAddRequestSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});

export const WorkspaceBatchAddResponseSchema = z.object({
  added: z.array(WorkspaceInfoSchema),
  failed: z.array(z.object({
    path: z.string(),
    error: z.string(),
  })),
});
```

### 4. Extend Daemon API

Add new endpoints to `AtlasDaemon` in `/src/core/atlas-daemon.ts`:

```typescript
// POST /api/workspaces/add - Add single workspace
this.app.post("/api/workspaces/add", async (c) => {
  const body = await c.req.json();
  const { path, name, description } = body;

  // Validate path exists
  // Check for workspace.yml (required)
  // Register workspace using WorkspaceManager
  // Return workspace entry
});

// POST /api/workspaces/add-batch - Add multiple workspaces
this.app.post("/api/workspaces/add-batch", async (c) => {
  const body = await c.req.json();
  const { paths } = body;

  // Process each path
  // Collect successes and failures
  // Return batch response
});
```

### 5. Implement Command Handler

The command handler should:

1. Parse command arguments (paths or --scan option)
2. For each path:
   - Validate the path exists and is a directory
   - Check if workspace.yml exists (throw error if not found)
   - Resolve relative paths to absolute paths
   - Check if workspace is already registered
3. For --scan option:
   - Parse --depth flag (default: 3, max: 10)
   - Recursively scan directory for workspace.yml files up to specified depth
   - Collect all workspace paths found
4. Call appropriate client API method (single or batch)
5. Display results (success/failure for each workspace)
6. Support JSON output for scripting

### 6. Error Handling

Handle these error cases:

- Path does not exist
- Path is not a directory
- workspace.yml not found (always required)
- Workspace already registered at this path
- Permission denied accessing path
- Daemon not running
- Invalid workspace.yml format
- Batch operation partial failures

### 7. Integration with WorkspaceManager

The daemon endpoints will use the existing `WorkspaceManager.registerWorkspace()` method which:

- Generates a unique Docker-style ID
- Loads and caches the workspace configuration
- Creates the registry entry
- Returns the workspace entry

For batch operations, the daemon will:

- Process paths concurrently (with reasonable limits)
- Collect successes and failures
- Return comprehensive batch response

## Technical Considerations

### Path Resolution

- Support relative paths, absolute paths, and tilde expansion
- Use `Deno.realPath()` to resolve to canonical absolute path
- Handle symlinks appropriately

### Validation

- Verify directory exists and is accessible
- Check for workspace.yml unless --force flag is used
- Prevent duplicate registrations of the same path

### User Experience

- Provide clear feedback on success/failure
- Show the generated workspace ID and name
- Suggest next steps (e.g., triggering signals)
- Support both interactive (Ink) and JSON output modes

## Example Implementation Flows

### Single Workspace Add

1. User runs: `atlas workspace add ~/projects/my-workspace`
2. CLI validates daemon is running
3. CLI resolves path to absolute: `/Users/username/projects/my-workspace`
4. CLI calls client.addWorkspace() with path and options
5. Client makes POST request to /api/workspaces/add
6. Daemon validates path and workspace.yml exists
7. Daemon calls WorkspaceManager.registerWorkspace()
8. WorkspaceManager generates ID, loads config, creates entry
9. Daemon returns workspace info to CLI
10. CLI displays success message with workspace details

### Batch Workspace Add

1. User runs: `atlas workspace add ~/project1 ~/project2 ~/project3`
2. CLI validates daemon is running
3. CLI resolves all paths to absolute paths
4. CLI calls client.addWorkspaces() with paths array
5. Client makes POST request to /api/workspaces/add-batch
6. Daemon processes each path concurrently:
   - Validates path exists
   - Checks for workspace.yml
   - Registers if valid, records error if not
7. Daemon returns batch response with successes and failures
8. CLI displays results for each workspace

### Scan Directory for Workspaces

1. User runs: `atlas workspace add --scan ~/projects --depth 5`
2. CLI validates depth parameter (default: 3, max: 10)
3. CLI scans directory recursively up to specified depth
4. CLI finds all directories containing workspace.yml
5. CLI calls client.addWorkspaces() with discovered paths
6. Same batch processing as above
7. CLI displays summary of added workspaces

## Testing Considerations

- Unit tests for path resolution and validation
- Integration tests for single and batch registration flows
- Edge cases:
  - Missing workspace.yml (should error)
  - Duplicate paths
  - Invalid paths
  - Symlinks
  - Paths with spaces
  - Empty batch operations
  - Partial batch failures
- Test --scan with various directory structures:
  - Different depth values (1, 3, 5, 10)
  - Depth validation (reject > 10)
  - Nested workspace structures
  - Performance with large directory trees
- Test JSON output mode for scripting

## Implementation Priority

1. Single workspace add functionality
2. Batch add with multiple paths
3. --scan directory option
4. JSON output support
