import process from "node:process";
import type { AtlasTools, AtlasUIMessage } from "@atlas/agent-sdk";
import {
  closePendingToolParts,
  createAgent,
  ok,
  repairToolCall,
  validateAtlasUIMessages,
} from "@atlas/agent-sdk";
import { pipeUIMessageStream } from "@atlas/agent-sdk/vercel-helpers";
import { bundledAgents } from "@atlas/bundled-agents";
import { client, parseResult } from "@atlas/client/v2";
import type { WorkspaceConfig } from "@atlas/config";
import { ArtifactTypeSchema } from "@atlas/core/artifacts";
import { ChatStorage } from "@atlas/core/chat/storage";
import { createErrorCause, getErrorDisplayMessage } from "@atlas/core/errors";
import {
  buildTemporalFacts,
  getDefaultProviderOpts,
  type PlatformModels,
  smallLLM,
} from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import type { ResourceEntry } from "@atlas/resources";
import { buildResourceGuidance, createLedgerClient } from "@atlas/resources";
import type { SkillSummary } from "@atlas/skills";
import { createLoadSkillTool, resolveVisibleSkills, SkillStorage } from "@atlas/skills";
import {
  convertToModelMessages,
  createUIMessageStream,
  smoothStream,
  stepCountIs,
  streamText,
} from "ai";
import { z } from "zod";
import { fetchLinkSummary, formatIntegrationsSection } from "../link-context.ts";
import {
  composeMemoryBlocks,
  composeResources,
  composeSkills,
  composeTools,
  composeWorkspaceSections,
  fetchForegroundContexts,
} from "./compose-context.ts";
import { buildOnboardingClause, buildUserProfileClause } from "./onboarding.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { connectServiceSucceeded } from "./stop-conditions.ts";
import { artifactTools } from "./tools/artifact-tools.ts";
import { createAgentTool } from "./tools/bundled-agent-tools.ts";
import { createRunCodeTool } from "./tools/code-exec.ts";
import { createConnectServiceTool } from "./tools/connect-service.ts";
import { createCreateMcpServerTool } from "./tools/create-mcp-server.ts";
import { createDelegateTool } from "./tools/delegate/index.ts";
import { createDisableMcpServerTool } from "./tools/disable-mcp-server.ts";
import { createBoundDraftTools } from "./tools/draft-tools.ts";
import { createEnableMcpServerTool } from "./tools/enable-mcp-server.ts";
import { createFileIOTools } from "./tools/file-io.ts";
import { createInstallMcpServerTool } from "./tools/install-mcp-server.ts";
import { createJobTools } from "./tools/job-tools.ts";
import { createListMCPServersTool } from "./tools/list-mcp-servers.ts";
import { createListMcpToolsTool } from "./tools/list-mcp-tools.ts";
import { createMemorySaveTool } from "./tools/memory-save.ts";
import { createResourceChatTools, RESOURCE_CHAT_TOOL_NAMES } from "./tools/resource-tools.ts";
import { createSearchMcpServersTool } from "./tools/search-mcp-servers.ts";
import { createBoundUpsertTools } from "./tools/upsert-tools.ts";
import { createWebFetchTool } from "./tools/web-fetch.ts";
import { createWebSearchTool } from "./tools/web-search.ts";
import { createMcpDependenciesTool } from "./tools/mcp-dependencies.ts";
import { createBoundWorkspaceOpsTools, createWorkspaceOpsTools } from "./tools/workspace-ops.ts";
import { fetchUserIdentitySection } from "./user-identity.ts";
import { fetchUserProfileState } from "./user-profile.ts";

const ROLE_SYSTEM = "system" as const;

interface WorkspaceChatResult {
  text: string | undefined;
}

/** Artifact shape from the artifacts storage endpoint. */
export interface ArtifactSummary {
  id: string;
  type: string;
  title: string;
  summary: string;
}

/** Zod schema for parsing resource entries from the daemon API. */
const ResourceEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("document"),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("external_ref"),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    provider: z.string(),
    ref: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("artifact_ref"),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    artifactId: z.string(),
    artifactType: z.union([ArtifactTypeSchema, z.literal("unavailable")]),
    rowCount: z.number().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
]);

const ResourcesResponseSchema = z.object({ resources: z.array(ResourceEntrySchema) });
const ArtifactsResponseSchema = z.object({
  artifacts: z.array(
    z.object({ id: z.string(), type: z.string(), title: z.string(), summary: z.string() }),
  ),
});

/**
 * Parse resource entries from raw daemon API response.
 * Returns empty array on invalid data (graceful degradation).
 */
export function parseResourceEntries(data: unknown): ResourceEntry[] {
  const parsed = ResourcesResponseSchema.safeParse(data);
  return parsed.success ? parsed.data.resources : [];
}

/**
 * Parse artifact summaries from raw daemon API response.
 * Returns empty array on invalid data.
 */
export function parseArtifactSummaries(data: unknown): ArtifactSummary[] {
  const parsed = ArtifactsResponseSchema.safeParse(data);
  return parsed.success ? parsed.data.artifacts : [];
}

/**
 * Compute orphaned artifacts — those whose IDs don't appear in any artifact_ref resource entry.
 */
export function computeOrphanedArtifacts(
  resourceEntries: ResourceEntry[],
  artifacts: ArtifactSummary[],
): ArtifactSummary[] {
  const linkedArtifactIds = new Set(
    resourceEntries
      .filter((e): e is ResourceEntry & { type: "artifact_ref" } => e.type === "artifact_ref")
      .map((e) => e.artifactId),
  );
  return artifacts.filter((a) => !linkedArtifactIds.has(a.id));
}

export interface WorkspaceDetails {
  name: string;
  description?: string;
  agents: string[];
  jobs: Array<{ id: string; name: string; description?: string }>;
  signals: Array<{ name: string }>;
  resourceEntries: ResourceEntry[];
  orphanedArtifacts: ArtifactSummary[];
}

export async function fetchWorkspaceDetails(
  workspaceId: string,
  logger: Logger,
): Promise<WorkspaceDetails> {
  const [wsResult, agentsResult, jobsResult, signalsResult, artifactsResult, resourcesResult] =
    await Promise.all([
      parseResult(client.workspace[":workspaceId"].$get({ param: { workspaceId } })),
      parseResult(client.workspace[":workspaceId"].agents.$get({ param: { workspaceId } })),
      parseResult(client.workspace[":workspaceId"].jobs.$get({ param: { workspaceId } })),
      parseResult(client.workspace[":workspaceId"].signals.$get({ param: { workspaceId } })),
      parseResult(client.artifactsStorage.index.$get({ query: { workspaceId, limit: "50" } })),
      parseResult(client.workspace[":workspaceId"].resources.$get({ param: { workspaceId } })),
    ]);

  const name = wsResult.ok ? (wsResult.data.name ?? workspaceId) : workspaceId;
  const description = wsResult.ok ? wsResult.data.description : undefined;

  if (!wsResult.ok) {
    logger.error("Failed to fetch workspace details", { workspaceId, error: wsResult.error });
  }

  const agents: string[] = [];
  if (agentsResult.ok && Array.isArray(agentsResult.data)) {
    for (const a of agentsResult.data) {
      const parsed = z.object({ id: z.string() }).safeParse(a);
      if (parsed.success) agents.push(parsed.data.id);
    }
  } else {
    logger.warn("Failed to fetch workspace agents", {
      workspaceId,
      error: agentsResult.ok ? "invalid shape" : agentsResult.error,
    });
  }

  const jobs: Array<{ id: string; name: string; description?: string }> = [];
  if (jobsResult.ok && Array.isArray(jobsResult.data)) {
    for (const j of jobsResult.data) {
      const parsed = z
        .object({ id: z.string(), name: z.string(), description: z.string().optional() })
        .safeParse(j);
      if (parsed.success) jobs.push(parsed.data);
    }
  } else {
    logger.warn("Failed to fetch workspace jobs", {
      workspaceId,
      error: jobsResult.ok ? "invalid shape" : jobsResult.error,
    });
  }

  const signals: Array<{ name: string }> = [];
  if (signalsResult.ok) {
    const parsed = z
      .object({ signals: z.array(z.object({ name: z.string() })) })
      .safeParse(signalsResult.data);
    if (parsed.success) {
      signals.push(...parsed.data.signals);
    }
  } else {
    logger.warn("Failed to fetch workspace signals", { workspaceId, error: signalsResult.error });
  }

  // Parse resource entries from daemon API (graceful degradation on failure)
  let resourceEntries: ResourceEntry[] = [];
  if (resourcesResult.ok) {
    resourceEntries = parseResourceEntries(resourcesResult.data);
  } else {
    logger.warn("Failed to fetch workspace resources", {
      workspaceId,
      error: resourcesResult.error,
    });
  }

  // Parse artifacts and compute orphans (artifacts not linked to any resource entry)
  let artifacts: ArtifactSummary[] = [];
  if (artifactsResult.ok) {
    artifacts = parseArtifactSummaries(artifactsResult.data);
  } else {
    logger.warn("Failed to fetch workspace artifacts", {
      workspaceId,
      error: artifactsResult.error,
    });
  }

  const orphanedArtifacts = computeOrphanedArtifacts(resourceEntries, artifacts);

  return { name, description, agents, jobs, signals, resourceEntries, orphanedArtifacts };
}

/**
 * Describe a signal trigger so Friday can answer "how do I run this?" without
 * guessing. Falls back to the provider name when the config shape doesn't
 * carry a user-facing identifier.
 */
function describeSignalTrigger(sig: unknown): string {
  if (typeof sig !== "object" || sig === null) return "";
  const s = sig as { provider?: unknown; config?: unknown };
  const provider = typeof s.provider === "string" ? s.provider : undefined;
  const cfg =
    typeof s.config === "object" && s.config !== null
      ? (s.config as Record<string, unknown>)
      : undefined;

  if (provider === "http" && cfg && typeof cfg.path === "string") {
    return `POST ${cfg.path}`;
  }
  if (provider === "schedule" && cfg) {
    const cron = typeof cfg.cron === "string" ? cfg.cron : undefined;
    const interval = typeof cfg.interval === "string" ? cfg.interval : undefined;
    return cron ? `cron ${cron}` : interval ? `every ${interval}` : "schedule";
  }
  if (provider === "fs-watch" && cfg && typeof cfg.path === "string") {
    return `watch ${cfg.path}`;
  }
  if (provider === "slack") return "slack message";
  if (provider === "telegram") return "telegram message";
  if (provider === "whatsapp") return "whatsapp message";
  if (provider === "discord") return "discord message";
  if (provider === "system") return "system";
  return provider ?? "";
}

/**
 * Format workspace capabilities as a system prompt section.
 *
 * When the full `wsConfig` is available, signal triggers (HTTP paths, cron
 * schedules, platform providers) and MCP tool names are inlined so Friday can
 * answer workspace-specific "how do I run this?" / "where's my data?" without
 * guessing. Without a config, falls back to a summary of names only.
 */
export function formatWorkspaceSection(
  workspaceId: string,
  details: WorkspaceDetails,
  config?: WorkspaceConfig,
): string {
  let section = `<workspace id="${workspaceId}" name="${details.name}">`;

  if (details.description) {
    section += `\n${details.description}`;
  }

  if (details.agents.length > 0) {
    section += `\n<agents>${details.agents.join(", ")}</agents>`;
  }

  if (details.jobs.length > 0) {
    const jobEntries = details.jobs.map((j) => {
      const desc = j.description ? ` - ${j.description}` : "";
      return `${j.name}${desc}`;
    });
    section += `\n<jobs>\n${jobEntries.join("\n")}\n</jobs>`;
  }

  if (details.signals.length > 0) {
    const signalConfigs = (config?.workspace as { signals?: Record<string, unknown> })?.signals;
    const signalEntries = details.signals.map((s) => {
      const trigger = signalConfigs ? describeSignalTrigger(signalConfigs[s.name]) : "";
      return trigger ? `${s.name} (${trigger})` : s.name;
    });
    section += `\n<signals>\n${signalEntries.join("\n")}\n</signals>`;
  }

  section += "\n</workspace>";
  return section;
}

/**
 * Build skills section from workspace skills.
 */
export function buildSkillsSection(workspaceSkills: SkillSummary[]): string {
  if (workspaceSkills.length === 0) return "";

  const entries = workspaceSkills.map(
    (s) => `<skill name="@${s.namespace}/${s.name}">${s.description}</skill>`,
  );

  return `<available_skills>
<instruction>Load skills with load_skill when task matches.</instruction>
${entries.join("\n")}
</available_skills>`;
}

/**
 * Build workspace-chat system prompt.
 */
export function getSystemPrompt(
  workspaceSection: string,
  options?: {
    integrations?: string;
    skills?: string;
    userIdentity?: string;
    resources?: string;
    memory?: string;
    onboarding?: string;
    userProfile?: string;
  },
): string {
  let prompt = SYSTEM_PROMPT;

  prompt = `${prompt}\n\n${workspaceSection}`;

  if (options?.memory) {
    prompt = `${prompt}\n\n${options.memory}`;
  }

  if (options?.onboarding) {
    prompt = `${prompt}\n\n${options.onboarding}`;
  }

  if (options?.resources) {
    prompt = `${prompt}\n\n${options.resources}`;
  }

  if (options?.integrations) {
    prompt = `${prompt}\n\n${options.integrations}`;
  }

  if (options?.skills) {
    prompt = `${prompt}\n\n${options.skills}`;
  }

  if (options?.userIdentity) {
    prompt = `${prompt}\n\n${options.userIdentity}`;
  }

  if (options?.userProfile) {
    prompt = `${prompt}\n\n${options.userProfile}`;
  }

  return prompt;
}

/**
 * Generates a concise 2-3 word title for a conversation based on its messages.
 */
export async function generateChatTitle(
  platformModels: PlatformModels,
  messages: AtlasUIMessage[],
  logger: Logger,
): Promise<string> {
  const messagePreview = messages
    .map((m) => `${m.role}: ${JSON.stringify(m.parts.filter((p) => p.type === "text"))}`)
    .join("\n");

  const result = await smallLLM({
    platformModels,
    system:
      "You generate concise 2-3 word titles for conversations. Only output the title, nothing else.",
    prompt: `Generate a title for this conversation:\n${messagePreview}`,
    maxOutputTokens: 250,
  });

  const title = result.trim();
  if (title.length < 3) {
    logger.warn("Chat title too short, using fallback", { title });
    return "Saved Chat";
  }
  return title;
}

export const workspaceChatAgent = createAgent<string, WorkspaceChatResult>({
  id: "workspace-chat",
  displayName: "Workspace Chat Agent",
  version: "1.0.0",
  description: "Chat agent scoped to a single workspace",
  expertise: { examples: [] },
  useWorkspaceSkills: true,

  handler: async (_, { session, logger, stream, abortSignal, platformModels }) => {
    if (!session.streamId) {
      throw new Error("Stream ID is required");
    }

    const workspaceId = session.workspaceId;
    if (!workspaceId) {
      throw new Error("Workspace ID is required for workspace chat");
    }

    // Load and validate chat history via workspace-scoped HTTP endpoint
    let messages: AtlasUIMessage[] = [];
    const res = await parseResult(
      client.workspaceChat(workspaceId)[":chatId"].$get({ param: { chatId: session.streamId } }),
    );
    if (res.ok) {
      messages = await validateAtlasUIMessages(res.data.messages);
    } else {
      logger.error("Failed to load chat history", { error: res.error });
    }

    let finalText: string | undefined;
    let cleanupSkills: (() => Promise<void>) | undefined;

    const persistStreamMessage = createUIMessageStream<AtlasUIMessage>({
      originalMessages: messages,
      onFinish: async ({ messages }) => {
        if (!session.streamId) {
          throw new Error("Stream ID is missing");
        }

        // Generate title on turns 2 and 4
        if (messages.length === 2 || messages.length === 4) {
          const title = await generateChatTitle(platformModels, messages, logger);
          const titleResult = await parseResult(
            client
              .workspaceChat(workspaceId)
              [":chatId"].title.$patch({ param: { chatId: session.streamId }, json: { title } }),
          );
          if (!titleResult.ok) {
            logger.error("Failed to update chat title", { streamId: session.streamId, title });
          }
        }

        // Persist assistant message directly via ChatStorage. The HTTP route
        // is locked down to user-role messages only — assistant persistence
        // happens in-process to avoid that guard and to skip an unnecessary
        // localhost roundtrip.
        //
        // Before persisting, sweep any tool-call parts that didn't reach a
        // terminal state. Cancelled / crashed turns leave the last in-flight
        // tool stuck in `input-streaming` or `input-available`, which the
        // chat page would then render as a "running…" spinner forever on
        // reload. Flipping them to `output-error` gives the UI something to
        // render and matches the semantics of what actually happened.
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === "assistant") {
          const { closed } = closePendingToolParts(lastMessage);
          if (closed > 0) {
            logger.info("Closed pending tool parts before persist", {
              streamId: session.streamId,
              messageId: lastMessage.id,
              closed,
              aborted: abortSignal?.aborted === true,
            });
          }
          const appendResult = await ChatStorage.appendMessage(
            session.streamId,
            lastMessage,
            workspaceId,
          );
          if (!appendResult.ok) {
            logger.error("Failed to append assistant message to chat storage", {
              streamId: session.streamId,
              error: appendResult.error,
            });
          } else {
            logger.debug("Assistant message persisted to chat storage", {
              streamId: session.streamId,
              messageId: lastMessage.id,
            });
          }
        }
      },
      execute: async ({ writer }) => {
        if (!session.streamId) {
          throw new Error("Stream ID is required");
        }

        // Parallel fetch of startup context
        const foregroundIds = session.foregroundWorkspaceIds ?? [];
        logger.info("Fetching workspace chat startup context", {
          workspaceId,
          foregroundCount: foregroundIds.length,
        });
        const [
          workspaceDetails,
          wsConfigResult,
          linkSummary,
          userIdentitySection,
          foregrounds,
          profileState,
        ] = await Promise.all([
          fetchWorkspaceDetails(workspaceId, logger),
          parseResult(client.workspace[":workspaceId"].config.$get({ param: { workspaceId } })),
          fetchLinkSummary(logger),
          fetchUserIdentitySection(logger),
          foregroundIds.length > 0
            ? fetchForegroundContexts(foregroundIds, logger)
            : Promise.resolve([]),
          fetchUserProfileState(workspaceId, logger),
        ]);

        let wsConfig: WorkspaceConfig | undefined;
        if (wsConfigResult.ok) {
          wsConfig = wsConfigResult.data.config;
        } else {
          logger.warn("Failed to fetch workspace config", {
            workspaceId,
            error: wsConfigResult.error,
          });
        }

        // Format sections — compose with foreground workspaces. wsConfig
        // carries the workspace.yml details (signal triggers, MCP server names)
        // so Friday can answer "how do I run this?" / "where's my data stored?"
        // without falling back to docker/infra speculation.
        const primaryWorkspaceSection = formatWorkspaceSection(
          workspaceId,
          workspaceDetails,
          wsConfig,
        );
        const workspaceSection = composeWorkspaceSections(primaryWorkspaceSection, foregrounds);
        const integrationsSection = linkSummary
          ? formatIntegrationsSection(linkSummary)
          : undefined;

        // Skills — scoped to this workspace (unassigned ∪ directly assigned), merged with foregrounds
        const primarySkills = await resolveVisibleSkills(workspaceId, SkillStorage);
        const mergedSkills = composeSkills(primarySkills, foregrounds);
        const skillsSection = buildSkillsSection(mergedSkills);

        // Connect service tool
        const connectServiceTool: AtlasTools = {};
        if (linkSummary && linkSummary.providers.length > 0) {
          const providerIds = linkSummary.providers.map((p) => p.id);
          connectServiceTool.connect_service = createConnectServiceTool(providerIds);
        }

        // Resource adapter — shared by resource tools
        const resourceAdapter = createLedgerClient();

        // load_skill
        const loadSkillResult = createLoadSkillTool({ workspaceId });
        const loadSkillTool = loadSkillResult.tool;
        cleanupSkills = loadSkillResult.cleanup;

        // MCP server discovery tool
        const listMcpServersTool = createListMCPServersTool(
          workspaceId,
          wsConfig,
          linkSummary ?? undefined,
          logger,
        );

        // MCP registry search + install tools
        const searchMcpServersTool = createSearchMcpServersTool(logger);
        const installMcpServerTool = createInstallMcpServerTool(logger);
        const createMcpServerTool = createCreateMcpServerTool(logger);

        // MCP tool discovery (registry-scoped, no workspace state modified)
        const listMcpToolsTool = createListMcpToolsTool(logger);

        // Workspace-scoped MCP management tools
        const mcpDependenciesTool = createMcpDependenciesTool(workspaceId, logger);
        const enableMcpServerTool = createEnableMcpServerTool(workspaceId, logger);
        const disableMcpServerTool = createDisableMcpServerTool(workspaceId, logger);

        // Job tools — pass session.streamId so nested job sessions inherit
        // the chat thread ID. The daemon's broadcast hook reads it to skip
        // the originating chat communicator (no echo back to Discord/Slack/etc).
        // Pass writer + abortSignal so job tools can stream via SSE and render
        // nested inner tool-call cards live in the chat UI.
        const jobTools = createJobTools(
          workspaceId,
          wsConfig?.jobs ?? {},
          wsConfig?.signals ?? {},
          logger,
          session.streamId,
          writer,
          abortSignal,
        );

        // Compose resources from primary + foreground workspaces
        const mergedResources = composeResources(workspaceDetails.resourceEntries, foregrounds);

        // Resource tools — only register when workspace has document resources
        const hasDocuments = mergedResources.some((e) => e.type === "document");
        const resourceTools = hasDocuments
          ? createResourceChatTools(
              resourceAdapter,
              new Map(mergedResources.map((e) => [e.slug, e])),
              workspaceId,
            )
          : {};

        // Ad-hoc freedom tools — modeled on Hermes + OpenClaw patterns.
        // These give the chat agent web fetch + search + code execution +
        // ephemeral file I/O so it can handle "look up X", "run this
        // Python", "analyze this CSV" turns without bouncing off a narrow
        // workspace-only tool set.
        //
        // - web_fetch: SSRF-guarded HTTP → markdown with content-provenance
        //   wrapping, 15-min per-session cache, 2 MB raw / 32 KB extracted
        //   caps, 30 s hard timeout.
        // - web_search: Brave Search API, only registered when
        //   BRAVE_SEARCH_API_KEY is set (Hermes `check_fn` pattern).
        // - run_code: python3 / deno / bash subprocess in a per-session
        //   scratch dir under {FRIDAY_HOME}/scratch/{sessionId}/, 30 s
        //   timeout, 100 KB stdout cap. No network inside the sandbox —
        //   scripts must use web_fetch via the outer tool loop.
        // - read_file / write_file / list_files: scoped to the same scratch
        //   dir so multi-step workflows (fetch → save → analyze in Python
        //   → read results) compose cleanly across turns.
        const adHocSessionId = session.sessionId || `session-${Date.now()}`;
        const webFetchTool = createWebFetchTool(logger);
        const webSearchTool = createWebSearchTool(logger);
        const runCodeTool = createRunCodeTool(adHocSessionId, logger);
        const fileIOTools = createFileIOTools(adHocSessionId, logger);

        // delegate runs nested streamText sub-agents in-process. The child's
        // tool set is the parent's full composed set minus `delegate` itself
        // (plus a synthetic `finish` tool the delegate injects). We resolve
        // the child's tool set lazily via a thunk so `composeTools()` below
        // can run first; `allToolsRef` is assigned after composition and the
        // thunk reads it at child-`execute()` time.
        let allToolsRef: AtlasTools = {};
        const delegateTool = createDelegateTool(
          {
            writer,
            session: {
              sessionId: adHocSessionId,
              workspaceId,
              streamId: session.streamId,
              userId: session.userId,
              datetime: session.datetime,
            },
            platformModels,
            logger,
            abortSignal,
            repairToolCall,
            workspaceConfig: wsConfig,
            linkSummary: linkSummary ?? undefined,
          },
          () => allToolsRef,
        );

        // Bundled-agent tools (`agent_<id>`) give the LLM direct one-step
        // access to Friday's specialist agents (web, gh, data-analyst, etc.)
        // without routing through a planner. Each wrapper self-gates on its
        // declared `environmentConfig.required` keys against `process.env`;
        // agents whose credentials are missing return `{}` and don't appear
        // in the composed tool set. Spread before direct/job/resource tools
        // so any name collision (there shouldn't be — `agent_` prefix) lets
        // direct tools win.
        const processEnv = Object.fromEntries(
          Object.entries(process.env).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        );
        const agentToolDeps = {
          writer,
          session: {
            sessionId: adHocSessionId,
            workspaceId,
            streamId: session.streamId,
            userId: session.userId,
            datetime: session.datetime,
          },
          platformModels,
          abortSignal,
          env: processEnv,
          logger,
        };
        const bundledAgentTools: AtlasTools = Object.assign(
          {},
          ...bundledAgents.map((agent) => createAgentTool(agent, agentToolDeps)),
        );

        const primaryTools: AtlasTools = {
          ...bundledAgentTools,
          ...connectServiceTool,
          ...jobTools,
          ...artifactTools,
          ...resourceTools,
          ...createMemorySaveTool(workspaceId, logger),
          ...webFetchTool,
          ...webSearchTool,
          ...runCodeTool,
          ...fileIOTools,
          ...createWorkspaceOpsTools(logger),
          ...createBoundWorkspaceOpsTools(logger, workspaceId),
          ...createBoundDraftTools(logger, workspaceId),
          ...createBoundUpsertTools(logger, workspaceId),
          ...listMcpServersTool,
          ...searchMcpServersTool,
          ...installMcpServerTool,
          ...createMcpServerTool,
          ...mcpDependenciesTool,
          ...enableMcpServerTool,
          ...disableMcpServerTool,
          ...listMcpToolsTool,
          delegate: delegateTool,
          load_skill: loadSkillTool,
        };

        // Build foreground job tools and compose with primary (primary wins on name conflict)
        const foregroundToolSets = foregrounds.map((fg) => ({
          workspaceId: fg.workspaceId,
          tools: createJobTools(
            fg.workspaceId,
            fg.config?.jobs ?? {},
            fg.config?.signals ?? {},
            logger,
            session.streamId,
            writer,
            abortSignal,
          ),
        }));
        const allTools = composeTools(primaryTools, foregroundToolSets);
        allToolsRef = allTools;

        // Build resource section for system prompt
        const resourceSectionParts: string[] = [];

        if (hasDocuments) {
          resourceSectionParts.push(`<resources>
Use resource_read/resource_write for direct document operations — faster than delegate or job tools.
For external services, use the matching \`agent_*\` specialist or \`delegate\`. For artifact data, use artifacts_get.
</resources>`);
        }

        const resourceGuidance = buildResourceGuidance(mergedResources, {
          availableTools: RESOURCE_CHAT_TOOL_NAMES,
        });
        if (resourceGuidance) {
          resourceSectionParts.push(resourceGuidance);
        }

        if (workspaceDetails.orphanedArtifacts.length > 0) {
          const orphanLines = workspaceDetails.orphanedArtifacts.map(
            (a) => `- ${a.id} (${a.type}): ${a.title} - ${a.summary}`,
          );
          resourceSectionParts.push(`Files (access via artifacts_get):\n${orphanLines.join("\n")}`);
        }

        if (hasDocuments) {
          try {
            const skillText = await resourceAdapter.getSkill(RESOURCE_CHAT_TOOL_NAMES);
            if (skillText) {
              resourceSectionParts.push(skillText);
            }
          } catch (err) {
            logger.warn("Failed to fetch resource skill text", { error: err });
          }
        }

        const resourceSection =
          resourceSectionParts.length > 0 ? resourceSectionParts.join("\n\n") : undefined;

        // Compose memory blocks from primary + foreground workspaces (always load primary)
        const memoryBlocks = await composeMemoryBlocks(workspaceId, foregroundIds, logger);
        const memorySection = memoryBlocks.length > 0 ? memoryBlocks.join("\n\n") : undefined;

        const onboardingClause = buildOnboardingClause(profileState);
        const userProfileClause = buildUserProfileClause(profileState);

        const systemPrompt = getSystemPrompt(workspaceSection, {
          integrations: integrationsSection,
          skills: skillsSection,
          userIdentity: userIdentitySection,
          resources: resourceSection,
          memory: memorySection,
          onboarding: onboardingClause,
          userProfile: userProfileClause,
        });

        const datetimeMessage = buildTemporalFacts(session.datetime);

        // Capture system prompt context on first turn (fire-and-forget)
        if (messages.length <= 1 && session.streamId) {
          ChatStorage.setSystemPromptContext(
            session.streamId,
            { systemMessages: [systemPrompt, datetimeMessage] },
            workspaceId,
          ).catch((err: unknown) =>
            logger.warn("Failed to capture system prompt context", { error: err }),
          );
        }

        logger.debug("Workspace chat context prepared", {
          workspaceId,
          workspaceName: workspaceDetails.name,
          agentCount: workspaceDetails.agents.length,
          jobCount: workspaceDetails.jobs.length,
          signalCount: workspaceDetails.signals.length,
          resourceCount: workspaceDetails.resourceEntries.length,
          integrations: linkSummary ? linkSummary.credentials.length : "unavailable",
          userIdentity: userIdentitySection ? "available" : "unavailable",
        });

        let errorEmitted = false;

        const conversationalModel = platformModels.get("conversational");
        // Drop cross-model assistant messages that carry reasoning parts.
        //
        // Two providers fail in opposite ways when replayed across model
        // boundaries:
        //   - Groq (llama-3.3): rejects any `reasoning` in input with HTTP 400
        //     "reasoning is not supported with this model".
        //   - OpenAI Responses API (gpt-5*, o*): server-side msg/rs ID pairs
        //     are co-dependent; stripping the reasoning part alone leaves
        //     the message half of the pair orphaned, yielding
        //     "Item 'msg_xxx' ... was provided without its required
        //     'reasoning' item: 'rs_xxx'".
        //
        // The only replay shape every provider tolerates is "message not
        // present at all", so we drop the whole turn rather than trying to
        // surgically edit a multi-provider-incompatible shape. Same-model
        // replays keep reasoning intact (tagged via MessageMetadata.provider
        // + modelId on the originating turn). Untagged messages are treated
        // as "unknown origin" — if they contain reasoning, drop them too.
        const sanitizedMessages = messages.filter((m) => {
          if (m.role !== "assistant") return true;
          const fromSameModel =
            m.metadata?.provider === conversationalModel.provider &&
            m.metadata?.modelId === conversationalModel.modelId;
          if (fromSameModel) return true;
          const hasReasoning = m.parts.some((p) => p.type === "reasoning");
          return !hasReasoning;
        });

        try {
          const result = streamText({
            model: conversationalModel,
            experimental_repairToolCall: repairToolCall,
            messages: [
              { role: ROLE_SYSTEM, content: systemPrompt },
              { role: ROLE_SYSTEM, content: datetimeMessage },
              ...(await convertToModelMessages(sanitizedMessages)),
            ],
            tools: allTools,
            toolChoice: "auto",
            stopWhen: [stepCountIs(40), connectServiceSucceeded()],
            maxOutputTokens: 20000,
            experimental_transform: smoothStream({ chunking: "word" }),
            maxRetries: 3,
            abortSignal,
            providerOptions: getDefaultProviderOpts("anthropic"),
            onFinish: ({ text }) => {
              finalText = text;
            },
            onError: ({ error }) => {
              if (!error) return;

              logger.error("Stream error in workspace-chat agent", { error });

              const errorCause = createErrorCause(error);
              const displayMessage = getErrorDisplayMessage(errorCause);

              if (stream && !errorEmitted) {
                writer.write({
                  id: crypto.randomUUID(),
                  type: "data-error",
                  data: { error: displayMessage, errorCause },
                });
                errorEmitted = true;
              }
            },
          });

          // Start piping the UI message stream
          let startTimestamp: string | undefined;
          let endTimestamp: string | undefined;

          writer.merge(
            result.toUIMessageStream({
              originalMessages: messages,
              messageMetadata: (metadata) => {
                if (!startTimestamp) {
                  startTimestamp = new Date().toISOString();
                }
                if (metadata.part.type === "finish") {
                  endTimestamp = new Date().toISOString();
                }
                return {
                  startTimestamp,
                  endTimestamp,
                  provider: conversationalModel.provider,
                  modelId: conversationalModel.modelId,
                  agentId: "workspace-chat",
                };
              },
            }),
          );
        } catch (error) {
          const errorCause = createErrorCause(error);
          const displayMessage = getErrorDisplayMessage(errorCause);

          logger.error("Workspace chat agent failed", { error, errorCause, displayMessage });

          if (stream && !errorEmitted) {
            writer.write({
              id: crypto.randomUUID(),
              type: "data-error",
              data: { error: displayMessage, errorCause },
            });
          }
        }
      },
    });

    try {
      await pipeUIMessageStream(persistStreamMessage, stream).catch((pipeError) => {
        logger.error("pipeUIMessageStream failed", { error: pipeError });
        throw pipeError;
      });
    } finally {
      cleanupSkills?.();
    }

    return ok({ text: finalText });
  },
  environment: {
    required: [],
    optional: [{ name: "FRIDAY_DAEMON_URL", description: "Platform MCP server URL" }],
  },
});
