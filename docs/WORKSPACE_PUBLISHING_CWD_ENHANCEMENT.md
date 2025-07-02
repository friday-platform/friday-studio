# Workspace Publishing CWD Enhancement Plan

## Problem Statement

Currently, when users create workspaces through the conversation supervisor, workspaces are always
created in `~/.atlas/workspaces/{name}` regardless of the user's current working directory (CWD).
This doesn't match user expectations - if they're in `~/code/` and create a workspace named "dang",
they expect it to be created at `~/code/dang/`.

Additionally:

- No collision detection - if directory exists, it fails instead of using incremental naming
- Direct filesystem operations in daemon instead of using storage adapters
- No way to pass CWD context from conversation supervisor to daemon

## Requirements

1. **CWD-based Path Resolution**: When no explicit path is provided, use the user's CWD as the base
   directory
2. **Collision Detection**: If target directory exists, append incremental counter (dang-2, dang-3,
   etc.)
3. **Storage Adapter Pattern**: Create a new `WorkspaceCreationAdapter` to handle filesystem
   operations
4. **Context Passing**: Pass CWD from conversation supervisor to daemon endpoint

## Proposed Solution

### 1. Create WorkspaceCreationAdapter

Create a new adapter in `@atlas/storage` package:

```typescript
// packages/storage/src/adapters/workspace-creation-adapter.ts
export interface WorkspaceCreationAdapter {
  /**
   * Create a workspace directory with collision detection
   * @param basePath - Base directory (CWD or explicit path)
   * @param name - Workspace name
   * @returns Final path where workspace was created
   */
  createWorkspaceDirectory(basePath: string, name: string): Promise<string>;

  /**
   * Write workspace configuration files
   * @param workspacePath - Directory path
   * @param config - Workspace YAML configuration
   */
  writeWorkspaceFiles(workspacePath: string, config: string): Promise<void>;
}

export class FilesystemWorkspaceCreationAdapter implements WorkspaceCreationAdapter {
  async createWorkspaceDirectory(basePath: string, name: string): Promise<string> {
    let targetPath = join(basePath, name);
    let counter = 1;

    // Check if directory exists and find available name
    while (true) {
      try {
        await Deno.stat(targetPath);
        // Directory exists, try with counter
        counter++;
        targetPath = join(basePath, `${name}-${counter}`);
      } catch {
        // Directory doesn't exist, we can use it
        break;
      }
    }

    // Create the directory
    await Deno.mkdir(targetPath, { recursive: true });
    return targetPath;
  }

  async writeWorkspaceFiles(workspacePath: string, config: string): Promise<void> {
    // Write workspace.yml
    const configPath = join(workspacePath, "workspace.yml");
    await Deno.writeTextFile(configPath, config);

    // Create .env file with placeholder
    const envPath = join(workspacePath, ".env");
    await Deno.writeTextFile(
      envPath,
      "# Add your environment variables here\nANTHROPIC_API_KEY=\n",
    );
  }
}
```

### 2. Update ConversationSupervisor

Modify the `publish_workspace` tool to include CWD context:

```typescript
// src/core/conversation-supervisor.ts
publish_workspace: {
  // ... existing parameters ...
  execute: (async ({ draftId, path }) => {
    // ... existing validation ...

    // Get current working directory if no path specified
    const cwd = path || Deno.cwd();

    // Call daemon API with CWD context
    const response = await fetch(`${daemonUrl}/api/workspaces/create-from-config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: draft.name,
        description: draft.description,
        config: yaml,
        path,
        cwd, // Add CWD to request
      }),
    });

    // ... rest of implementation
  });
}
```

### 3. Update AtlasDaemon Endpoint

Modify `/api/workspaces/create-from-config` to use the new adapter:

```typescript
// apps/atlasd/src/atlas-daemon.ts

// Add to imports
import { FilesystemWorkspaceCreationAdapter } from "@atlas/storage";

// Add to class properties
private workspaceCreationAdapter: FilesystemWorkspaceCreationAdapter;

// Initialize in constructor/init
this.workspaceCreationAdapter = new FilesystemWorkspaceCreationAdapter();

// Update the endpoint
this.app.post("/api/workspaces/create-from-config", async (c) => {
  try {
    const body = await c.req.json() as {
      name: string;
      description: string;
      config: string;
      path?: string;
      cwd?: string; // Add CWD to body type
    };

    const { name, description, config, path, cwd } = body;

    if (!name || !description || !config) {
      return c.json({ error: "name, description, and config are required" }, 400);
    }

    // Determine base path
    let basePath: string;
    if (path) {
      // Explicit path provided - use its parent directory
      basePath = dirname(path);
    } else if (cwd) {
      // Use provided CWD
      basePath = cwd;
    } else {
      // Fallback to ~/.atlas/workspaces
      basePath = join(Deno.env.get("HOME") || "/tmp", ".atlas/workspaces");
    }

    // Create workspace directory with collision detection
    const workspacePath = await this.workspaceCreationAdapter.createWorkspaceDirectory(
      basePath,
      name
    );

    // Write workspace files
    await this.workspaceCreationAdapter.writeWorkspaceFiles(workspacePath, config);

    // Register the new workspace
    const manager = getWorkspaceManager();
    const entry = await manager.registerWorkspace(workspacePath, {
      name,
      description,
    });

    return c.json({
      id: entry.id,
      name: entry.name,
      path: entry.path,
      description,
      message: `Workspace created successfully from configuration`,
    }, 201);
  } catch (error) {
    return c.json({
      error: `Failed to create workspace from config: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }, 500);
  }
});
```

### 4. Update System Prompt

Update the conversation supervisor's system prompt to explain the new behavior:

```typescript
## Publishing Workspaces
When the user says "publish it" or wants to finalize their workspace:
1. Call publish_workspace with the draftId
2. The workspace will be created in the user's current directory with collision detection
3. If a directory with that name exists, it will use name-2, name-3, etc.
4. Include the FULL PATH where the workspace was created in your response
```

## Implementation Steps

1. **Create WorkspaceCreationAdapter** in @atlas/storage package
   - Define interface
   - Implement filesystem adapter with collision detection
   - Add tests

2. **Update ConversationSupervisor**
   - Pass CWD in publish_workspace tool
   - Update system prompt to explain behavior

3. **Update AtlasDaemon**
   - Add workspaceCreationAdapter property
   - Update create-from-config endpoint
   - Remove direct filesystem operations

4. **Test scenarios**
   - Create workspace in CWD
   - Create workspace with explicit path
   - Collision detection (dang, dang-2, dang-3)
   - Fallback to ~/.atlas/workspaces when no context

## Benefits

1. **Better UX**: Workspaces created where users expect them
2. **Collision Safety**: No failures due to existing directories
3. **Clean Architecture**: Storage operations properly abstracted
4. **Flexibility**: Easy to add cloud storage adapters in future

## Migration Considerations

- Existing workspaces in ~/.atlas/workspaces remain unaffected
- New behavior only applies to workspaces created through conversation supervisor
- Direct API calls can still specify explicit paths
