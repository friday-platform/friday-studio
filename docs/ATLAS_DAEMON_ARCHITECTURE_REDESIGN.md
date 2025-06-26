# Atlas MCP Integration Architecture Redesign

## Problem Statement

The current MCP (Model Context Protocol) integration is fundamentally broken due to architectural
issues:

1. **Cross-Process Communication Failure**: WorkspaceRuntimeRegistry uses in-memory storage, but MCP
   server (`atlas mcp serve`) and workspace processes (`atlas workspace serve`) run in separate
   processes, preventing communication.

2. **Poor User Experience**: Users must manually start/stop individual workspace processes, making
   it impossible to have a conversational interface across multiple workspaces.

3. **No Workspace Discovery**: MCP shows 0 workspaces because running workspaces can't be discovered
   by the MCP server.

4. **Process Management Complexity**: Each workspace requires a separate `atlas workspace serve`
   command, creating a complex manual process management burden.

## Current Broken Architecture

```
User → Claude Code MCP Client → atlas mcp serve (Process A)
                                      ↓ (tries to read WorkspaceRuntimeRegistry)
                                      ↓ (empty - different process)
                                      
Separate: atlas workspace serve (Process B) 
          ↓ (registers in its own WorkspaceRuntimeRegistry instance)
          ↓ (Process A can't see this)
```

## Proposed Solution: Atlas Daemon Architecture

### Core Concept

Replace the current multi-process model with a **single Atlas daemon** that acts as the user's local
Atlas platform instance. The daemon manages all workspaces as logical containers, creating runtimes
on-demand when signals arrive, rather than maintaining separate running processes per workspace.

### 1. Atlas Daemon as Local Platform

**Single Process, Multiple Workspaces:**

- One `atlas daemon start` process serves all registered workspaces
- Workspaces are logical containers (configurations), not running processes
- Runtimes created on-demand when signals arrive, destroyed when idle
- No port allocation needed per workspace - daemon uses one port

**Unified MCP Interface:**

- Single MCP server within daemon exposes all registered workspaces
- Cross-workspace operations work seamlessly
- Provides the conversational experience users expect
- Direct routing to workspace contexts without subprocess communication

### 2. Workspace as Logical Container

**New Conceptual Model:**

```typescript
// Workspaces are configurations, not processes
interface WorkspaceConfig {
  id: string;
  name: string;
  description: string;
  signals: Record<string, SignalConfig>;
  agents: Record<string, AgentConfig>;
  jobs: Record<string, JobConfig>;
  // No port, no process info - just logical grouping
}

// Daemon manages ephemeral runtimes with KV-backed state
interface DaemonState {
  private kv: Deno.Kv;
  
  // In-memory caches for performance
  activeRuntimes: Map<string, WorkspaceRuntime>; // Created on-demand
  activeSessions: Map<string, Session[]>; // Grouped by workspace
  
  // KV-backed persistent state
  async getRegisteredWorkspaces(): Promise<Map<string, WorkspaceConfig>> {
    const list = await this.kv.get<string[]>(["workspaces", "_list"]);
    const configs = new Map<string, WorkspaceConfig>();
    
    for (const id of list.value || []) {
      const config = await this.kv.get<WorkspaceConfig>(["workspaces", id]);
      if (config.value) configs.set(id, config.value);
    }
    
    return configs;
  }
  
  // Session tracking with KV for recovery
  async trackSession(workspaceId: string, session: Session): Promise<void> {
    await this.kv.set(["sessions", workspaceId, session.id], {
      id: session.id,
      startTime: session.startTime,
      status: session.status,
      metadata: session.metadata,
    });
  }
}
```

**Runtime Lifecycle:**

- Runtimes created when first signal arrives for workspace
- Runtimes destroyed when all sessions complete
- No persistent processes per workspace
- Memory-efficient: 30 workspaces = 30 configs, 0-3 active runtimes

### 3. WorkspaceRegistry with Storage Adapter Pattern

**Storage Adapter Architecture:**

```typescript
// Abstract storage interface for registry
interface RegistryStorageAdapter {
  get<T>(key: string[]): Promise<T | null>;
  set<T>(key: string[], value: T): Promise<void>;
  delete(key: string[]): Promise<void>;
  list<T>(prefix: string[]): Promise<Array<{ key: string[]; value: T }>>;
  watch<T>(prefix: string[]): AsyncIterable<Array<{ key: string[]; value: T }>>;

  // Atomic operations support
  atomic(): AtomicOperation;
}

interface AtomicOperation {
  set<T>(key: string[], value: T): AtomicOperation;
  delete(key: string[]): AtomicOperation;
  commit(): Promise<boolean>;
}

// Deno KV implementation
class DenoKVStorageAdapter implements RegistryStorageAdapter {
  constructor(private kv: Deno.Kv) {}

  async get<T>(key: string[]): Promise<T | null> {
    const result = await this.kv.get<T>(key);
    return result.value;
  }

  async set<T>(key: string[], value: T): Promise<void> {
    await this.kv.set(key, value);
  }

  async *watch<T>(prefix: string[]): AsyncIterable<Array<{ key: string[]; value: T }>> {
    const watcher = this.kv.watch<T>([prefix]);
    for await (const entries of watcher) {
      yield entries.map((e) => ({ key: e.key, value: e.value! }));
    }
  }

  // ... other methods
}

// Legacy filesystem implementation for migration
class FileSystemStorageAdapter implements RegistryStorageAdapter {
  constructor(private path: string) {}
  // JSON file-based implementation
}

// Registry uses adapter pattern
class WorkspaceRegistryManager {
  constructor(private storage: RegistryStorageAdapter) {}

  async register(workspace: WorkspaceConfig): Promise<void> {
    const atomic = this.storage.atomic();

    // Atomic registration with list update
    atomic.set(["workspaces", workspace.id], workspace);

    const list = await this.storage.get<string[]>(["workspaces", "_list"]) || [];
    if (!list.includes(workspace.id)) {
      atomic.set(["workspaces", "_list"], [...list, workspace.id]);
    }

    await atomic.commit();
  }

  // All registry methods work with any storage backend
}
```

**Storage Adapter Benefits:**

- **Migration Path**: Easy transition from filesystem to Deno KV
- **Flexibility**: Support multiple backends (files, KV, Redis, etc.)
- **Testing**: Use mock adapters or ephemeral storage
- **No Lock-in**: Switch storage backends without changing registry code

**KV-Specific Features When Using DenoKVStorageAdapter:**

- Atomic transactions for consistency
- Real-time updates via watch
- No file locking issues
- Built-in SQLite backing
- Concurrent access support

**Registry Configuration:**

```typescript
// Choose storage backend via configuration
const storage = Deno.env.get("ATLAS_STORAGE") === "filesystem"
  ? new FileSystemStorageAdapter("~/.atlas/registry.json")
  : new DenoKVStorageAdapter(await Deno.openKv());
```

### 3.1 Benefits of Deno KV over Filesystem Storage

**Key Advantages:**

1. **No File Locking Issues**
   - Concurrent access handled automatically
   - No need for lock files or mutex patterns
   - Multiple processes can safely read/write

2. **Atomic Transactions**
   - Ensure consistency during multi-step operations
   - Prevent partial updates during crashes
   - Support conditional operations (compare-and-swap)

3. **Built-in SQLite Backing**
   - Reliable, battle-tested storage engine
   - ACID compliance for data integrity
   - Efficient queries and indexing

4. **Native TypeScript API**
   - Type-safe operations without JSON parsing
   - Direct object storage and retrieval
   - No serialization/deserialization overhead

5. **Watch Capabilities**
   - Real-time updates across processes
   - Event-driven architecture support
   - Efficient change detection

6. **Simplified Testing**
   - Ephemeral databases for unit tests
   - No cleanup of test files needed
   - Isolated test environments

**Migration from File-Based Storage:**

```typescript
// Old: File-based with manual locking
const data = JSON.parse(await Deno.readTextFile(registryPath));
data.workspaces.push(newWorkspace);
await Deno.writeTextFile(registryPath, JSON.stringify(data, null, 2));

// New: KV with atomic operations
const atomic = kv.atomic();
atomic.set(["workspaces", workspace.id], workspace);
atomic.set(["workspaces", "_list"], [...existingIds, workspace.id]);
await atomic.commit();
```

### 4. Git Discovery with User Consent

**Prompted Registration (Not Auto-Registration):**

```bash
$ atlas daemon start
Atlas daemon discovered 3 unregistered workspaces in this git repo:
  • examples/workspaces/telephone (Multi-Provider Telephone Game)  
  • examples/workspaces/web-analysis (Web Page Analysis)
  • examples/workspaces/k8s-assistant (Kubernetes Assistant)

Register all? [y/N]: y
✓ Registered 3 workspaces
✓ Atlas daemon running on port 8080
```

**Discovery Process:**

1. Use `git rev-parse --show-toplevel` to find git root
2. Scan common locations: `{git-root}/examples/workspaces/`, `{git-root}/workspaces/`, `{git-root}/`
3. Find `workspace.yml` files within max depth of 3
4. Prompt user for registration consent
5. Allow selective registration

### 5. Intuitive Command Structure

**Simplified Commands (no start/stop for workspaces):**

```bash
# Workspace commands (registration only)
atlas workspace register <path>      # Register a workspace
atlas workspace unregister <id>      # Remove from registry
atlas workspace list                 # Show all registered workspaces
atlas workspace status               # Show workspace activity status

# Signal triggering (creates runtime on-demand)
atlas signal trigger <workspace-id> <signal-id> [data]

# Daemon management (mostly implicit)
atlas daemon start                   # Start daemon explicitly
atlas daemon stop                    # Stop daemon
atlas daemon status                  # Show daemon status
```

**Implicit Daemon Management:**

```bash
$ atlas signal trigger telephone start-game
✓ Starting Atlas daemon...           # Auto-starts if not running
✓ Daemon running on port 8080
✓ Processing signal 'start-game' in workspace 'telephone'
✓ Session started: 550e8400-e29b-41d4-a716-446655440000

$ atlas workspace status
Workspace          Status    Sessions  Last Activity
telephone          active    1         2 seconds ago
web-analysis       idle      0         2 hours ago
k8s-assistant      idle      0         yesterday
```

### 6. HTTP-Based Communication

**Daemon API Design:**

```
# Core daemon endpoints
GET  /health                      # Daemon health check
GET  /api/status                  # Daemon status + active runtimes

# Workspace management (config only)
GET  /api/workspaces              # List all registered workspaces
POST /api/workspaces/register     # Register new workspace
DELETE /api/workspaces/{id}       # Unregister workspace
GET  /api/workspaces/{id}         # Get workspace config + status

# Signal processing (creates runtime on-demand)
POST /api/workspaces/{id}/signals/{signalId}  # Trigger signal
GET  /api/workspaces/{id}/sessions            # List workspace sessions
GET  /api/workspaces/{id}/sessions/{sessionId} # Get session details

# MCP endpoints (integrated)
POST /api/mcp/tools/workspace_list      # MCP workspace_list tool
POST /api/mcp/tools/trigger_job         # MCP job triggering
```

**Workspace-Scoped Routes:**

```
# All workspace operations scoped under /api/workspaces/{id}/
# No separate ports or processes per workspace
# Daemon routes requests to appropriate runtime (creating if needed)
```

**Auto-start Logic:**

1. CLI command tries HTTP call to daemon port (default 8080)
2. If connection fails: start daemon process, wait for ready
3. Daemon loads all registered workspaces from registry
4. Runtimes created on-demand when signals arrive

### 7. Configuration Management

**Daemon Configuration:**

```yaml
# atlas.yml
daemon:
  port: 8080 # Single daemon port
  auto_start: true # Auto-start daemon when needed
  runtime:
    idle_timeout: 300 # Seconds before idle runtime shutdown
    max_concurrent_runtimes: 10 # Limit concurrent active workspaces
  mcp:
    enabled: true # Enable MCP server within daemon
```

**Command-line Overrides:**

```bash
atlas daemon start --port 9000
atlas signal trigger --daemon-port 9000 workspace-id signal-id
```

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1)

**1.1 Transform WorkspaceServer to AtlasDaemon**

- Refactor `src/core/workspace-server.ts` → `src/core/atlas-daemon.ts`
- Remove workspace-specific routes, add daemon-level routes
- Implement on-demand runtime creation/destruction
- Add workspace routing logic (path prefix based)

**1.2 Implement Storage Adapter Pattern**

- Create `RegistryStorageAdapter` interface in `src/core/registry-storage.ts`
- Implement `DenoKVStorageAdapter` using Deno KV
- Implement `FileSystemStorageAdapter` for backward compatibility
- Update `WorkspaceRegistryManager` to use adapter pattern
- Add configuration to choose storage backend
- Create migration utility to move from filesystem to KV

**1.3 Runtime Lifecycle Management**

- Implement on-demand `WorkspaceRuntime` creation
- Add idle timeout for runtime cleanup
- Create session tracking per workspace
- Ensure proper cleanup on daemon shutdown

### Phase 2: CLI Integration (Week 2)

**2.1 Implement New CLI Commands**

- Create `src/cli/commands/daemon/` directory with daemon commands
- Implement `atlas daemon start/stop/status` commands
- Remove `atlas workspace serve` command entirely
- Update `atlas signal trigger` to use daemon HTTP API

**2.2 Git Discovery with Prompts**

- Enhance workspace discovery in daemon startup
- Add interactive prompts for workspace registration
- Implement selective registration capabilities
- Store selections in registry for persistence

**2.3 Simplify Configuration**

- Update atlas.yml schema for daemon settings
- Remove workspace port allocation logic
- Add runtime lifecycle configuration options
- Implement command-line overrides for daemon settings

### Phase 3: MCP Integration (Week 3)

**3.1 Daemon-Integrated MCP Server**

- Integrate MCP server directly into daemon process
- Update `PlatformMCPServer` to access daemon's workspace registry
- Implement MCP tools that route through daemon's signal processor
- Enable cross-workspace operations via single MCP connection

**3.2 Update Architecture Tests**

- Remove multi-process integration tests
- Add daemon lifecycle tests with on-demand runtimes
- Test workspace isolation within single process
- Verify MCP can access all registered workspaces
- Use ephemeral KV databases for test isolation
- Add KV-specific tests:
  - Atomic transaction behavior
  - Concurrent access patterns
  - Watch functionality
  - Recovery after KV corruption

**3.3 Signal Processing Flow**

- Implement unified signal processor in daemon
- Route signals to appropriate workspace context
- Create runtime if needed, reuse if exists
- Clean up idle runtimes after timeout

### Phase 4: Polish and Documentation (Week 4)

**4.1 Error Handling and Recovery**

- Add robust error handling for runtime creation failures
- Implement graceful degradation when workspaces unavailable
- Add health checks for daemon and active runtimes
- Handle daemon restart with session recovery from KV
- Implement KV transaction retry logic for transient failures
- Add KV corruption detection and recovery mechanisms

**4.2 Performance Optimization**

- Runtime creation already lazy (on-demand)
- Implement configurable idle timeout for cleanup
- Add runtime pooling for frequently used workspaces
- Optimize workspace configuration caching

**4.3 Documentation and Migration**

- Update docs to reflect workspace-as-config model
- Create migration guide from `workspace serve` pattern
- Document new signal-driven architecture
- Add examples of daemon-based workflows

## Success Criteria

### Functional Requirements

1. **MCP Integration Works**: `workspace_list` shows all registered workspaces
2. **Single Daemon Process**: One daemon serves all workspaces
3. **On-Demand Runtimes**: Workspaces activate only when signals arrive
4. **Unified API**: All workspace operations through daemon HTTP API
5. **Workspace Discovery**: Git discovery prompts for workspace registration

### User Experience Goals

1. **Zero Process Management**: No manual workspace start/stop needed
2. **Conversational Interface**: Claude Code seamlessly accesses all workspaces
3. **Resource Efficient**: Only active workspaces consume resources
4. **Clear Status Visibility**: Easy to see which workspaces have active sessions

### Technical Requirements

1. **Simplified Architecture**: Single process, multiple logical workspaces
2. **Clean Separation**: Daemon handles routing, workspaces handle logic
3. **Backward Compatibility**: Existing workspace.yml files work unchanged
4. **Auto-Cleanup**: Idle runtimes automatically destroyed

## Risk Mitigation

### Potential Issues

1. **Memory Growth**: Multiple active runtimes consuming memory
2. **Workspace Isolation**: Ensuring workspaces don't interfere in single process
3. **Daemon Crashes**: Single point of failure for all workspaces
4. **Migration Confusion**: Users expecting workspace processes

### Mitigation Strategies

1. **Runtime Limits**: Configure max concurrent runtimes and idle timeouts
2. **Worker Isolation**: Keep using Web Workers for agent isolation
3. **Session Persistence**: Store session state for recovery after crashes
4. **Clear Communication**: Emphasize workspaces are now logical containers

## Files to Modify/Create

### New Files

- `src/core/atlas-daemon.ts` - Daemon server (evolved from workspace-server.ts)
- `src/core/signal-processor.ts` - Unified signal routing and processing
- `src/core/registry-storage.ts` - Storage adapter interface and implementations
- `src/cli/commands/daemon/` - Daemon CLI commands
- `src/cli/commands/signal/trigger.tsx` - Signal trigger command

### Modified Files

- `src/core/workspace-server.ts` - Transform into atlas-daemon.ts
- `src/core/workspace-registry.ts` - Migrate from filesystem to Deno KV storage
- `src/core/mcp/platform-mcp-server.ts` - Integrate within daemon
- `src/cli/commands/workspace/serve.tsx` - Remove entirely
- `src/core/workspace-runtime.ts` - Make ephemeral, remove server coupling

### Removed Files

- `src/cli/commands/workspace/start.tsx` - Not needed
- `src/cli/commands/workspace/stop.tsx` - Not needed
- Any runtime storage interfaces - Runtimes are ephemeral
- `~/.atlas/registry.json` - Replaced by Deno KV database

## Key Architecture Shift

This redesign fundamentally changes how we think about workspaces:

- **Before**: Workspace = Running Process with HTTP Server
- **After**: Workspace = Configuration that activates on-demand

The daemon becomes the platform, workspaces become logical groupings, and the entire system becomes
more resource-efficient and user-friendly.
