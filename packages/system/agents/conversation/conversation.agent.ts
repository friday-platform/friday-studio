import process from "node:process";
import type {
  AgentContext,
  AtlasTools,
  AtlasUIMessage,
  AtlasUIMessageChunk,
  StreamEmitter,
} from "@atlas/agent-sdk";
import { createAgent, ok, repairToolCall, validateAtlasUIMessages } from "@atlas/agent-sdk";
import { pipeUIMessageStream } from "@atlas/agent-sdk/vercel-helpers";
import { client, parseResult } from "@atlas/client/v2";
import { OutlineRefsResultSchema } from "@atlas/core";
import { ChatStorage } from "@atlas/core/chat/storage";
import { createErrorCause, getErrorDisplayMessage, parseAPICallError } from "@atlas/core/errors";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import { getMCPRegistryAdapter } from "@atlas/core/mcp-registry/storage";
import {
  buildTemporalFacts,
  getDefaultProviderOpts,
  registry,
  smallLLM,
  traceModel,
} from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import type { SkillSummary } from "@atlas/skills";
import { createLoadSkillTool, SkillStorage } from "@atlas/skills";
import {
  createUIMessageStream,
  hasToolCall,
  jsonSchema,
  type StopCondition,
  smoothStream,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { z } from "zod";
import { fsmWorkspaceCreatorAgent } from "../fsm-workspace-creator/mod.ts";
import { skillDistillerAgent } from "../skill-distiller/skill-distiller.agent.ts";
import {
  WorkspacePlannerSuccessDataSchema,
  workspacePlannerAgent,
} from "../workspace-planner/workspace-planner.agent.ts";
import { getCapabilitiesSection } from "./capabilities.ts";
import { fetchLinkSummary, formatIntegrationsSection } from "./link-context.ts";
import { estimateTokens, processMessageHistory } from "./message-windowing.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { wrapToolsWithSessionContext } from "./session-context.ts";
import { skills } from "./skills/index.ts";
import { workspaceCreationComplete } from "./stop-conditions.ts";
import { createConnectServiceTool } from "./tools/connect-service.ts";
import { createDoTaskTool } from "./tools/do-task/index.ts";
import { conversationTools } from "./tools/mod.ts";
import { fetchScratchpadContext } from "./tools/scratchpad-tools.ts";
import { fetchUserIdentitySection } from "./user-identity.ts";

const ROLE_SYSTEM = "system" as const;

/**
 * Output type for conversation agent - the text response from the LLM
 */
interface ConversationResult {
  text: string | undefined;
}

/**
 * Fetch all workspaces, jobs, and signals from the daemon
 */
async function fetchWorkspaceContext(
  logger: Logger,
): Promise<{
  workspaces: Array<{ id: string; name: string; description?: string }>;
  jobsByWorkspace: Map<string, string[]>;
  signalsByWorkspace: Map<string, string[]>;
}> {
  const workspaces: Array<{ id: string; name: string; description?: string }> = [];
  const jobsByWorkspace = new Map<string, string[]>();
  const signalsByWorkspace = new Map<string, string[]>();

  // Fetch workspaces
  const workspacesResult = await parseResult(client.workspace.index.$get());
  if (!workspacesResult.ok) {
    logger.error("Failed to fetch workspaces for prompt injection", {
      error: workspacesResult.error,
    });
    return { workspaces, jobsByWorkspace, signalsByWorkspace };
  }

  // For each workspace, fetch its jobs and signals
  for (const ws of workspacesResult.data) {
    workspaces.push({ id: ws.id, name: ws.name, description: ws.description });

    const jobsResult = await parseResult(
      client.workspace[":workspaceId"].jobs.$get({ param: { workspaceId: ws.id } }),
    );
    if (jobsResult.ok) {
      jobsByWorkspace.set(
        ws.id,
        jobsResult.data.map((j) => j.name),
      );
    } else {
      logger.warn("Failed to fetch jobs for workspace", {
        workspaceId: ws.id,
        error: jobsResult.error,
      });
      jobsByWorkspace.set(ws.id, []);
    }

    // Fetch signals for this workspace
    const signalsResult = await parseResult(
      client.workspace[":workspaceId"].signals.$get({ param: { workspaceId: ws.id } }),
    );
    if (signalsResult.ok) {
      signalsByWorkspace.set(
        ws.id,
        signalsResult.data.signals.map((s) => s.name),
      );
    } else {
      logger.warn("Failed to fetch signals for workspace", {
        workspaceId: ws.id,
        error: signalsResult.error,
      });
      signalsByWorkspace.set(ws.id, []);
    }
  }

  return { workspaces, jobsByWorkspace, signalsByWorkspace };
}

/**
 * Format workspaces, jobs, and signals as structured prompt section
 */
function formatWorkspacesAndJobsSection(
  workspaces: Array<{ id: string; name: string; description?: string }>,
  jobsByWorkspace: Map<string, string[]>,
  signalsByWorkspace: Map<string, string[]>,
): string {
  if (workspaces.length === 0) {
    return `<available_workspaces>
No workspaces currently available.
</available_workspaces>`;
  }

  let section = `<available_workspaces>
`;

  for (const ws of workspaces) {
    section += `## ${ws.name} (${ws.id})\n`;
    if (ws.description) {
      section += `${ws.description}\n`;
    }

    const jobs = jobsByWorkspace.get(ws.id) || [];
    if (jobs.length > 0) {
      section += `Jobs: ${jobs.join(", ")}\n`;
    }

    const signals = signalsByWorkspace.get(ws.id) || [];
    if (signals.length > 0) {
      section += `Signals: ${signals.join(", ")}\n`;
    }
    section += "\n";
  }

  section += `Use workspace_describe and workspace_jobs_describe for detailed information.
</available_workspaces>`;
  return section;
}

/**
 * Format available agents as structured prompt section
 */
function formatAgentsSection(agents: string[]): string {
  if (agents.length === 0) {
    return `<available_agents>
No agents currently available.
</available_agents>`;
  }

  return `<available_agents>
${agents.join(", ")}
</available_agents>`;
}

/**
 * Build combined skills section from hardcoded and workspace skills.
 * Returns empty string if no skills available.
 */
function buildSkillsSection(
  hardcodedSkills: typeof skills,
  workspaceSkills: SkillSummary[],
): string {
  const hardcodedEntries = hardcodedSkills.map(
    (s) => `<skill name="${s.id}">${s.description}</skill>`,
  );
  const workspaceEntries = workspaceSkills.map(
    (s) => `<skill name="@${s.namespace}/${s.name}">${s.description}</skill>`,
  );

  const allEntries = [...hardcodedEntries, ...workspaceEntries];

  if (allEntries.length === 0) return "";

  return `<available_skills>
<instruction>Load skills with load_skill when task matches.</instruction>
${allEntries.join("\n")}
</available_skills>`;
}

/**
 * Build system prompt with optional context sections.
 *
 * Sections are appended in order:
 * 1. Base prompt (from prompt.txt)
 * 2. Stream ID (if present)
 * 3. Workspaces
 * 4. Agents
 * 5. Integrations
 * 6. Skills
 * 7. Supported domains
 * 8. User identity (if present)
 */
function getSystemPrompt(
  streamId?: string,
  workspacesSection?: string,
  agentsSection?: string,
  integrationsSection?: string,
  skillsSection?: string,
  capabilitiesSection?: string,
  userIdentitySection?: string,
): string {
  let prompt = SYSTEM_PROMPT;

  // Add critical streamId instruction for signal triggers
  if (streamId) {
    prompt = `${prompt}
      CRITICAL: Stream ID is ${streamId}. Include this parameter when streamId is available as a parameter in tools.
    `;
  }

  // Inject workspaces and jobs section at the end
  if (workspacesSection) {
    prompt = `${prompt}\n\n${workspacesSection}`;
  }

  // Inject agents section at the end
  if (agentsSection) {
    prompt = `${prompt}\n\n${agentsSection}`;
  }

  // Inject integrations section at the end
  if (integrationsSection) {
    prompt = `${prompt}\n\n${integrationsSection}`;
  }

  if (skillsSection) {
    prompt = `${prompt}\n\n${skillsSection}`;
  }

  if (capabilitiesSection) {
    prompt = `${prompt}\n\n${capabilitiesSection}`;
  }

  // User identity at end - context about who is being served
  if (userIdentitySection) {
    prompt = `${prompt}\n\n${userIdentitySection}`;
  }

  return prompt;
}

/**
 * Generates a concise 3-5 word title for a conversation based on its messages.
 */
async function generateChatTitle(messages: AtlasUIMessage[], logger: Logger): Promise<string> {
  const messagePreview = messages
    .map((m) => `${m.role}: ${JSON.stringify(m.parts.filter((p) => p.type === "text"))}`)
    .join("\n");

  try {
    return await smallLLM({
      system:
        "You generate concise 2-3 word titles for conversations. Only output the title, nothing else.",
      prompt: `Generate a title for this conversation:\n${messagePreview}`,
      maxOutputTokens: 50,
    });
  } catch (error) {
    logger.error("Failed to generate chat title", { error });
    return "Saved Chat";
  }
}

/**
 * Create a StreamEmitter that bridges agent progress events to the conversation writer.
 * Agents emit data-tool-progress events; the writer forwards them to the UI stream.
 */
function createAgentStreamEmitter(writer: {
  write: (chunk: AtlasUIMessageChunk) => void;
}): StreamEmitter {
  return {
    emit: (event) => {
      try {
        writer.write(event);
      } catch {
        // Writer may be closed — swallow errors from progress events
      }
    },
    end: () => {},
    error: () => {},
  };
}

/**
 * Build a synthesized AgentContext from the conversation agent's own context.
 * Used for direct agent invocation (no MCP round-trip).
 */
function buildAgentContext(
  session: AgentContext["session"],
  logger: Logger,
  stream: StreamEmitter,
  abortSignal?: AbortSignal,
): AgentContext {
  return { tools: {}, session, env: {}, stream, logger, abortSignal };
}

// Export the agent
export const conversationAgent = createAgent<string, ConversationResult>({
  id: "conversation",
  displayName: "Conversation Agent",
  version: "1.0.0",
  description: "Interactive conversation agent for workspace collaboration",
  // Expose /agents endpoint as an MCP server for tool access

  expertise: { examples: [] },
  useWorkspaceSkills: true,

  /**
   * NOTE: prompt param is unused — message history is loaded from chat DB instead.
   */
  handler: async (_, { session, logger, tools, stream, abortSignal, telemetry }) => {
    if (!session.streamId) {
      throw new Error("Stream ID is required");
    }
    // Load and validate chat history
    let messages: AtlasUIMessage[] = [];
    let contentFilteredMessageIds: string[] = [];
    const res = await parseResult(
      client.chat[":chatId"].$get({ param: { chatId: session.streamId } }),
    );
    if (res.ok) {
      messages = await validateAtlasUIMessages(res.data.messages);

      // Exclude content-filtered messages from LLM context (auto-recovery).
      // Field exists on StoredChatSchema but Hono client type inference doesn't propagate it.
      const filteredIds = z
        .object({ contentFilteredMessageIds: z.array(z.string()).optional() })
        .safeParse(res.data.chat).data?.contentFilteredMessageIds;
      if (filteredIds && filteredIds.length > 0) {
        contentFilteredMessageIds = filteredIds;
        const filteredSet = new Set(filteredIds);
        messages = messages.filter((m) => !filteredSet.has(m.id));
        logger.info("Excluded content-filtered messages from context", {
          excludedCount: filteredIds.length,
          remainingCount: messages.length,
        });
      }
    } else {
      logger.error("Failed to load chat history", { error: res.error });
    }

    // Store the original error if streamText fails
    let originalStreamError: unknown = null;
    let interceptedApiError: unknown = null;
    let finalText: string | undefined;
    let finalFinishReason: string | undefined;
    let cleanupSkills: (() => Promise<void>) | undefined;

    const persistStreamMessage = createUIMessageStream<AtlasUIMessage>({
      originalMessages: messages,
      onFinish: async ({ messages }) => {
        if (!session.streamId) {
          throw new Error("Stream ID is missing");
        }
        /**
         * On the first two turns of the conversation, generate a title for the chat.
         * This should give a title if the user starts with a filler message like "Hey" but
         * also then further refine it based on the next turn, which should be more meaningful.
         */
        if (messages.length === 2 || messages.length === 4) {
          const title = await generateChatTitle(messages, logger);
          const titleResult = await parseResult(
            client.chat[":chatId"].title.$patch({
              param: { chatId: session.streamId },
              json: { title },
            }),
          );

          if (!titleResult.ok) {
            logger.error("Failed to update chat title", { streamId: session.streamId, title });
          }
        }

        // Store the assistant message to chat storage
        // Get the last message which should be the assistant's response
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === "assistant") {
          // Don't persist empty messages from content-filter responses.
          // Storing these corrupts the conversation: step-start-only messages
          // produce zero model messages during conversion, creating consecutive
          // user messages that violate the API's alternating role requirement.
          const hasText = lastMessage.parts.some(
            (p) => p.type === "text" && p.text.trim().length > 0,
          );
          if (finalFinishReason === "content-filter" && !hasText) {
            logger.warn("Skipping storage of empty content-filtered message", {
              streamId: session.streamId,
              messageId: lastMessage.id,
              finishReason: finalFinishReason,
            });
          } else {
            const appendResult = await parseResult(
              client.chat[":chatId"].message.$post({
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
        }
      },
      execute: async ({ writer }) => {
        if (!session.streamId) {
          throw new Error("Stream ID is required");
        }

        // Session context for tool injection (datetime enables timezone-aware operations)
        const sessionContext = {
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          userId: session.userId,
          streamId: session.streamId,
          datetime: session.datetime,
        };

        /**
         * Register workspace-planner and fsm-workspace-creator as static tools.
         * Direct invocation via .execute() — no MCP round-trip.
         */
        const agentStream = createAgentStreamEmitter(writer);
        const agentContext = buildAgentContext(session, logger, agentStream, abortSignal);

        const systemAgents: AtlasTools = {
          "workspace-planner": tool({
            description: workspacePlannerAgent.metadata.description,
            inputSchema: jsonSchema<{ intent: string; artifactId?: string }>({
              type: "object",
              properties: {
                intent: {
                  type: "string",
                  description: "Workspace requirements or modification request",
                },
                artifactId: {
                  type: "string",
                  description: "Artifact ID to update (omit for new plans)",
                },
              },
              required: ["intent"],
            }),
            execute: ({ intent, artifactId }) => {
              logger.debug("Executing workspace-planner directly", { intent, artifactId });
              return workspacePlannerAgent.execute({ intent, artifactId }, agentContext);
            },
          }),
          "fsm-workspace-creator": tool({
            description: fsmWorkspaceCreatorAgent.metadata.description,
            inputSchema: jsonSchema<{ artifactId: string; workspacePath?: string }>({
              type: "object",
              properties: {
                artifactId: { type: "string", description: "WorkspacePlan artifact ID" },
                workspacePath: { type: "string", description: "Path to workspace directory" },
              },
              required: ["artifactId"],
            }),
            execute: ({ artifactId, workspacePath }) => {
              logger.debug("Executing fsm-workspace-creator directly", {
                artifactId,
                workspacePath,
              });
              return fsmWorkspaceCreatorAgent.execute({ artifactId, workspacePath }, agentContext);
            },
          }),
          "skill-distiller": tool({
            description: skillDistillerAgent.metadata.description,
            inputSchema: jsonSchema<{
              artifactIds: string[];
              namespace?: string;
              name?: string;
              focus?: string;
              draftArtifactId?: string;
            }>({
              type: "object",
              properties: {
                artifactIds: {
                  type: "array",
                  items: { type: "string" },
                  description: "Artifact IDs containing corpus material",
                },
                namespace: {
                  type: "string",
                  description: "Target namespace for the skill (falls back to 'atlas')",
                },
                name: { type: "string", description: "Suggested skill name" },
                focus: { type: "string", description: "What aspect to emphasize" },
                draftArtifactId: { type: "string", description: "Existing draft to revise" },
              },
              required: ["artifactIds"],
            }),
            execute: (input) => {
              logger.debug("Executing skill-distiller directly", {
                artifactCount: input.artifactIds.length,
                namespace: input.namespace,
              });
              return skillDistillerAgent.execute(input, agentContext);
            },
          }),
        };

        // Track system agent names for prompt injection
        const agentNames = Object.keys(systemAgents);

        // Parallel fetch of startup context
        logger.info("Fetching startup context for prompt injection");
        const [
          { workspaces, jobsByWorkspace, signalsByWorkspace },
          linkSummary,
          userIdentitySection,
          dynamicServers,
        ] = await Promise.all([
          fetchWorkspaceContext(logger),
          fetchLinkSummary(logger),
          fetchUserIdentitySection(logger),
          getMCPRegistryAdapter()
            .then((adapter) => adapter.list())
            .catch((error): MCPServerMetadata[] => {
              logger.warn("Failed to load dynamic MCP servers for capabilities section", {
                error: error instanceof Error ? error.message : String(error),
              });
              return [];
            }),
        ]);

        // Format sections from fetched data
        const workspacesSection = formatWorkspacesAndJobsSection(
          workspaces,
          jobsByWorkspace,
          signalsByWorkspace,
        );
        const agentsSection = formatAgentsSection(agentNames);
        const integrationsSection = linkSummary
          ? formatIntegrationsSection(linkSummary)
          : undefined;

        // Generate capabilities section from bundled agents + MCP registry + dynamic servers
        const capabilitiesSection = getCapabilitiesSection(dynamicServers);

        // Create link auth tool if Link is available with provider-constrained enum
        const connectServiceTool: AtlasTools = {};
        if (linkSummary && linkSummary.providers.length > 0) {
          const providerIds = linkSummary.providers.map((p) => p.id);
          connectServiceTool.connect_service = createConnectServiceTool(providerIds);
        }

        // Emit outline for newly connected credential (last user message only)
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        if (lastUserMsg) {
          const CredentialLinkedSchema = z.object({
            provider: z.string(),
            displayName: z.string(),
          });
          for (const part of lastUserMsg.parts) {
            if (part.type === "data-credential-linked") {
              const parsed = CredentialLinkedSchema.safeParse(part.data);

              if (parsed.success) {
                const credential = linkSummary?.credentials.find(
                  (c) => c.provider === parsed.data.provider,
                );

                writer.write({
                  type: "data-outline-update",
                  data: {
                    id: parsed.data.provider,
                    title: `${parsed.data.displayName} Access Provided`,
                    timestamp: Date.now(),
                    content: credential?.label || undefined,
                  },
                });
              }
            }
          }
        }

        logger.debug("Startup context sections prepared", {
          workspaceCount: workspaces.length,
          agentCount: agentNames.length,
          integrations: linkSummary ? linkSummary.credentials.length : "unavailable",
          providers: linkSummary ? linkSummary.providers.length : "unavailable",
          providerIds: linkSummary ? linkSummary.providers.map((p) => p.id) : "unavailable",
          userIdentity: userIdentitySection ? "available" : "unavailable",
        });

        // Platform tool allowlist for the conversation agent.
        // Only these platform tools are exposed; non-platform tools (conversationTools,
        // connectService, systemAgents, do_task, load_skill) are added separately below.
        //
        // Keep in sync with:
        // - packages/mcp-server/src/tools/index.ts (canonical tool registration)
        // - packages/core/src/agent-conversion/agent-tool-filters.ts (LLM agent allowlist)
        // - packages/fsm-engine/mcp-tool-context.ts (FSM engine allowlist)
        const ALLOWED_TOOLS = new Set([
          // Workspace management
          "workspace_list",
          "workspace_describe",
          "workspace_delete",
          // Session/job inspection
          "session_describe",
          "session_cancel",
          "workspace_jobs_list",
          "workspace_jobs_describe",
          // Signal triggering
          "workspace_signal_trigger",
          "workspace_signals_list",
          // Library
          "library_list",
          "library_get",
          // Artifacts
          "artifacts_create",
          "artifacts_update",
          "artifacts_get",
          "artifacts_get_by_chat",
          // System
          "system_version",
          // connect_mcp_server is a conversationTool, not a platform tool — added via ...conversationTools below
        ]);

        // Wrap platform tools to inject session context (datetime for timezone-aware operations)
        const filteredTools = wrapToolsWithSessionContext(tools, sessionContext, ALLOWED_TOOLS);

        const workspaceId = session.workspaceId || "atlas-conversation";

        const globalSkillsResult = await SkillStorage.list();
        const globalSkills = globalSkillsResult.ok ? globalSkillsResult.data : [];
        const skillsSection = buildSkillsSection(skills, globalSkills);

        const doTaskTool = createDoTaskTool(
          writer,
          {
            sessionId: session.sessionId || `session-${Date.now()}`,
            workspaceId,
            streamId: session.streamId,
            userId: session.userId,
            daemonUrl: getAtlasDaemonUrl(),
            datetime: session.datetime,
          },
          logger,
          abortSignal,
        );

        const loadSkillResult = createLoadSkillTool({ hardcodedSkills: skills });
        const loadSkillTool = loadSkillResult.tool;
        cleanupSkills = loadSkillResult.cleanup;

        const allTools = {
          ...filteredTools,
          ...conversationTools,
          ...connectServiceTool,
          ...systemAgents,
          do_task: doTaskTool,
          load_skill: loadSkillTool,
        };

        /**
         * Stop condition for workspace-planner: only stop if it succeeds.
         * Does NOT stop when workspace-planner fails (allows retry).
         */
        const workspacePlannerSucceeded =
          (): StopCondition<typeof allTools> =>
          ({ steps }) => {
            for (const step of steps) {
              for (const toolResult of step.toolResults) {
                if (toolResult.toolName === "workspace-planner") {
                  // Direct invocation returns AgentPayload: { ok: true, data: ... }
                  try {
                    const result = z
                      .object({
                        output: z.object({
                          ok: z.literal(true),
                          data: WorkspacePlannerSuccessDataSchema,
                        }),
                      })
                      .parse(toolResult);

                    if (result.output.ok) {
                      return true;
                    }
                  } catch (e) {
                    logger.debug("workspacePlannerSucceeded check failed (expected during retry)", {
                      e,
                    });
                  }
                }
              }
            }
            return false;
          };

        // Load scratchpad context for automatic injection
        const scratchpadContext = await fetchScratchpadContext(
          session.streamId,
          logger,
          100, // Use full default limit for complete context
        );

        // Estimate system prompt tokens to determine message history budget
        const systemPrompt = getSystemPrompt(
          session.streamId,
          workspacesSection,
          agentsSection,
          integrationsSection,
          skillsSection,
          capabilitiesSection,
          userIdentitySection,
        );

        const datetimeMessage = buildTemporalFacts(session.datetime);

        // Capture system prompt context on first turn (fire-and-forget)
        // Must happen after datetimeMessage is defined to capture actual messages sent to LLM
        if (messages.length <= 1) {
          const systemMessages = [
            systemPrompt, // Already assembled by getSystemPrompt()
            datetimeMessage,
            ...(scratchpadContext ? [scratchpadContext] : []),
          ];
          if (session.streamId) {
            ChatStorage.setSystemPromptContext(session.streamId, { systemMessages }).catch(
              (err: unknown) =>
                logger.warn("Failed to capture system prompt context", { error: err }),
            );
          }
        }
        const systemTokens =
          estimateTokens(systemPrompt) + // Already includes workspacesSection + agentsSection + integrationsSection
          estimateTokens(scratchpadContext) +
          estimateTokens(datetimeMessage);

        // Calculate dynamic message budget based on actual system context
        const MODEL_CONTEXT_LIMIT = 131_072;
        const OUTPUT_RESERVE = 20_000; // Reserve for assistant response with extended thinking
        const SAFETY_BUFFER = 10_000; // Margin for token estimation error

        const dynamicMessageBudget =
          MODEL_CONTEXT_LIMIT - systemTokens - OUTPUT_RESERVE - SAFETY_BUFFER;

        logger.debug("Dynamic token budget allocation", {
          modelLimit: MODEL_CONTEXT_LIMIT,
          systemTokens,
          outputReserve: OUTPUT_RESERVE,
          safetyBuffer: SAFETY_BUFFER,
          messagesBudget: dynamicMessageBudget,
          budgetPercentage: ((dynamicMessageBudget / MODEL_CONTEXT_LIMIT) * 100).toFixed(1),
        });

        // Truncate message history to fit within dynamically calculated budget
        const prunedModelMessages = await processMessageHistory(
          messages,
          { maxTokens: dynamicMessageBudget },
          logger,
        );

        logger.debug("Processed message history", {
          originalCount: messages.length,
          finalCount: prunedModelMessages.length,
          removedMessages: messages.length - prunedModelMessages.length,
        });

        let result: Awaited<ReturnType<typeof streamText<typeof allTools>>>;
        let errorEmitted = false;

        // Set up unhandled rejection interceptor to catch API errors that escape the SDK
        // This is necessary because Vercel AI SDK doesn't properly propagate auth errors in streaming mode
        const unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
          const error = event.reason;
          // Check if this is an API error from the AI SDK
          const apiError = parseAPICallError(error);
          if (apiError) {
            logger.error("Intercepted AI SDK API error", {
              error: apiError,
              statusCode: apiError.statusCode,
              name: apiError.constructor?.name,
            });
            interceptedApiError = apiError;
            // Prevent default logging to console
            event.preventDefault();
          }
        };

        // Add the handler before starting the stream
        globalThis.addEventListener("unhandledrejection", unhandledRejectionHandler);

        // Also try to catch process-level unhandled rejections (Node.js style)
        const processHandler = (reason: unknown) => {
          const apiError = parseAPICallError(reason);
          if (apiError) {
            logger.error("Process caught AI SDK API error", {
              error: apiError,
              statusCode: apiError.statusCode,
            });
            interceptedApiError = apiError;
          }
        };

        if (process?.on) {
          process.on("unhandledRejection", processHandler);
        }

        try {
          try {
            result = streamText({
              model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
              experimental_repairToolCall: repairToolCall,
              messages: [
                {
                  role: ROLE_SYSTEM,
                  content: getSystemPrompt(
                    session.streamId,
                    workspacesSection,
                    agentsSection,
                    integrationsSection,
                    skillsSection,
                    capabilitiesSection,
                    userIdentitySection,
                  ),
                },
                { role: ROLE_SYSTEM, content: buildTemporalFacts(session.datetime) },
                // Add scratchpad context as third system message if it exists
                ...(scratchpadContext ? [{ role: ROLE_SYSTEM, content: scratchpadContext }] : []),
                // Notify model about excluded content-filtered messages
                ...(contentFilteredMessageIds.length > 0
                  ? [
                      {
                        role: ROLE_SYSTEM,
                        content:
                          "Note: One or more earlier messages were excluded from this conversation because they triggered a content safety filter. If the user asks about missing context, explain that some messages were filtered and suggest they rephrase or re-share the information.",
                      },
                    ]
                  : []),
                ...prunedModelMessages,
              ],
              tools: allTools,
              toolChoice: "auto",
              stopWhen: [
                stepCountIs(40),
                hasToolCall("connect_service"),
                workspacePlannerSucceeded(),
                // @ts-expect-error StopCondition<AtlasTools> is contravariant - allTools has specific keys
                // but AtlasTools is Record<string, AtlasTool>. Using StopCondition<any> like AI SDK's
                // hasToolCall would fix this, but we'd lose the (minimal) type safety on step.toolResults.
                workspaceCreationComplete(),
              ],
              maxOutputTokens: 20000,
              experimental_transform: smoothStream({ chunking: "word" }),
              maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
              abortSignal, // Pass the abort signal for cancellation
              providerOptions: getDefaultProviderOpts("anthropic"),
              experimental_context: { conversationSessionId: session.sessionId },
              // Pass telemetry config if provided in context
              experimental_telemetry: telemetry ? { isEnabled: true, ...telemetry } : undefined,
              onChunk: ({ chunk }) => {
                // Handle outline refs from tool results
                if (chunk.type === "tool-result" && "result" in chunk) {
                  const parsed = OutlineRefsResultSchema.safeParse(chunk.result);
                  if (parsed.success && parsed.data.outlineRefs) {
                    for (const ref of parsed.data.outlineRefs) {
                      writer.write({
                        type: "data-outline-update",
                        data: {
                          id: ref.service,
                          title: ref.title,
                          timestamp: Date.now(),
                          content: ref.content,
                          artifactId: ref.artifactId,
                          artifactLabel: ref.artifactLabel,
                        },
                      });
                    }
                  }
                }
                // Emit intent before tool execution
                if (chunk.type === "tool-input-start") {
                  if (chunk.toolName === "connect_service") {
                    writer.write({ type: "data-intent", data: { content: "Requesting Access" } });
                  } else if (chunk.toolName === "workspace-planner") {
                    writer.write({ type: "data-intent", data: { content: "Creating plan" } });
                  }
                }
              },
              onFinish: ({ text, finishReason }) => {
                finalText = text;
                finalFinishReason = finishReason;

                if (finishReason === "content-filter") {
                  logger.warn("Content filter triggered", {
                    streamId: session.streamId,
                    finishReason,
                  });

                  writer.write({
                    id: crypto.randomUUID(),
                    type: "data-error",
                    data: {
                      error:
                        "The response was blocked by a content safety filter. This can happen when processing certain document content. Try rephrasing your request or starting a new conversation.",
                      errorCause: "content-filter",
                    },
                  });

                  // Mark the last user message as content-filtered for auto-recovery.
                  // On subsequent turns, this message will be excluded from LLM context,
                  // breaking the loop where problematic content gets resent every turn.
                  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
                  if (lastUserMsg && session.streamId) {
                    ChatStorage.addContentFilteredMessageIds(session.streamId, [
                      lastUserMsg.id,
                    ]).catch((err: unknown) =>
                      logger.warn("Failed to mark content-filtered message", { error: err }),
                    );
                    logger.info("Marked message as content-filtered", {
                      messageId: lastUserMsg.id,
                      streamId: session.streamId,
                    });
                  }
                }
              },
              onError: ({ error }) => {
                if (!error) {
                  return;
                }

                logger.error("Stream chunk error in conversation agent", { error });
                originalStreamError = originalStreamError ?? error;

                const apiError = parseAPICallError(error);
                if (apiError) {
                  interceptedApiError = apiError;
                }

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
          } catch (streamTextError) {
            // Catch synchronous errors from streamText (e.g., immediate API errors)
            const apiError = parseAPICallError(streamTextError);
            logger.error("Caught synchronous error from streamText", {
              error: streamTextError,
              statusCode: apiError?.statusCode,
            });

            // Check if it's an API error
            if (apiError) {
              interceptedApiError = apiError;

              // Immediately handle the error
              const errorCause = createErrorCause(apiError);
              const displayMessage = getErrorDisplayMessage(errorCause);

              if (stream && !errorEmitted) {
                writer.write({
                  id: crypto.randomUUID(),
                  type: "data-error",
                  data: { error: displayMessage, errorCause },
                });
                errorEmitted = true;
              }

              // Clean up and return
              globalThis.removeEventListener("unhandledrejection", unhandledRejectionHandler);
            }

            // Re-throw if not an API error
            throw streamTextError;
          }

          // Track start timestamp for this agent invocation (only one assistant message per call)
          let startTimestamp: string | undefined;
          let endTimestamp: string | undefined;

          // Start piping the UI message stream immediately
          // DO NOT consume the stream elsewhere - it's single-consumer only
          writer.merge(
            result.toUIMessageStream({
              originalMessages: messages,
              messageMetadata: (metadata) => {
                // Set startTimestamp once on first chunk, then preserve it
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
          // Handle API errors with user-friendly messages
          // Use the intercepted API error first (actual auth error), then others
          const actualError = interceptedApiError || originalStreamError || error;
          const errorCause = createErrorCause(actualError);
          const displayMessage = getErrorDisplayMessage(errorCause);

          logger.error("Conversation agent failed", {
            error,
            originalError: originalStreamError,
            interceptedApiError: interceptedApiError,
            errorCause,
            displayMessage,
          });

          // Emit error message to stream so user can see it
          if (stream && !errorEmitted) {
            writer.write({
              id: crypto.randomUUID(),
              type: "data-error",
              data: { error: displayMessage, errorCause },
            });
            errorEmitted = true;
          }

          // Return error response instead of throwing
        } finally {
          // Remove the unhandled rejection handler to prevent memory leaks
          globalThis.removeEventListener("unhandledrejection", unhandledRejectionHandler);

          // Clean up process handler if it was added
          if (process?.off) {
            process.off("unhandledRejection", processHandler);
          }
        }
      },
    });

    /**
     * Even though this doesn't return a value, it *must* be awaited otherwise
     * the pipe will break before the LLM has a chance to respond.
     */
    try {
      await pipeUIMessageStream(persistStreamMessage, stream).catch((pipeError) => {
        logger.error("pipeUIMessageStream failed", { error: pipeError });

        const apiError = parseAPICallError(pipeError);
        if (apiError) {
          interceptedApiError = apiError;
        }

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
