# Agent Loader

The agent loader discovers, loads, and manages agents from multiple sources. It handles
pre-registered agents that exist before any session starts.

## What It Does

- **Discovery**: Finds agents from files, memory, and bundled sources
- **Loading**: Converts different agent formats to AtlasAgent instances
- **Caching**: Stores loaded agents for performance
- **Registry**: Controls which agents are visible based on workspace type

## Architecture

```
AgentRegistry (High-level API)
    ↓
AgentLoader (Manages adapters and caching)
    ↓
Adapters (Load from specific sources)
    ├── SystemAdapter (Atlas internals)
    ├── BundledAdapter (Pre-installed agents)
    ├── YAMLFileAdapter (User .agent.yml files)
    └── SDKAdapter (Runtime registered agents)
```

## Agent Types

| Type        | Source               | Visibility             | Purpose                                        |
| ----------- | -------------------- | ---------------------- | ---------------------------------------------- |
| **System**  | Compiled into Atlas  | System workspaces only | Atlas internals (conversation, fact-extractor) |
| **Bundled** | Compiled into Atlas  | All workspaces         | Pre-installed useful agents (Slack, GitHub)    |
| **SDK**     | Runtime registration | All workspaces         | Custom agents via @atlas/agent-sdk             |
| **YAML**    | .agent.yml files     | All workspaces         | Configuration-based agents                     |

**Note**: LLM agents are NOT handled here. They're created dynamically per-session from
workspace.yml by the session runtime.

## Key Files

### `registry.ts`

High-level API that manages agent discovery and access. Controls workspace-based visibility:

```typescript
// System workspaces see ALL agents
const registry = new AgentRegistry({ includeSystemAgents: true });

// User workspaces see bundled and user agents (no system agents)
const registry = new AgentRegistry({ includeSystemAgents: false });
```

### `loader.ts`

Coordinates multiple adapters and handles caching:

```typescript
const loader = new AgentLoader();
loader.addAdapter(new SystemAgentAdapter());
loader.addAdapter(new BundledAgentAdapter());

// Try each adapter until one succeeds
const agent = await loader.loadAgent("slack");
```

### `adapters/`

Each adapter loads agents from a specific source:

- **`system-adapter.ts`**: Built-in Atlas agents (conversation, fact-extractor)
- **`bundled-adapter.ts`**: Pre-installed agents shipped with Atlas
- **`yaml-file-adapter.ts`**: User-defined .agent.yml files from filesystem
- **`sdk-adapter.ts`**: Programmatically registered agents
- **`types.ts`**: Common interfaces and types

## How Adapters Work

All adapters implement the `AgentAdapter` interface:

```typescript
interface AgentAdapter {
  loadAgent(id: string): Promise<AgentSourceData>;
  listAgents(): Promise<AgentSummary[]>;
  exists(id: string): Promise<boolean>;
  readonly adapterName: string;
  readonly sourceType: AgentSourceType;
}
```

The loader tries adapters in registration order until one succeeds.

## Workspace Isolation

System agents are isolated from user workspaces:

```typescript
function createRegistryForWorkspace(workspace: Workspace): AgentRegistry {
  const isSystemWorkspace = workspace.metadata?.system === true;

  return new AgentRegistry({
    includeSystemAgents: isSystemWorkspace,
  });
}
```

## Adding New Agent Sources

To add a new agent source:

1. Create an adapter implementing `AgentAdapter`
2. Register it with the loader: `loader.addAdapter(new MyAdapter())`
3. The adapter handles discovery and loading from your source

## Testing

Run tests with:

```bash
deno task test packages/core/tests/agent-loader
```

Tests cover:

- Individual adapter functionality
- Multi-adapter scenarios
- Workspace isolation
- Error handling

## Important Notes

- **Don't add LLM agents here** - they're session-specific and handled by workspace runtime
- **System agents are restricted** - only visible in system workspaces
- **Bundled agents are immutable** - compiled into the binary
- **Caching is automatic** - agents are cached after first load
- **Order matters** - adapters are tried in registration order
