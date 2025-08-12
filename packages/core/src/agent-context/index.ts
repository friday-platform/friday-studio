/**
 * Agent Context Builder Factory
 *
 * Creates a function for building complete agent execution contexts,
 * including MCP tools, environment variables, and memory integration.
 */

import type { AgentContext, AgentSessionData, AtlasAgent, AtlasTool } from "@atlas/agent-sdk";
import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { CoALAMemoryManager } from "@atlas/memory";
import type { GlobalMCPServerPool } from "../mcp-server-pool.ts";
import { createEnvironmentContext } from "./environment-context.ts";
import { MCPStreamEmitter, NoOpStreamEmitter } from "../streaming/stream-emitters.ts";
import { createAtlasClient } from "@atlas/oapi-client";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface AgentContextBuilderDeps {
  daemonUrl: string;
  mcpServerPool: GlobalMCPServerPool;
  logger: Logger;
  server?: Server;
  hasActiveSSE?: () => boolean; // Add SSE check
}

/**
 * Create an agent context builder function
 */
export function createAgentContextBuilder(deps: AgentContextBuilderDeps) {
  const { daemonUrl, mcpServerPool, logger } = deps;
  const atlasClient = createAtlasClient({ baseUrl: daemonUrl });

  // Create factory functions
  const validateEnvironment = createEnvironmentContext(logger);

  /**
   * Build full agent execution context and enrich prompt with memories
   */
  return async function buildAgentContext(
    agent: AtlasAgent,
    sessionData: AgentSessionData & { streamId?: string },
    sessionMemory: CoALAMemoryManager | null,
    prompt: string,
    overrides?: Partial<AgentContext>,
    previousResults?: Array<{ agentId: string; output: unknown }>,
  ): Promise<{ context: AgentContext; enrichedPrompt: string }> {
    const agentLogger = logger.child({
      agentId: agent.metadata.id,
      workspaceId: sessionData.workspaceId,
      sessionId: sessionData.sessionId,
      streamId: sessionData.streamId,
    });

    // 1. Fetch all tools directly from MCP servers
    let allTools: Record<string, AtlasTool> = {};
    try {
      allTools = await fetchAllTools(
        sessionData.workspaceId,
        agent.mcpConfig,
        atlasClient,
        mcpServerPool,
        logger,
      );

      agentLogger.info("Pre-fetched tools", { toolCount: Object.keys(allTools).length });
    } catch (error) {
      agentLogger.error("Failed to pre-fetch tools", { error });
      // Continue with empty tools rather than failing entirely
      allTools = {};
    }

    // 2. Build environment context with validated variables
    const envContext = await validateEnvironment(
      sessionData.workspaceId,
      agent.metadata.id,
      agent.environmentConfig,
    );

    // 3. Retrieve and format memories into the prompt
    const enrichedPrompt = await enrichPromptWithMemories(
      agent,
      sessionMemory,
      prompt,
      previousResults,
    );

    // 4. Create stream emitter based on context
    let streamEmitter = overrides?.stream;
    if (!streamEmitter) {
      if (deps.server && sessionData.streamId) {
        // When we have a streamId and server, always use MCPStreamEmitter
        // The orchestrator handles its own SSE connection
        agentLogger.info("Creating MCPStreamEmitter", { sessionData });
        streamEmitter = new MCPStreamEmitter(
          deps.server,
          agent.metadata.id,
          sessionData.sessionId,
          agentLogger,
        );
      } else {
        agentLogger.info("Creating NoOpStreamEmitter");
        streamEmitter = new NoOpStreamEmitter();
      }
    }

    const context: AgentContext = {
      env: envContext,
      session: sessionData,
      stream: streamEmitter,
      logger: logger.child({
        workspaceId: sessionData.workspaceId,
        sessionId: sessionData.sessionId,
        agentId: agent.metadata.id,
        streamId: sessionData.streamId,
      }),
      ...overrides,
      // Tools should be last to ensure they're available unless explicitly overridden
      tools: overrides?.tools || allTools,
    };

    return { context, enrichedPrompt };
  };
}

/**
 * Fetch all tools directly from MCP servers
 * Merges workspace, platform, and agent servers with proper precedence
 */
async function fetchAllTools(
  workspaceId: string,
  agentMCPConfig: Record<string, MCPServerConfig> | undefined,
  atlasClient: ReturnType<typeof createAtlasClient>,
  mcpServerPool: GlobalMCPServerPool,
  logger: Logger,
): Promise<Record<string, AtlasTool>> {
  logger.debug("Fetching tools from MCP servers", {
    workspaceId,
    agentMCPServerCount: agentMCPConfig ? Object.keys(agentMCPConfig).length : 0,
  });

  // Get workspace config from daemon
  const { data, error } = await atlasClient.GET("/api/workspaces/{workspaceId}/config", {
    params: { path: { workspaceId } },
  });
  if (error) {
    logger.error("Failed to fetch workspace config", {
      operation: "fetch_all_tools",
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
    operation: "fetch_all_tools",
    workspaceId,
    workspaceServers: Object.keys(workspaceConfig.tools?.mcp?.servers ?? {}),
    agentServers: Object.keys(agentMCPConfig || {}),
    totalServerCount: Object.keys(allServerConfigs).length,
    serverIds: Object.keys(allServerConfigs),
  });

  // Get pooled MCP manager and fetch all tools
  const mcpManager = await mcpServerPool.getMCPManager(allServerConfigs);
  const serverIds = Object.keys(allServerConfigs);

  try {
    const tools = await mcpManager.getToolsForServers(serverIds);

    // Release the manager back to the pool
    mcpServerPool.releaseMCPManager(allServerConfigs);

    return tools;
  } catch (error) {
    // Make sure to release the manager even on error
    mcpServerPool.releaseMCPManager(allServerConfigs);
    throw error;
  }
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
        operation: "merge_server_configs",
        serverId: id,
        existingTransport: merged[id].transport.type,
        agentTransport: agentConfig.transport.type,
      });
    }

    merged[id] = agentConfig;
  }

  return merged;
}

/**
 * Enrich prompt with relevant memories and previous results
 */
function enrichPromptWithMemories(
  _agent: AtlasAgent,
  _sessionMemory: CoALAMemoryManager | null,
  prompt: string,
  previousResults?: Array<{ agentId: string; output: unknown }>,
): Promise<string> {
  // If there are previous results, include them in the prompt
  if (previousResults && previousResults.length > 0) {
    const previousResultsContext = previousResults.map((result) => {
      const outputStr = typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output, null, 2);
      return `Agent ${result.agentId} output:\n${outputStr}`;
    }).join("\n\n");

    // Enrich the prompt with previous results
    const enrichedPrompt =
      `Previous agent results:\n${previousResultsContext}\n\nCurrent task:\n${prompt}`;
    return Promise.resolve(enrichedPrompt);
  }

  // No previous results, return prompt as-is
  // TODO: Add CoALA memory integration when complete
  return Promise.resolve(prompt);
}

// Re-export types for convenience
export type { EnvironmentValidationError } from "./environment-context.ts";
export { getEnvironmentHelp } from "./environment-context.ts";
