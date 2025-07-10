/**
 * ConversationAgent - System agent for interactive conversations
 * Extends BaseAgent with conversation-specific capabilities
 */

import { BaseAgent } from "../../../src/core/agents/base-agent-v2.ts";
import type { IAtlasAgent } from "../../../src/types/core.ts";
import { LLMProvider } from "../../../src/utils/llm/provider.ts";
import { DaemonCapabilityRegistry } from "../../../src/core/daemon-capabilities.ts";
import type { Tool } from "ai";
import {
  createReasoningMachine,
  type ReasoningAction,
  type ReasoningCallbacks,
  type ReasoningContext,
  type ReasoningResult,
} from "@atlas/reasoning";

export interface ConversationAgentConfig {
  model?: string;
  system_prompt?: string;
  prompts?: {
    system?: string;
    user?: string;
  };
  tools?: string[];
  temperature?: number;
  max_tokens?: number;
  use_reasoning?: boolean;
  max_reasoning_steps?: number;
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
      use_reasoning: false,
      max_reasoning_steps: 5,
      ...config,
    };

    // Check for prompts in config (passed from workspace) or use system_prompt
    const systemPrompt = config.prompts?.system ||
      this.config.system_prompt ||
      "You are a helpful AI assistant.";

    // Set agent prompts based on configuration
    this.setPrompts(systemPrompt, "");
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
      // Check if reasoning is enabled
      if (this.config.use_reasoning) {
        this.logger.info("Using reasoning-based conversation", {
          maxSteps: this.config.max_reasoning_steps,
          message: message.substring(0, 100),
        });

        return await this.executeWithReasoning(message, streamId);
      }

      // Check if we have tools configured
      const hasTools = this.config.tools && this.config.tools.length > 0;

      if (hasTools) {
        // Use tool-enabled completion for reasoning
        this.logger.info("Using tool-enabled completion", {
          toolCount: this.config.tools.length,
          tools: this.config.tools,
        });

        // Convert daemon capabilities to MCP-style tools
        const daemonTools = await this.getDaemonCapabilityTools(streamId);

        this.logger.info("Daemon tools prepared", {
          toolCount: Object.keys(daemonTools).length,
          toolKeys: Object.keys(daemonTools),
          streamId,
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
          // Create enhanced system prompt with streamId context
          const enhancedSystemPrompt = streamId
            ? `${this.prompts.system}\n\nIMPORTANT: When using the stream_reply tool, you MUST use stream_id: "${streamId}" (not "default" or any other value).`
            : this.prompts.system;

          // Use LLMProvider directly for tool-enabled completion
          const result = await LLMProvider.generateTextWithTools(message, {
            systemPrompt: enhancedSystemPrompt,
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
  private async getDaemonCapabilityTools(streamId?: string): Promise<Record<string, Tool>> {
    const tools: Record<string, any> = {};

    // Get all daemon capabilities that match our configured tools
    for (const toolName of this.config.tools || []) {
      const capability = DaemonCapabilityRegistry.getCapability(toolName);
      if (capability) {
        // Use the capability's inputSchema directly if available
        // Otherwise create a minimal schema
        const parameters = capability.inputSchema || {
          type: "object",
          properties: {},
          additionalProperties: true,
        };

        // Pass schema directly - LLMProvider will wrap with jsonSchema if needed
        tools[capability.id] = {
          description: capability.description,
          parameters: parameters,
          execute: async (args: any) => {
            this.logger.info(`Executing daemon capability: ${capability.id}`, { args, streamId });

            // Create daemon execution context
            const context = {
              sessionId: streamId || this.id,
              agentId: this.id,
              workspaceId: "atlas-conversation",
              daemon: DaemonCapabilityRegistry.getDaemonInstance(),
              conversationId: args.conversationId || streamId || this.id,
            };

            // Handle stream_reply - note the parameter names match the inputSchema
            if (capability.id === "stream_reply") {
              const result = await DaemonCapabilityRegistry.executeCapability(
                capability.id,
                context,
                args.stream_id || args.streamId || streamId || this.id, // Use provided streamId
                args.message,
                args.metadata,
                args.conversationId || streamId || this.id,
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

            // For other capabilities, pass args as-is
            const result = await DaemonCapabilityRegistry.executeCapability(
              capability.id,
              context,
              args,
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
   * Execute conversation with reasoning capabilities
   */
  private async executeWithReasoning(
    message: string,
    streamId?: string,
  ): Promise<unknown> {
    this.logger.info("Starting reasoning-based conversation", {
      message: message.substring(0, 100),
      streamId,
      hasStreamId: !!streamId,
    });

    try {
      // Create reasoning context
      const tools = await this.getDaemonCapabilityTools(streamId);

      this.logger.debug("Reasoning context tools prepared", {
        toolCount: Object.keys(tools).length,
        toolNames: Object.keys(tools),
      });

      const userContext = {
        message,
        streamId,
        conversationId: streamId || this.id,
        tools,
      };

      // Create reasoning callbacks
      const callbacks = {
        // Generate thinking based on conversation context
        think: async (context) => {
          this.logger.debug("Think callback invoked", {
            message: context.userContext.message.substring(0, 100),
            stepCount: context.steps.length,
            currentIteration: context.currentIteration,
          });

          try {
            const previousSteps = context.steps.map((s) => ({
              thinking: s.thinking,
              action: s.action,
              observation: s.observation,
            }));

            const thinkingPrompt = `
You are having a conversation with a user. Analyze what they need and plan your response.

User message: ${context.userContext.message}

${
              previousSteps.length > 0
                ? `Previous reasoning steps:
${JSON.stringify(previousSteps, null, 2)}`
                : ""
            }

Think step-by-step about:
1. What is the user asking for?
2. Do I need to use any tools to help them?
3. What would be the most helpful response?
4. Should I stream the response using stream_reply?

Provide your thinking in a structured way that leads to a clear action.`;

            this.logger.debug("Generating thinking with LLM", {
              promptLength: thinkingPrompt.length,
              systemPromptLength: this.prompts.system.length,
            });

            const thinking = await LLMProvider.generateText(thinkingPrompt, {
              systemPrompt:
                `${this.prompts.system}\n\nYou are now in reasoning mode. Plan your response step by step.`,
              model: this.config.model || "claude-3-5-sonnet-20241022",
              provider: "anthropic",
              temperature: 0.3,
              maxTokens: 1000,
            });

            this.logger.debug("Thinking generated", {
              thinkingLength: thinking.length,
              thinkingPreview: thinking.substring(0, 100),
            });

            return {
              thinking,
              confidence: 0.8, // Could analyze thinking to determine confidence
            };
          } catch (error) {
            this.logger.error("Think callback failed", {
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
          }
        },

        // Parse action from thinking
        parseAction: (thinking: string): ReasoningAction | null => {
          this.logger.debug("Parsing action from thinking", {
            thinkingLength: thinking.length,
          });

          // Look for tool usage patterns in thinking
          if (thinking.includes("stream_reply") || thinking.includes("respond to the user")) {
            return {
              type: "tool_call",
              toolName: "stream_reply",
              parameters: {},
              reasoning: "Streaming response to user",
            };
          }

          // Check if task is complete
          if (
            thinking.includes("task is complete") || thinking.includes("conversation is finished")
          ) {
            return {
              type: "complete",
              parameters: {},
              reasoning: "Conversation goal achieved",
            };
          }

          // Default to completing if no clear action
          return {
            type: "complete",
            parameters: {},
            reasoning: "No specific action needed",
          };
        },

        // Execute the determined action
        executeAction: async (action, context) => {
          this.logger.info("Executing reasoning action", {
            type: action.type,
            toolName: action.toolName,
          });

          if (action.type === "tool_call" && action.toolName) {
            const tools = context.userContext.tools;
            const tool = tools[action.toolName];

            if (tool) {
              // Generate appropriate parameters based on the tool
              let parameters: any = {};

              if (action.toolName === "stream_reply") {
                // Generate response based on conversation context and reasoning
                const responsePrompt = `
Based on the conversation and reasoning, generate a helpful response.

User message: ${context.userContext.message}

Reasoning: ${context.currentStep?.thinking || ""}

Generate a natural, helpful response that addresses the user's needs.`;

                const response = await LLMProvider.generateText(responsePrompt, {
                  systemPrompt: this.prompts.system,
                  model: this.config.model || "claude-3-5-sonnet-20241022",
                  provider: "anthropic",
                  temperature: this.config.temperature || 0.7,
                  maxTokens: this.config.max_tokens || 2000,
                });

                parameters = {
                  stream_id: context.userContext.streamId,
                  message: response,
                };
              }

              const result = await tool.execute(parameters);
              return {
                result,
                observation: `Tool ${action.toolName} executed successfully`,
              };
            }
          }

          return {
            result: null,
            observation: "Action completed",
          };
        },

        // Check if conversation goal is achieved
        isComplete: (context) => {
          // Complete after responding or reaching max iterations
          const hasResponded = context.steps.some(
            (step) => step.action?.toolName === "stream_reply",
          );
          return hasResponded || context.currentIteration >= context.maxIterations;
        },

        // Stream reasoning updates
        onThinkingStart: () => {
          this.logger.debug("Reasoning started");
        },
        onThinkingUpdate: (partial) => {
          this.logger.debug("Reasoning update", { partial: partial.substring(0, 100) });
        },
        onActionDetermined: (action) => {
          this.logger.info("Action determined", { action });
        },
        onObservation: (observation) => {
          this.logger.info("Observation", { observation });
        },
      };

      this.logger.info("About to create reasoning machine", {
        hasCallbacks: !!callbacks,
        callbackKeys: Object.keys(callbacks),
        maxIterations: this.config.max_reasoning_steps || 5,
      });

      // Create and run reasoning machine
      let machine;
      try {
        machine = createReasoningMachine(callbacks, {
          maxIterations: this.config.max_reasoning_steps || 5,
        });
        this.logger.info("Reasoning machine created successfully");
      } catch (error) {
        this.logger.error("Failed to create reasoning machine", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        });
        throw error;
      }

      // Run the machine with user context
      const result = await new Promise<ReasoningResult>((resolve, reject) => {
        try {
          const actor = machine.createActor({
            input: userContext,
          });

          this.logger.debug("Reasoning actor created");

          actor.subscribe({
            complete: () => {
              this.logger.debug("Reasoning actor completed");
              const snapshot = actor.getSnapshot();
              resolve(snapshot.output as ReasoningResult);
            },
            error: (error) => {
              this.logger.error("Reasoning machine error", {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                errorType: error instanceof Error ? error.constructor.name : typeof error,
              });
              reject(error);
            },
          });

          actor.start();
          this.logger.debug("Reasoning actor started");
        } catch (error) {
          this.logger.error("Failed to create reasoning actor", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
            fullError: String(error),
            userContext: {
              message: userContext.message,
              hasTools: !!userContext.tools,
              toolCount: Object.keys(userContext.tools || {}).length,
            },
          });
          reject(error);
        }
      }).catch((error) => {
        // Return a failed result instead of throwing
        this.logger.error("Reasoning execution failed, returning fallback result", {
          error: error instanceof Error ? error.message : String(error),
        });

        return {
          status: "failed",
          reasoning: {
            steps: [],
            totalIterations: 0,
            finalThinking: "Error occurred during reasoning",
            confidence: 0,
          },
          execution: {
            agentsExecuted: [],
            toolsExecuted: [],
            totalDuration: 0,
          },
          jobResults: {
            goal: "Respond to user",
            achieved: false,
            output: null,
            artifacts: {},
          },
          metrics: {
            llmTokens: 0,
            llmCost: 0,
            agentCalls: 0,
            toolCalls: 0,
          },
        } as ReasoningResult;
      });

      this.logger.info("Reasoning completed", {
        status: result.status,
        steps: result.reasoning.totalIterations,
        achieved: result.jobResults.achieved,
      });

      return {
        reasoning: result,
        response: result.jobResults.output,
      };
    } catch (error) {
      this.logger.error("executeWithReasoning failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
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
        use_reasoning: { type: "boolean", default: false },
        max_reasoning_steps: { type: "number", default: 5, min: 1, max: 20 },
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

    if (config.use_reasoning !== undefined && typeof config.use_reasoning !== "boolean") {
      errors.push("use_reasoning must be a boolean");
    }

    if (config.max_reasoning_steps !== undefined) {
      if (
        typeof config.max_reasoning_steps !== "number" ||
        config.max_reasoning_steps < 1 ||
        config.max_reasoning_steps > 20
      ) {
        errors.push("max_reasoning_steps must be a number between 1 and 20");
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
