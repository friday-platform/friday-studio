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
Atlas platform instance, managing all workspaces centrally.

### 1. Atlas Daemon as Local Platform

**Single Process Management:**

- One `atlas daemon start` process manages all workspace lifecycles
- Replaces multiple `atlas workspace serve` processes
- Acts as local Atlas platform instance for the user
- Handles resource allocation, port management, and process coordination

**Unified MCP Interface:**

- Single MCP server within daemon exposes all registered workspaces
- Cross-workspace operations work seamlessly
- Provides the conversational experience users expect

### 2. Storage Interface Architecture

**Create Storage Interface:**

```typescript
interface RuntimeStorage {
  registerRuntime(workspaceId: string, info: RuntimeInfo): Promise<void>;
  unregisterRuntime(workspaceId: string): Promise<void>;
  listActiveRuntimes(): Promise<RuntimeInfo[]>;
  getRuntime(workspaceId: string): Promise<RuntimeInfo | null>;
  updateRuntimeStatus(workspaceId: string, status: RuntimeStatus): Promise<void>;
}

interface RuntimeInfo {
  workspaceId: string;
  pid: number;
  port: number;
  startedAt: string;
  status: "starting" | "running" | "stopping" | "stopped";
  lastSeen: string;
}
```

**Filesystem Backend Implementation:**

- Store active runtimes in `~/.atlas/active-runtimes.json`
- Cross-process accessible via filesystem
- Atomic writes using temporary files for consistency
- Automatic cleanup of stale entries

### 3. WorkspaceRegistry Enhancement

**Extend Existing WorkspaceRegistry:**

- Keep existing persistent workspace definitions (in `~/.atlas/registry.json`)
- Add runtime tracking capabilities using RuntimeStorage interface
- Registry becomes single source of truth for all workspace management
- Maintain backward compatibility with existing workspace registration

**Enhanced Methods:**

```typescript
class WorkspaceRegistryManager {
  // Existing methods remain unchanged

  // New runtime management methods
  async startWorkspace(id: string): Promise<RuntimeInfo>;
  async stopWorkspace(id: string): Promise<void>;
  async getWorkspaceRuntime(id: string): Promise<RuntimeInfo | null>;
  async listActiveWorkspaces(): Promise<RuntimeInfo[]>;

  // Communication methods
  async communicateWithWorkspace(id: string, request: any): Promise<any>;
}
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

**Replace `atlas workspace serve` with `atlas workspace start`:**

```bash
# New user-facing commands
atlas workspace start my-workspace    # Start specific workspace
atlas workspace stop my-workspace     # Stop specific workspace  
atlas workspace list                  # Show all registered workspaces
atlas workspace status               # Show daemon + workspace status

# Daemon management (mostly implicit)
atlas daemon start                   # Start daemon explicitly
atlas daemon stop                    # Stop daemon and all workspaces
atlas daemon status                  # Show daemon status
```

**Implicit Daemon Management:**

```bash
$ atlas workspace start telephone
✓ Starting Atlas daemon...           # Auto-starts if not running
✓ Daemon running on port 8080
✓ Starting workspace 'telephone'...
✓ Workspace 'telephone' ready at http://localhost:8081

$ atlas workspace start web-analysis  
✓ Starting workspace 'web-analysis'... # Daemon already running
✓ Workspace 'web-analysis' ready at http://localhost:8082
```

### 6. HTTP-Based Communication

**Daemon API Design:**

```
GET  /api/workspaces              # List all registered workspaces
POST /api/workspaces/{id}/start   # Start specific workspace  
POST /api/workspaces/{id}/stop    # Stop specific workspace
GET  /api/workspaces/{id}/status  # Get workspace status
GET  /api/status                  # Daemon status + running workspaces

# MCP endpoints (internal)
POST /api/mcp/workspace_list      # MCP workspace_list tool
POST /api/mcp/workspace_trigger_job # MCP job triggering
```

**CLI to Daemon Communication:**

```bash
# All workspace commands communicate with daemon over HTTP
atlas workspace start telephone     # → HTTP POST to localhost:8080/api/workspaces/telephone/start
atlas workspace stop telephone      # → HTTP POST to localhost:8080/api/workspaces/telephone/stop  
atlas workspace list               # → HTTP GET to localhost:8080/api/workspaces
```

**Auto-start Logic:**

1. CLI command tries HTTP call to configured daemon port (default 8080)
2. If connection fails: start daemon process, wait for ready signal, retry
3. If connection succeeds: send command to daemon
4. Daemon handles all workspace lifecycle management

### 7. Configuration Management

**Daemon Port Configuration:**

```yaml
# atlas.yml
daemon:
  port: 8080 # Default daemon port
  auto_start: true # Auto-start daemon when needed
  workspace_ports: # Port range for workspaces
    start: 8081
    end: 8200
```

**Command-line Overrides:**

```bash
atlas workspace start telephone --daemon-port 9000
atlas daemon start --port 9000
```

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1)

**1.1 Create Storage Interface**

- Define `RuntimeStorage` interface in `src/core/runtime-storage.ts`
- Implement `FilesystemRuntimeStorage` class
- Add comprehensive tests for storage operations
- Ensure atomic writes and consistency

**1.2 Extend WorkspaceRegistry**

- Add `RuntimeStorage` dependency to `WorkspaceRegistryManager`
- Implement runtime tracking methods
- Add HTTP communication capabilities for workspace interaction
- Maintain backward compatibility with existing functionality

**1.3 Create Atlas Daemon Core**

- Create `src/core/atlas-daemon.ts` with core daemon logic
- Implement workspace lifecycle management
- Add HTTP server with REST API endpoints
- Include proper signal handling and graceful shutdown

### Phase 2: CLI Integration (Week 2)

**2.1 Implement New CLI Commands**

- Create `src/cli/commands/daemon/` directory with daemon commands
- Implement `atlas daemon start/stop/status` commands
- Replace `atlas workspace serve` with `atlas workspace start/stop`
- Add HTTP client for CLI-to-daemon communication

**2.2 Git Discovery with Prompts**

- Enhance workspace discovery in `WorkspaceRegistryManager`
- Add interactive prompts for workspace registration
- Implement selective registration capabilities
- Add configuration options for discovery behavior

**2.3 Configuration Management**

- Add daemon configuration schema to atlas.yml
- Implement port management and conflict resolution
- Add command-line flag handling for daemon port overrides

### Phase 3: MCP Integration (Week 3)

**3.1 Daemon-Integrated MCP Server**

- Move MCP server functionality into Atlas daemon
- Update `PlatformMCPServer` to work within daemon process
- Ensure MCP tools communicate with workspace runtimes via daemon
- Test cross-workspace MCP operations

**3.2 Update Existing Tests**

- Fix broken integration tests to work with new architecture
- Update test patterns to use daemon-based communication
- Add comprehensive tests for daemon lifecycle and workspace management
- Ensure all existing functionality continues to work

**3.3 Workspace-to-Daemon Communication**

- Implement HTTP endpoints for workspace-specific operations
- Add job triggering, session management via daemon API
- Test signal processing through daemon architecture

### Phase 4: Polish and Documentation (Week 4)

**4.1 Error Handling and Recovery**

- Add robust error handling for daemon crashes
- Implement automatic workspace recovery on daemon restart
- Add health checks and monitoring capabilities
- Handle port conflicts and resource allocation issues

**4.2 Performance Optimization**

- Implement lazy workspace startup (start on first request)
- Add workspace idle shutdown to conserve resources
- Optimize HTTP communication between CLI and daemon
- Add caching for workspace status information

**4.3 Documentation and Migration**

- Update all documentation to reflect new architecture
- Create migration guide for existing users
- Add troubleshooting guide for common issues
- Document daemon configuration options

## Success Criteria

### Functional Requirements

1. **MCP Integration Works**: `workspace_list` shows all registered workspaces
2. **Single Daemon Process**: All workspaces managed by one daemon process
3. **Intuitive Commands**: `atlas workspace start/stop` commands work seamlessly
4. **Cross-Process Communication**: CLI commands successfully communicate with daemon
5. **Workspace Discovery**: Git discovery prompts for workspace registration

### User Experience Goals

1. **Zero Manual Process Management**: Users never need to manually start/stop workspace processes
2. **Conversational Interface**: Claude Code can seamlessly interact with all workspaces
3. **Automatic Daemon Management**: Daemon starts automatically when needed
4. **Clear Status Visibility**: Users can easily see what workspaces are running

### Technical Requirements

1. **All Tests Pass**: Existing functionality preserved
2. **Clean Architecture**: Clear separation between CLI, daemon, and workspace concerns
3. **Backward Compatibility**: Existing workspace configurations continue to work
4. **Resource Efficiency**: Idle workspaces can be shut down to save resources

## Risk Mitigation

### Potential Issues

1. **Port Conflicts**: Multiple daemons or workspace port allocation issues
2. **Process Communication**: HTTP communication failures between CLI and daemon
3. **Workspace Recovery**: Daemon crashes losing workspace state
4. **Migration Complexity**: Breaking existing user workflows

### Mitigation Strategies

1. **Robust Port Management**: Automatic port discovery and conflict resolution
2. **Graceful Degradation**: CLI falls back to direct workspace communication if daemon unavailable
3. **State Persistence**: All workspace state stored in persistent storage for recovery
4. **Backward Compatibility**: Maintain support for existing commands during transition

## Files to Modify/Create

### New Files

- `src/core/runtime-storage.ts` - Storage interface and filesystem implementation
- `src/core/atlas-daemon.ts` - Core daemon logic and HTTP server
- `src/cli/commands/daemon/` - Daemon CLI commands
- `src/cli/commands/workspace/start.tsx` - New workspace start command
- `src/cli/commands/workspace/stop.tsx` - New workspace stop command

### Modified Files

- `src/core/workspace-registry.ts` - Add runtime tracking capabilities
- `src/core/mcp/platform-mcp-server.ts` - Integrate with daemon architecture
- `src/cli/commands/workspace/serve.tsx` - Deprecate or redirect to start command
- `src/cli/commands/index.ts` - Register new commands
- All test files - Update for new architecture

This architecture provides a clean foundation for the conversational workspace experience while
solving the fundamental cross-process communication issues that broke the MCP integration.
