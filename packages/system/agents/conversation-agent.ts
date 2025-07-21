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
import { streamText, tool } from "ai";
import { z } from "zod";
import { BaseAgent } from "../../../src/core/agents/base-agent-v2.ts";
import type { SystemAgentMetadata } from "../../../src/core/system-agent-registry.ts";

const ConversationInputSchema = z.object({
  message: z.string(),
  streamId: z.string().optional(),
  userId: z.string().optional(),
  conversationId: z.string().optional(), // Legacy field for backward compatibility
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
  type: "thinking" | "text" | "tool_call" | "tool_result" | "error";
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
  reasoning: string;
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
  private llmProvider = createAnthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
  private toolRegistry: AtlasToolRegistry;

  constructor(config: SystemAgentConfigObject, id?: string, toolRegistry?: AtlasToolRegistry) {
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
            missingTools.join(", ")
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
   * @param streaming - Optional callback for streaming response chunks
   * @returns Response object with text, reasoning, execution flow, and metadata
   *
   * Flow:
   * 1. Validates input and loads conversation history
   * 2. Prepares available tools from registry
   * 3. Executes AI streaming with configured model
   * 4. Processes stream events (thinking, text, tool calls)
   * 5. Persists conversation state
   */
  protected async execute(
    input?: unknown,
    streaming?: (data: string) => void,
  ): Promise<unknown> {
    this.logger.info("ConversationAgent execute called", {
      input: JSON.stringify(input),
      hasStreaming: !!streaming,
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

    if (streamId) {
      try {
        const historyResult = await this.loadConversationHistory(streamId);
        if (historyResult.success && historyResult.messages?.length) {
          historyContext = historyResult.historyContext || "";
          messagesInHistory = historyResult.messages.length;
          isNewConversation = false;
        }

        await this.saveMessage(streamId, {
          role: "user",
          content: message,
        }, { userId, timestamp: new Date().toISOString() });
      } catch (error) {
        this.logger.warn("Failed to handle conversation history", { error });
      }
    }

    const tools: Record<string, Tool> = {};
    for (const toolName of this.config.tools || []) {
      const tool = this.toolRegistry.getToolByName(toolName);
      if (tool) {
        tools[toolName] = tool;
      } else {
        this.logger.warn(`Tool not found in registry: ${toolName}`);
      }
    }

    // atlas_stream_reply is mandatory for sending responses to users
    if (!tools.atlas_stream_reply) {
      throw new Error(
        "atlas_stream_reply tool is required for conversation responses but not found in registry",
      );
    }

    // Wrap tools to inject context (especially streamId for atlas_stream_reply)
    const wrappedTools = this.wrapToolsWithContext(tools, streamId);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable not set. " +
          "Please configure your Anthropic API key to enable conversations.",
      );
    }

    // Debug: Log the actual tool objects
    this.logger.info("Tool configuration debug", {
      toolNames: Object.keys(wrappedTools),
      atlasStreamReplyTool: wrappedTools.atlas_stream_reply
        ? {
          hasExecute: !!wrappedTools.atlas_stream_reply.execute,
          hasDescription: !!wrappedTools.atlas_stream_reply.description,
          hasParameters: !!wrappedTools.atlas_stream_reply.parameters,
        }
        : null,
    });

    this.logger.info("Calling streamText with configuration", {
      model: "claude-3-7-sonnet-20250219",
      systemPromptLength: this.buildSystemPrompt(historyContext).length,
      systemPromptSnippet: this.buildSystemPrompt(historyContext).substring(0, 500),
      messageLength: message.length,
      toolCount: Object.keys(wrappedTools).length,
      tools: Object.keys(wrappedTools),
    });

    const { fullStream, text, reasoning } = streamText({
      model: this.llmProvider("claude-3-7-sonnet-20250219"),
      system: this.buildSystemPrompt(historyContext),
      messages: [{ role: "user", content: message }],
      tools: wrappedTools,
      toolChoice: "auto",
      maxSteps: 20, // Prevents infinite tool loops
      temperature: 0.7,
      maxTokens: 2000,
      experimental_toolCallStreaming: true,
      providerOptions: {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: 25000 },
        },
      },
    });

    const executionFlow: ExecutionFlow = {
      steps: [],
      reasoning: "",
      responseBuffer: "",
      thinkingBuffer: "",
    };

    try {
      for await (const chunk of fullStream) {
        const event = this.processStreamEvent(chunk);
        if (!event) continue;

        switch (event.type) {
          case "thinking":
            executionFlow.thinkingBuffer += event.content;
            if (streaming) streaming(`💭 ${event.content}`);
            break;

          case "text":
            executionFlow.responseBuffer += event.content;
            if (streaming) streaming(event.content);
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
              args: JSON.stringify(event.metadata?.args).substring(0, 200),
            });
            break;

          case "error":
            this.logger.error("Stream processing error", { error: event.content });
            if (streaming) streaming(`❌ Error: ${event.content}`);
            break;
        }
      }
    } catch (error) {
      this.logger.error("Error processing stream", {
        error: error instanceof Error ? error.message : String(error),
        streamId,
      });
      throw error;
    }

    const finalText = await text;
    const finalReasoning = await reasoning;

    if (streamId && finalText) {
      try {
        await this.saveMessage(streamId, {
          role: "assistant",
          content: finalText,
        }, { timestamp: new Date().toISOString(), reasoning: true });
      } catch (error) {
        this.logger.warn("Failed to save assistant message", { error });
      }
    }

    return {
      text: finalText || executionFlow.responseBuffer,
      reasoning: finalReasoning || executionFlow.thinkingBuffer || "",
      executionFlow: executionFlow.steps,
      response: finalText || executionFlow.responseBuffer, // Backward compatibility
      toolCalls: executionFlow.steps.filter((step) => step.type === "tool_call"),
      conversationMetadata: {
        streamId,
        messagesInHistory: messagesInHistory + 2,
        isNewConversation,
      },
    };
  }

  /**
   * Wrap tools with context injection
   */
  private wrapToolsWithContext(
    tools: Record<string, Tool>,
    streamId?: string,
  ): Record<string, Tool> {
    const wrappedTools: Record<string, Tool> = {};

    for (const [name, origTool] of Object.entries(tools)) {
      if (name === "atlas_stream_reply") {
        // Create a custom tool that doesn't require streamId as a parameter
        // The AI only needs to provide content and optional metadata
        wrappedTools[name] = tool({
          description:
            "Send a streaming reply to the user. This tool automatically includes the stream ID.",
          parameters: z.object({
            content: z.string().describe("The content to send as a streaming reply"),
            metadata: z.record(z.unknown()).optional().describe(
              "Optional metadata for the message",
            ),
          }),
          execute: async ({ content, metadata }) => {
            if (!streamId) {
              throw new Error(
                "streamId is required for atlas_stream_reply but was not provided in the conversation context",
              );
            }

            this.logger.info(`Executing atlas_stream_reply with injected streamId`, {
              content: content.substring(0, 100),
              streamId,
              hasMetadata: !!metadata,
            });

            // Call the original tool with all required parameters
            return await origTool.execute!({
              streamId,
              content,
              metadata,
            }, {
              toolCallId: crypto.randomUUID(),
              messages: [],
            });
          },
        });
      } else {
        // Pass through other tools unchanged
        wrappedTools[name] = origTool;
      }
    }

    return wrappedTools;
  }

  /**
   * Constructs system prompt that enforces tool usage patterns
   */
  private buildSystemPrompt(historyContext?: string): string {
    const basePrompt = this.config.prompt || "You are a helpful AI assistant.";

    return `${basePrompt}

${historyContext ? `\nConversation History:\n${historyContext}\n` : ""}

CRITICAL INSTRUCTIONS FOR TOOL USAGE:
1. You MUST ALWAYS use the 'atlas_stream_reply' tool to send ANY message to the user
2. NEVER respond with plain text - ALWAYS use atlas_stream_reply tool
3. For EVERY user message, you MUST call atlas_stream_reply to respond
4. The atlas_stream_reply tool only requires these parameters:
   - content: Your message text (REQUIRED)
   - metadata: Additional data (OPTIONAL)
   
DO NOT include streamId - it is automatically handled for you.

MANDATORY RESPONSE PATTERN:
When you receive any user message, respond using:
atlas_stream_reply({ content: "Your response here" })

EXAMPLE - CORRECT:
User: "Hello"
Your tool call: atlas_stream_reply({ content: "Hi there! How can I help you today?" })

EXAMPLE - INCORRECT:
- Responding without using the tool
- Including streamId in the parameters (it's automatic)`;
  }

  /**
   * Converts AI SDK stream chunks into structured events for processing
   *
   * @param chunk - Stream chunk from AI SDK
   * @returns Structured event or null if chunk type is not handled
   *
   * Known issue: tool-result chunks are not currently processed by the AI SDK
   */
  private processStreamEvent(chunk: TextStreamPart<Record<string, Tool>>): StreamEvent | null {
    const timestamp = Date.now();

    switch (chunk.type) {
      case "reasoning":
        return {
          type: "thinking",
          content: chunk.textDelta,
          timestamp,
        };

      case "text-delta":
        return {
          type: "text",
          content: chunk.textDelta,
          timestamp,
        };

      case "tool-call":
        return {
          type: "tool_call",
          content: `Calling ${chunk.toolName}`,
          metadata: {
            toolName: chunk.toolName,
            args: chunk.args,
            toolCallId: chunk.toolCallId,
          },
          timestamp,
        };

      case "error":
        return {
          type: "error",
          content: String(chunk.error),
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

  private async loadConversationHistory(streamId: string): Promise<ConversationStorageOutput> {
    try {
      const storageTool = this.toolRegistry.getToolByName("atlas_conversation_storage");
      if (!storageTool?.execute) {
        return { success: false, error: "Conversation storage tool not available" };
      }

      const result = await storageTool.execute({
        operation: "retrieve",
        streamId,
      }, {
        toolCallId: crypto.randomUUID(),
        messages: [],
      });

      if (result?.result) {
        const data = result.result;
        const messages = Array.isArray(data) ? data : data.messages;
        if (messages?.length) {
          return {
            success: true,
            messages,
            historyContext: messages.map((m: { role: string; content: string }) =>
              `${m.role}: ${m.content}`
            ).join("\n"),
          };
        }
      }

      return { success: false, error: "No conversation history found" };
    } catch (error) {
      this.logger.warn("Failed to load conversation history", { streamId, error });
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
      const storageTool = this.toolRegistry.getToolByName("atlas_conversation_storage");
      if (!storageTool?.execute) {
        this.logger.warn("Conversation storage tool not available for saving message");
        return;
      }

      await storageTool.execute({
        operation: "store",
        streamId,
        data: {
          message,
          metadata,
          timestamp: new Date().toISOString(),
        },
      }, {
        toolCallId: crypto.randomUUID(),
        messages: [],
      });
    } catch (error) {
      this.logger.warn("Failed to save message to conversation storage", { streamId, error });
    }
  }
}
