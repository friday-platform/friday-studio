/**
 * Conversation Agent - SDK Architecture Implementation
 *
 * Interactive conversation agent for workspace collaboration with:
 * - Persistent conversation history via daemon storage
 * - Tool execution through MCP server
 * - Real-time streaming responses
 * - Task tracking with todos
 */
import process from "node:process";
import type { AtlasTools, AtlasUIMessage } from "@atlas/agent-sdk";
import { createAgent, repairToolCall, validateAtlasUIMessages } from "@atlas/agent-sdk";
import { pipeUIMessageStream } from "@atlas/agent-sdk/vercel-helpers";
import { client, parseResult } from "@atlas/client/v2";
import { ChatStorage } from "@atlas/core/chat/storage";
import { createErrorCause, getErrorDisplayMessage, parseAPICallError } from "@atlas/core/errors";
import { registry, smallLLM } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createIdGenerator,
  createUIMessageStream,
  hasToolCall,
  jsonSchema,
  smoothStream,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { getCapabilitiesSection } from "./capabilities.ts";
import { fetchLinkSummary, formatIntegrationsSection } from "./link-context.ts";
import { estimateTokens, processMessageHistory } from "./message-windowing.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { formatSkillsSection } from "./skills/index.ts";
import { createConnectServiceTool } from "./tools/connect-service.ts";
import { createDoTaskTool } from "./tools/do-task/index.ts";
import { loadSkillTool } from "./tools/load-skill.ts";
import { conversationTools } from "./tools/mod.ts";
import { fetchScratchpadContext } from "./tools/scratchpad-tools.ts";
import { fetchUserIdentitySection } from "./user-identity.ts";

const ROLE_SYSTEM = "system" as const;

/**
 * Fetch all workspaces and their jobs from the daemon
 */
async function fetchWorkspacesAndJobs(
  logger: Logger,
): Promise<{
  workspaces: Array<{ id: string; name: string; description?: string }>;
  jobsByWorkspace: Map<string, string[]>;
}> {
  const workspaces: Array<{ id: string; name: string; description?: string }> = [];
  const jobsByWorkspace = new Map<string, string[]>();

  // Fetch workspaces
  const workspacesResult = await parseResult(client.workspace.index.$get());
  if (!workspacesResult.ok) {
    logger.error("Failed to fetch workspaces for prompt injection", {
      error: workspacesResult.error,
    });
    return { workspaces, jobsByWorkspace };
  }

  // For each workspace, fetch its jobs
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
  }

  return { workspaces, jobsByWorkspace };
}

/**
 * Format workspaces and jobs as structured prompt section
 */
function formatWorkspacesAndJobsSection(
  workspaces: Array<{ id: string; name: string; description?: string }>,
  jobsByWorkspace: Map<string, string[]>,
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
    section += "\n";
  }

  section += `Use atlas_workspace_describe and atlas_workspace_jobs_describe for detailed information.
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
  supportedDomainsSection?: string,
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

  if (supportedDomainsSection) {
    prompt = `${prompt}\n\n${supportedDomainsSection}`;
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
 * Connect to agent server for system agents with custom inputSchemas.
 * Only used for workspace-planner and fsm-workspace-creator which need structured inputs.
 * Regular bundled agents (calendar, email, etc.) go through do_task tool.
 */
async function getAgentServerClient(streamId: string, logger: Logger) {
  const client = new Client({ name: "atlas-streaming-client", version: "1.0.0" });

  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8080/agents"), {
    requestInit: { headers: { "mcp-session-id": crypto.randomUUID(), "x-stream-id": streamId } },
  });

  try {
    await client.connect(transport);
    logger.info("Connected to Agent Server via MCP for system agents");
  } catch (error) {
    logger.error("Failed to connect to Agent Server", { error });
    throw new Error(`Failed to connect to Agent Server: ${error}`);
  }

  return { agentServer: client, agentServerTransport: transport };
}

// Export the agent
export const conversationAgent = createAgent({
  id: "conversation",
  displayName: "Conversation Agent",
  version: "1.0.0",
  description: "Interactive conversation agent for workspace collaboration",
  // Expose /agents endpoint as an MCP server for tool access

  expertise: { domains: ["conversation"], examples: [] },

  /**
   * Main conversation handler that processes user prompts with streaming responses.
   * Manages conversation history persistence, tool execution, and real-time event streaming.
   *
   * NOTE: The conversation agent works a bit differently than other agents. Rather than using
   * the prompt that triggers the signal, the message history is loaded in its entirety from
   * the chat history db, rather than using the signal input prompt.
   *
   * @param prompt - NOT USED - see the note above.
   * @param context - Execution context with session, logger, and available tools
   * @returns Conversation response with text, reasoning, execution flow, and tool calls
   */
  handler: async (_, { session, logger, tools, stream, abortSignal, telemetry }) => {
    if (!session.streamId) {
      throw new Error("Stream ID is required");
    }
    // Load and validate chat history
    let messages: AtlasUIMessage[] = [];
    const res = await parseResult(
      client.chat[":chatId"].$get({ param: { chatId: session.streamId } }),
    );
    if (res.ok) {
      messages = await validateAtlasUIMessages(res.data.messages);
    } else {
      logger.error("Failed to load chat history", { error: res.error });
    }

    /**
     * Connect to Agent Server for system agents with custom inputSchemas.
     * Regular agents (calendar, email, etc.) go through do_task tool.
     */
    const { agentServer, agentServerTransport } = await getAgentServerClient(
      session.streamId,
      logger,
    );

    // Store the original error if streamText fails
    let originalStreamError: unknown = null;
    let interceptedApiError: unknown = null;
    let finalText: string | undefined;

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
      },
      execute: async ({ writer }) => {
        if (!session.streamId) {
          throw new Error("Stream ID is required");
        }

        /**
         * Register ONLY system agents with custom inputSchemas as direct tools.
         * These agents (workspace-planner, fsm-workspace-creator) need structured inputs.
         * Regular bundled agents (calendar, email, etc.) are accessed via do_task tool.
         */
        const { tools: agentTools } = await agentServer.listTools();
        const systemAgents: AtlasTools = {};
        const systemAgentNames = ["workspace-planner", "fsm-workspace-creator"];

        for (const agent of agentTools) {
          // Only register system agents with custom inputSchemas
          if (!systemAgentNames.includes(agent.name)) continue;

          logger.info("Registering system agent as direct tool", { agentName: agent.name });

          const paramsSchema = structuredClone(agent.inputSchema);
          delete paramsSchema.properties?._sessionContext;
          paramsSchema.required = paramsSchema.required?.filter(
            (r: string) => r !== "_sessionContext",
          );

          systemAgents[agent.name] = tool({
            name: agent.name,
            description: agent.description,
            inputSchema: jsonSchema(paramsSchema),
            execute: async (input) => {
              const requestId = crypto.randomUUID();

              logger.debug("Executing system agent", { agentName: agent.name, input });

              try {
                const result = await agentServer.callTool(
                  {
                    name: agent.name,
                    arguments: {
                      ...input,
                      _sessionContext: {
                        sessionId: session.sessionId,
                        workspaceId: session.workspaceId,
                        userId: session.userId,
                        streamId: session.streamId,
                      },
                    },
                    _meta: { requestId },
                  },
                  undefined,
                  { timeout: 1_200_000 },
                );
                return { result };
              } catch (error) {
                logger.error("System agent invocation failed", {
                  error,
                  agentName: agent.name,
                  requestId,
                });
                throw error;
              }
            },
          });
        }

        // Track system agent names for prompt injection
        const agentNames = Object.keys(systemAgents);

        // Parallel fetch of startup context
        logger.info("Fetching startup context for prompt injection");
        const [{ workspaces, jobsByWorkspace }, linkSummary, userIdentitySection] =
          await Promise.all([
            fetchWorkspacesAndJobs(logger),
            fetchLinkSummary(logger),
            fetchUserIdentitySection(logger),
          ]);

        // Format sections from fetched data
        const workspacesSection = formatWorkspacesAndJobsSection(workspaces, jobsByWorkspace);
        const agentsSection = formatAgentsSection(agentNames);
        const integrationsSection = linkSummary
          ? formatIntegrationsSection(linkSummary)
          : undefined;

        // Load skills for prompt injection
        const skillsSection = formatSkillsSection();

        // Generate capabilities section from bundled agents + MCP registry
        const supportedDomainsSection = getCapabilitiesSection();

        // Create link auth tool if Link is available with provider-constrained enum
        const connectServiceTool: AtlasTools = {};
        if (linkSummary && linkSummary.providers.length > 0) {
          const providerIds = linkSummary.providers.map((p) => p.id);
          connectServiceTool.connect_service = createConnectServiceTool(providerIds);
        }

        logger.debug("Startup context sections prepared", {
          workspaceCount: workspaces.length,
          agentCount: agentNames.length,
          integrations: linkSummary ? linkSummary.credentials.length : "unavailable",
          providers: linkSummary ? linkSummary.providers.length : "unavailable",
          userIdentity: userIdentitySection ? "available" : "unavailable",
        });

        // MVP: Tool allowlist - only expose specific workspace management and task execution tools
        const ALLOWED_TOOLS = new Set([
          // Workspace management
          "atlas_workspace_list",
          "atlas_workspace_create",
          "atlas_workspace_describe",
          "atlas_workspace_update",
          "atlas_workspace_delete",
          // Session/job inspection
          "atlas_session_describe",
          "atlas_session_cancel",
          "atlas_job_list",
          "atlas_job_describe",
          // Signal triggering
          "atlas_workspace_signal_trigger",
          "atlas_signals_list",
          // Library
          "atlas_library_list",
          "atlas_library_get",
          // Artifacts
          "artifacts_create",
          "artifacts_update",
          "artifacts_get",
          "artifacts_get_by_chat",
          // System
          "system_version",
        ]);

        const filteredTools = Object.fromEntries(
          Object.entries(tools).filter(([name]) => ALLOWED_TOOLS.has(name)),
        );

        // Create do_task tool with writer closure for progress
        const doTaskTool = createDoTaskTool(
          writer,
          {
            sessionId: session.sessionId || `session-${Date.now()}`,
            workspaceId: session.workspaceId || "atlas-conversation",
            streamId: session.streamId,
            userId: session.userId,
            daemonUrl: getAtlasDaemonUrl(),
            datetime: session.datetime,
          },
          logger,
          abortSignal,
        );

        const allTools = {
          ...filteredTools,
          ...conversationTools,
          ...connectServiceTool,
          ...systemAgents,
          do_task: doTaskTool,
          load_skill: loadSkillTool,
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
          supportedDomainsSection,
          userIdentitySection,
        );

        const datetimeMessage = session.datetime
          ? `## Context Facts\n- Current Date: ${session.datetime.localDate}\n- Current Time: ${session.datetime.localTime} (${session.datetime.timezone})\n- Timestamp: ${session.datetime.timestamp}\n- Timezone Offset: ${session.datetime.timezoneOffset}`
          : `Current datetime (UTC): ${new Date().toISOString()}`;

        // Capture system prompt context on first turn (fire-and-forget)
        // Must happen after datetimeMessage is defined to capture actual messages sent to LLM
        if (messages.length <= 1) {
          const systemMessages = [
            systemPrompt, // Already assembled by getSystemPrompt()
            datetimeMessage,
            ...(scratchpadContext ? [scratchpadContext] : []),
          ];
          ChatStorage.setSystemPromptContext(session.streamId!, { systemMessages }).catch(
            (err: unknown) =>
              logger.warn("Failed to capture system prompt context", { error: err }),
          );
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
        const prunedModelMessages = processMessageHistory(
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
              model: registry.languageModel("anthropic:claude-sonnet-4-5"),
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
                    supportedDomainsSection,
                    userIdentitySection,
                  ),
                },
                {
                  role: ROLE_SYSTEM,
                  content: session.datetime
                    ? `## Context Facts\n- Current Date: ${session.datetime.localDate}\n- Current Time: ${session.datetime.localTime} (${session.datetime.timezone})\n- Timestamp: ${session.datetime.timestamp}\n- Timezone Offset: ${session.datetime.timezoneOffset}`
                    : `Current datetime (UTC): ${new Date().toISOString()}`,
                },
                // Add scratchpad context as third system message if it exists
                ...(scratchpadContext ? [{ role: ROLE_SYSTEM, content: scratchpadContext }] : []),
                ...prunedModelMessages,
              ],
              tools: allTools,
              toolChoice: "auto",
              stopWhen: [stepCountIs(40), hasToolCall("connect_service")],
              maxOutputTokens: 20000,
              experimental_transform: smoothStream({ chunking: "word" }),
              maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
              abortSignal, // Pass the abort signal for cancellation
              providerOptions: { groq: { reasoningFormat: "parsed", reasoningEffort: "medium" } },
              experimental_context: { conversationSessionId: session.sessionId },
              // Pass telemetry config if provided in context
              experimental_telemetry: telemetry ? { isEnabled: true, ...telemetry } : undefined,
              onFinish: ({ text }) => {
                finalText = text;
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
              generateMessageId: createIdGenerator({ prefix: "msg", size: 8 }),
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

          // Clean up MCP transport before returning error
          try {
            await agentServerTransport.close();
            logger.info("Closed MCP transport after outer error");
          } catch (closeError) {
            logger.error("Failed to close MCP transport after outer error", { error: closeError });
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
    await pipeUIMessageStream(persistStreamMessage, stream).catch(async (pipeError) => {
      logger.error("pipeUIMessageStream failed", { error: pipeError });

      const apiError = parseAPICallError(pipeError);
      if (apiError) {
        interceptedApiError = apiError;
      }

      // Close MCP transport on error
      try {
        await agentServerTransport.close();
        logger.info("Closed MCP transport after pipe error");
      } catch (closeError) {
        logger.error("Failed to close MCP transport", { error: closeError });
      }
      throw pipeError;
    });

    // Successfully completed - close MCP transport
    try {
      await agentServerTransport.close();
      logger.info("Closed MCP transport after successful completion");
    } catch (closeError) {
      logger.error("Failed to close MCP transport", { error: closeError });
    }

    return { text: finalText };
  },
  environment: {
    required: [],
    optional: [{ name: "ATLAS_DAEMON_URL", description: "Platform MCP server URL" }],
  },
});
