# Atlas Platform MCP Server Integration - Implementation Summary

## Problem Statement

The Atlas platform MCP server is not available to workspaces, causing email notifications and other
platform tools to fail. The error `spawnSync atlas-mcp ENOENT` occurs because workspaces expect an
`atlas-mcp` command that doesn't exist.

## Solution: Runtime Injection with Automatic Tool Availability

We implemented a comprehensive solution that:

1. Modifies MCPServerRegistry.initialize() to automatically inject the atlas-platform MCP server
   configuration with HTTP transport
2. Auto-injects "atlas-platform" into every agent's tools array at runtime
3. Provides natural task-focused prompts without tool enumeration
4. Adds tool_choice parameter for critical operations

## Implementation Plan

### 1. Fix Platform MCP Server Initialization

**Location**: `apps/atlasd/src/atlas-daemon.ts`

The PlatformMCPServer is already initialized but should use `getAtlasDaemonUrl()`:

```typescript
import { getAtlasDaemonUrl } from "@atlas/atlasd";

// Updated in initializeMCPServer() method:
private initializeMCPServer(): void {
    const logger = AtlasLogger.getInstance();
    const daemonUrl = getAtlasDaemonUrl();

    this.mcpServer = new PlatformMCPServer({
      daemonUrl,
      logger,
    });
}
```

### 2. MCP Endpoint Already Exists ✓

**Location**: `apps/atlasd/src/atlas-daemon.ts`

The `/mcp` endpoint is already implemented:

```typescript
// Already exists:
this.app.post("/mcp", async (c) => {
  if (!this.mcpServer) {
    return c.json({ error: "Platform MCP server not initialized" }, 503);
  }

  // Create StreamableHTTPTransport handler for the platform MCP server
  const transport = new StreamableHTTPTransport();
  return transport.handle(c.req.raw, this.mcpServer.getServer());
});
```

### 3. Modify MCPServerRegistry to Inject Platform Configuration

**Location**: `packages/mcp/src/registry.ts`

Update the initialize method to inject atlas-platform configuration with all available tools:

```typescript
import { getAtlasDaemonUrl } from "@atlas/atlasd";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { experimental_createMCPClient as createMCPClient } from "ai";

export class MCPServerRegistry {
  /**
   * Initialize the registry with platform and workspace configurations
   */
  static async initialize(
    atlasConfig?: AtlasConfig,
    workspaceConfig?: WorkspaceConfig,
  ): Promise<void> {
    // Get all available platform tools dynamically
    const platformTools = await this.getAllPlatformTools();

    // Inject atlas-platform MCP server configuration
    const platformMCPServer: Partial<MCPServerConfig> = {
      transport: {
        type: "http" as const,
        url: `${getAtlasDaemonUrl()}/mcp`,
      },
      tools: {
        allow: platformTools, // Dynamically generated list of all platform tools
      },
    };

    // Merge platform server into atlas config
    if (!atlasConfig) {
      atlasConfig = {
        tools: {
          mcp: {
            servers: {
              "atlas-platform": platformMCPServer,
            },
          },
        },
      };
    } else {
      atlasConfig = {
        ...atlasConfig,
        tools: {
          ...atlasConfig.tools,
          mcp: {
            ...atlasConfig.tools?.mcp,
            servers: {
              ...atlasConfig.tools?.mcp?.servers,
              "atlas-platform": platformMCPServer,
            },
          },
        },
      };
    }

    this.atlasConfig = atlasConfig;
    this.workspaceConfig = workspaceConfig;

    logger.info("MCPServerRegistry initialized with platform server", {
      operation: "mcp_registry_init",
      hasPlatformConfig: true,
      hasWorkspaceConfig: !!workspaceConfig,
      platformServerUrl: platformMCPServer.transport.url,
      platformToolCount: platformTools.length,
      platformTools: platformTools,
    });
  }

  /**
   * Get all available platform tools from the MCP server
   */
  private static async getAllPlatformTools(): Promise<string[]> {
    try {
      const daemonUrl = getAtlasDaemonUrl();

      // Create MCP client with HTTP transport
      const transport = new StreamableHTTPClientTransport(
        new URL(`${daemonUrl}/mcp`),
      );

      const mcpClient = await createMCPClient({
        transport,
      });

      // Get tools from the MCP client
      const tools = await mcpClient.tools();
      const toolNames = Object.keys(tools);

      if (toolNames.length === 0) {
        throw new Error("No tools returned from MCP server");
      }

      // Close the client after use
      await mcpClient.close();

      return toolNames;
    } catch (error) {
      logger.error("Failed to get platform tools dynamically", {
        error: error instanceof Error ? error.message : String(error),
      });

      // If we can't get tools dynamically, we should fail initialization
      // This ensures we never use a static list
      throw new Error(
        `Cannot initialize MCPServerRegistry: Failed to fetch platform tools from MCP server. ` +
          `Ensure the daemon is running and the MCP server is properly initialized.`,
      );
    }
  }
}
```

### 4. Update workspace-runtime-machine.ts

**Location**: `src/core/workspace-runtime-machine.ts`

Update the `registerMCPServers` function to handle async initialization:

```typescript
async function registerMCPServers(
  config: MergedConfig,
  workspaceId: string,
): Promise<void> {
  try {
    // Check if workspace has MCP server configuration
    if (!config.workspace.tools?.mcp?.servers) {
      logger.debug("No MCP servers configured for workspace", {
        operation: "mcp_server_registration",
        workspaceId,
      });
      return;
    }

    logger.info("Registering MCP servers for workspace", {
      operation: "mcp_server_registration",
      workspaceId,
      serverCount: Object.keys(config.workspace.tools.mcp.servers).length,
      serverIds: Object.keys(config.workspace.tools.mcp.servers),
    });

    // Initialize MCPServerRegistry to handle merging platform and workspace configs
    // CHANGE: Now await the async initialize
    await MCPServerRegistry.initialize(
      config.atlas, // Platform config
      config.workspace, // Workspace config
    );

    // Get server IDs from workspace configuration
    const serverIds = Object.keys(config.workspace.tools.mcp.servers);

    // IMPORTANT: After initialization, atlas-platform will be automatically included
    // in the merged configuration, so we need to also include it in serverIds
    const allServerIds = [...serverIds];
    if (!allServerIds.includes("atlas-platform")) {
      allServerIds.push("atlas-platform");
    }

    // Get server configurations from registry (now includes atlas-platform)
    const serverConfigs = MCPServerRegistry.getServerConfigs(allServerIds);

    // Get MCPManager instance from LLMProvider
    const mcpManager = LLMProvider.getMCPManager();

    // Register each server (including atlas-platform)
    const registrationPromises = serverConfigs.map(async (serverConfig) => {
      try {
        await mcpManager.registerServer(serverConfig);
        logger.info(`Successfully registered MCP server: ${serverConfig.id}`, {
          operation: "mcp_server_registration",
          workspaceId,
          serverId: serverConfig.id,
          transport: serverConfig.transport.type,
        });
      } catch (error) {
        logger.error(`Failed to register MCP server: ${serverConfig.id}`, {
          operation: "mcp_server_registration",
          workspaceId,
          serverId: serverConfig.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Don't throw - continue with other servers
      }
    });

    // Wait for all registrations to complete
    await Promise.allSettled(registrationPromises);

    logger.info("MCP server registration completed for workspace", {
      operation: "mcp_server_registration",
      workspaceId,
      totalServers: serverConfigs.length,
    });
  } catch (error) {
    logger.error("Failed to register MCP servers for workspace", {
      operation: "mcp_server_registration",
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw - workspace should continue to initialize even if MCP registration fails
  }
}
```

### 5. Auto-inject atlas-platform for All Agents

**Location**: `src/core/actors/session-supervisor-actor.ts`

Modify the getAgentExecutionConfig method to automatically include atlas-platform:

```typescript
private getAgentExecutionConfig(agentId: string): AgentExecutionConfig {
    // ... existing code ...

    let tools: string[] = [];
    if (agentConfig.type === "llm") {
      tools = agentConfig.config.tools || [];
    } else if (agentConfig.type === "system") {
      tools = agentConfig.config.tools || [];
    }

    // Always include atlas-platform for all agents to access Atlas tools
    if (!tools.includes("atlas-platform")) {
      tools = ["atlas-platform", ...tools];
    }

    return {
      agentId,
      agent: agentConfig,
      tools: tools,
      memory: this.config?.memory,
      workspaceTools: this.config?.tools,
    };
}
```

### 6. Add tool_choice Parameter for Critical Operations

**Location**: `packages/tools/src/internal/workspace-creation/tools.ts`

Add tool_choice parameter to LLM agent configuration:

```typescript
tool_choice: z.enum(["auto", "required", "none"]).optional().describe(
  "Tool usage strategy: 'auto' (LLM decides), 'required' (must use tools), 'none' (no tools). Use 'required' for agents that MUST use specific tools like email notifications.",
),
```

## Technical Details

### How It Works

1. **Daemon Initialization**: The daemon creates and initializes the PlatformMCPServer instance

2. **HTTP Endpoint**: The daemon exposes `/mcp` endpoint to handle MCP protocol requests

3. **Configuration Injection**: MCPServerRegistry.initialize() automatically injects the
   atlas-platform MCP server configuration:

   ```yaml
   tools:
     mcp:
       servers:
         atlas-platform:
           transport:
             type: "http"
             url: "http://localhost:8080/mcp"
           tools:
             allow:
               - "atlas_notify_email"
               - "tavily_search"
               # ... other platform tools
   ```

4. **Standard MCP Flow**: The existing MCP infrastructure handles the atlas-platform server like any
   other MCP server

5. **Tool Access**: Agents can use platform tools through the standard MCP manager

### Key Design Benefits

- **Uses Standard MCP Protocol**: Platform tools work through the same MCP infrastructure as
  workspace tools
- **HTTP Transport**: Well-tested transport mechanism
- **Tool Allowlist**: Explicit control over which tools are available
- **No Binary Required**: Uses HTTP endpoint instead of stdio command
- **Consistent Architecture**: Platform server works exactly like other MCP servers

## Key Implementation Improvements

### Beyond the Original Plan

Our final implementation went beyond the original plan with these enhancements:

1. **Automatic Tool Injection**: Auto-inject "atlas-platform" into every agent's tools array
2. **Natural Prompts**: Removed need to enumerate tools in agent prompts
3. **Tool Choice Control**: Added tool_choice parameter for critical operations
4. **Scalable Solution**: New tools automatically available without updating configs

## Benefits

1. **Standard MCP Architecture**: Uses existing MCP server infrastructure
2. **Configuration-based**: Platform server injected as standard MCP configuration
3. **HTTP Transport**: Reliable and well-tested transport mechanism
4. **Automatic Availability**: All agents automatically get atlas-platform tools
5. **No Binary Required**: Uses HTTP endpoint instead of stdio command
6. **Natural Language**: Agents use task-focused prompts without tool enumeration
7. **Scalable**: New tools automatically available to all agents

## Implementation Summary

1. ✅ Fixed PlatformMCPServer initialization to use `getAtlasDaemonUrl()`
2. ✅ `/mcp` endpoint already exists in daemon
3. ✅ Imported required dependencies in MCPServerRegistry
4. ✅ Modified `MCPServerRegistry.initialize()` to inject atlas-platform configuration with dynamic
   tool list using StreamableHTTPClientTransport
5. ✅ Implemented dynamic tool discovery using MCP client
6. ✅ Updated workspace-runtime-machine.ts to handle async MCPServerRegistry.initialize()
7. ✅ Auto-inject atlas-platform in all agent tools arrays
8. ✅ Added tool_choice parameter for critical operations
9. ✅ Updated workspace creation tools to use natural prompts

## Testing Plan

1. **Unit Tests**:
   - Test MCPServerRegistry correctly injects atlas-platform configuration
   - Test merged configuration includes both platform and workspace servers
   - Test daemon `/mcp` endpoint responds correctly

2. **Integration Tests**:
   - Start daemon and verify `/mcp` endpoint is accessible
   - Create workspace and verify atlas-platform server is registered
   - Test atlas_notify_email tool can be called through MCP
   - Test tavily_search tool can be called through MCP

3. **Manual Testing**:
   - Run telephone example
   - Verify atlas-platform appears in registered MCP servers
   - Verify email notifications work without manual configuration
   - Check logs show "Successfully registered MCP server: atlas-platform"

## Security Considerations

1. **Tool Access**: All workspaces automatically get platform tools
2. **Direct Registration**: Tools are registered in-process, no external access needed
3. **Controlled Environment**: Platform tools run in the same process as workspace runtime

## Tool Selection Solution

### Automatic Tool Discovery and Natural Prompts

Our implementation solved tool selection challenges through:

1. **Automatic Tool Availability**: All agents automatically have access to atlas-platform tools
   - No need to configure tools in workspace files
   - No need to enumerate tools in agent prompts
   - Agents discover and use appropriate tools based on task

2. **Natural Task-Focused Prompts**: Agents use natural language:

   ```yaml
   # Before: Tool-specific prompts
   prompt: "You MUST use atlas_notify_email to send emails"

   # After: Natural task prompts
   prompt: "Send email notifications with the analysis results"
   ```

3. **Tool Choice for Critical Operations**:

   ```yaml
   # Ensure email agent uses tools
   tool_choice: "required"
   ```

4. **No Tool Enumeration**: The system is scalable:
   - New tools automatically available
   - No need to update prompts when tools change
   - Agents select appropriate tools based on task context

### How Tool Selection Works Now

1. **Automatic Discovery**: Agents have access to all atlas-platform tools
2. **Context-Based Selection**: LLM selects tools based on task requirements
3. **No Manual Configuration**: No need to specify which tools to use
4. **Tool Choice Enforcement**: Use `tool_choice: "required"` for critical operations

## Summary

Our implementation successfully solves the atlas-platform availability problem through:

1. **Runtime Injection**: Automatically inject atlas-platform MCP server configuration
2. **HTTP Transport**: Use HTTP endpoint at `/mcp` instead of stdio
3. **Dynamic Tool Discovery**: Fetch available tools using StreamableHTTPClientTransport
4. **Automatic Agent Access**: Auto-inject "atlas-platform" into all agent tools arrays
5. **Natural Prompts**: Agents use task-focused prompts without tool enumeration
6. **Tool Choice Control**: Critical operations can enforce tool usage

The solution eliminates the `atlas-mcp ENOENT` error and provides:

- Automatic tool availability for all agents
- Scalable architecture (new tools automatically available)
- Natural language interactions
- Reliable tool selection for critical operations

### Configuration Result

The runtime-injected configuration appears as:

```yaml
tools:
  mcp:
    servers:
      atlas-platform:
        transport:
          type: "http"
          url: "${ATLAS_DAEMON_URL}/mcp" # Dynamically determined
        tools:
          allow: [/* All platform tools dynamically discovered */]
```

### Key Differences from Original Plan

1. **Automatic tool array injection** - All agents get atlas-platform automatically
2. **Natural prompts** - No need to specify tool names in prompts
3. **tool_choice parameter** - Added for critical operation control
4. **Removed tool enumeration** - Scalable without manual updates
