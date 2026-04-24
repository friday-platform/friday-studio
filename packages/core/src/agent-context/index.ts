import type {
  AgentContext,
  AgentMemoryContext,
  AgentSessionData,
  AgentSkill,
  AtlasAgent,
  AtlasTool,
} from "@atlas/agent-sdk";
import type { MCPServerConfig } from "@atlas/config";
import type { PlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import {
  createLoadSkillTool,
  extractArchiveContents,
  formatAvailableSkills,
  resolveVisibleSkills,
  SkillStorage,
  validateSkillReferences,
} from "@atlas/skills";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { UserConfigurationError } from "../errors/user-configuration-error.ts";
import {
  hasUnusableCredentialCause,
  resolveSlackAppByWorkspace,
} from "../mcp-registry/credential-resolver.ts";
import { discoverMCPServers } from "../mcp-registry/discovery.ts";
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
  }> {
    const agentLogger = logger.child({
      agentId: agent.metadata.id,
      workspaceId: sessionData.workspaceId,
      sessionId: sessionData.sessionId,
      streamId: sessionData.streamId,
    });

    let allTools: Record<string, AtlasTool> = {};
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
 * applies agent-level overrides, injects atlas-platform, and resolves slack-app
 * credentials. Delegates to createMCPTools for the actual tool instantiation.
 */
async function fetchAllTools(
  workspaceId: string,
  agentMCPConfig: Record<string, MCPServerConfig> | undefined,
  logger: Logger,
  signal?: AbortSignal,
): Promise<{ tools: Record<string, AtlasTool>; release: () => Promise<void> }> {
  logger.debug("Fetching tools from MCP servers", {
    workspaceId,
    agentMCPServerCount: agentMCPConfig ? Object.keys(agentMCPConfig).length : 0,
    agentMCPServerIds: agentMCPConfig ? Object.keys(agentMCPConfig) : [],
  });

  const candidates = await discoverMCPServers(workspaceId);

  // Build config map from discovered candidates (workspace + registry + static)
  const allServerConfigs: Record<string, MCPServerConfig> = {};
  for (const candidate of candidates) {
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

  // slack-app credentials are wired per-workspace (not a user-level default).
  // Resolve the workspace's wired bot credential and inject its ID so the
  // downstream env resolver fetches the correct credential by ID.
  await injectSlackAppCredentialId(allServerConfigs, workspaceId);

  const { tools, dispose } = await createMCPTools(allServerConfigs, logger, { signal });
  return { tools, release: dispose };
}

/**
 * Find a provider-only slack-app credential ref in MCP server envs and
 * replace it with the credential ID wired to this workspace.
 */
export async function injectSlackAppCredentialId(
  configs: Record<string, MCPServerConfig>,
  workspaceId: string,
): Promise<void> {
  const ref = findSlackAppProviderRef(configs);
  if (!ref) return;

  const wired = await resolveSlackAppByWorkspace(workspaceId);
  if (!wired) {
    throw UserConfigurationError.missingConfiguration("slack", workspaceId, ["slack-app"], []);
  }
  ref.env[ref.key] = { ...ref.value, id: wired.credentialId };
}

/** Locate the first slack-app provider-only ref across all MCP server envs. */
function findSlackAppProviderRef(configs: Record<string, MCPServerConfig>) {
  for (const config of Object.values(configs)) {
    if (!config.env) continue;
    for (const [key, value] of Object.entries(config.env)) {
      if (typeof value === "object" && value.provider === "slack-app" && !value.id) {
        return { env: config.env, key, value };
      }
    }
  }
  return null;
}
