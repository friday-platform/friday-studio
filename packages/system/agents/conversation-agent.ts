/**
 * ConversationAgent - System agent for interactive conversations
 * Extends BaseAgent with conversation-specific capabilities
 */

import { BaseAgent } from "../../../src/core/agents/base-agent-v2.ts";
import type { IAtlasAgent } from "../../../src/types/core.ts";
import { LLMProvider } from "../../../src/utils/llm/provider.ts";
import { DaemonCapabilityRegistry } from "../../../src/core/daemon-capabilities.ts";
import type { Tool } from "ai";

export interface ConversationAgentConfig {
  model?: string;
  system_prompt?: string;
  tools?: string[];
  temperature?: number;
  max_tokens?: number;
  [key: string]: any; // Allow additional properties from agent config
}

export class ConversationAgent extends BaseAgent implements IAtlasAgent {
  private config: ConversationAgentConfig;

  constructor(config: ConversationAgentConfig = {}, id?: string) {
    super(undefined, id);

    this.logger.info("ConversationAgent constructor called", {
      configKeys: Object.keys(config),
      config: JSON.stringify(config),
      hasTools: !!config.tools,
      toolsLength: config.tools?.length,
      tools: config.tools,
    });

    this.config = {
      model: "claude-3-5-sonnet-20241022",
      system_prompt: "You are a helpful AI assistant for Atlas workspace conversations.",
      tools: [],
      temperature: 0.7,
      max_tokens: 2000,
      ...config,
    };

    // Set agent prompts based on configuration
    this.setPrompts(
      this.config.system_prompt || "You are a helpful AI assistant.",
      "",
    );
  }

  // IAtlasAgent interface implementation
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

  controls(): object {
    return {
      model: this.config.model,
      temperature: this.config.temperature,
      max_tokens: this.config.max_tokens,
      tools: this.config.tools,
    };
  }

  /**
   * Get default model for this agent
   */
  protected override getDefaultModel(): string {
    return this.config.model || super.getDefaultModel();
  }

  /**
   * Execute conversation logic
   */
  protected async execute(
    input?: unknown,
    streaming?: (data: string) => void,
  ): Promise<unknown> {
    this.logger.info("ConversationAgent execute called", {
      inputType: typeof input,
      hasStreaming: !!streaming,
      input: JSON.stringify(input).substring(0, 200),
    });

    // Extract message and streamId from input
    const message = typeof input === "string" ? input : (input as any)?.message || "Hello";

    const streamId = (input as any)?.streamId;

    this.logger.info("Processing message", {
      message: message.substring(0, 100),
      systemPrompt: this.prompts.system.substring(0, 100),
      model: this.config.model,
      streamId,
    });

    try {
      // Check if we have tools configured
      const hasTools = this.config.tools && this.config.tools.length > 0;

      if (hasTools) {
        // Use tool-enabled completion for reasoning
        this.logger.info("Using tool-enabled completion", {
          toolCount: this.config.tools.length,
          tools: this.config.tools,
        });

        // Convert daemon capabilities to MCP-style tools
        const daemonTools = await this.getDaemonCapabilityTools();

        this.logger.info("Daemon tools prepared", {
          toolCount: Object.keys(daemonTools).length,
          toolKeys: Object.keys(daemonTools),
        });

        // Log tool format for debugging
        for (const [toolName, tool] of Object.entries(daemonTools)) {
          this.logger.info(`Tool details for ${toolName}`, {
            toolName,
            hasDescription: !!tool.description,
            description: tool.description,
            hasParameters: !!tool.parameters,
            hasExecute: !!tool.execute,
            parametersType: typeof tool.parameters,
            parametersConstructor: tool.parameters?.constructor?.name,
          });
        }

        this.logger.info("About to call generateTextWithTools", {
          message: message.substring(0, 100),
          toolCount: Object.keys(daemonTools).length,
          model: this.config.model || "claude-3-5-sonnet-20241022",
          temperature: this.config.temperature || 0.7,
        });

        try {
          // Use LLMProvider directly for tool-enabled completion
          const result = await LLMProvider.generateTextWithTools(message, {
            systemPrompt: this.prompts.system,
            model: this.config.model || "claude-3-5-sonnet-20241022",
            provider: "anthropic",
            temperature: this.config.temperature || 0.7,
            maxTokens: this.config.max_tokens || 4000,
            tools: daemonTools,
            maxSteps: 10,
            operationContext: {
              operation: "conversation_agent",
              agentId: this.id,
              streamId,
            },
          });

          this.logger.info("Tool-enabled response received", {
            responseLength: result.text?.length || 0,
            toolCallCount: result.toolCalls?.length || 0,
          });

          // The tool calls should already be executed by generateTextWithTools
          // including stream_reply if it was called
          return {
            response: result.text,
            toolCalls: result.toolCalls,
          };
        } catch (toolError) {
          this.logger.error("Tool execution error", {
            error: toolError instanceof Error ? toolError.message : String(toolError),
            stack: toolError instanceof Error ? toolError.stack : undefined,
            errorName: toolError instanceof Error ? toolError.constructor.name : typeof toolError,
            fullError: String(toolError),
            cause: toolError instanceof Error && (toolError as any).cause
              ? String((toolError as any).cause)
              : undefined,
            tools: Object.keys(daemonTools),
            model: this.config.model,
          });
          throw toolError;
        }
      } else {
        // Fallback to simple completion without tools
        const response = await LLMProvider.generateText(message, {
          systemPrompt: this.prompts.system,
          model: this.config.model || "claude-3-5-sonnet-20241022",
          provider: "anthropic",
          temperature: this.config.temperature || 0.7,
          maxTokens: this.config.max_tokens || 4000,
          operationContext: {
            operation: "conversation_agent",
            agentId: this.id,
          },
        });

        this.logger.info("ConversationAgent response received", {
          responseLength: response.length || 0,
        });

        // If we have a streamId, stream the response via daemon capability
        if (streamId && response) {
          this.logger.info("Streaming response", {
            streamId,
            contentLength: response.length,
          });
          await this.handleStreamReply(streamId, response);
        } else {
          this.logger.warn("Not streaming response", {
            hasStreamId: !!streamId,
            hasContent: !!response,
          });
        }

        return {
          response,
        };
      }
    } catch (error) {
      this.logger.error("ConversationAgent execution failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        fullError: String(error),
        cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
        hasTools: !!this.config.tools?.length,
        toolCount: this.config.tools?.length || 0,
      });
      throw error;
    }
  }

  /**
   * Convert daemon capabilities to tool format for LLM
   */
  private async getDaemonCapabilityTools(): Promise<Record<string, Tool>> {
    const { z } = await import("zod/v4");
    const tools: Record<string, any> = {};

    // Get all daemon capabilities that match our configured tools
    for (const toolName of this.config.tools || []) {
      const capability = DaemonCapabilityRegistry.getCapability(toolName);
      if (capability) {
        // Create proper Zod schema based on capability
        let parameters: any;

        if (capability.id === "stream_reply") {
          parameters = z.object({
            streamId: z.string().describe("Stream ID for the conversation"),
            message: z.string().describe("The message to stream to the user"),
            metadata: z.any().optional().describe("Optional metadata"),
            conversationId: z.string().optional().describe("Conversation ID"),
          });
        } else if (capability.id === "conversation_storage") {
          parameters = z.object({
            method: z.enum(["save", "load", "list", "delete"]).describe("Storage operation"),
            conversationId: z.string().optional().describe("Conversation ID"),
            data: z.any().optional().describe("Data to save"),
          });
        } else {
          // Generic schema for other capabilities
          parameters = z.object({
            args: z.array(z.any()).optional().describe("Arguments for the capability"),
          });
        }

        // AI SDK expects 'parameters' (not 'input_schema')
        tools[capability.id] = {
          description: capability.description,
          parameters: parameters,
          execute: async (args: any) => {
            this.logger.info(`Executing daemon capability: ${capability.id}`, { args });

            // Create daemon execution context
            const context = {
              sessionId: this.id,
              agentId: this.id,
              workspaceId: "atlas-conversation",
              daemon: DaemonCapabilityRegistry.getDaemonInstance(),
              conversationId: args.conversationId || this.id,
            };

            // Handle stream_reply specially
            if (capability.id === "stream_reply") {
              const result = await DaemonCapabilityRegistry.executeCapability(
                capability.id,
                context,
                args.streamId || this.id,
                args.message,
                args.metadata,
                args.conversationId || this.id,
              );
              return result;
            }

            // Handle conversation_storage
            if (capability.id === "conversation_storage") {
              const result = await DaemonCapabilityRegistry.executeCapability(
                capability.id,
                context,
                args.method,
                args.conversationId,
                args.data,
              );
              return result;
            }

            // Execute the capability with proper argument unpacking
            const result = await DaemonCapabilityRegistry.executeCapability(
              capability.id,
              context,
              ...(args.args || []),
            );

            return result;
          },
        };
      }
    }

    this.logger.info("Converted daemon capabilities to tools", {
      toolCount: Object.keys(tools).length,
      toolNames: Object.keys(tools),
    });

    return tools;
  }

  /**
   * Stream reply through daemon SSE capability
   */
  private async handleStreamReply(streamId: string, message: string): Promise<void> {
    this.logger.info("handleStreamReply called", { streamId, messageLength: message.length });

    try {
      const context = {
        sessionId: streamId,
        agentId: this.id,
        workspaceId: "atlas-conversation",
        daemon: null, // Will be set by registry
        conversationId: streamId,
      };

      this.logger.info("Calling stream_reply capability", {
        streamId,
        agentId: this.id,
        context,
      });

      const result = await DaemonCapabilityRegistry.executeCapability(
        "stream_reply",
        context,
        streamId,
        message,
        undefined, // metadata
        streamId, // conversationId
      );

      this.logger.info("Stream reply completed", {
        success: result?.success,
        messageId: result?.messageId,
        result,
      });

      if (!result?.success) {
        throw new Error(
          `Stream reply failed: ${result?.error || result?.message || "Unknown error"}`,
        );
      }
    } catch (error) {
      this.logger.error("Stream reply failed", {
        streamId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Static method to get agent metadata for registry
   */
  static getMetadata() {
    return {
      id: "conversation",
      name: "ConversationAgent",
      type: "system" as const,
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
        model: { type: "string", default: "claude-3-5-sonnet-20241022" },
        system_prompt: { type: "string", default: "You are a helpful AI assistant." },
        tools: { type: "array", default: [] },
        temperature: { type: "number", default: 0.7, min: 0, max: 2 },
        max_tokens: { type: "number", default: 2000, min: 1 },
      },
    };
  }

  /**
   * Validate configuration for this agent type
   */
  static validateConfig(config: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (config.model && typeof config.model !== "string") {
      errors.push("model must be a string");
    }

    if (config.system_prompt && typeof config.system_prompt !== "string") {
      errors.push("system_prompt must be a string");
    }

    if (config.tools && !Array.isArray(config.tools)) {
      errors.push("tools must be an array");
    }

    if (config.temperature !== undefined) {
      if (
        typeof config.temperature !== "number" || config.temperature < 0 || config.temperature > 2
      ) {
        errors.push("temperature must be a number between 0 and 2");
      }
    }

    if (config.max_tokens !== undefined) {
      if (typeof config.max_tokens !== "number" || config.max_tokens < 1) {
        errors.push("max_tokens must be a positive number");
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
