/**
 * ConversationAgent - System agent for interactive conversations
 * Extends BaseAgent with conversation-specific capabilities
 */

import { BaseAgent } from "../../../src/core/agents/base-agent-v2.ts";
import type { IAtlasAgent } from "../../../src/types/core.ts";
import { LLMProvider } from "../../../src/utils/llm/provider.ts";
import { DaemonCapabilityRegistry } from "../../../src/core/daemon-capabilities.ts";
import { WorkspaceCapabilityRegistry } from "../../../src/core/workspace-capabilities.ts";
import type { Tool } from "ai";
import {
  createReasoningMachine,
  parseAction as parseReasoningAction,
  type ReasoningAction,
  type ReasoningCallbacks,
  type ReasoningContext,
  type ReasoningResult,
} from "@atlas/reasoning";
import { createActor } from "xstate";

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

    // Extract message, streamId, and other metadata from input
    const message = typeof input === "string" ? input : (input as any)?.message || "Hello";
    const streamId = (input as any)?.streamId;
    const userId = (input as any)?.userId;
    const conversationId = (input as any)?.conversationId || streamId;

    this.logger.info("Processing message", {
      message: message.substring(0, 100),
      systemPrompt: this.prompts.system.substring(0, 100),
      model: this.config.model,
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
        if (historyResult.success && historyResult.messages?.length > 0) {
          historyContext = historyResult.historyContext || "";
          messagesInHistory = historyResult.messages.length;
          isNewConversation = false;

          // Convert messages to proper format
          historyMessages = historyResult.messages.map((msg: any) => ({
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
      if (this.config.use_reasoning) {
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
          maxSteps: this.config.max_reasoning_steps,
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
          // Create enhanced system prompt with streamId and history context
          let enhancedSystemPrompt = this.prompts.system;
          if (historyContext) {
            enhancedSystemPrompt = `${historyContext}\n\n${enhancedSystemPrompt}`;
          }
          if (streamId) {
            enhancedSystemPrompt =
              `${enhancedSystemPrompt}\n\nIMPORTANT: When using the stream_reply tool, you MUST use stream_id: "${streamId}" (not "default" or any other value).`;
          }

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
        let enhancedSystemPrompt = this.prompts.system;
        if (historyContext) {
          enhancedSystemPrompt = `${historyContext}\n\n${enhancedSystemPrompt}`;
        }
        const response = await LLMProvider.generateText(message, {
          systemPrompt: enhancedSystemPrompt,
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

        // Save assistant response
        if (streamId && response) {
          await this.saveMessage(streamId, {
            role: "assistant",
            content: response,
            metadata: {
              timestamp: new Date().toISOString(),
            },
          });
        }

        return {
          response,
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
        hasTools: !!this.config.tools?.length,
        toolCount: this.config.tools?.length || 0,
      });
      throw error;
    }
  }

  /**
   * Convert daemon and workspace capabilities to tool format for LLM
   */
  private async getDaemonCapabilityTools(streamId?: string): Promise<Record<string, Tool>> {
    const tools: Record<string, any> = {};

    // Ensure workspace capabilities are initialized
    WorkspaceCapabilityRegistry.initialize();

    // Get all daemon and workspace capabilities that match our configured tools
    for (const toolName of this.config.tools || []) {
      // First check daemon capabilities
      let capability = DaemonCapabilityRegistry.getCapability(toolName);

      // If not found in daemon capabilities, check workspace capabilities
      if (!capability) {
        const workspaceCapability = WorkspaceCapabilityRegistry.getCapability(toolName);
        if (workspaceCapability) {
          // Convert workspace capability to the same format as daemon capability
          capability = {
            id: workspaceCapability.id,
            description: workspaceCapability.description,
            inputSchema: workspaceCapability.inputSchema,
            // The implementation will be wrapped below
          };
        }
      }

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
            this.logger.info(`Executing capability: ${capability.id}`, { args, streamId });

            // Check if this is a workspace capability
            const workspaceCapability = WorkspaceCapabilityRegistry.getCapability(capability.id);
            if (workspaceCapability) {
              // Create workspace execution context
              const context = {
                sessionId: streamId || this.id,
                agentId: this.id,
                workspaceId: "atlas-conversation",
                conversationId: args.conversationId || streamId || this.id,
              };

              // Execute workspace capability
              // For workspace capabilities, we need to pass arguments based on the expected parameters
              // Most workspace capabilities expect individual parameters, not an args object

              // Special handling for known workspace capabilities
              if (capability.id === "publish_workspace") {
                const result = await workspaceCapability.implementation(
                  context,
                  args.draftId,
                  args.path,
                );
                return result;
              } else if (capability.id === "workspace_draft_create") {
                const result = await workspaceCapability.implementation(
                  context,
                  args.config,
                  args.description,
                );
                return result;
              } else if (capability.id === "workspace_draft_update") {
                const result = await workspaceCapability.implementation(
                  context,
                  args.draftId,
                  args.updates,
                  args.updateDescription,
                );
                return result;
              } else if (capability.id === "validate_draft_config") {
                const result = await workspaceCapability.implementation(context, args.draftId);
                return result;
              } else if (capability.id === "pre_publish_check") {
                const result = await workspaceCapability.implementation(context, args.draftId);
                return result;
              } else if (capability.id === "show_draft_config") {
                const result = await workspaceCapability.implementation(context, args.draftId);
                return result;
              } else if (capability.id === "list_session_drafts") {
                const result = await workspaceCapability.implementation(context);
                return result;
              } else if (capability.id === "library_list") {
                const result = await workspaceCapability.implementation(context, args.category);
                return result;
              } else if (capability.id === "library_get") {
                const result = await workspaceCapability.implementation(context, args.id);
                return result;
              } else if (capability.id === "library_search") {
                const result = await workspaceCapability.implementation(
                  context,
                  args.query,
                  args.category,
                );
                return result;
              } else {
                // For other workspace capabilities, pass all args as individual parameters
                const argValues = Object.values(args);
                const result = await workspaceCapability.implementation(context, ...argValues);
                return result;
              }
            }

            // Otherwise it's a daemon capability
            // Create daemon execution context
            const context = {
              sessionId: streamId || this.id,
              agentId: this.id,
              workspaceId: "atlas-conversation",
              daemon: DaemonCapabilityRegistry.getDaemonInstance(),
              conversationId: args.conversationId || streamId || this.id,
            };

            // Handle stream_reply - pass the entire args object
            if (capability.id === "stream_reply") {
              const result = await DaemonCapabilityRegistry.executeCapability(
                capability.id,
                context,
                args, // Pass the whole args object
              );
              return result;
            }

            // Handle conversation_storage - pass the entire args object
            if (capability.id === "conversation_storage") {
              const result = await DaemonCapabilityRegistry.executeCapability(
                capability.id,
                context,
                args, // Pass the whole args object
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
    historyContext?: string,
  ): Promise<unknown> {
    this.logger.info("Starting reasoning-based conversation", {
      message: message.substring(0, 100),
      streamId,
      hasStreamId: !!streamId,
    });

    try {
      // Create reasoning context
      const tools = await this.getDaemonCapabilityTools(streamId);

      this.logger.info("Reasoning context tools prepared", {
        toolCount: Object.keys(tools).length,
        toolNames: Object.keys(tools),
      });

      const userContext = {
        message,
        streamId,
        conversationId: streamId || this.id,
        tools,
        historyContext,
        // Track draft ID across reasoning steps
        draftId: null as string | null,
      };

      // Create reasoning callbacks
      const callbacks = {
        // Generate thinking based on conversation context
        think: async (context) => {
          this.logger.info("Think callback invoked", {
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

${
              context.userContext.historyContext
                ? `Conversation history:\n${context.userContext.historyContext}\n\n`
                : ""
            }User message: ${context.userContext.message}

${
              previousSteps.length > 0
                ? `Previous reasoning steps:
${JSON.stringify(previousSteps, null, 2)}`
                : ""
            }

Available tools: ${Object.keys(context.userContext.tools).join(", ")}
${
              context.userContext.draftId
                ? `\nCurrent draft ID: ${context.userContext.draftId} (use this for workspace operations)\n`
                : ""
            }
Think step-by-step about:
1. What is the user asking for?
2. What tools do I need to use to accomplish this?
3. Am I in the middle of a multi-step process?

If you're creating a workspace after user confirmation:
- First use stream_reply to acknowledge
- Then CONTINUE reasoning to call workspace_draft_create

If the user is confirming but you've already completed all the actions:
- Use stream_reply to acknowledge what's been done
- Then use ACTION: complete to finish the reasoning

Provide your response in EXACTLY this format:

THINKING: [Your detailed analysis of what the user needs and your current progress]

ACTION: [tool_call or complete]
TOOL_NAME: [appropriate tool name if ACTION is tool_call]
PARAMETERS: [valid JSON parameters for the tool if ACTION is tool_call]
REASONING: [Why you chose this action]

IMPORTANT: 
- Use ACTION: tool_call when you need to use a tool
- Use ACTION: complete when the conversation is done and no more actions are needed
- After confirming workspace creation, your NEXT action should be workspace_draft_create
- Don't stop after just acknowledging - complete the task
- The PARAMETERS must be valid JSON on a single line
- For workspace_draft_create, the PARAMETERS must contain: name, description, and initialConfig
- The initialConfig follows the WorkspaceConfig schema shown in workspace_draft_create_format section
- Example PARAMETERS format: {"name": "workspace-name", "description": "workspace description", "initialConfig": {... full workspace config ...}}
- NEVER call workspace_draft_create with empty parameters {}`;

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

            this.logger.info("Thinking generated", {
              thinkingLength: thinking.length,
              thinkingPreview: thinking.substring(0, 200) + "...",
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

        // Parse action from thinking using the reasoning package parser
        parseAction: (thinking: string): ReasoningAction | null => {
          this.logger.info("Parsing action from thinking", {
            thinkingLength: thinking.length,
            thinkingPreview: thinking.substring(0, 200),
          });

          const action = parseReasoningAction(thinking);

          if (action) {
            this.logger.info("Parsed action", {
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
          this.logger.info("Executing reasoning action", {
            type: action.type,
            toolName: action.toolName,
          });

          if (action.type === "tool_call" && action.toolName) {
            const tools = context.userContext.tools;
            const tool = tools[action.toolName];

            if (tool) {
              // Use the parameters from the parsed action
              const parameters = action.parameters || {};

              // For stream_reply, ensure we have the required fields
              if (action.toolName === "stream_reply") {
                // Use streamId from context if not in parameters
                if (!parameters.stream_id && context.userContext.streamId) {
                  parameters.stream_id = context.userContext.streamId;
                }
              }

              this.logger.info("Executing tool with parameters", {
                toolName: action.toolName,
                parameters: JSON.stringify(parameters),
              });

              const result = await tool.execute(parameters);

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
          const lastMessage = (context.userContext as any).streamedMessage ||
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
          const actor = createActor(machine, {
            input: userContext,
          });

          this.logger.info("Reasoning actor created");

          actor.subscribe({
            complete: () => {
              this.logger.info("Reasoning actor completed");
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
        } as ReasoningResult;
      });

      this.logger.info("Reasoning completed", {
        status: result.status,
        steps: result.reasoning.totalIterations,
        achieved: result.jobResults.achieved,
        finalThinking: result.reasoning.finalThinking?.substring(0, 200),
      });

      // Get the actual message that was streamed to the user
      const streamedMessage = (userContext as any).streamedMessage || result.jobResults.output;

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

  /**
   * Load conversation history using daemon capability
   */
  private async loadConversationHistory(streamId: string): Promise<any> {
    try {
      const tools = await this.getDaemonCapabilityTools(streamId);
      if (tools.conversation_storage?.execute) {
        return await tools.conversation_storage.execute({
          action: "load_history",
          stream_id: streamId,
        }, {});
      }
    } catch (error) {
      this.logger.error("Failed to load conversation history", {
        streamId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { success: false, messages: [] };
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
      const tools = await this.getDaemonCapabilityTools(streamId);
      if (tools.conversation_storage?.execute) {
        await tools.conversation_storage.execute({
          action: "save_message",
          stream_id: streamId,
          message,
        }, {});
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
    const tools = await this.getDaemonCapabilityTools(streamId);

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

ONLY return "NEEDS_REASONING" if you truly need multi-step reasoning or complex analysis.

Examples of what you SHOULD handle:
- User says "#1" or "first one" -> They're choosing option 1 from your list
- User says "yes" or "yeah" -> They're agreeing to your last question
- User provides a short answer -> They're responding to your question

DO NOT ask for clarification if the context is clear from the conversation history.`;

    const result = await LLMProvider.generateTextWithTools(message, {
      systemPrompt,
      messages: historyMessages || [],
      model: this.config.model || "claude-3-5-sonnet-20241022",
      provider: "anthropic",
      temperature: this.config.temperature || 0.7,
      maxTokens: 1000, // Increased for proper responses
      tools: tools,
      toolChoice: "required", // Force tool use
      maxSteps: 2, // Allow one tool call plus response
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
        streamReplyCall && streamReplyCall.args && typeof streamReplyCall.args.message === "string"
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
