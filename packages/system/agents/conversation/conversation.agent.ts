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
import { createAgent, validateAtlasUIMessages } from "@atlas/agent-sdk";
import { pipeUIMessageStream } from "@atlas/agent-sdk/vercel-helpers";
import { client, parseResult } from "@atlas/client/v2";
import { anthropic } from "@atlas/core";
import { createErrorCause, getErrorDisplayMessage, parseAPICallError } from "@atlas/core/errors";
import type { Logger } from "@atlas/logger";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  convertToModelMessages,
  createIdGenerator,
  generateText,
  jsonSchema,
  smoothStream,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import {
  type CancellationNotification,
  StreamContentNotificationSchema,
} from "../../../core/src/streaming/stream-emitters.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { conversationTools } from "./tools/mod.ts";

/**
 * Get the system prompt with optional conversation history injection and available tools
 * Based on existing conversation-agent.ts buildSystemPrompt logic
 */
function getSystemPrompt(streamId?: string): string {
  let prompt = SYSTEM_PROMPT;

  // Add critical streamId instruction for signal triggers
  if (streamId) {
    prompt = `${prompt}
      CRITICAL: Stream ID is ${streamId}. Include this parameter when streamId is available as a parameter in tools.
    `;
  }

  return prompt;
}

/**
 * Generates a concise 3-5 word title for a conversation based on its messages.
 */
async function generateChatTitle(messages: AtlasUIMessage[], logger: Logger): Promise<string> {
  try {
    const titlePrompt = `Generate a concise 3-5 word title for this conversation. Only output the title, nothing else.
      Conversation:
      ${messages.map((m) => `${m.role}: ${JSON.stringify(m.parts.filter((p) => p.type === "text"))}`).join("\n")}`;
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5"),
      prompt: titlePrompt,
      maxOutputTokens: 50,
    });
    return text;
  } catch (error) {
    logger.error("Failed to generate chat title", { error });
    return "Saved Chat";
  }
}

async function getAgentServerClient(streamId: string, logger: Logger) {
  // Create official MCP client (not AI SDK client - supports notifications)
  const client = new Client({ name: "atlas-streaming-client", version: "1.0.0" });

  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:8080/agents"), {
    requestInit: { headers: { "mcp-session-id": crypto.randomUUID(), "x-stream-id": streamId } },
  });

  try {
    await client.connect(transport);
    logger.info("Connected to Agent Server via MCP");
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

    /**
     * Connect directly to the Atlas Agent server so that we can invoke agents and
     * intercept streamed notifications to show their progress and status updates.
     */
    const { agentServer, agentServerTransport } = await getAgentServerClient(
      session.streamId,
      logger,
    );
    agentServer.setNotificationHandler(StreamContentNotificationSchema, (notification) => {
      const { event } = notification.params;
      // Event is validated by schema to have required structure
      if (stream) {
        // @ts-expect-error will be addressed during Chat
        stream.emit(event);
      }
    });

    // Track active agent invocations for cancellation
    const activeMCPRequests = new Map<string, string>(); // agentName:invocationId -> requestId

    // Handle cancellation - send notifications for all active agent invocations
    if (abortSignal) {
      abortSignal.addEventListener("abort", async () => {
        logger.info("Conversation cancelled, notifying active agents", {
          activeAgents: Array.from(activeMCPRequests.keys()),
        });

        for (const [key, requestId] of activeMCPRequests) {
          const agentName = key.split(":")[0];
          try {
            const notification: CancellationNotification = {
              method: "notifications/cancelled",
              params: { requestId, reason: "Conversation cancelled by user" },
            };
            await agentServer.notification(notification);
            logger.debug("Sent cancellation notification", { agentName, requestId });
          } catch (error) {
            logger.warn("Failed to send cancellation notification", {
              error,
              requestId,
              agentName,
            });
          }
        }
        activeMCPRequests.clear();
      });
    }

    /**
     * Register and transform all agents from the Agent Server for use
     * by the conversation agent.
     */
    const { tools: agentTools } = await agentServer.listTools();
    const agents: AtlasTools = {};
    for (const agent of agentTools) {
      // Skip the conversation agent. The universe might implode.
      if (agent.name === "conversation") continue;

      /**
       * @hack
       * Right now, we're stuffing session context into the input schema for the agent.
       * This is because when I originally wrote it, I was unaware of the _meta property.
       * Subsequently, I figured it out (see the requestId) but didn't yet move over
       * the session context.
       *
       * The structured cloning and deletion of params is to trim those from the input schema
       * that the conversation agent will have to generate since they're injected programatically.
       */
      const paramsSchema = structuredClone(agent.inputSchema);
      delete paramsSchema.properties?._sessionContext;
      paramsSchema.required = paramsSchema.required?.filter((r) => r !== "_sessionContext");

      agents[agent.name] = tool({
        name: agent.name,
        description: agent.description,
        // @ts-expect-error the JSON Schema output by the MCP SDK tool definition doesn't align with the AI SDK.
        inputSchema: jsonSchema(paramsSchema),
        execute: async (input) => {
          const requestId = crypto.randomUUID();
          const invocationId = crypto.randomUUID(); // Unique ID for this specific invocation
          const trackingKey = `${agent.name}:${invocationId}`;

          // Track this invocation for cancellation
          activeMCPRequests.set(trackingKey, requestId);

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
                _meta: { requestId }, // Pass requestId for cancellation correlation
              },
              undefined,
              { timeout: 1_200_000 },
            );
            return { result };
          } catch (error) {
            logger.error("Agent invocation failed", { error, agentName: agent.name, requestId });
            throw error; // Re-throw to maintain error propagation
          } finally {
            // Clean up tracking regardless of success/failure
            activeMCPRequests.delete(trackingKey);
          }
        },
      });
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

    const allTools = { ...tools, ...conversationTools, ...agents };

    /**
     * Load conversation context from workspace memory system instead of separate storage
     */

    const systemPrompt = `Current datetime (UTC): ${new Date().toISOString()}

    ${getSystemPrompt(session.streamId)}
    `;

    // Store the original error if streamText fails
    let originalStreamError: unknown = null;
    let interceptedApiError: unknown = null;
    let result: Awaited<ReturnType<typeof streamText>>;
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
          model: anthropic("claude-sonnet-4-20250514"),
          system: systemPrompt,
          messages: convertToModelMessages(messages),
          tools: allTools,
          toolChoice: "auto",
          stopWhen: stepCountIs(40),
          maxOutputTokens: 20000,
          experimental_transform: smoothStream({ chunking: "word" }),
          maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
          abortSignal, // Pass the abort signal for cancellation
          providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 25000 } } },
          experimental_context: { conversationSessionId: session.sessionId },
          // Pass telemetry config if provided in context
          experimental_telemetry: telemetry ? { isEnabled: true, ...telemetry } : undefined,
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
              stream.emit({
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
            stream.emit({
              id: crypto.randomUUID(),
              type: "data-error",
              data: { error: displayMessage, errorCause },
            });
            errorEmitted = true;
          }

          // Clean up and return
          globalThis.removeEventListener("unhandledrejection", unhandledRejectionHandler);
          return { text: displayMessage, reasoning: "", executionFlow: [], toolCalls: [] };
        }

        // Re-throw if not an API error
        throw streamTextError;
      }

      // Start piping the UI message stream immediately
      // DO NOT consume the stream elsewhere - it's single-consumer only
      const pipePromise = pipeUIMessageStream(
        result.toUIMessageStream({
          originalMessages: messages,
          generateMessageId: createIdGenerator({ prefix: "msg", size: 8 }),
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
        }),
        stream,
      );

      // Wait for both the text/reasoning and the pipe to complete
      // This ensures all streaming events are emitted before we close MCP transport
      let finalText: string;

      try {
        const [textResult, pipeResult] = await Promise.allSettled([result.text, pipePromise]);

        // Check for pipe errors first - they indicate streaming failures
        if (pipeResult.status === "rejected") {
          const pipeError = pipeResult.reason;
          logger.error("pipeUIMessageStream failed", { error: pipeError });

          const apiError = parseAPICallError(pipeError);
          if (apiError) {
            interceptedApiError = apiError;
          }

          throw pipeError;
        }

        // Check for text errors
        if (textResult.status === "rejected") {
          throw textResult.reason;
        }

        finalText = textResult.status === "fulfilled" ? textResult.value : "";
      } catch (streamError) {
        // Handle error that occurs during stream consumption
        // Use the most specific error available
        const actualError = interceptedApiError || originalStreamError || streamError;

        logger.error("Error consuming stream", {
          error: streamError,
          originalError: originalStreamError,
          interceptedApiError: interceptedApiError,
        });
        const errorCause = createErrorCause(actualError);
        const displayMessage = getErrorDisplayMessage(errorCause);

        if (stream && !errorEmitted) {
          stream.emit({
            id: crypto.randomUUID(),
            type: "data-error",
            data: { error: displayMessage, errorCause },
          });
          errorEmitted = true;
        }

        // Clean up MCP before returning
        try {
          await agentServerTransport.close();
          logger.info("Closed MCP transport after stream error");
        } catch (closeError) {
          logger.error("Failed to close MCP transport after error", { error: closeError });
        }

        return { text: displayMessage, reasoning: "", executionFlow: [], toolCalls: [] };
      }

      // Successfully completed - close MCP transport now that streaming is done
      try {
        await agentServerTransport.close();
        logger.info("Closed MCP transport after successful completion");
      } catch (closeError) {
        logger.error("Failed to close MCP transport", { error: closeError });
      }

      return { text: finalText };
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
        stream.emit({
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
      return { text: displayMessage, reasoning: "", executionFlow: [], toolCalls: [] };
    } finally {
      // Remove the unhandled rejection handler to prevent memory leaks
      globalThis.removeEventListener("unhandledrejection", unhandledRejectionHandler);

      // Clean up process handler if it was added
      if (process?.off) {
        process.off("unhandledRejection", processHandler);
      }
    }
  },
  environment: {
    required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }],
    optional: [{ name: "ATLAS_DAEMON_URL", description: "Platform MCP server URL" }],
  },
});
