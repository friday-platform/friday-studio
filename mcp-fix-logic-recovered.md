# MCP Fix Logic Recovery

## Core Problem & Solution

The main issue was **MCP Server ID Assignment** - MCP tools were loading but not executing due to
missing server IDs in worker contexts.

## Key Logic Fixes:

### 1. Dual-Mode Configuration Resolution in WorkspaceMCPConfigurationService

**Problem**: Agent execution workers couldn't access MCP registry directly, causing missing server
IDs.

**Solution**: Modified constructor to accept direct MCP server configurations:

```typescript
constructor(
  private workspaceId: string,
  private sessionId?: string,
  private mcpServerConfigs?: Record<string, any>, // NEW: Direct configs for worker contexts
) {}
```

**Core Logic**:

```typescript
// In getServerConfigurations method:
for (const serverId of requestedServerIds) {
  let baseConfig: MCPServerConfig | undefined;

  if (this.mcpServerConfigs && this.mcpServerConfigs[serverId]) {
    // Use direct configuration if available (for worker contexts)
    baseConfig = {
      ...this.mcpServerConfigs[serverId],
      id: serverId, // CRITICAL: Ensure the config has the correct id field
    } as MCPServerConfig;
  } else {
    // Fallback to registry for non-worker contexts
    baseConfig = MCPServerRegistry.getServerConfig(serverId);
  }

  if (!baseConfig) {
    continue; // Skip missing servers
  }

  configurations.push(baseConfig);
}
```

### 2. Environment Variable Support for MCP Servers

**Problem**: Linear MCP server getting 401 Unauthorized due to hardcoded auth.

**Solution**: Added `env` field to stdio transport with "auto" resolution:

```typescript
// In MCPTransportConfigSchema:
z.object({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(), // NEW: Environment variables
}).strict();
```

**Core Logic**:

```typescript
// Process environment variables and resolve "auto" values
const processedEnv: Record<string, string> = {};
if (env) {
  for (const [key, value] of Object.entries(env)) {
    if (value === "auto" || value === "from_environment") {
      const envValue = Deno.env.get(key);
      if (envValue) {
        processedEnv[key] = envValue;
      }
    } else {
      processedEnv[key] = String(value);
    }
  }
}

mcpClient = await createMCPClient({
  transport: new StdioMCPTransport({
    command,
    args: args || [],
    env: processedEnv, // Pass processed environment
  }),
});
```

### 3. Complete MCP Registry Sharing Chain

**Problem**: SessionSupervisor and AgentSupervisor couldn't access workspace MCP servers.

**Solution**: Implemented complete sharing chain:

**SessionSupervisor**:

```typescript
private workspaceMcpServers?: Record<string, any>;

setWorkspaceMcpServers(servers: Record<string, any>): void {
  this.workspaceMcpServers = servers;
}

getMcpServerConfigsForAgent(agentId: string, serverNames: string[]): any[] {
  if (!this.workspaceMcpServers) return [];
  
  const configs: any[] = [];
  for (const serverName of serverNames) {
    if (this.workspaceMcpServers[serverName]) {
      configs.push({
        ...this.workspaceMcpServers[serverName],
        id: serverName, // Ensure ID is set
      });
    }
  }
  
  return configs;
}
```

**AgentSupervisor**:

```typescript
private sessionSupervisor?: any;

setSessionSupervisor(sessionSupervisor: any): void {
  this.sessionSupervisor = sessionSupervisor;
}

// In prepareAgentEnvironment:
environment.mcp_server_configs = this.prepareAgentMcpServerConfigs(agent);

private prepareAgentMcpServerConfigs(agent: AgentMetadata): Record<string, any> | undefined {
  // Get configs from SessionSupervisor
  const configs = this.sessionSupervisor.getMcpServerConfigsForAgent(
    agent.id,
    agentMcpServerNames,
  );
  
  // Convert to object keyed by server ID
  const configsObj: Record<string, any> = {};
  for (const config of configs) {
    configsObj[config.id] = config;
  }
  
  return configsObj;
}
```

### 4. Agent Execution Worker Fix

**Problem**: Workers weren't receiving complete MCP configurations.

**Solution**: Pass MCP server configs from environment:

```typescript
// In agent-execution-worker.ts initialization:
const mcpConfigurationService = new WorkspaceMCPConfigurationService(
  workspaceId,
  sessionId,
  environment?.mcp_server_configs, // Pass direct configs to service
);
```

### 5. Connection Verification with Retry Logic

**Problem**: stdio transport needed time to start up.

**Solution**: Added connection verification:

```typescript
private async verifyConnection(
  client: MCPClient,
  serverId: string,
  transportType: string,
): Promise<boolean> {
  if (transportType === "stdio") {
    const maxRetries = 10;
    const retryDelay = 500;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await Promise.race([
          client.tools(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Connection verification timeout")), 2000)
          ),
        ]);
        return true;
      } catch (error) {
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    }
  }
  
  return false;
}
```

## Implementation Flow:

1. **WorkspaceRuntime** initializes MCP registry
2. **WorkspaceSupervisor** passes MCP servers to sessions
3. **SessionSupervisor** filters configs for agents
4. **AgentSupervisor** prepares agent-specific configs
5. **Agent Execution Worker** receives both names and full configs
6. **MCPManager** uses direct configs (worker) or registry (main)

## Critical Success Factors:

1. **Always set the `id` field** on MCP server configurations
2. **Use dual-mode resolution** (direct configs vs registry)
3. **Pass complete configurations** through the supervisor chain
4. **Verify connections** before marking servers as available
5. **Handle environment variables** with "auto" resolution

This logic ensures MCP tools load AND execute properly across the entire supervisor hierarchy.
