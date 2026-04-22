# @atlas/system

This package contains system-level components for Atlas, including built-in system workspaces and
agents.

## System Workspaces

System workspaces are built-in workspaces that provide core Atlas functionality. They are embedded
at build time and always available in every Atlas installation.

### Key Characteristics

1. **Build-Time Embedding**: System workspaces are defined as YAML files and embedded into the Atlas
   binary at build time
2. **Always Available**: They are automatically registered when the WorkspaceManager initializes
3. **Protected**: Cannot be deleted without explicit force option
4. **Identified by**:
   - `metadata.system = true` field
   - `system://` path prefix (e.g., `system://system`)
   - Known IDs defined in `SystemWorkspaceId` type

### Implementation

#### Directory Structure

```
packages/system/workspaces/
├── system.yml          # Kernel system workspace
└── mod.ts              # Build-time import module
```

#### Build-Time Import

The `packages/system/workspaces/mod.ts` file imports each YAML file and exposes it via
`SYSTEM_WORKSPACES`:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceConfigSchema } from "@atlas/config";
import { parse } from "@std/yaml";

const systemYaml = readFileSync(fileURLToPath(new URL("./system.yml", import.meta.url)), "utf-8");

export const SYSTEM_WORKSPACES = {
  system: WorkspaceConfigSchema.parse(parse(systemYaml)),
} as const;

export type SystemWorkspaceId = keyof typeof SYSTEM_WORKSPACES;
```

### Registration

System workspaces are automatically registered by the WorkspaceManager during initialization:

```typescript
const manager = new WorkspaceManager(registry);
await manager.initialize({
  registerSystemWorkspaces: true, // Default behavior
});
```

### Usage

#### Accessing System Workspaces

System workspaces can be accessed like any other workspace:

```typescript
// Find by ID
const systemWorkspace = await manager.find({ id: "system" });

// List all workspaces including system ones
const allWorkspaces = await manager.list({ includeSystem: true });
```

#### Configuration Loading

When loading configuration for a system workspace, the embedded config is returned directly:

```typescript
const config = await manager.getWorkspaceConfig("system");
// Returns the embedded configuration object
```

### Benefits

1. **No File System Dependencies**: System workspaces don't require file system access
2. **Consistent Availability**: Always present regardless of installation method
3. **Version Controlled**: Configuration changes are tracked in source control
4. **Type Safety**: Build-time validation ensures configurations are valid
5. **Performance**: No runtime file I/O for system workspace configs

### Adding New System Workspaces

To add a new system workspace:

1. Create a new YAML file in `packages/system/workspaces/`
2. Read it in `packages/system/workspaces/mod.ts`
3. Add it to the `SYSTEM_WORKSPACES` const
4. The workspace will be automatically available after rebuild

## System Agents

The `agents/` directory contains system-level agents that provide core Atlas functionality.
Currently registered system agents:

- `workspace-chat`: Powers per-workspace direct chat (the user-facing chat surface)
- `workspace-improver`: System workspace for self-modification flows

These agents are registered in `packages/core/src/agent-loader/adapters/system-adapter.ts` and
exposed via `packages/system/agents/mod.ts`.
