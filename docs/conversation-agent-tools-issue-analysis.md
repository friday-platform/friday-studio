# Conversation Agent Tools Issue Analysis

## Problem Summary

The conversation agent (`src/core/agents/conversation-agent.ts`) is not receiving the daemon
capability tools it needs to function properly. This is because the current architecture only passes
MCP server tools to agents, but the conversation workspace uses daemon capabilities instead.

## Current Architecture Flow

### 1. Workspace Configuration

In `packages/system-workspaces/conversation.ts`, the conversation agent declares tools:

```typescript
tools: [
  "stream_reply",
  "workspace_draft_create", 
  "workspace_draft_update",
  "validate_draft_config",
  "pre_publish_check",
  "publish_workspace",
  "show_draft_config",
  "list_session_drafts",
  "library_list",
  "library_get",
  "library_search",
],
```

These are **daemon capabilities**, not MCP servers.

### 2. Workspace Runtime Issue

In `src/core/workspace-runtime.ts` (lines 988-994), tools are only passed if MCP servers exist:

```typescript
workspaceTools: mergedConfig.workspace.tools?.mcp?.servers
  ? {
    mcp: {
      servers: mergedConfig.workspace.tools.mcp.servers,
    },
  }
  : undefined,
```

Since the conversation workspace has no MCP servers, `workspaceTools` is `undefined`.

### 3. Agent Execution Worker

The agent execution worker (`src/core/workers/agent-execution-worker.ts`) expects workspace tools
via:

- MCP servers configuration
- Workspace tools metadata in the environment

The daemon capabilities are never passed to the worker, so the agent can't use them.

### 4. How the Legacy System Works

The old conversation supervisor (`src/core/conversation-supervisor.old.ts`) creates tools directly:

```typescript
const tools = createCxTools(sessionId);
const result = await LLMProviderManager.generateTextWithTools(message, {
  systemPrompt,
  tools,
  // ...
});
```

It doesn't go through the worker system - it executes directly in the supervisor context.

## Root Cause

The fundamental issue is a **conceptual mismatch** between different types of tools:

1. **MCP Server Tools** - External tools provided by MCP servers
2. **Daemon Capabilities** - System-level tools provided by the Atlas daemon
3. **Workspace Capabilities** - Workspace-specific tools

The current architecture only handles MCP server tools properly in the agent execution flow.

## Proposed Solutions

### Solution 1: Quick Fix - Pass Daemon Capabilities as Metadata (Recommended for immediate fix)

Modify the workspace runtime to detect daemon capability references and pass them as workspace tools
metadata.

**Implementation Points:**

1. In `workspace-runtime.ts`, after loading the configuration:
   - Check if agents have tools that aren't MCP servers
   - For daemon capability tools, load their metadata from `DaemonCapabilityRegistry`
   - Pass this metadata in the supervisor config as `workspaceToolsMetadata`

2. In the supervisor worker:
   - Pass the tools metadata to agent execution workers via the environment

3. The existing `createWorkspaceToolsFromMetadata` in the agent execution worker will handle the
   rest

**Pros:**

- Minimal changes required
- Uses existing infrastructure
- Can be implemented quickly

**Cons:**

- Temporary solution
- Doesn't address the architectural mismatch

### Solution 2: Proper Architectural Fix - Unified Tool System

Create a proper abstraction for all tool types and handle them uniformly.

**Implementation Points:**

1. Create a `ToolRegistry` that manages all tool types:
   ```typescript
   interface ToolSource {
     type: "mcp" | "daemon" | "workspace";
     provider: MCPServer | DaemonCapability | WorkspaceCapability;
   }
   ```

2. Modify agent configuration to support multiple tool sources:
   ```typescript
   tools: {
     mcp: ["slack", "github"],
     daemon: ["stream_reply", "workspace_draft_create"],
     workspace: ["custom_tool"]
   }
   ```

3. Update the agent execution worker to handle all tool types uniformly

**Pros:**

- Clean architecture
- Extensible for future tool types
- Clear separation of concerns

**Cons:**

- Significant refactoring required
- Breaks existing configurations
- Longer implementation time

### Solution 3: System Workspace Special Handling

Add special handling for system workspaces that can provide daemon capabilities directly.

**Implementation Points:**

1. Mark workspaces as "system" workspaces in configuration
2. For system workspaces, automatically inject daemon capabilities as tools
3. Create a special tool adapter for daemon capabilities in the worker

**Pros:**

- Isolates changes to system workspaces
- Doesn't affect regular workspaces
- Maintains backward compatibility

**Cons:**

- Creates special cases in the code
- Less flexible than a unified system

## Recommended Approach

For immediate resolution, implement **Solution 1** with the following specific changes:

### 1. Modify workspace-runtime.ts

```typescript
// After line 987, add daemon capability metadata collection
const daemonCapabilityMetadata: Record<string, any> = {};

// Check all agents for daemon capability tools
for (const [agentId, agentConfig] of Object.entries(allAgents)) {
  if (agentConfig.tools && Array.isArray(agentConfig.tools)) {
    for (const toolName of agentConfig.tools) {
      // Check if this is a daemon capability
      const capability = DaemonCapabilityRegistry.getCapability(toolName);
      if (capability) {
        daemonCapabilityMetadata[toolName] = {
          id: capability.id,
          description: capability.description,
          inputSchema: capability.inputSchema,
          category: capability.category,
        };
      }
    }
  }
}

// Modify the supervisor config (around line 988)
const supervisorConfig = {
  // ... existing config
  workspaceTools: mergedConfig.workspace.tools?.mcp?.servers
    ? {
      mcp: {
        servers: mergedConfig.workspace.tools.mcp.servers,
      },
    }
    : undefined,
  daemonCapabilityMetadata, // Add this new field
};
```

### 2. Modify supervisor to pass metadata to agents

In the supervisor worker, when creating agent execution tasks, include the daemon capability
metadata in the environment.

### 3. Modify agent-execution-worker.ts

Update the tool creation logic to check for daemon capabilities:

```typescript
// Around line 666, after checking for workspace_tools_metadata
if (!env.workspace_tools_metadata && env.daemon_capability_metadata) {
  // Check if this agent uses daemon capabilities
  const agentTools = request.agent_config.tools || [];
  const relevantCapabilities: Record<string, any> = {};

  for (const toolName of agentTools) {
    if (env.daemon_capability_metadata[toolName]) {
      relevantCapabilities[toolName] = env.daemon_capability_metadata[toolName];
    }
  }

  if (Object.keys(relevantCapabilities).length > 0) {
    workspaceTools = await this.createWorkspaceToolsFromMetadata(relevantCapabilities);
  }
}
```

## Testing Strategy

1. **Unit Tests**: Test daemon capability metadata extraction
2. **Integration Tests**: Test conversation agent with daemon tools
3. **Manual Testing**:
   - Start a conversation
   - Ask to create a workspace
   - Verify stream_reply works
   - Verify workspace creation tools work

## Migration Path

1. Implement Solution 1 as a quick fix
2. Plan for Solution 2 as a long-term architectural improvement
3. Deprecate the old conversation supervisor once the new system is stable

## Conclusion

The issue stems from an architectural gap where daemon capabilities aren't treated as first-class
tools in the agent execution system. While a proper fix would involve creating a unified tool
system, we can quickly resolve the conversation agent issue by passing daemon capability metadata
through the existing infrastructure.
