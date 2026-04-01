import type {
  AgentContext,
  AgentSessionData,
  AgentSkill,
  AtlasAgent,
  AtlasTool,
} from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import {
  type GlobalSkillRefConfig,
  type InlineSkillConfig,
  type MCPServerConfig,
  parseSkillRef,
  type SkillEntry,
  type WorkspaceConfig,
} from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import {
  createLoadSkillTool,
  extractArchiveContents,
  formatAvailableSkills,
  SkillStorage,
  validateSkillReferences,
} from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { UserConfigurationError } from "../errors/user-configuration-error.ts";
import {
  hasUnusableCredentialCause,
  resolveSlackAppByWorkspace,
} from "../mcp-registry/credential-resolver.ts";
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
      let resolvedSkills: AgentSkill[] | undefined;

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

        // Resolve all workspace skills eagerly so agents that use their own tool systems
        // (e.g. claude-code with Claude Code SDK) can access skill content via context.skills.
        // Global skills are also still available via load_skill tool for LLM-based agents.
        const allResolved: AgentSkill[] = inlineSkills.map((s) => ({
          name: s.name,
          description: s.description,
          instructions: s.instructions,
        }));

        if (globalRefs.length > 0) {
          const fetchResults = await Promise.allSettled(
            globalRefs.map(async (ref) => {
              const { namespace, name } = parseSkillRef(ref.name);
              const result = await SkillStorage.get(namespace, name, ref.version);
              if (!result.ok) {
                agentLogger.warn("Failed to resolve global skill", {
                  skill: ref.name,
                  error: result.error,
                });
                return null;
              }
              if (!result.data) {
                agentLogger.warn("Global skill not found", {
                  skill: ref.name,
                  version: ref.version,
                });
                return null;
              }
              const skill = result.data;

              // Extract archive reference files into memory so agents can
              // write them alongside SKILL.md in their sandbox.
              let referenceFiles: Record<string, string> | undefined;
              if (skill.archive) {
                try {
                  referenceFiles = await extractArchiveContents(new Uint8Array(skill.archive));
                  agentLogger.info("Extracted skill archive", {
                    skill: ref.name,
                    fileCount: Object.keys(referenceFiles).length,
                  });
                } catch (e) {
                  agentLogger.warn("Failed to extract skill archive", {
                    skill: ref.name,
                    error: stringifyError(e),
                  });
                }
              }

              // Validate that all file references in instructions point to
              // files that exist in the archive. Dead links = broken skill.
              const archiveFileList = referenceFiles ? Object.keys(referenceFiles) : [];
              const deadLinks = validateSkillReferences(skill.instructions, archiveFileList);
              if (deadLinks.length > 0) {
                agentLogger.warn("Skill has dead file references", { skill: ref.name, deadLinks });
              }

              agentLogger.info("Resolved global skill", {
                skill: ref.name,
                version: skill.version,
                hasArchive: !!skill.archive,
                deadLinks: deadLinks.length,
              });
              return {
                // Use short name (not @namespace/name) for sandbox path compatibility
                name: skill.name ?? name,
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
        }

        if (allResolved.length > 0) {
          resolvedSkills = allResolved;
        }

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
        skills: resolvedSkills,
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

  // slack-app credentials are wired per-workspace (not a user-level default).
  // Resolve the workspace's wired bot credential and inject its ID so the
  // downstream env resolver fetches the correct credential by ID.
  await injectSlackAppCredentialId(allServerConfigs, workspaceId);

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

/**
 * Find a provider-only slack-app credential ref in MCP server envs and
 * replace it with the credential ID wired to this workspace.
 */
async function injectSlackAppCredentialId(
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
