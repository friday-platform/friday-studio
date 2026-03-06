import type { AgentContext, AgentSessionData, AtlasAgent, AtlasTool } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type {
  GlobalSkillRefConfig,
  InlineSkillConfig,
  MCPServerConfig,
  SkillEntry,
  WorkspaceConfig,
} from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import { createLoadSkillTool, formatAvailableSkills, SkillStorage } from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { hasUnusableCredentialCause } from "../mcp-registry/credential-resolver.ts";
import { MCPStreamEmitter } from "../streaming/stream-emitters.ts";
import { createEnvironmentContext } from "./environment-context.ts";

interface AgentContextBuilderDeps {
  logger: Logger;
  server?: Server;
  hasActiveSSE?: () => boolean;
}

export function createAgentContextBuilder(deps: AgentContextBuilderDeps) {
  const { logger } = deps;

  const validateEnvironment = createEnvironmentContext(logger);

  return async function buildAgentContext(
    agent: AtlasAgent,
    sessionData: AgentSessionData & { streamId?: string },
    prompt: string,
    overrides?: Partial<AgentContext>,
  ): Promise<{
    context: AgentContext;
    enrichedPrompt: string;
    releaseMCPTools: () => Promise<void>;
  }> {
    const agentLogger = logger.child({
      agentId: agent.metadata.id,
      workspaceId: sessionData.workspaceId,
      sessionId: sessionData.sessionId,
      streamId: sessionData.streamId,
    });

    let allTools: Record<string, AtlasTool> = {};
    let skillEntries: SkillEntry[] = [];
    let releaseMCPTools: () => Promise<void> = () => Promise.resolve();
    agentLogger.debug("Building agent context", {
      agentId: agent.metadata.id,
      hasMcpConfig: !!agent.mcpConfig,
      mcpConfigKeys: agent.mcpConfig ? Object.keys(agent.mcpConfig) : [],
    });
    try {
      const fetched = await fetchAllTools(
        sessionData.workspaceId,
        agent.mcpConfig,
        logger,
        overrides?.abortSignal,
      );
      allTools = fetched.tools;
      skillEntries = fetched.skillEntries;
      releaseMCPTools = fetched.release;

      agentLogger.info("Pre-fetched tools", { toolCount: Object.keys(allTools).length });
    } catch (error) {
      // Credential errors must surface to the user — re-throw so the session fails
      // instead of silently running the agent without any tools.
      if (hasUnusableCredentialCause(error)) {
        throw error;
      }

      agentLogger.error("Failed to pre-fetch tools", { error });
      // Continue with empty tools rather than failing entirely
      allTools = {};
    }

    try {
      const envContext = await validateEnvironment(
        sessionData.workspaceId,
        agent.metadata.id,
        agent.environmentConfig,
      );

      let enrichedPrompt = prompt;
      let cleanupSkills: (() => Promise<void>) | undefined;

      if (agent.useWorkspaceSkills) {
        const inlineSkills = skillEntries.filter((e): e is InlineSkillConfig => "inline" in e);
        const globalRefs = skillEntries.filter((e): e is GlobalSkillRefConfig => !("inline" in e));

        const globalResult = await SkillStorage.list();
        const globalSummaries = globalResult.ok ? globalResult.data : [];

        const availableSkills = [
          ...inlineSkills.map((s) => ({ name: s.name, description: s.description })),
          ...globalSummaries.map((s) => ({
            name: `@${s.namespace}/${s.name}`,
            description: s.description,
          })),
        ];

        if (availableSkills.length > 0) {
          // Add load_skill tool only if one doesn't already exist.
          // This preserves any unified or specialized load_skill tool (e.g., conversation agent's
          // unified tool that checks hardcoded skills first).
          if (!allTools.load_skill) {
            const { tool: loadSkill, cleanup } = createLoadSkillTool({
              inlineSkills,
              skillEntries: globalRefs,
            });
            allTools.load_skill = loadSkill;
            cleanupSkills = cleanup;
          }
          enrichedPrompt = `${enrichedPrompt}\n\n${formatAvailableSkills(availableSkills)}`;
        }
      }

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

      const release = releaseMCPTools;
      return {
        context,
        enrichedPrompt,
        releaseMCPTools: async () => {
          await release();
          await cleanupSkills?.();
        },
      };
    } catch (err) {
      await releaseMCPTools();
      throw err;
    }
  };
}

/**
 * Fetch all tools directly from MCP servers.
 * Merges workspace, platform, and agent servers with proper precedence.
 * Also returns workspace skill entries for load_skill tool configuration.
 */
async function fetchAllTools(
  workspaceId: string,
  agentMCPConfig: Record<string, MCPServerConfig> | undefined,
  logger: Logger,
  signal?: AbortSignal,
): Promise<{
  tools: Record<string, AtlasTool>;
  skillEntries: SkillEntry[];
  release: () => Promise<void>;
}> {
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

  const skillEntries = workspaceConfig.skills ?? [];

  const { tools, dispose } = await createMCPTools(allServerConfigs, logger, { signal });
  return { tools, skillEntries, release: dispose };
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
