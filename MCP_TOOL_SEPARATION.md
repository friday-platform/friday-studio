# MCP Tool Separation: Internal vs Public Architecture

## Overview

Atlas currently has a single MCP platform server (`atlas-platform`) that combines both internal
platform management tools and external integrations. This document outlines the planned separation
into distinct internal and public MCP tool categories for better security, access control, and
architectural clarity.

## Current Architecture Issues

### Single MCP Server Problems

- **Mixed Access Levels**: Platform management tools (library, workspace) mixed with public tools
- **Security Concerns**: Internal tools accessible to external integrations
- **Configuration Complexity**: Single server with all capabilities vs granular access control
- **Context Passing**: Workspace context hardcoded vs automatically injected

### Current Tool Categories in `atlas-platform`

**Platform Management Tools:**

- `workspace_list`, `workspace_create`, `workspace_delete`, `workspace_describe`
- `workspace_jobs_list`, `workspace_jobs_describe`, `workspace_sessions_list`
- `workspace_signals_list`, `workspace_signals_trigger`, `workspace_agents_list`

**Library Management Tools:**

- `library_list`, `library_get`, `library_search`, `library_stats`, `library_templates`
- `library_store` (newly added)

**Context Requirements:**

- All tools require automatic workspace/session context injection
- No hardcoded workspace IDs or session IDs allowed

## Proposed Separation Architecture

### 1. Internal MCP Server (`atlas-internal`)

**Purpose**: Platform management and workspace-scoped operations **Access**: Only available to
authenticated workspace agents **Context**: Automatic workspace/session/agent context injection

**Tool Categories:**

#### Library Management

```typescript
// Internal library tools with automatic context injection
"library_store"; // Create library items (reports, artifacts, etc.)
"library_get"; // Retrieve library items with workspace filtering
"library_list"; // List workspace-scoped library items
"library_search"; // Search within workspace library
"library_delete"; // Delete workspace library items
"library_stats"; // Workspace library usage statistics
```

#### Workspace Operations

```typescript
// Workspace management tools
"workspace_describe"; // Get current workspace details
"workspace_jobs_list"; // List jobs in current workspace
"workspace_agents_list"; // List agents in current workspace
"workspace_sessions_list"; // List sessions in current workspace
"workspace_memory_query"; // Query workspace memory
"workspace_context_get"; // Get workspace context/variables
```

#### Session Operations

```typescript
// Session-scoped operations
"session_describe"; // Get current session details
"session_memory_store"; // Store session-specific memory
"session_memory_query"; // Query session memory
"session_context_get"; // Get session variables/context
```

**Security Features:**

- Automatic workspace/session isolation
- Context injection prevents cross-workspace access
- Authenticated access only through workspace agents

### 2. Public MCP Server (`atlas-public`)

**Purpose**: External integrations and community tools **Access**: Available to any workspace with
explicit configuration **Context**: No automatic context injection

**Tool Categories:**

#### Platform Information (Read-Only)

```typescript
// Platform-level read-only operations
"platform_workspaces_list"; // List all workspaces (admin view)
"platform_templates_list"; // List available workspace templates
"platform_capabilities_list"; // List platform capabilities
"platform_status"; // Platform health and status
```

#### External Integrations

```typescript
// Community and external tool access
"external_github_*"; // GitHub API integration
"external_web_search"; // Web search capabilities
"external_file_*"; // File system operations
"external_http_*"; // HTTP request tools
```

**Security Features:**

- Explicit capability grants in workspace configuration
- No automatic context injection
- Rate limiting and usage quotas
- Sandboxed execution environment

### 3. Hybrid Configuration Example

```yaml
# workspace.yml
tools:
  mcp:
    servers:
      # Internal Atlas platform tools (automatic context)
      atlas-internal:
        transport:
          type: "stdio"
          command: "deno"
          args: ["run", "--allow-all", "/path/to/atlas/src/cli.tsx", "mcp", "serve", "internal"]
        capabilities:
          tools:
            allowed: [
              "library_store",
              "library_get",
              "library_list",
              "workspace_describe",
              "session_memory_store",
            ]
        context_injection: true # Automatic workspace/session context

      # Public external integrations (explicit context)
      atlas-public:
        transport:
          type: "stdio"
          command: "deno"
          args: ["run", "--allow-all", "/path/to/atlas/src/cli.tsx", "mcp", "serve", "public"]
        capabilities:
          tools:
            allowed: [
              "platform_workspaces_list",
              "platform_templates_list",
            ]
        context_injection: false # No automatic context

      # External third-party MCP servers
      github-api:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-github"]
```

## Implementation Plan

### Phase 1: Context Injection (✅ COMPLETED)

- [x] Add workspace context to PlatformMCPServer constructor
- [x] Implement automatic context injection in library_store
- [x] Remove hardcoded workspace_id from agent prompts
- [x] Update tool schemas to reflect auto-injection

### Phase 2: Internal Server Creation

- [ ] Create `InternalMCPServer` class extending `PlatformMCPServer`
- [ ] Move workspace-scoped tools to internal server
- [ ] Implement automatic workspace isolation
- [ ] Add session-scoped memory tools

### Phase 3: Public Server Creation

- [ ] Create `PublicMCPServer` class for external integrations
- [ ] Move platform-level read-only tools to public server
- [ ] Implement rate limiting and security controls
- [ ] Add external integration capabilities

### Phase 4: CLI Integration

- [ ] Add `mcp serve internal` and `mcp serve public` CLI commands
- [ ] Update workspace templates to use separated servers
- [ ] Migration guide for existing workspaces

### Phase 5: Security Hardening

- [ ] Implement proper authentication for internal tools
- [ ] Add workspace access control validation
- [ ] Security audit of tool separation
- [ ] Documentation and testing

## Security Benefits

### Access Control

- **Internal tools**: Only accessible to authenticated workspace agents
- **Public tools**: Available with explicit grants and rate limiting
- **Cross-workspace isolation**: Automatic workspace scoping prevents data leaks

### Context Safety

- **Automatic injection**: Eliminates hardcoded workspace/session references
- **Scope validation**: Tools automatically respect workspace boundaries
- **Audit trail**: Clear separation enables better security logging

### Attack Surface Reduction

- **Principle of least privilege**: Agents only get necessary tool access
- **Sandboxing**: External integrations isolated from platform operations
- **Input validation**: Stronger validation boundaries between tool categories

## Migration Strategy

### Backward Compatibility

1. Keep existing `atlas-platform` server during transition
2. Add deprecation warnings for mixed tool usage
3. Provide automatic migration tools for workspace configurations

### Gradual Rollout

1. Start with new workspaces using separated servers
2. Migrate existing workspaces during maintenance windows
3. Remove legacy `atlas-platform` server after full migration

### Testing Strategy

1. Comprehensive integration tests for both server types
2. Security testing for access control boundaries
3. Performance testing for context injection overhead
4. Migration testing with existing workspace configurations

## Future Considerations

### Community Extensions

- Plugin system for additional internal tools
- Community-contributed public tools
- Tool marketplace with security reviews

### Enterprise Features

- Role-based access control for tool categories
- Audit logging with compliance features
- Multi-tenant workspace isolation
- Enterprise authentication integration

### Performance Optimization

- Tool call caching for frequently used operations
- Batch operations for multiple tool calls
- Connection pooling for external integrations
- Resource usage monitoring and alerting

---

**Status**: Phase 1 (Context Injection) completed ✅\
**Next**: Begin Phase 2 (Internal Server Creation)\
**Target**: Complete separation by Atlas v2.0
