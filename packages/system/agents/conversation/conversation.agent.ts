/**
 * Conversation Agent - SDK Architecture Implementation
 *
 * Interactive conversation agent for workspace collaboration with:
 * - Persistent conversation history via daemon storage
 * - Tool execution through MCP server
 * - Real-time streaming responses
 * - Task tracking with todos
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { AtlasTools, AtlasUIMessage } from "@atlas/agent-sdk";
import { createAgent } from "@atlas/agent-sdk";
import { pipeUIMessageStream } from "@atlas/agent-sdk/vercel-helpers";
import { type SystemAgentConfigObject, SystemAgentConfigObjectSchema } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { createAtlasClient } from "@atlas/oapi-client";
import { Client } from "@modelcontextprotocol/sdk/client";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  convertToModelMessages,
  createIdGenerator,
  smoothStream,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { z } from "zod/v4";
import { StreamContentNotificationSchema } from "../../../core/src/streaming/stream-emitters.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { conversationTools, workspaceMemoryTool } from "./tools/mod.ts";

type Role = "user" | "assistant";
type ChatMessage = { role: Role; content: string };
type MessageHistory = { messages: Array<ChatMessage> };

/**
 * Get the system prompt with optional conversation history injection and available tools
 * Based on existing conversation-agent.ts buildSystemPrompt logic
 */
function getSystemPrompt(
  historyMessages?: Array<{ role: string; content: string }>,
  tools?: AtlasTools,
  streamId?: string,
): string {
  let prompt = SYSTEM_PROMPT;

  // Add critical streamId instruction for signal triggers
  if (streamId) {
    prompt = `${prompt}
      CRITICAL: Your current Stream ID is ${streamId}. Include this when calling the atlas_workspace_signals_trigger tool.
    `;
  }

  // Replace the conversation history placeholder if present
  if (historyMessages && historyMessages.length > 0) {
    const formattedHistory = historyMessages.map((m) => `${m.role}: ${m.content}`).join("\n");
    prompt = prompt.replace(
      "{{CONVERSATION_HISTORY}}",
      `\nConversation History:\n${formattedHistory}\n`,
    );
  } else {
    // Remove the placeholder if no history
    prompt = prompt.replace("{{CONVERSATION_HISTORY}}", "");
  }

  // Replace the available tools placeholder with actual tool descriptions
  if (tools && Object.keys(tools).length > 0) {
    const toolDescriptions = Object.entries(tools)
      .map(([name, tool]) => {
        if (tool.description) {
          return `- ${name}: ${tool.description}`;
        }
        return `- ${name}`;
      })
      .join("\n");

    prompt = prompt.replace("{{AVAILABLE_TOOLS}}", `Available tools:\n${toolDescriptions}`);
  } else {
    // Remove the placeholder if no tools
    prompt = prompt.replace("{{AVAILABLE_TOOLS}}", "");
  }

  return prompt;
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

  return client;
}

// Export the agent
export const conversationAgent = createAgent({
  id: "conversation",
  displayName: "Conversation Agent",
  version: "1.0.0",
  description: "Interactive conversation agent for workspace collaboration",

  expertise: { domains: ["conversation"], capabilities: ["interactive-chat"], examples: [] },

  /**
   * Main conversation handler that processes user prompts with streaming responses.
   * Manages conversation history persistence, tool execution, and real-time event streaming.
   *
   * @param prompt - User's input message
   * @param context - Execution context with session, logger, and available tools
   * @returns Conversation response with text, reasoning, execution flow, and tool calls
   */
  handler: async (prompt, { session, logger, tools, config, stream }) => {
    if (!session.streamId) {
      throw new Error("Stream ID is required");
    }
    const client = createAtlasClient();
    const anthropic = createAnthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

    /**
     * Connect directly to the Atlas Agent server so that we can invoke agents and
     * intercept streamed notifications to show their progress and status updates.
     */
    const agentServer = await getAgentServerClient(session.streamId, logger);
    agentServer.setNotificationHandler(StreamContentNotificationSchema, (notification) => {
      const { event } = notification.params;
      stream?.emit(event);
    });

    /**
     * Register and transform all agents from the Agent Server for use
     * by the conversation agent.
     */
    const { tools: agentTools } = await agentServer.listTools();
    const agents: AtlasTools = {};
    for (const agent of agentTools) {
      // Skip the conversation agent. The universe might implode.
      if (agent.name === "conversation") continue;
      agents[agent.name] = tool({
        name: agent.name,
        description: agent.description,
        inputSchema: z.object({ prompt: z.string() }),
        execute: async (input) => {
          try {
            const result = await agentServer.callTool({
              name: agent.name,
              arguments: {
                prompt: input.prompt,
                _sessionContext: {
                  sessionId: session.sessionId,
                  workspaceId: session.workspaceId,
                  userId: session.userId,
                  streamId: session.streamId,
                },
              },
            });
            return { result };
          } catch (error) {
            logger.error("Agent invocation failed", { error });
          }
        },
      });
    }

    // Get configuration values from workspace config with defaults
    // Parse and validate config using proper schema types
    let agentConfig: SystemAgentConfigObject | undefined;

    if (config) {
      try {
        agentConfig = SystemAgentConfigObjectSchema.parse(config);
        logger.info("Successfully parsed system agent configuration", {
          model: agentConfig.model,
          temperature: agentConfig.temperature,
          maxTokens: agentConfig.max_tokens,
        });
      } catch (error) {
        logger.warn("Invalid system agent configuration, using defaults", {
          error: error instanceof Error ? error.message : String(error),
          receivedConfig: config,
        });
      }
    }

    // If chat history exists, load it.
    const messages: AtlasUIMessage[] = [];
    const chatHistory = await client.GET("/api/chat-storage/{streamId}", {
      params: { path: { streamId: session.streamId } },
    });
    if (chatHistory.data && chatHistory.data.messages.length > 0) {
      // @ts-expect-error the AI sdk doesn't currently export Zod schemas for UIMessage and UIMessageChunk
      // so right now we're accepting a z.record(z.string(), z.unknown());
      // @see: https://github.com/vercel/ai/issues/8100
      messages.push(...chatHistory.data.messages.slice(-20));
    }

    // convert the prompt to an AtlasUIMessage
    const userMessage: AtlasUIMessage = {
      id: crypto.randomUUID(),
      role: "user",
      parts: [{ type: "text", text: prompt }],
    };

    // Push the message to the array which will be sent to the LLM.
    messages.push(userMessage);

    // Emit it using our custom message type
    // @HACK: `data-user-message` this is a workaround since the AI SDK doesn't
    // give you a way to emit user messages back to the stream. It expects that
    // they will be just pushed to the array and persisted client-side.
    stream?.emit({ type: "data-user-message", data: prompt });

    const allTools = { ...tools, ...conversationTools, ...agents };

    /**
     * Load conversation context from workspace memory system instead of separate storage
     */
    let history: MessageHistory = { messages: [] };

    try {
      // Use workspace memory tool from conversation tools

      const result = await workspaceMemoryTool.execute?.(
        { operation: "load_context", maxEntries: 10, sessionId: session.sessionId, prompt: prompt },
        { messages: [], toolCallId: crypto.randomUUID() },
      );

      if (result?.success && result.conversationHistory.length > 0) {
        const conversationHistory = result.conversationHistory;

        // Convert workspace memory format to conversation format
        const pastChatContext: Array<ChatMessage> = [];
        for (const entry of conversationHistory) {
          const userContent = entry?.user;
          const assistantContent = entry?.assistant;
          if (typeof userContent === "string" && userContent.trim().length > 0) {
            pastChatContext.push({ role: "user", content: userContent });
          }
          if (typeof assistantContent === "string" && assistantContent.trim().length > 0) {
            pastChatContext.push({ role: "assistant", content: assistantContent });
          }
        }

        // Limit to recent messages
        history = { messages: pastChatContext.slice(-20) };

        logger.info("Loaded conversation context from workspace memory", {
          entriesLoaded: conversationHistory.length,
          messagesCount: messages.length,
        });
      }
    } catch (error) {
      logger.warn("Failed to load workspace memory context", { error });
    }

    const systemPrompt = `Current datetime (UTC): ${new Date().toISOString()}

    ${getSystemPrompt(history.messages, allTools, session.streamId)}
    `;

    const result = streamText({
      model: anthropic("claude-sonnet-4-20250514"),
      system: systemPrompt,
      messages: convertToModelMessages(messages),
      tools: allTools,
      toolChoice: "auto",
      stopWhen: stepCountIs(40),
      temperature: 0.3,
      maxOutputTokens: 20000,
      experimental_transform: smoothStream({ chunking: "word" }),
      maxRetries: 3, // Enable retries for API resilience (e.g., 529 errors)
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 25000 } } },
    });

    pipeUIMessageStream(
      result.toUIMessageStream({
        originalMessages: messages,
        generateMessageId: createIdGenerator({ prefix: "msg", size: 8 }),
        onFinish: async ({ messages }) => {
          if (!session.streamId) {
            throw new Error("Stream ID is missing");
          }
          // Store the updated chat
          await client.PUT("/api/chat-storage/{streamId}", {
            params: { path: { streamId: session.streamId } },
            body: { messages },
          });
        },
      }),
      stream,
    );

    const executionFlow = {
      steps: [] as Array<{ type: string; tool?: string; args?: unknown; timestamp: string }>,
      reasoning: [] as string[],
      responseBuffer: "",
      thinkingBuffer: "",
      startTime: Date.now(), // Track start time for duration calculation
    };

    const finalText = await result.text;
    const finalReasoning = await result.reasoning;

    // Convert reasoning to proper format - prioritize collected reasoning if AI SDK reasoning is empty
    const processedReasoning =
      finalReasoning.length > 0
        ? finalReasoning.map((item) => item.text).join("\n")
        : executionFlow.reasoning.join("\n");

    return {
      text: finalText || executionFlow.responseBuffer,
      reasoning: processedReasoning,
      executionFlow: executionFlow.steps,
      toolCalls: executionFlow.steps.filter((s) => s.type === "tool_call"),
    };
  },
  environment: {
    required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }],
    optional: [{ name: "ATLAS_DAEMON_URL", description: "Platform MCP server URL" }],
  },
});
