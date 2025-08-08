/**
 * MCP Context Factory
 *
 * Creates functions that give agents unified access to MCP tools from:
 * - Workspace MCP servers (from workspace config)
 * - Atlas platform server (always included)
 * - Agent-specific servers (highest priority)
 */

import type { AtlasTool } from "@atlas/agent-sdk";
import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { GlobalMCPServerPool } from "../mcp-server-pool.ts";
import { createAtlasClient } from "@atlas/oapi-client";

export interface MCPContext {
  /** Get tools from MCP server(s) - returns AI SDK Tool format directly */
  getTools(serverName?: string): Promise<Record<string, AtlasTool>>;

  /** Call MCP tool directly (TODO: implement) */
  callTool(toolName: string, args: unknown): Promise<unknown>;

  /** Cleanup MCP connections */
  dispose(): void;
}

/**
 * Create MCP context factory
 */
export function createMCPContextFactory(deps: {
  daemonUrl: string;
  mcpServerPool: GlobalMCPServerPool;
  logger: Logger;
}) {
  const { daemonUrl, mcpServerPool, logger } = deps;
  const atlasClient = createAtlasClient({ baseUrl: daemonUrl });

  return async function createMCPContext(
    workspaceId: string,
    agentMCPConfig?: Record<string, MCPServerConfig>,
  ): Promise<MCPContext> {
    logger.debug("Creating MCP server context for agent", {
      workspaceId,
      agentMCPServerCount: agentMCPConfig ? Object.keys(agentMCPConfig).length : 0,
    });

    // Get workspace config from daemon
    const { data, error } = await atlasClient.GET("/api/workspaces/{workspaceId}/config", {
      params: { path: { workspaceId } },
    });
    if (error) {
      logger.error("Failed to fetch workspace config", {
        operation: "mcp_context_creation",
        workspaceId,
        error,
      });
      throw new Error(`Failed to fetch workspace config: ${error}`);
    }
    const workspaceConfig: WorkspaceConfig = data.config;

    // Merge workspace and agent MCP servers (agent takes precedence)
    const allServerConfigs = mergeServerConfigs(
      workspaceConfig.tools?.mcp?.servers || {},
      agentMCPConfig || {},
      logger,
    );

    logger.info("Created merged MCP server configuration", {
      operation: "mcp_context_creation",
      workspaceId,
      workspaceServers: Object.keys(workspaceConfig.tools?.mcp?.servers ?? {}),
      agentServers: Object.keys(agentMCPConfig || {}),
      totalServerCount: Object.keys(allServerConfigs).length,
      serverIds: Object.keys(allServerConfigs),
    });

    // Get pooled MCP manager
    const mcpManager = await mcpServerPool.getMCPManager(allServerConfigs);

    return {
      async getTools(serverName?: string): Promise<Record<string, AtlasTool>> {
        try {
          if (serverName) {
            // Get tools from specific server
            if (!allServerConfigs[serverName]) {
              throw new Error(`MCP server not found: ${serverName}`);
            }
            return await mcpManager.getToolsForServers([serverName]);
          } else {
            // Get tools from all servers
            const serverIds = Object.keys(allServerConfigs);
            return await mcpManager.getToolsForServers(serverIds);
          }
        } catch (error) {
          logger.error("Failed to get MCP tools", {
            operation: "mcp_get_tools",
            workspaceId,
            serverName,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },

      callTool(_toolName: string, _args: unknown): Promise<unknown> {
        // TODO: Implement direct tool calling
        // This would require extending MCPManager to support direct tool execution
        throw new Error("Direct MCP tool calling not yet implemented");
      },

      dispose: () => {
        try {
          mcpServerPool.releaseMCPManager(allServerConfigs);

          logger.debug("Released MCP context resources", {
            operation: "mcp_context_disposal",
            workspaceId,
            serverCount: Object.keys(allServerConfigs).length,
          });
        } catch (error) {
          logger.error("Error disposing MCP context", {
            operation: "mcp_context_disposal",
            workspaceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    };
  };
}

/**
 * Merge MCP server configs with precedence: agent > platform > workspace
 */
function mergeServerConfigs(
  workspaceServers: Record<string, MCPServerConfig>,
  agentServers: Record<string, MCPServerConfig>,
  logger: Logger,
): Record<string, MCPServerConfig> {
  // Start with workspace servers (lowest priority)
  const merged = { ...workspaceServers };

  // Add Atlas platform server (takes priority over workspace servers)
  const platformServerConfig: MCPServerConfig = {
    transport: {
      type: "http",
      url: "http://localhost:8080/mcp",
    },
  };

  merged["atlas-platform"] = platformServerConfig;

  // Agent servers take highest precedence over everything
  for (const [id, agentConfig] of Object.entries(agentServers)) {
    if (merged[id]) {
      logger.info("Agent MCP server overriding other server", {
        operation: "mcp_server_merge",
        serverId: id,
        existingTransport: merged[id].transport.type,
        agentTransport: agentConfig.transport.type,
      });
    }

    merged[id] = agentConfig;
  }

  return merged;
}
