import type { AtlasTools, AtlasUIMessage } from "@atlas/agent-sdk";
import { createAgent, ok, repairToolCall, validateAtlasUIMessages } from "@atlas/agent-sdk";
import { pipeUIMessageStream } from "@atlas/agent-sdk/vercel-helpers";
import { client, parseResult } from "@atlas/client/v2";
import type { WorkspaceConfig } from "@atlas/config";
import { ArtifactTypeSchema } from "@atlas/core/artifacts";
import { ArtifactStorage } from "@atlas/core/artifacts/storage";
import { ChatStorage } from "@atlas/core/chat/storage";
import { createErrorCause, getErrorDisplayMessage } from "@atlas/core/errors";
import {
  buildTemporalFacts,
  getDefaultProviderOpts,
  registry,
  smallLLM,
  traceModel,
} from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import type { ResourceEntry } from "@atlas/resources";
import { buildResourceGuidance, createLedgerClient } from "@atlas/resources";
import type { SkillSummary } from "@atlas/skills";
import { createLoadSkillTool, SkillStorage } from "@atlas/skills";
import {
  convertToModelMessages,
  createUIMessageStream,
  smoothStream,
  stepCountIs,
  streamText,
} from "ai";
import { z } from "zod";
import { fetchLinkSummary, formatIntegrationsSection } from "../conversation/link-context.ts";
import { connectServiceSucceeded } from "../conversation/stop-conditions.ts";
import { createConnectServiceTool } from "../conversation/tools/connect-service.ts";
import { fetchUserIdentitySection } from "../conversation/user-identity.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { artifactTools } from "./tools/artifact-tools.ts";
import { createWorkspaceDoTask } from "./tools/do-task.ts";
import { createJobTools } from "./tools/job-tools.ts";
import { createResourceChatTools, RESOURCE_CHAT_TOOL_NAMES } from "./tools/resource-tools.ts";

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

/**
 * Fetch workspace details: config, agents, jobs, signals, resources, artifacts.
 */
async function fetchWorkspaceDetails(
  workspaceId: string,
  logger: Logger,
): Promise<{
  name: string;
  description?: string;
  agents: string[];
  jobs: Array<{ id: string; name: string; description?: string }>;
  signals: Array<{ name: string }>;
  resourceEntries: ResourceEntry[];
  orphanedArtifacts: ArtifactSummary[];
}> {
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
 * Format workspace capabilities as a system prompt section.
 */
export function formatWorkspaceSection(
  workspaceId: string,
  details: Awaited<ReturnType<typeof fetchWorkspaceDetails>>,
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
    section += `\n<signals>${details.signals.map((s) => s.name).join(", ")}</signals>`;
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
  options?: { integrations?: string; skills?: string; userIdentity?: string; resources?: string },
): string {
  let prompt = SYSTEM_PROMPT;

  prompt = `${prompt}\n\n${workspaceSection}`;

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

  return prompt;
}

/**
 * Generates a concise 2-3 word title for a conversation based on its messages.
 */
export async function generateChatTitle(
  messages: AtlasUIMessage[],
  logger: Logger,
): Promise<string> {
  const messagePreview = messages
    .map((m) => `${m.role}: ${JSON.stringify(m.parts.filter((p) => p.type === "text"))}`)
    .join("\n");

  const result = await smallLLM({
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

  handler: async (_, { session, logger, stream, abortSignal }) => {
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
          const title = await generateChatTitle(messages, logger);
          const titleResult = await parseResult(
            client
              .workspaceChat(workspaceId)
              [":chatId"].title.$patch({ param: { chatId: session.streamId }, json: { title } }),
          );
          if (!titleResult.ok) {
            logger.error("Failed to update chat title", { streamId: session.streamId, title });
          }
        }

        // Persist assistant message
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === "assistant") {
          const appendResult = await parseResult(
            client
              .workspaceChat(workspaceId)
              [":chatId"].message.$post({
                param: { chatId: session.streamId },
                json: { message: lastMessage },
              }),
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
        logger.info("Fetching workspace chat startup context", { workspaceId });
        const [workspaceDetails, wsConfigResult, linkSummary, userIdentitySection] =
          await Promise.all([
            fetchWorkspaceDetails(workspaceId, logger),
            parseResult(client.workspace[":workspaceId"].config.$get({ param: { workspaceId } })),
            fetchLinkSummary(logger),
            fetchUserIdentitySection(logger),
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

        // Format sections
        const workspaceSection = formatWorkspaceSection(workspaceId, workspaceDetails);
        const integrationsSection = linkSummary
          ? formatIntegrationsSection(linkSummary)
          : undefined;

        // Skills
        const globalSkillsResult = await SkillStorage.list();
        const globalSkills = globalSkillsResult.ok ? globalSkillsResult.data : [];
        const skillsSection = buildSkillsSection(globalSkills);

        // Connect service tool
        const connectServiceTool: AtlasTools = {};
        if (linkSummary && linkSummary.providers.length > 0) {
          const providerIds = linkSummary.providers.map((p) => p.id);
          connectServiceTool.connect_service = createConnectServiceTool(providerIds);
        }

        // Resource adapter — shared by resource tools and do_task sub-tasks
        const resourceAdapter = createLedgerClient();

        // do_task (workspace-scoped if config available, standard otherwise)
        const doTaskSession = {
          sessionId: session.sessionId || `session-${Date.now()}`,
          workspaceId,
          streamId: session.streamId,
          userId: session.userId,
          daemonUrl: getAtlasDaemonUrl(),
          datetime: session.datetime,
          resourceAdapter,
          artifactStorage: ArtifactStorage,
        };
        const fallbackConfig: WorkspaceConfig = {
          version: "1.0",
          workspace: { name: workspaceDetails.name },
        };
        const doTaskTool = createWorkspaceDoTask(
          wsConfig ?? fallbackConfig,
          writer,
          doTaskSession,
          logger,
          abortSignal,
        );

        // load_skill
        const loadSkillResult = createLoadSkillTool({});
        const loadSkillTool = loadSkillResult.tool;
        cleanupSkills = loadSkillResult.cleanup;

        // Job tools
        const jobTools = createJobTools(
          workspaceId,
          wsConfig?.jobs ?? {},
          wsConfig?.signals ?? {},
          logger,
        );

        // Resource tools — only register when workspace has document resources
        const hasDocuments = workspaceDetails.resourceEntries.some((e) => e.type === "document");
        const resourceTools = hasDocuments
          ? createResourceChatTools(
              resourceAdapter,
              new Map(workspaceDetails.resourceEntries.map((e) => [e.slug, e])),
              workspaceId,
            )
          : {};

        const allTools = {
          ...connectServiceTool,
          ...jobTools,
          ...artifactTools,
          ...resourceTools,
          do_task: doTaskTool,
          load_skill: loadSkillTool,
        };

        // Build resource section for system prompt
        const resourceSectionParts: string[] = [];

        if (hasDocuments) {
          resourceSectionParts.push(`<resources>
Use resource_read/resource_write for direct document operations — faster than do_task or job tools.
For external services, use do_task. For artifact data, use artifacts_get.
</resources>`);
        }

        const resourceGuidance = buildResourceGuidance(workspaceDetails.resourceEntries, {
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

        const systemPrompt = getSystemPrompt(workspaceSection, {
          integrations: integrationsSection,
          skills: skillsSection,
          userIdentity: userIdentitySection,
          resources: resourceSection,
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

        try {
          const result = streamText({
            model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
            experimental_repairToolCall: repairToolCall,
            messages: [
              { role: ROLE_SYSTEM, content: systemPrompt },
              { role: ROLE_SYSTEM, content: datetimeMessage },
              ...(await convertToModelMessages(messages)),
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
                return { ...metadata, startTimestamp, endTimestamp };
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
    optional: [{ name: "ATLAS_DAEMON_URL", description: "Platform MCP server URL" }],
  },
});
