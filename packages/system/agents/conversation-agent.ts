/**
 * ConversationAgent - System agent for interactive conversations
 *
 * This agent manages chat interactions within Atlas workspaces, providing:
 * - Persistent conversation history with context retrieval
 * - Tool execution with streaming capabilities
 * - AI-powered responses using Claude models
 * - Real-time streaming of thoughts, responses, and tool calls
 *
 * Key features:
 * - Automatically loads and maintains conversation context across sessions
 * - Supports configurable tools for extended functionality
 * - Implements streaming for responsive user experience
 * - Handles error recovery and graceful degradation
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { type SystemAgentConfigObject } from "@atlas/config";
import { AtlasToolRegistry, getAtlasToolRegistry } from "@atlas/tools";
import type { TextStreamPart, Tool } from "ai";
import { stepCountIs, streamText } from "ai";
import { z } from "zod/v4";
import { BaseAgent } from "../../../src/core/agents/base-agent-v2.ts";
import type { SystemAgentMetadata } from "../../../src/core/system-agent-registry.ts";
import { isOverloadError, withExponentialBackoff } from "../../../src/utils/exponential-backoff.ts";

const ConversationInputSchema = z.object({
  message: z.string(),
  streamId: z.string().optional(),
  userId: z.string().optional(),
});

interface ConversationAgentControls {
  tools?: string[];
}

interface ConversationStorageOutput {
  success: boolean;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  historyContext?: string; // Pre-formatted for LLM prompt injection
  error?: string;
}

interface StreamEvent {
  id: string;
  type: "thinking" | "text" | "tool_call" | "tool_result" | "error" | "finish";
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: number;
}

type ExecutionStep = {
  type: string;
  tool?: string;
  args?: unknown;
  timestamp: number;
};

type ExecutionFlow = {
  steps: ExecutionStep[];
  reasoning: string[];
  responseBuffer: string;
  thinkingBuffer: string;
};

/**
 * ConversationAgent implementation for Atlas workspace conversations
 *
 * Lifecycle:
 * 1. Constructor validates configuration and available tools
 * 2. Execute method processes user messages with conversation history
 * 3. Streams responses with tool calls and reasoning
 * 4. Persists conversation state for future interactions
 */
export class ConversationAgent extends BaseAgent {
  private config: SystemAgentConfigObject;
  private llmProvider = createAnthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
  });
  private toolRegistry: AtlasToolRegistry;
  private streamId: string | undefined;

  constructor(
    config: SystemAgentConfigObject,
    id?: string,
    toolRegistry?: AtlasToolRegistry,
  ) {
    super(undefined, id);

    this.config = config;
    this.toolRegistry = toolRegistry || getAtlasToolRegistry();

    this.logger.info("ConversationAgent constructor called", {
      configKeys: Object.keys(this.config),
      config: JSON.stringify(this.config),
      hasTools: !!this.config.tools,
      toolsLength: this.config.tools?.length,
      tools: this.config.tools,
      toolRegistry: !!this.toolRegistry,
      usingDefaultRegistry: !toolRegistry,
    });

    // Validate configured tools exist before execution starts
    if (this.config.tools && this.config.tools.length > 0) {
      const missingTools = this.config.tools.filter(
        (tool) => !this.toolRegistry.hasTools(tool),
      );
      if (missingTools.length > 0) {
        throw new Error(
          `Required tools not available in registry: ${
            missingTools.join(
              ", ",
            )
          }. Ensure tools are properly registered.`,
        );
      }
    }

    const systemPrompt = this.config.prompt ||
      "You are a helpful AI assistant for Atlas workspace conversations.";
    this.setPrompts(systemPrompt, "");
  }

  name(): string {
    return "ConversationAgent";
  }

  nickname(): string {
    return "chat";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "atlas-system";
  }

  purpose(): string {
    return "Interactive conversation agent for workspace collaboration";
  }

  controls(): ConversationAgentControls {
    return {
      tools: this.config.tools,
    };
  }

  protected override getDefaultModel(): string {
    return "claude-3-7-sonnet-20250219";
  }

  /**
   * Processes user messages and generates AI responses
   *
   * @param input - User input containing message, streamId, userId
   * @returns Response object with text, reasoning, execution flow, and metadata
   *
   * Flow:
   * 1. Validates input and loads conversation history
   * 2. Loads tools from multiple sources:
   *    - Conversation tools (with context injection for streamId/userId)
   *    - Additional category tools (workspace, signal, library, draft, session)
   *    - User-configured tools (specified in config.tools)
   * 3. Merges tools with conversation tools taking precedence for context injection
   * 4. Executes AI streaming with configured model
   * 5. Processes stream events (thinking, text, tool calls)
   * 6. Persists conversation state
   */
  protected async execute(input?: unknown): Promise<unknown> {
    this.logger.info("ConversationAgent execute called", {
      input: JSON.stringify(input),
    });

    const { message, streamId, userId } = ConversationInputSchema.parse(input);

    this.logger.info("Processing message", {
      message: message.substring(0, 100),
      streamId,
      userId,
    });

    let historyContext = "";
    let messagesInHistory = 0;
    let isNewConversation = true;

    // Get conversation tools with context injection (streamId, userId automatically handled)
    const conversationTools = this.toolRegistry.getToolsWithContext(
      "conversation",
      {
        streamId,
        userId,
      },
    );

    // Get user-configured tools by name if specified
    const configuredTools: Record<string, Tool> = {};
    if (this.config.tools && this.config.tools.length > 0) {
      for (const toolName of this.config.tools) {
        const tool = this.toolRegistry.getToolByName(toolName);
        if (tool) {
          configuredTools[toolName] = tool;
        } else {
          this.logger.warn(
            `Configured tool not found in registry: ${toolName}`,
          );
        }
      }
    }

    // Merge all tools: conversation (with context) + additional categories + configured tools
    // Conversation tools take precedence to ensure context injection is preserved
    const finalTools = {
      ...configuredTools,
      ...conversationTools, // Last to ensure context injection is preserved
    };

    if (streamId) {
      try {
        const historyResult = await this.loadConversationHistory(streamId);
        if (historyResult.success && historyResult.messages?.length) {
          historyContext = historyResult.historyContext || "";
          messagesInHistory = historyResult.messages.length;
          isNewConversation = false;
        }

        await this.saveMessage(
          streamId,
          {
            role: "user",
            content: message,
          },
          { userId, timestamp: new Date().toISOString() },
        );

        // send message back in the SSE stream
        if (finalTools.atlas_stream_event?.execute) {
          await finalTools.atlas_stream_event.execute(
            {
              streamId,
              id: crypto.randomUUID(),
              eventType: "request",
              content: message,
              timestamp: new Date().toISOString(),
            },
            { toolCallId: crypto.randomUUID(), messages: [] },
          );
        }
      } catch (error) {
        this.logger.warn("Failed to handle conversation history", { error });
      }
    }

    // atlas_stream_event is mandatory for sending responses to users
    if (!finalTools.atlas_stream_event) {
      throw new Error(
        "atlas_stream_event tool is required for rich messaging but not found in registry",
      );
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable not set. " +
          "Please configure your Anthropic API key to enable conversations.",
      );
    }

    // Debug: Log the comprehensive tool configuration
    this.logger.info("Tool configuration debug", {
      totalTools: Object.keys(finalTools).length,
      conversationToolsCount: Object.keys(conversationTools).length,
      configuredToolsCount: Object.keys(configuredTools).length,
      toolNames: Object.keys(finalTools),
      categoryBreakdown: {
        conversation: Object.keys(conversationTools),
        configured: Object.keys(configuredTools),
      },
      atlasStreamEventTool: finalTools.atlas_stream_event
        ? {
          hasExecute: !!finalTools.atlas_stream_event.execute,
          hasDescription: !!finalTools.atlas_stream_event.description,
          hasParameters: !!finalTools.atlas_stream_event.inputSchema,
          hasContextInjection: true, // Since it comes from conversation tools
        }
        : null,
      contextInjected: {
        streamId: streamId ? "injected" : "not_provided",
        userId: userId ? "injected" : "not_provided",
      },
    });

    this.logger.info("Calling streamText with configuration", {
      model: "claude-3-7-sonnet-20250219",
      messageLength: message.length,
      toolCount: Object.keys(finalTools).length,
      tools: Object.keys(finalTools),
    });

    try {
      // Use exponential backoff utility for retry logic
      const result = await withExponentialBackoff(
        async () => {
          const { fullStream, text, reasoning } = streamText({
            model: this.llmProvider("claude-sonnet-4-20250514"),
            system: this.buildSystemPrompt(historyContext),
            messages: [{ role: "user", content: message }],
            tools: finalTools,
            toolChoice: "auto",
            stopWhen: stepCountIs(20),
            temperature: 0.7,
            maxOutputTokens: 8000,
            providerOptions: {
              anthropic: {
                thinking: { type: "enabled", budgetTokens: 25000 },
              },
            },
          });

          const executionFlow: ExecutionFlow = {
            steps: [],
            reasoning: [],
            responseBuffer: "",
            thinkingBuffer: "",
          };

          let prevChunk:
            | TextStreamPart<{
              [x: string]: Tool;
            }>
            | undefined = undefined;

          for await (const chunk of fullStream) {
            const event = this.processStreamEvent(chunk, prevChunk);
            prevChunk = chunk;

            if (!event || !streamId) continue;

            // Stream rich events directly
            if (finalTools.atlas_stream_event?.execute) {
              await finalTools.atlas_stream_event.execute(
                {
                  id: event.id,
                  streamId,
                  eventType: event.type,
                  content: event.content,
                  metadata: this.extractMetadata(event),
                },
                { toolCallId: crypto.randomUUID(), messages: [] },
              );
            }

            switch (event.type) {
              case "thinking":
                executionFlow.thinkingBuffer += event.content;
                executionFlow.reasoning.push(event.content);
                break;

              case "text":
                executionFlow.responseBuffer += event.content;
                break;

              case "finish":
                executionFlow.responseBuffer += event.content;
                break;

              case "tool_call":
                executionFlow.steps.push({
                  type: "tool_call",
                  tool: event.metadata?.toolName as string,
                  args: event.metadata?.args,
                  timestamp: event.timestamp,
                });

                this.logger.info("Tool call initiated", {
                  tool: event.metadata?.toolName,
                  streamId,
                  args: JSON.stringify(event.metadata?.args),
                });
                break;

              case "error":
                this.logger.error("Stream processing error", {
                  error: JSON.stringify(event.content),
                });
                break;
            }
          }

          // If we get here, the stream completed successfully
          const finalText = await text;
          const finalReasoning = await reasoning;

          if (streamId && finalText) {
            try {
              await this.saveMessage(
                streamId,
                {
                  role: "assistant",
                  content: finalText,
                },
                { timestamp: new Date().toISOString(), reasoning: true },
              );
            } catch (error) {
              this.logger.warn("Failed to save assistant message", { error });
            }
          }

          // Convert reasoning to proper format - prioritize collected reasoning if AI SDK reasoning is empty
          const hasAISDKReasoning = Array.isArray(finalReasoning) && finalReasoning.length > 0;
          const processedReasoning = hasAISDKReasoning ? finalReasoning : executionFlow.reasoning;

          const reasoningText = hasAISDKReasoning
            ? finalReasoning
              .map((item) => typeof item === "string" ? item : JSON.stringify(item))
              .join("\n")
            : executionFlow.reasoning.join("\n") ||
              executionFlow.thinkingBuffer ||
              "";

          return {
            text: finalText || executionFlow.responseBuffer,
            reasoning: processedReasoning,
            reasoningText,
            executionFlow: executionFlow.steps,
            response: finalText || executionFlow.responseBuffer, // Backward compatibility
            toolCalls: executionFlow.steps.filter(
              (step) => step.type === "tool_call",
            ),
            conversationMetadata: {
              streamId,
              messagesInHistory: messagesInHistory + 2,
              isNewConversation,
            },
          };
        },
        {
          maxRetries: 10,
          onRetry: async (attempt, delay, error) => {
            this.logger.info("Retrying after delay", {
              attempt,
              delayMs: delay,
              streamId,
              error: error instanceof Error ? error.message : String(error),
            });

            // Stream retry status to user
            if (streamId && finalTools.atlas_stream_event?.execute) {
              await finalTools.atlas_stream_event.execute(
                {
                  id: crypto.randomUUID(),
                  streamId,
                  eventType: "thinking",
                  content: `Retrying (attempt ${attempt}/10)... waiting ${delay / 1000}s`,
                  metadata: { retryCount: attempt, delay, maxRetries: 10 },
                },
                { toolCallId: crypto.randomUUID(), messages: [] },
              );
            }
          },
          isRetryable: isOverloadError,
        },
      );

      return result;
    } catch (error) {
      // Handle errors that exhausted all retries
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error as { type?: string; message?: string };
      const isOverload = isOverloadError(error);

      this.logger.error("Stream processing error after all retries", {
        error: errorMessage,
        errorType: errorObj?.type || "unknown",
        errorDetails: error instanceof Error
          ? {
            name: error.name,
            stack: error.stack?.split("\n").slice(0, 3).join("\n"),
          }
          : error,
        streamId,
        isOverloadError: isOverload,
      });

      if (isOverload) {
        // Stream a user-friendly error message
        if (streamId && finalTools.atlas_stream_event?.execute) {
          await finalTools.atlas_stream_event.execute(
            {
              id: crypto.randomUUID(),
              streamId,
              eventType: "error",
              content:
                "I'm experiencing high demand. I tried 10 times but couldn't process your request. Please try again later.",
              metadata: {
                errorType: "overload",
                retriesExhausted: true,
                attempts: 10,
              },
            },
            { toolCallId: crypto.randomUUID(), messages: [] },
          );
        }

        // Return a graceful error response instead of throwing
        return {
          text:
            "I apologize, but I'm currently experiencing high demand. I tried 10 times but couldn't process your request. Please try again later.",
          reasoning: ["Service temporarily overloaded after 10 retry attempts"],
          reasoningText: "Service temporarily overloaded after 10 retry attempts",
          executionFlow: [],
          response:
            "I apologize, but I'm currently experiencing high demand. I tried 10 times but couldn't process your request. Please try again later.",
          toolCalls: [],
          conversationMetadata: {
            streamId,
            messagesInHistory: messagesInHistory + 1, // Only count user message
            isNewConversation,
            error: "overload",
            retriesExhausted: true,
            attempts: 10,
          },
        };
      }

      // For other errors, rethrow
      throw error;
    }
  }

  /**
   * Extract metadata based on event type
   */
  private extractMetadata(
    event: StreamEvent,
  ): Record<string, unknown> | undefined {
    if (event.type === "tool_call") {
      return {
        toolName: event.metadata?.toolName,
        toolCallId: event.metadata?.toolCallId,
        args: event.metadata?.args,
      };
    }
    if (event.type === "tool_result") {
      return {
        toolName: event.metadata?.toolName,
        toolCallId: event.metadata?.toolCallId,
        result: event.metadata?.result,
      };
    }

    return event.metadata;
  }

  /**
   * Wrap tools with context injection
   */
  private buildSystemPrompt(historyContext?: string): string {
    if (!this.config.prompt) {
      throw new Error("ConversationAgent config.prompt is required");
    }
    let prompt = this.config.prompt;

    // Replace the conversation history placeholder if present
    if (historyContext) {
      prompt = prompt.replace(
        "{{CONVERSATION_HISTORY}}",
        `\nConversation History:\n${historyContext}\n`,
      );
    } else {
      // Remove the placeholder if no history
      prompt = prompt.replace("{{CONVERSATION_HISTORY}}", "");
    }

    return prompt;
  }

  private getUniqueId(type: string, prevType?: string): string {
    if (type === prevType && this.streamId) {
      return this.streamId;
    }

    this.streamId = crypto.randomUUID();
    return this.streamId;
  }

  /**
   * Converts AI SDK stream chunks into structured events for processing
   *
   * @param chunk - Stream chunk from AI SDK
   * @returns Structured event or null if chunk type is not handled
   *
   * Known issue: tool-result chunks are not currently processed by the AI SDK
   */
  private processStreamEvent(
    chunk: TextStreamPart<Record<string, Tool>>,
    prevChunk: TextStreamPart<Record<string, Tool>> | undefined,
  ): StreamEvent | null {
    const timestamp = Date.now();

    switch (chunk.type) {
      case "reasoning":
        return {
          id: this.getUniqueId("reasoning", prevChunk?.type),
          type: "thinking",
          content: chunk.text,
          timestamp,
        };

      case "text":
        return {
          id: this.getUniqueId("text", prevChunk?.type),
          type: "text",
          content: chunk.text,
          timestamp,
        };

      case "tool-call":
        return {
          id: this.getUniqueId("tool_call"),
          type: "tool_call",
          content: `Calling ${chunk.toolName}`,
          metadata: {
            toolName: chunk.toolName,
            args: chunk.input,
            toolCallId: chunk.toolCallId,
          },
          timestamp,
        };
      case "finish":
        return {
          id: this.getUniqueId("tool_call"),
          type: "finish",
          content: chunk.finishReason,
          timestamp,
        };

      case "error":
        return {
          id: this.getUniqueId("tool_call"),
          type: "error",
          content: JSON.stringify(chunk.error, null, 2),
          metadata: { error: chunk.error },
          timestamp,
        };

      default:
        return null;
    }
  }

  static getMetadata(): SystemAgentMetadata {
    return {
      id: "conversation",
      name: "ConversationAgent",
      type: "system",
      version: "1.0.0",
      provider: "atlas-system",
      description: "Interactive conversation agent for workspace collaboration",
      capabilities: [
        "text-generation",
        "conversation",
        "memory-enhanced",
        "context-aware",
      ],
      configSchema: {
        prompt: { type: "string", default: "You are a helpful AI assistant." },
        tools: { type: "array", default: [] },
      },
    };
  }

  private async loadConversationHistory(
    streamId: string,
  ): Promise<ConversationStorageOutput> {
    try {
      const storageTool = this.toolRegistry.getToolByName(
        "atlas_conversation_storage",
      );
      if (!storageTool?.execute) {
        return {
          success: false,
          error: "Conversation storage tool not available",
        };
      }

      const result = await storageTool.execute(
        {
          operation: "retrieve",
          streamId,
        },
        {
          toolCallId: crypto.randomUUID(),
          messages: [],
        },
      );

      if (result?.result) {
        const data = result.result;
        const messages = Array.isArray(data) ? data : data.messages;
        if (messages?.length) {
          return {
            success: true,
            messages,
            historyContext: messages
              .map(
                (m: { role: string; content: string }) => `${m.role}: ${m.content}`,
              )
              .join("\n"),
          };
        }
      }

      return { success: false, error: "No conversation history found" };
    } catch (error) {
      this.logger.warn("Failed to load conversation history", {
        streamId,
        error,
      });
      return { success: false, error: "Failed to load conversation history" };
    }
  }

  private async saveMessage(
    streamId: string,
    message: {
      role: "user" | "assistant";
      content: string;
    },
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const storageTool = this.toolRegistry.getToolByName(
        "atlas_conversation_storage",
      );
      if (!storageTool?.execute) {
        this.logger.warn(
          "Conversation storage tool not available for saving message",
        );
        return;
      }

      await storageTool.execute(
        {
          operation: "store",
          streamId,
          data: {
            message,
            metadata,
            timestamp: new Date().toISOString(),
          },
        },
        {
          toolCallId: crypto.randomUUID(),
          messages: [],
        },
      );
    } catch (error) {
      this.logger.warn("Failed to save message to conversation storage", {
        streamId,
        error,
      });
    }
  }
}
