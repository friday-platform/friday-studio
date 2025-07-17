/**
 * ConversationAgent - System agent for interactive conversations
 * Extends BaseAgent with conversation-specific capabilities
 */

import { type SystemAgentConfigObject, SystemAgentConfigObjectSchema } from "@atlas/config";
import { LLMProvider } from "@atlas/core";
import {
  createReasoningMachine,
  parseAction as parseReasoningAction,
  type ReasoningAction,
  type ReasoningCallbacks,
  type ReasoningResult,
} from "@atlas/reasoning";
import type { Tool } from "ai";
import { createActor } from "xstate";
import { z } from "zod";
import { BaseAgent } from "../../../src/core/agents/base-agent-v2.ts";
import {
  ConversationStorageOutput,
  createStreamsImplementation,
  DaemonCapabilityRegistry,
  type DaemonExecutionContext,
} from "../../../src/core/daemon-capabilities.ts";
import type { SystemAgentMetadata } from "../../../src/core/system-agent-registry.ts";
import {
  type AgentExecutionContext,
  WorkspaceCapabilityRegistry,
} from "../../../src/core/workspace-capabilities.ts";
import { ValidationError } from "../../../src/utils/errors.ts";

// Schema for execute method input validation
const ConversationInputSchema = z.object({
  message: z.string(),
  streamId: z.string().optional(),
  userId: z.string().optional(),
  conversationId: z.string().optional(),
});

type ConversationInput = z.infer<typeof ConversationInputSchema>;

// Interface for controls() method return type
interface ConversationAgentControls {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: string[];
}

// Interface for tool execution options
interface ConversationToolExecutionOptions {
  toolCallId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  agentId: string;
  streamId?: string;
}

// Schema for reasoning action arguments
const ReasoningActionArgsSchema = z.object({
  thinking: z.string(),
  action: z.enum(["tool_call", "complete"]),
  toolName: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  reasoning: z.string(),
  messageContent: z.string().optional(),
});

type ReasoningActionArgs = z.infer<typeof ReasoningActionArgsSchema>;

// Interface for reasoning user context
interface ReasoningUserContext {
  message: string;
  streamId?: string;
  conversationId: string;
  tools: Record<string, Tool>;
  historyContext?: string;
  draftId: string | null;
  streamedMessage?: string;
}

// Using SystemAgentMetadata from system-agent-registry.ts

export class ConversationAgent extends BaseAgent {
  private agentConfig: SystemAgentConfigObject;

  constructor(config: SystemAgentConfigObject, id?: string) {
    super(undefined, id);

    // Parse and validate the configuration
    let parsedConfig: SystemAgentConfigObject;
    try {
      parsedConfig = SystemAgentConfigObjectSchema.parse(config);
    } catch (e) {
      if (e instanceof z.ZodError) {
        throw new ValidationError("Invalid configuration for ConversationAgent", e);
      }
      throw e;
    }

    this.logger.info("ConversationAgent constructor called", {
      configKeys: Object.keys(parsedConfig),
      config: JSON.stringify(parsedConfig),
      hasTools: !!parsedConfig.tools,
      toolsLength: parsedConfig.tools?.length,
      tools: parsedConfig.tools,
    });

    this.agentConfig = {
      model: "gemini-2.5-flash",
      prompt: "You are a helpful AI assistant for Atlas workspace conversations.",
      tools: [],
      temperature: 0.7,
      max_tokens: 2000,
      use_reasoning: false,
      max_reasoning_steps: 5,
      ...parsedConfig,
    };

    // Use prompt from config or default
    const systemPrompt = this.agentConfig.prompt ||
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

  controls(): ConversationAgentControls {
    return {
      model: this.agentConfig.model,
      temperature: this.agentConfig.temperature,
      max_tokens: this.agentConfig.max_tokens,
      tools: this.agentConfig.tools,
    };
  }

  /**
   * Get default model for this agent
   */
  protected override getDefaultModel(): string {
    return this.agentConfig.model || super.getDefaultModel();
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

    // Validate and extract input parameters
    let validatedInput: ConversationInput;
    try {
      validatedInput = ConversationInputSchema.parse(input);
    } catch (e) {
      if (e instanceof z.ZodError) {
        throw new ValidationError("Invalid input for ConversationAgent", e);
      }
      throw e;
    }

    const { message, streamId, userId } = validatedInput;
    const conversationId = validatedInput.conversationId || streamId;

    this.logger.info("Processing message", {
      message: message.substring(0, 100),
      systemPrompt: this.prompts.system.substring(0, 100),
      model: this.agentConfig.model,
      streamId,
      userId,
      conversationId,
    });

    // Load conversation history if we have a streamId
    let historyContext = "";
    let historyMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    let messagesInHistory = 0;
    let isNewConversation = true;

    if (streamId) {
      try {
        const historyResult = await this.loadConversationHistory(streamId);
        if (
          historyResult.success && "messages" in historyResult && historyResult.messages.length > 0
        ) {
          historyContext = historyResult.historyContext || "";
          messagesInHistory = historyResult.messages.length;
          isNewConversation = false;

          // Convert messages to proper format
          historyMessages = historyResult.messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          }));

          this.logger.info("Loaded conversation history", {
            streamId,
            messageCount: messagesInHistory,
            contextLength: historyContext.length,
          });
        }
      } catch (error) {
        this.logger.warn("Failed to load conversation history", {
          streamId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Save user message before processing
    if (streamId) {
      try {
        await this.saveMessage(streamId, {
          role: "user",
          content: message,
          metadata: {
            userId,
            timestamp: new Date().toISOString(),
            workspaceContext: "atlas-conversation",
          },
        });
      } catch (error) {
        this.logger.warn("Failed to save user message", {
          streamId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      // Check if reasoning is enabled
      if (this.agentConfig.use_reasoning) {
        // Check if this is a simple greeting or acknowledgment
        const isSimpleMessage = this.isSimpleMessage(message);

        if (isSimpleMessage) {
          this.logger.info("Using fast-path for simple message", {
            message: message.substring(0, 100),
          });

          // Fast path - generate response with tool support but without reasoning
          const response = await this.generateSimpleResponseWithTools(
            message,
            streamId,
            historyMessages,
          );

          // If response is null, it means the query is complex and needs reasoning
          if (response === null) {
            this.logger.info("Fast-path determined message needs full reasoning, delegating");
            // Fall through to reasoning execution below
          } else {
            // Save the response
            if (streamId && response) {
              await this.saveMessage(streamId, {
                role: "assistant",
                content: response,
                metadata: {
                  timestamp: new Date().toISOString(),
                  fastPath: true,
                },
              });
            }

            return {
              response,
              conversationMetadata: {
                streamId,
                messagesInHistory: messagesInHistory + 2,
                isNewConversation,
                fastPath: true,
              },
            };
          }
        }

        this.logger.info("Using reasoning-based conversation", {
          maxSteps: this.agentConfig.max_reasoning_steps,
          message: message.substring(0, 100),
        });

        const result = await this.executeWithReasoning(message, streamId, historyContext);

        // Save assistant response if we got one
        if (streamId && result && typeof result === "object" && "response" in result) {
          await this.saveMessage(streamId, {
            role: "assistant",
            content: String(result.response),
            metadata: {
              timestamp: new Date().toISOString(),
              reasoning: true,
            },
          });
        }

        // Add conversation metadata to result
        return {
          ...(typeof result === "object" && result !== null ? result : {}),
          conversationMetadata: {
            streamId,
            messagesInHistory: messagesInHistory + 2, // user + assistant
            isNewConversation,
          },
        };
      }

      // Check if we have tools configured
      const hasTools = this.agentConfig.tools && this.agentConfig.tools.length > 0;

      if (hasTools) {
        // Use tool-enabled completion for reasoning
        this.logger.info("Using tool-enabled completion", {
          toolCount: this.agentConfig.tools.length,
          tools: this.agentConfig.tools,
        });

        // Convert daemon capabilities to MCP-style tools
        const daemonTools = this.getDaemonCapabilityTools(streamId);

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
          model: this.agentConfig.model || "claude-3-5-sonnet-20241022",
          temperature: this.agentConfig.temperature || 0.7,
        });

        try {
          // Create enhanced system prompt with streamId and history context
          let enhancedSystemPrompt = this.prompts.system;
          if (historyContext) {
            enhancedSystemPrompt = `${historyContext}\n\n${enhancedSystemPrompt}`;
          }
          if (streamId) {
            enhancedSystemPrompt =
              `${enhancedSystemPrompt}\n\nIMPORTANT: When using the stream_reply tool, you MUST use stream_id: "${streamId}" (not "default" or any other value).`;
          }

          // Use LLMProvider with unified API for tool-enabled completion
          const result = await LLMProvider.generateText(message, {
            systemPrompt: enhancedSystemPrompt,
            model: this.agentConfig.model || "claude-3-5-sonnet-20241022",
            provider: "google",
            temperature: this.agentConfig.temperature || 0.7,
            max_tokens: this.agentConfig.max_tokens || 4000,
            tools: daemonTools,
            max_steps: 10,
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

          // Save assistant response
          if (streamId && result.text) {
            await this.saveMessage(streamId, {
              role: "assistant",
              content: result.text,
              metadata: {
                timestamp: new Date().toISOString(),
                toolCallCount: result.toolCalls?.length || 0,
              },
            });
          }

          // The tool calls should already be executed by generateTextWithTools
          // including stream_reply if it was called
          return {
            response: result.text,
            toolCalls: result.toolCalls,
            conversationMetadata: {
              streamId,
              messagesInHistory: messagesInHistory + 2, // user + assistant
              isNewConversation,
            },
          };
        } catch (toolError) {
          this.logger.error("Tool execution error", {
            error: toolError instanceof Error ? toolError.message : String(toolError),
            stack: toolError instanceof Error ? toolError.stack : undefined,
            errorName: toolError instanceof Error ? toolError.constructor.name : typeof toolError,
            fullError: String(toolError),
            cause: toolError instanceof Error && toolError.cause
              ? String(toolError.cause)
              : undefined,
            tools: Object.keys(daemonTools),
            model: this.agentConfig.model,
          });
          throw toolError;
        }
      } else {
        // Fallback to simple completion without tools
        let enhancedSystemPrompt = this.prompts.system;
        if (historyContext) {
          enhancedSystemPrompt = `${historyContext}\n\n${enhancedSystemPrompt}`;
        }
        const response = await LLMProvider.generateText(message, {
          systemPrompt: enhancedSystemPrompt,
          model: this.agentConfig.model || "claude-3-5-sonnet-20241022",
          provider: "google",
          temperature: this.agentConfig.temperature || 0.7,
          max_tokens: this.agentConfig.max_tokens || 4000,
          operationContext: {
            operation: "conversation_agent",
            agentId: this.id,
          },
        });

        this.logger.info("ConversationAgent response received", {
          responseLength: response.text.length || 0,
        });

        // If we have a streamId, stream the response via daemon capability
        if (streamId && response.text) {
          this.logger.info("Streaming response", {
            streamId,
            contentLength: response.text.length,
          });
          await this.handleStreamReply(streamId, response.text);
        } else {
          this.logger.warn("Not streaming response", {
            hasStreamId: !!streamId,
            hasContent: !!response,
          });
        }

        // Save assistant response
        if (streamId && response.text) {
          await this.saveMessage(streamId, {
            role: "assistant",
            content: response.text,
            metadata: {
              timestamp: new Date().toISOString(),
            },
          });
        }

        return {
          response: response.text,
          conversationMetadata: {
            streamId,
            messagesInHistory: messagesInHistory + 2, // user + assistant
            isNewConversation,
          },
        };
      }
    } catch (error) {
      this.logger.error("ConversationAgent execution failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        fullError: String(error),
        cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
        hasTools: !!this.agentConfig.tools?.length,
        toolCount: this.agentConfig.tools?.length || 0,
      });
      throw error;
    }
  }

  /**
   * Convert daemon and workspace capabilities to tool format for LLM
   */
  private getDaemonCapabilityTools(streamId?: string): Record<string, Tool> {
    const tools: Record<string, Tool> = {};

    // Ensure workspace capabilities are initialized
    WorkspaceCapabilityRegistry.initialize();

    // Get all daemon and workspace capabilities that match our configured tools
    for (const toolName of this.agentConfig.tools || []) {
      // First check daemon capabilities
      const capability = DaemonCapabilityRegistry.getCapability(toolName);

      if (capability) {
        // Create execution context for daemon capabilities
        const daemonContext: DaemonExecutionContext = {
          sessionId: streamId || this.id,
          agentId: this.id,
          workspaceId: "atlas-conversation",
          daemon: DaemonCapabilityRegistry.getDaemonInstance(),
          conversationId: streamId || this.id,
          streams: createStreamsImplementation(),
        };

        // Use toTool method directly
        const tool = capability.toTool(daemonContext);
        tools[capability.id] = tool;

        // Debug logging for tool structure
        this.logger.info("Created daemon capability tool", {
          toolId: capability.id,
          toolDescription: tool.description,
          hasParameters: !!tool.parameters,
          parametersType: typeof tool.parameters,
          hasExecute: !!tool.execute,
          // Log the actual parameter schema for stream_reply
          ...(capability.id === "stream_reply" && tool.parameters && {
            streamReplySchema: {
              type: tool.parameters.constructor.name,
              // Safely access shape - it might be a function or property depending on Zod version
              shape: tool.parameters._def?.shape
                ? (typeof tool.parameters._def.shape === "function"
                  ? Object.keys(tool.parameters._def.shape() || {})
                  : Object.keys(tool.parameters._def.shape || {}))
                : "no shape available",
            },
          }),
        });
        continue;
      }

      // If not found in daemon capabilities, check workspace capabilities
      const workspaceCapability = WorkspaceCapabilityRegistry.getCapability(toolName);
      if (workspaceCapability) {
        // Create execution context for workspace capabilities
        const workspaceContext: AgentExecutionContext = {
          workspaceId: "atlas-conversation",
          sessionId: streamId || this.id,
          agentId: this.id,
          conversationId: streamId || this.id,
        };

        // Use toTool method directly
        tools[workspaceCapability.id] = workspaceCapability.toTool(workspaceContext);
      }
    }

    this.logger.info("Converted capabilities to tools", {
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
      const context: DaemonExecutionContext = {
        sessionId: streamId,
        agentId: this.id,
        workspaceId: "atlas-conversation",
        daemon: DaemonCapabilityRegistry.getDaemonInstance(),
        conversationId: streamId,
        streams: createStreamsImplementation(),
      };

      this.logger.info("Calling stream_reply capability", {
        streamId,
        agentId: this.id,
        context,
      });

      const streamReplyCapability = DaemonCapabilityRegistry.getCapability("stream_reply");
      if (!streamReplyCapability) {
        throw new Error("Stream reply capability not found");
      }

      const tool = streamReplyCapability.toTool(context);

      // Create execution options required by AI SDK
      const executionOptions: ConversationToolExecutionOptions = {
        toolCallId: crypto.randomUUID(),
        messages: [],
        agentId: this.id,
        streamId,
      };

      const result = await tool.execute({
        stream_id: streamId,
        message,
        metadata: undefined,
        conversationId: streamId,
      }, executionOptions);

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
    historyContext?: string,
  ): Promise<unknown> {
    this.logger.info("Starting reasoning-based conversation", {
      message: message.substring(0, 100),
      streamId,
      hasStreamId: !!streamId,
    });

    try {
      // Create reasoning context
      const tools = this.getDaemonCapabilityTools(streamId);

      this.logger.info("Reasoning context tools prepared", {
        toolCount: Object.keys(tools).length,
        toolNames: Object.keys(tools),
      });

      const userContext: ReasoningUserContext = {
        message,
        streamId,
        conversationId: streamId || this.id,
        tools,
        historyContext,
        // Track draft ID across reasoning steps
        draftId: null,
      };

      // Create reasoning callbacks
      const callbacks: ReasoningCallbacks<ReasoningUserContext> = {
        // Generate thinking based on conversation context
        think: async (context) => {
          const userCtx = context.userContext;
          this.logger.info("Think callback invoked", {
            message: userCtx.message.substring(0, 100),
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
You are having a conversation with a user. Use the reasoning_action tool to analyze what they need and plan your response.

${
              userCtx.historyContext
                ? `Conversation history:\n${userCtx.historyContext}\n\n`
                : ""
            }User message: ${userCtx.message}

${
              previousSteps.length > 0
                ? `Previous reasoning steps:
${JSON.stringify(previousSteps, null, 2)}`
                : ""
            }

Available tools: ${Object.keys(userCtx.tools).join(", ")}
${
              userCtx.draftId
                ? `\nCurrent draft ID: ${userCtx.draftId} (use this for workspace operations)\n`
                : ""
            }

Use the reasoning_action tool to:
1. Analyze what the user is asking for
2. Determine what tools you need to use
3. Check if you're in the middle of a multi-step process

If you're creating a workspace after user confirmation:
- First use stream_reply to acknowledge
- Then CONTINUE reasoning to call workspace_draft_create

If the user is confirming but you've already completed all the actions:
- Use stream_reply to acknowledge what's been done
- Then set action to "complete" to finish the reasoning

For the reasoning_action tool:
- thinking: Your detailed analysis of what the user needs and your current progress
- action: Either "tool_call" or "complete"
- toolName: The name of the tool to call (if action is tool_call)
- parameters: The complete parameters for the tool call (if action is tool_call)
- reasoning: Why you chose this action

CRITICAL: For stream_reply tool calls, ALWAYS include these required parameters:
- stream_id: "${userCtx.streamId}" (use this exact value)
- message: "your response message to the user" (REQUIRED - cannot be empty)

EXAMPLES of proper parameters for stream_reply:
{
  "parameters": {
    "stream_id": "${userCtx.streamId}",
    "message": "I'll help you create an email monitoring workspace. Let me understand your requirements..."
  }
}

Or you can use messageContent field instead:
{
  "messageContent": "I'll help you create an email monitoring workspace. Let me understand your requirements..."
}

For workspace_draft_create parameters, include:
- name: workspace name
- description: workspace description  
- initialConfig: the full WorkspaceConfig object with version, workspace, signals, jobs, agents, and tools`;

            this.logger.debug("Generating thinking with LLM", {
              promptLength: thinkingPrompt.length,
              systemPromptLength: this.prompts.system.length,
            });

            // Use structured output for better reliability
            const reasoningTool: Record<string, Tool> = {
              reasoning_action: {
                description: "Determine the next action in the reasoning process",
                parameters: z.object({
                  thinking: z.string().describe(
                    "Your detailed analysis of what the user needs and your current progress",
                  ),
                  action: z.enum(["tool_call", "complete"]).describe("The type of action to take"),
                  toolName: z.string().optional().describe(
                    "The name of the tool to call (if action is tool_call)",
                  ),
                  parameters: z.record(z.string(), z.unknown()).optional().describe(
                    "The parameters for the tool call (if action is tool_call). For stream_reply, include 'message' with the content to send. For workspace_draft_create, include 'name', 'description', and 'initialConfig'.",
                  ),
                  reasoning: z.string().describe("Why you chose this action"),
                  // Add explicit field for stream_reply message content
                  messageContent: z.string().optional().describe(
                    "If using stream_reply, put the full message content here instead of in parameters",
                  ),
                }),
                execute: (args) => {
                  // This tool is only used for structured output, not actual execution
                  return args;
                },
              },
            };

            // Include all available tools so the LLM knows what's available
            // The reasoning_action tool should be first for priority
            const allToolsForReasoning = {
              ...reasoningTool,
              ...context.userContext.tools, // Include all tools from userContext
            };

            const result = await LLMProvider.generateText(thinkingPrompt, {
              systemPrompt:
                `${this.prompts.system}\n\nYou are now in reasoning mode. Plan your response step by step.\n\nAvailable tools: ${
                  Object.keys(context.userContext.tools).join(", ")
                }`,
              model: this.agentConfig.model || "claude-3-5-sonnet-20241022",
              provider: "google",
              temperature: 0.3,
              max_tokens: 8000, // Near Claude 3.5 Sonnet's limit of 8192
              tools: allToolsForReasoning,
              tool_choice: { type: "tool", toolName: "reasoning_action" }, // Force use of reasoning_action
              operationContext: {
                operation: "conversation_reasoning",
                agentId: this.id,
              },
            });

            // Extract the structured output from tool calls
            const toolCall = result.toolCalls?.[0];
            if (toolCall?.toolName === "reasoning_action" && toolCall.args) {
              let validatedArgs: ReasoningActionArgs;
              try {
                validatedArgs = ReasoningActionArgsSchema.parse(toolCall.args);
              } catch (e) {
                if (e instanceof z.ZodError) {
                  throw new ValidationError("Invalid reasoning action arguments", e);
                }
                throw e;
              }

              const { thinking, action, toolName, parameters, reasoning, messageContent } =
                validatedArgs;

              // If messageContent is provided for stream_reply, ensure it's in parameters
              let finalParameters = parameters || {};
              if (toolName === "stream_reply" && messageContent) {
                finalParameters = { message: messageContent, ...finalParameters };
              }

              // Embed the structured action data in the thinking for the parseAction callback
              const thinkingWithAction = `${thinking}\n\n[ACTION_DATA]${
                JSON.stringify({
                  action,
                  toolName,
                  parameters: finalParameters,
                  reasoning,
                })
              }[/ACTION_DATA]`;

              this.logger.info("Thinking generated with structured action", {
                thinkingLength: thinking.length,
                action,
                toolName,
                hasParameters: !!parameters,
                parametersPreview: parameters
                  ? JSON.stringify(parameters).substring(0, 200)
                  : "no parameters",
              });

              return {
                thinking: thinkingWithAction,
                confidence: 0.9, // Higher confidence with structured output
              };
            }

            // Fallback if no structured output
            const thinking = result.text || "No thinking generated";
            this.logger.info("Thinking generated (fallback)", {
              thinkingLength: thinking.length,
              thinkingPreview: thinking.substring(0, 200) + "...",
            });

            return {
              thinking,
              confidence: 0.7, // Lower confidence without structured output
            };
          } catch (error) {
            this.logger.error("Think callback failed", {
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
            throw error;
          }
        },

        // Parse action from thinking - now using structured output
        parseAction: (thinking: string): ReasoningAction | null => {
          this.logger.info("Parsing action from thinking", {
            thinkingLength: thinking.length,
            thinkingPreview: thinking.substring(0, 200),
          });

          // In the new approach, we pass structured data through the thinking
          // The thinking callback should have embedded the structured action
          try {
            // Look for embedded JSON in the thinking
            const jsonMatch = thinking.match(/\[ACTION_DATA\](.*)\[\/ACTION_DATA\]/s);
            if (jsonMatch && typeof jsonMatch.index === "number") {
              const actionData = JSON.parse(jsonMatch[1]);
              const thinkingText = thinking.substring(0, jsonMatch.index).trim();

              // If stream_reply is called without a message, use the thinking text as a fallback
              if (
                actionData.toolName === "stream_reply" &&
                (!actionData.parameters || !actionData.parameters.message) &&
                thinkingText
              ) {
                this.logger.info(
                  "stream_reply is missing a message, using thinking text as fallback.",
                  { thinkingText: thinkingText.substring(0, 100) },
                );
                if (!actionData.parameters) {
                  actionData.parameters = {};
                }
                actionData.parameters.message = thinkingText;
              }

              this.logger.info("Parsed structured action", {
                type: actionData.action,
                toolName: actionData.toolName,
                hasParameters: !!actionData.parameters,
              });

              return {
                type: actionData.action,
                toolName: actionData.toolName,
                parameters: actionData.parameters || {},
                reasoning: actionData.reasoning || "No reasoning provided",
              };
            }
          } catch (e) {
            this.logger.warn("Failed to parse embedded action data", { error: e });
          }

          // Fallback to regex parsing for backwards compatibility
          const action = parseReasoningAction(thinking);

          if (action) {
            this.logger.info("Parsed action via regex", {
              type: action.type,
              toolName: action.toolName,
              hasParameters: !!action.parameters,
              parameters: action.parameters,
            });
          } else {
            this.logger.warn("No action parsed from thinking");
          }

          return action;
        },

        // Execute the determined action
        executeAction: async (action, context) => {
          const userCtx = context.userContext;
          this.logger.info("Executing reasoning action", {
            type: action.type,
            toolName: action.toolName,
          });

          if (action.type === "tool_call" && action.toolName) {
            const tools = userCtx.tools;
            const tool = tools[action.toolName];

            if (tool) {
              // Use the parameters from the parsed action
              const parameters = action.parameters || {};

              // For stream_reply, ensure we have the required fields
              if (action.toolName === "stream_reply") {
                // Use streamId from context if not in parameters
                if (!parameters.stream_id && userCtx.streamId) {
                  parameters.stream_id = userCtx.streamId;
                }

                // If message is missing, this suggests the reasoning failed to provide proper parameters
                // Log the issue and provide a default friendly response
                if (!parameters.message || typeof parameters.message !== "string") {
                  this.logger.warn("stream_reply called without proper message parameter", {
                    toolName: action.toolName,
                    parameters: JSON.stringify(parameters),
                    reasoning: action.reasoning,
                    userMessage: userCtx.message,
                  });

                  // Provide a default friendly response based on the user's message
                  if (
                    userCtx.message.toLowerCase().trim().match(
                      /^(hi|hello|hey|good morning|good afternoon|good evening)/,
                    )
                  ) {
                    parameters.message =
                      "Hi! I'm here to help you with Atlas. What would you like to work on?";
                  } else {
                    parameters.message =
                      "I'm here to help! Could you tell me more about what you'd like to do?";
                  }
                }
              }

              this.logger.info("Executing tool with parameters", {
                toolName: action.toolName,
                parameters: JSON.stringify(parameters),
              });

              const toolExecutionOptions: ConversationToolExecutionOptions = {
                toolCallId: crypto.randomUUID(),
                messages: [], // Could be populated with conversation history if needed
                agentId: this.id,
                streamId: userCtx.streamId,
              };

              const result = await tool.execute(parameters, toolExecutionOptions);

              // Track the message that was sent for stream_reply
              if (action.toolName === "stream_reply" && parameters.message) {
                // Store the streamed message in context for later saving
                context.userContext.streamedMessage = parameters.message;
              }

              // Track the draft ID from workspace_draft_create
              if (action.toolName === "workspace_draft_create") {
                this.logger.info("workspace_draft_create result", {
                  result: JSON.stringify(result),
                  hasDraftId: !!result?.draftId,
                  hasSuccess: !!result?.success,
                  keys: result ? Object.keys(result) : [],
                });

                if (result?.draftId) {
                  context.userContext.draftId = result.draftId;
                  this.logger.info("Captured draft ID from workspace creation", {
                    draftId: result.draftId,
                  });
                } else if (result?.error) {
                  this.logger.error("workspace_draft_create failed", {
                    error: result.error,
                    result: JSON.stringify(result),
                  });
                }
              }

              // Use stored draft ID for subsequent workspace operations
              if (
                [
                  "validate_draft_config",
                  "pre_publish_check",
                  "publish_workspace",
                  "show_draft_config",
                  "workspace_draft_update",
                ].includes(action.toolName)
              ) {
                if (!parameters.draftId && context.userContext.draftId) {
                  parameters.draftId = context.userContext.draftId;
                  this.logger.info("Using stored draft ID for workspace operation", {
                    toolName: action.toolName,
                    draftId: context.userContext.draftId,
                  });
                }
              }

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
          // Don't complete just because we used stream_reply
          // We might need to continue with workspace creation or other actions

          // Check if we're in the middle of a workspace creation flow
          const lastStep = context.steps[context.steps.length - 1];
          const lastMessage = context.userContext.streamedMessage ||
            lastStep?.action?.parameters?.message || "";

          // If we just confirmed we're creating something, don't stop
          const creationPhrases = [
            "create",
            "build",
            "set up",
            "configure",
            "proceed",
            "let me",
            "i'll",
            "now",
            "creating",
          ];
          const isCreatingWorkspace = creationPhrases.some((phrase) =>
            lastMessage.toLowerCase().includes(phrase)
          );

          if (isCreatingWorkspace && context.currentIteration < 3) {
            return false; // Continue to actually create the workspace
          }

          // Complete if we've done substantial work or hit max iterations
          return context.currentIteration >= context.maxIterations;
        },

        // Stream reasoning updates
        onThinkingStart: () => {
          this.logger.info("Reasoning started");
        },
        onThinkingUpdate: (partial) => {
          this.logger.info("Reasoning update", { partial });
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
        maxIterations: this.agentConfig.max_reasoning_steps || 5,
      });

      // Create and run reasoning machine
      let machine;
      try {
        machine = createReasoningMachine(callbacks, {
          maxIterations: this.agentConfig.max_reasoning_steps || 5,
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
          const actor = createActor(machine, {
            input: userContext,
          });

          this.logger.info("Reasoning actor created");

          actor.subscribe({
            complete: () => {
              this.logger.info("Reasoning actor completed");
              const snapshot = actor.getSnapshot();
              resolve(snapshot.output);
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
          this.logger.info("Reasoning actor started");
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
        };
      });

      this.logger.info("Reasoning completed", {
        status: result.status,
        steps: result.reasoning.totalIterations,
        achieved: result.jobResults.achieved,
        finalThinking: result.reasoning.finalThinking?.substring(0, 200),
      });

      // Get the actual message that was streamed to the user
      const streamedMessage = userContext.streamedMessage ||
        result.jobResults.output;

      return {
        reasoning: result,
        response: streamedMessage,
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
  static getMetadata(): SystemAgentMetadata {
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
        prompt: { type: "string", default: "You are a helpful AI assistant." },
        tools: { type: "array", default: [] },
        temperature: { type: "number", default: 0.7, min: 0, max: 2 },
        max_tokens: { type: "number", default: 2000, min: 1 },
        use_reasoning: { type: "boolean", default: false },
        max_reasoning_steps: { type: "number", default: 5, min: 1, max: 20 },
      },
    };
  }

  /**
   * Load conversation history using daemon capability
   */
  private async loadConversationHistory(streamId: string): Promise<ConversationStorageOutput> {
    try {
      const tools = this.getDaemonCapabilityTools(streamId);
      if (tools.conversation_storage?.execute) {
        const executionOptions: ConversationToolExecutionOptions = {
          toolCallId: crypto.randomUUID(),
          messages: [],
          agentId: this.id,
          streamId,
        };

        return await tools.conversation_storage.execute({
          action: "load_history",
          stream_id: streamId,
        }, executionOptions);
      }
    } catch (error) {
      this.logger.error("Failed to load conversation history", {
        streamId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { success: false, error: "Failed to load conversation history" };
  }

  /**
   * Save message to conversation history using daemon capability
   */
  private async saveMessage(
    streamId: string,
    message: {
      role: "user" | "assistant";
      content: string;
      metadata?: Record<string, any>;
    },
  ): Promise<void> {
    try {
      const tools = this.getDaemonCapabilityTools(streamId);
      if (tools.conversation_storage?.execute) {
        const executionOptions: ConversationToolExecutionOptions = {
          toolCallId: crypto.randomUUID(),
          messages: [],
          agentId: this.id,
          streamId,
        };

        await tools.conversation_storage.execute({
          action: "save_message",
          stream_id: streamId,
          message,
        }, executionOptions);
      }
    } catch (error) {
      this.logger.error("Failed to save message to history", {
        streamId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if a message is simple enough to bypass reasoning
   */
  private isSimpleMessage(message: string): boolean {
    const normalized = message.toLowerCase().trim();

    // Simple patterns include greetings AND short contextual responses
    const simplePatterns = [
      /^(hi|hello|hey|good morning|good afternoon|good evening)[\s!.]*$/,
      /^(thanks|thank you|thx|ty)[\s!.]*$/,
      /^(bye|goodbye|see you|later)[\s!.]*$/,
      /^(yes|yeah|yep|yup|no|nope|nah)[\s!.]*$/,
      /^(ok|okay|sure|got it|understood)[\s!.]*$/,
      /^what'?s up\??$/,
      /^how are you\??$/,
      /^#\d+$/, // Numbered choices like #1, #2
      /^(first|second|third|last) one$/i, // Ordinal choices
      /^\d+$/, // Just a number
    ];

    const isSimple = simplePatterns.some((pattern) => pattern.test(normalized));

    this.logger.info("Checking if message is simple", {
      message: normalized,
      isSimple,
      messageLength: normalized.length,
    });

    return isSimple;
  }

  /**
   * Generate a simple response with tool support but without reasoning loop
   */
  private async generateSimpleResponseWithTools(
    message: string,
    streamId?: string,
    historyMessages?: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<string | null> {
    // Get daemon capability tools
    const tools = this.getDaemonCapabilityTools(streamId);

    // Build proper system prompt
    let systemPrompt = this.prompts.system;
    if (streamId) {
      systemPrompt =
        `${systemPrompt}\n\nIMPORTANT: When using the stream_reply tool, you MUST use stream_id: "${streamId}" (not "default" or any other value).`;
    }

    // Add instruction to use stream_reply directly OR indicate complexity
    systemPrompt =
      `${systemPrompt}\n\nYou are handling a simple message in an ongoing conversation. You have the full conversation history above.

CRITICAL INSTRUCTIONS:
1. You MUST use the stream_reply tool to respond to the user
2. Understand the context from the conversation history
3. If the user is responding to something you previously said (like choosing an option), handle it appropriately
4. Use parameters: {"stream_id": "${streamId}", "message": "your response"}

WORKSPACE PUBLISHING CONTEXT:
- If the user says "yes" to a publishing question, check for drafts using list_session_drafts
- If you find a recent draft, proceed with pre_publish_check and publish_workspace
- If no drafts found, explain that and ask for clarification

ONLY return "NEEDS_REASONING" if you truly need multi-step reasoning or complex analysis.

Examples of what you SHOULD handle:
- User says "#1" or "first one" -> They're choosing option 1 from your list
- User says "yes" or "yeah" -> Check conversation context:
  * If agreeing to publish -> list_session_drafts, then publish the found draft
  * If agreeing to other question -> respond appropriately
- User provides a short answer -> They're responding to your question

DO NOT ask for clarification if the context is clear from the conversation history.`;

    // Log tools being passed to LLM
    this.logger.info("Calling generateSimpleResponseWithTools", {
      message,
      streamId,
      toolCount: Object.keys(tools).length,
      toolNames: Object.keys(tools),
      streamReplyTool: tools.stream_reply
        ? {
          hasParameters: !!tools.stream_reply.parameters,
          description: tools.stream_reply.description,
        }
        : "not found",
    });

    const result = await LLMProvider.generateText(message, {
      systemPrompt,
      // Note: messages parameter not supported in new API - context is passed via systemPrompt
      model: this.agentConfig.model || "claude-3-5-sonnet-20241022",
      provider: "google",
      temperature: this.agentConfig.temperature || 0.7,
      max_tokens: 2000, // Increased for workspace operations
      tools: tools,
      tool_choice: "required", // Force tool use
      max_steps: 5, // Allow multiple tool calls for publish flow
      operationContext: {
        operation: "conversation_agent_simple_tools",
        agentId: this.id,
        streamId,
      },
    });

    this.logger.info("Simple tool response received", {
      responseLength: result.text?.length || 0,
      toolCallCount: result.toolCalls?.length || 0,
      text: result.text,
      toolCalls: result.toolCalls?.map((tc) => ({
        toolName: tc.toolName,
        args: tc.args,
      })),
    });

    // Check if the model indicated this needs reasoning
    if (result.text && result.text.includes("NEEDS_REASONING")) {
      this.logger.info("Simple path detected complex query, delegating to reasoning");
      return null; // Signal to use reasoning
    }

    // Find the stream_reply tool call to get the actual message sent
    let streamedMessage = result.text || "";
    if (result.toolCalls && result.toolCalls.length > 0) {
      const streamReplyCall = result.toolCalls.find((tc) => tc.toolName === "stream_reply");
      if (
        streamReplyCall && streamReplyCall.args &&
        typeof streamReplyCall.args.message === "string"
      ) {
        streamedMessage = streamReplyCall.args.message;
        this.logger.info("Extracted streamed message from tool call", {
          messageLength: streamedMessage.length,
          messagePreview: streamedMessage.substring(0, 100),
        });
      }
    }

    // Return the actual message that was streamed
    return streamedMessage;
  }
}
