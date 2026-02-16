/**
 * Agent Context Builder Factory
 *
 * Creates a function for building complete agent execution contexts,
 * including MCP tools and environment variables.
 */

import type { AgentContext, AgentSessionData, AtlasAgent, AtlasTool } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import { createLoadSkillTool, formatAvailableSkills, SkillStorage } from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { GlobalMCPServerPool } from "../mcp-server-pool.ts";
import { MCPStreamEmitter } from "../streaming/stream-emitters.ts";
import { createEnvironmentContext } from "./environment-context.ts";

interface AgentContextBuilderDeps {
  mcpServerPool: GlobalMCPServerPool;
  logger: Logger;
  server?: Server;
  hasActiveSSE?: () => boolean; // Add SSE check
}

/**
 * Create an agent context builder function
 */
export function createAgentContextBuilder(deps: AgentContextBuilderDeps) {
  const { mcpServerPool, logger } = deps;

  // Create factory functions
  const validateEnvironment = createEnvironmentContext(logger);

  /**
   * Build full agent execution context
   */
  return async function buildAgentContext(
    agent: AtlasAgent,
    sessionData: AgentSessionData & { streamId?: string },
    prompt: string,
    overrides?: Partial<AgentContext>,
  ): Promise<{ context: AgentContext; enrichedPrompt: string }> {
    const agentLogger = logger.child({
      agentId: agent.metadata.id,
      workspaceId: sessionData.workspaceId,
      sessionId: sessionData.sessionId,
      streamId: sessionData.streamId,
    });

    // 1. Fetch all tools directly from MCP servers
    let allTools: Record<string, AtlasTool> = {};
    agentLogger.debug("Building agent context", {
      agentId: agent.metadata.id,
      hasMcpConfig: !!agent.mcpConfig,
      mcpConfigKeys: agent.mcpConfig ? Object.keys(agent.mcpConfig) : [],
    });
    try {
      allTools = await fetchAllTools(
        sessionData.workspaceId,
        agent.mcpConfig,
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

    // 3. Enrich prompt with workspace skills (if agent opts in)
    let enrichedPrompt = prompt;

    if (agent.useWorkspaceSkills) {
      const skillsResult = await SkillStorage.list(sessionData.workspaceId);
      const skills = skillsResult.ok ? skillsResult.data : [];

      if (skills.length > 0) {
        // Add workspace-scoped load_skill tool only if one doesn't already exist.
        // This preserves any unified or specialized load_skill tool (e.g., conversation agent's
        // unified tool that checks hardcoded skills first).
        if (!allTools.load_skill) {
          allTools.load_skill = createLoadSkillTool(sessionData.workspaceId);
        }
        // Append available skills to prompt
        enrichedPrompt = `${enrichedPrompt}\n\n${formatAvailableSkills(skills)}`;
      }
    }

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
      // Spread overrides to include abortSignal and other overrides
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
  mcpServerPool: GlobalMCPServerPool,
  logger: Logger,
): Promise<Record<string, AtlasTool>> {
  logger.debug("Fetching tools from MCP servers", {
    workspaceId,
    agentMCPServerCount: agentMCPConfig ? Object.keys(agentMCPConfig).length : 0,
    agentMCPServerIds: agentMCPConfig ? Object.keys(agentMCPConfig) : [],
  });

  // Get workspace config from daemon
  const response = await parseResult(
    client.workspace[":workspaceId"].config.$get({ param: { workspaceId } }),
  );

  if (!response.ok) {
    logger.error("Failed to fetch workspace config", {
      operation: "fetch_all_tools",
      workspaceId,
      error: response.error,
    });
    throw new Error(`Failed to fetch workspace config: ${stringifyError(response.error)}`);
  }
  const workspaceConfig: WorkspaceConfig = response.data.config;

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
  merged["atlas-platform"] = getAtlasPlatformServerConfig();

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
