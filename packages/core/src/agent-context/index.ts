import type {
  AgentContext,
  AgentMemoryContext,
  AgentSessionData,
  AgentSkill,
  AtlasAgent,
  AtlasTool,
} from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { MCPServerConfig } from "@atlas/config";
import type { PlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { createMCPTools, type DisconnectedIntegration } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import {
  createLoadSkillTool,
  extractArchiveContents,
  formatAvailableSkills,
  resolveVisibleSkills,
  SkillStorage,
  validateSkillReferences,
} from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { wrapPlatformToolsWithScope } from "../agent-conversion/agent-tool-filters.ts";
import { discoverMCPServers, type LinkSummary } from "../mcp-registry/discovery.ts";
import { takeMountContext } from "../mount-context-registry.ts";
import { MCPStreamEmitter } from "../streaming/stream-emitters.ts";
import { createEnvironmentContext } from "./environment-context.ts";

interface AgentContextBuilderDeps {
  logger: Logger;
  platformModels: PlatformModels;
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
    disconnectedIntegrations: DisconnectedIntegration[];
  }> {
    const agentLogger = logger.child({
      agentId: agent.metadata.id,
      workspaceId: sessionData.workspaceId,
      sessionId: sessionData.sessionId,
      streamId: sessionData.streamId,
    });

    let allTools: Record<string, AtlasTool> = {};
    let releaseMCPTools: () => Promise<void> = () => Promise.resolve();
    let disconnectedIntegrations: DisconnectedIntegration[] = [];
    agentLogger.debug("Building agent context", {
      agentId: agent.metadata.id,
      hasMcpConfig: !!agent.mcpConfig,
      mcpConfigKeys: agent.mcpConfig ? Object.keys(agent.mcpConfig) : [],
    });
    try {
      const fetched = await fetchAllTools(
        sessionData.workspaceId,
        sessionData.workspaceName,
        agent.mcpConfig,
        logger,
        overrides?.abortSignal,
      );
      allTools = fetched.tools;
      releaseMCPTools = fetched.release;
      disconnectedIntegrations = fetched.disconnected;

      agentLogger.info("Pre-fetched tools", {
        toolCount: Object.keys(allTools).length,
        disconnectedCount: disconnectedIntegrations.length,
      });
    } catch (error) {
      // Unexpected fatal error (e.g. signal abort). Per-server transport,
      // startup, and timeout failures are silently dropped inside
      // createMCPTools so the chat continues with whatever connected.
      agentLogger.error("Failed to pre-fetch tools", { error });
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
      let resolvedSkills: AgentSkill[] | undefined;

      if (agent.useWorkspaceSkills) {
        // Resolve visible skills: unassigned (global) ∪ workspace-assigned
        // ∪ job-assigned (when the session carries a jobName).
        const visibleSummaries = await resolveVisibleSkills(sessionData.workspaceId, SkillStorage, {
          jobName: sessionData.jobName,
        });

        const availableSkills = visibleSummaries.map((s) => ({
          name: `@${s.namespace}/${s.name}`,
          description: s.description,
        }));

        // Eagerly resolve full content for all visible skills so agents that use
        // their own tool systems (e.g. claude-code with Claude Code SDK) can
        // access skill content via context.skills.
        const allResolved: AgentSkill[] = [];
        const fetchResults = await Promise.allSettled(
          visibleSummaries.map(async (summary) => {
            const result = await SkillStorage.get(summary.namespace, summary.name ?? "");
            if (!result.ok || !result.data) {
              agentLogger.warn("Failed to resolve skill", {
                skill: `@${summary.namespace}/${summary.name}`,
                error: result.ok ? "not found" : result.error,
              });
              return null;
            }
            const skill = result.data;

            // Extract archive reference files into memory
            let referenceFiles: Record<string, string> | undefined;
            if (skill.archive) {
              try {
                referenceFiles = await extractArchiveContents(new Uint8Array(skill.archive));
              } catch (e) {
                agentLogger.warn("Failed to extract skill archive", {
                  skill: `@${summary.namespace}/${summary.name}`,
                  error: stringifyError(e),
                });
              }
            }

            const archiveFileList = referenceFiles ? Object.keys(referenceFiles) : [];
            const deadLinks = validateSkillReferences(skill.instructions, archiveFileList);
            if (deadLinks.length > 0) {
              agentLogger.warn("Skill has dead file references", {
                skill: `@${summary.namespace}/${summary.name}`,
                deadLinks,
              });
            }

            return {
              name: skill.name ?? summary.name ?? "",
              description: skill.description,
              instructions: skill.instructions,
              referenceFiles,
            };
          }),
        );
        for (const fetchResult of fetchResults) {
          if (fetchResult.status === "fulfilled" && fetchResult.value) {
            allResolved.push(fetchResult.value);
          }
        }

        if (allResolved.length > 0) {
          resolvedSkills = allResolved;
        }

        if (availableSkills.length > 0) {
          // Add load_skill tool only if one doesn't already exist.
          if (!allTools.load_skill) {
            const { tool: loadSkill, cleanup } = createLoadSkillTool({
              workspaceId: sessionData.workspaceId,
              jobName: sessionData.jobName,
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

      // Resolve memory context: prefer overrides, then registry lookup via memoryContextKey
      let memory: AgentMemoryContext | undefined = overrides?.memory;
      if (!memory && sessionData.memoryContextKey) {
        memory = takeMountContext(sessionData.memoryContextKey);
      }

      const context: AgentContext = {
        env: envContext,
        session: sessionData,
        stream: streamEmitter,
        skills: resolvedSkills,
        logger: logger.child({
          workspaceId: sessionData.workspaceId,
          sessionId: sessionData.sessionId,
          agentId: agent.metadata.id,
          streamId: sessionData.streamId,
        }),
        platformModels: deps.platformModels,
        // Spread overrides to include abortSignal and other overrides
        ...overrides,
        ...(memory ? { memory } : {}),
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
        disconnectedIntegrations,
      };
    } catch (err) {
      await releaseMCPTools();
      throw err;
    }
  };
}

/**
 * Fetch all tools directly from MCP servers.
 * Discovers all workspace, registry, and static servers via discoverMCPServers,
 * applies agent-level overrides, and injects atlas-platform. Delegates to
 * createMCPTools for the actual tool instantiation.
 *
 * Allowlisted platform tools (memory, artifacts, state, webfetch) get
 * workspaceId/workspaceName auto-injected from the session scope so callers
 * (LLM tool calls, atlas/system handler code) never need to pass workspace
 * identity. Same wrap that FSM LLM steps and user agents apply.
 */
async function fetchAllTools(
  workspaceId: string,
  workspaceName: string | undefined,
  agentMCPConfig: Record<string, MCPServerConfig> | undefined,
  logger: Logger,
  signal?: AbortSignal,
): Promise<{
  tools: Record<string, AtlasTool>;
  release: () => Promise<void>;
  disconnected: DisconnectedIntegration[];
}> {
  logger.debug("Fetching tools from MCP servers", {
    workspaceId,
    agentMCPServerCount: agentMCPConfig ? Object.keys(agentMCPConfig).length : 0,
    agentMCPServerIds: agentMCPConfig ? Object.keys(agentMCPConfig) : [],
  });

  // Fetch Link summary so we can accurately determine which Link-backed servers
  // are configured. Without this, all Link-backed servers show as unconfigured.
  let linkSummary: LinkSummary | undefined;
  try {
    const result = await parseResult(client.link.v1.summary.$get({ query: {} }));
    if (result.ok && "providers" in result.data) {
      linkSummary = result.data as LinkSummary;
    }
  } catch {
    // Ignore — unconfigured Link-backed servers will be filtered out, which is safe.
  }

  const candidates = await discoverMCPServers(workspaceId, undefined, linkSummary);

  // Build config map from discovered candidates (workspace + registry + static)
  // Only include servers whose credentials are resolved — unconfigured servers
  // would cause createMCPTools to throw when resolving Link/env refs.
  const allServerConfigs: Record<string, MCPServerConfig> = {};
  for (const candidate of candidates) {
    if (!candidate.configured) continue;
    allServerConfigs[candidate.metadata.id] = candidate.mergedConfig;
  }

  // Always inject atlas-platform
  allServerConfigs["atlas-platform"] = getAtlasPlatformServerConfig();

  // Agent-level MCP configs take highest precedence
  for (const [id, agentConfig] of Object.entries(agentMCPConfig ?? {})) {
    if (allServerConfigs[id]) {
      logger.info("Agent MCP server overriding discovered server", {
        operation: "fetch_all_tools",
        serverId: id,
        existingTransport: allServerConfigs[id].transport.type,
        agentTransport: agentConfig.transport.type,
      });
    }
    allServerConfigs[id] = agentConfig;
  }

  logger.info("Created merged MCP server configuration", {
    operation: "fetch_all_tools",
    workspaceId,
    discoveredServerCount: candidates.length,
    agentServers: Object.keys(agentMCPConfig || {}),
    totalServerCount: Object.keys(allServerConfigs).length,
    serverIds: Object.keys(allServerConfigs),
  });

  const { tools, dispose, disconnected } = await createMCPTools(allServerConfigs, logger, {
    signal,
  });
  const wrapped = wrapPlatformToolsWithScope(tools, { workspaceId, workspaceName });
  return { tools: wrapped, release: dispose, disconnected };
}
