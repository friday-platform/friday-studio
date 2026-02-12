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
   - `system://` path prefix (e.g., `system://atlas-conversation`)
   - Known IDs defined in `SystemWorkspaceId` type

### Implementation

#### Directory Structure

```
packages/system/workspaces/
├── conversation.yml     # Atlas conversation workspace
├── monitoring.yml       # System monitoring workspace (future)
└── mod.ts              # Build-time import module
```

#### YAML Definition

System workspaces are defined as standard workspace YAML files:

```yaml
version: "1.0"
workspace:
  id: "atlas-conversation"
  name: "Friday Conversation"
  description: "System workspace for interactive Friday conversations"
signals:
  conversation-started:
    provider: "system"
    description: "Triggered when a new conversation begins"
# ... rest of configuration
```

#### Build-Time Import

The `packages/system/workspaces/mod.ts` file imports all YAML files at build time:

```typescript
import conversationYaml from "./conversation.yml" with { type: "text" };
import { parse } from "@std/yaml";
import { WorkspaceConfigSchema } from "@atlas/config";

export const SYSTEM_WORKSPACES = {
  "atlas-conversation": WorkspaceConfigSchema.parse(parse(conversationYaml)),
} as const;

export type SystemWorkspaceId = keyof typeof SYSTEM_WORKSPACES;
```

This requires the `--unstable-raw-imports` flag in Deno configuration.

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
const conversationWorkspace = await manager.find({
  id: "atlas-conversation",
});

// List all workspaces including system ones
const allWorkspaces = await manager.list({
  includeSystem: true,
});
```

#### Configuration Loading

When loading configuration for a system workspace, the embedded config is returned directly:

```typescript
const config = await manager.getWorkspaceConfig("atlas-conversation");
// Returns the embedded configuration object
```

### Benefits

1. **No File System Dependencies**: System workspaces don't require file system access
2. **Consistent Availability**: Always present regardless of installation method
3. **Version Controlled**: Configuration changes are tracked in source control
4. **Type Safety**: Build-time validation ensures configurations are valid
5. **Performance**: No runtime file I/O for system workspace configs

### Migration from Virtual Workspaces

System workspaces replace the previous "virtual workspace" concept:

- **Before**: Virtual workspaces with special `virtual://` prefix and runtime loading
- **After**: System workspaces with `system://` prefix and build-time embedding

The migration simplifies the codebase by:

- Removing special case handling throughout the system
- Eliminating dynamic configuration loading for built-in workspaces
- Providing compile-time guarantees about system workspace validity

### Adding New System Workspaces

To add a new system workspace:

1. Create a new YAML file in `packages/system/workspaces/`
2. Import it in `packages/system/workspaces/mod.ts`
3. Add it to the `SYSTEM_WORKSPACES` const
4. The workspace will be automatically available after rebuild

Example:

```typescript
// In mod.ts
import monitoringYaml from "./monitoring.yml" with { type: "text" };

export const SYSTEM_WORKSPACES = {
  "atlas-conversation": /* ... */,
  "atlas-monitoring": WorkspaceConfigSchema.parse(parse(monitoringYaml)),
} as const;
```

## System Agents

The `agents/` directory contains system-level agents that provide core Atlas functionality:

- `conversation-agent.ts`: Handles interactive conversations within the Atlas system

These agents are designed to work with system workspaces and provide essential platform
capabilities.
