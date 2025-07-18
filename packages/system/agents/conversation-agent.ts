/**
 * ConversationAgent - System agent for interactive conversations
 * Extends BaseAgent with conversation-specific capabilities
 */

import { type SystemAgentConfigObject, SystemAgentConfigObjectSchema } from "@atlas/config";
import { LLMProvider } from "@atlas/core";
import {
  createReasoningMachine,
  type ReasoningAction,
  type ReasoningCallbacks,
  type ReasoningCompletion,
  type ReasoningContext,
  type ReasoningExecutionResult,
  type ReasoningResult,
} from "@atlas/reasoning";
import type { Tool } from "ai";
import { createActor } from "xstate";
import { z } from "zod";
import { BaseAgent } from "../../../src/core/agents/base-agent-v2.ts";
import {
  createStreamsImplementation,
  DaemonCapabilityRegistry,
} from "../../../src/core/daemon-capabilities.ts";
import type { SystemAgentMetadata } from "../../../src/core/system-agent-registry.ts";
import { WorkspaceCapabilityRegistry } from "../../../src/core/workspace-capabilities.ts";
import { ValidationError } from "../../../src/utils/errors.ts";
import { ReasoningThinking } from "../../reasoning/src/types.ts";

// Schema for execute method input validation
const ConversationInputSchema = z.object({
  message: z.string(),
  streamId: z.string().optional(),
  userId: z.string().optional(),
  conversationId: z.string().optional(),
});

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
  conversationId?: string;
}

// Interface for conversation storage output
interface ConversationStorageOutput {
  success: boolean;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  historyContext?: string;
  error?: string;
}

// Interface for reasoning user context
type ConversationReasoningContext = {
  message: string;
  streamId?: string;
  conversationId: string;
  tools: Record<string, Tool>;
  historyContext?: string;
  goal: string;
  workspaceId: string;
  sessionId: string;
};

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
      model: "claude-3-7-sonnet-latest",
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

  private getAvailableCapabilities(streamId?: string): {
    availableAgents: any[];
    availableTools: Record<string, Tool>;
  } {
    WorkspaceCapabilityRegistry.initialize();
    const availableAgents = WorkspaceCapabilityRegistry.getAllCapabilities();
    const availableTools = this.getDaemonCapabilityTools(streamId);
    return { availableAgents, availableTools };
  }

  /**
   * Get default model for this agent
   */
  protected override getDefaultModel(): string {
    return this.agentConfig.model || super.getDefaultModel();
  }

  /**
   * Initializes the conversation by loading history and saving the user's message.
   */
  private async _initializeConversation(
    streamId: string,
    message: string,
    userId?: string,
  ): Promise<{
    historyContext: string;
    messagesInHistory: number;
    isNewConversation: boolean;
  }> {
    let historyContext = "";
    let messagesInHistory = 0;
    let isNewConversation = true;

    try {
      const historyResult = await this.loadConversationHistory(streamId);
      if (
        historyResult.success && "messages" in historyResult && historyResult.messages.length > 0
      ) {
        historyContext = historyResult.historyContext || "";
        messagesInHistory = historyResult.messages.length;
        isNewConversation = false;
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

    try {
      await this.saveMessage(
        streamId,
        {
          role: "user",
          content: message,
        },
        {
          userId,
          timestamp: new Date().toISOString(),
          workspaceContext: "atlas-conversation",
        },
      );
    } catch (error) {
      this.logger.warn("Failed to save user message", {
        streamId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { historyContext, messagesInHistory, isNewConversation };
  }

  /**
   * Finalizes the conversation by saving the assistant's response.
   */
  private async _finalizeConversation(
    streamId: string,
    response: unknown,
  ): Promise<void> {
    if (response && typeof response === "object" && "response" in response && response.response) {
      await this.saveMessage(
        streamId,
        {
          role: "assistant",
          content: String(response.response),
        },
        {
          timestamp: new Date().toISOString(),
          reasoning: true,
        },
      );
    }
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

    const validatedInput = ConversationInputSchema.parse(input);
    const { message, streamId, userId } = validatedInput;

    this.logger.info("Processing message", {
      message: message.substring(0, 100),
      model: this.agentConfig.model,
      streamId,
    });

    let historyContext = "";
    let messagesInHistory = 0;
    let isNewConversation = true;

    if (streamId) {
      const conversationState = await this._initializeConversation(
        streamId,
        message,
        userId,
      );
      historyContext = conversationState.historyContext;
      messagesInHistory = conversationState.messagesInHistory;
      isNewConversation = conversationState.isNewConversation;
    }

    try {
      this.logger.info("Using reasoning-based conversation", {
        maxSteps: this.agentConfig.max_reasoning_steps,
        message: message.substring(0, 100),
      });

      const result = await this.executeWithReasoning(
        message,
        streamId,
        historyContext,
      );

      if (streamId) {
        await this._finalizeConversation(streamId, result);
      }

      return {
        ...(typeof result === "object" && result !== null ? result : {}),
        conversationMetadata: {
          streamId,
          messagesInHistory: messagesInHistory + (result ? 2 : 1), // user + assistant
          isNewConversation,
        },
      };
    } catch (error) {
      this.logger.error("ConversationAgent execution failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Convert daemon and workspace capabilities to tool format for LLM
   */
  private getDaemonCapabilityTools(streamId?: string): Record<string, Tool> {
    const tools: Record<string, Tool> = {};
    WorkspaceCapabilityRegistry.initialize();

    const capabilityRegistries = [
      DaemonCapabilityRegistry,
      WorkspaceCapabilityRegistry,
    ];

    for (const toolName of this.agentConfig.tools || []) {
      for (const registry of capabilityRegistries) {
        const capability = registry.getCapability(toolName);
        if (capability) {
          const context = registry === DaemonCapabilityRegistry
            ? {
              sessionId: streamId || this.id,
              agentId: this.id,
              workspaceId: "atlas-conversation",
              daemon: DaemonCapabilityRegistry.getDaemonInstance(),
              conversationId: streamId || this.id,
              streams: createStreamsImplementation(),
            }
            : {
              workspaceId: "atlas-conversation",
              sessionId: streamId || this.id,
              agentId: this.id,
              conversationId: streamId || this.id,
            };

          const tool = capability.toTool(context as any);
          tools[capability.id] = tool;
          this.logger.info(`Created ${registry.constructor.name} tool`, {
            toolId: capability.id,
          });
          break; // Move to the next toolName once found
        }
      }
    }

    this.logger.info("Converted capabilities to tools", {
      toolCount: Object.keys(tools).length,
      toolNames: Object.keys(tools),
    });

    return tools;
  }

  /**
   * Builds the prompt for the 'think' step of the reasoning process.
   * @param context - The current reasoning context.
   * @returns The prompt string for the LLM.
   */
  private _buildThinkingPrompt(
    context: ReasoningContext<ConversationReasoningContext>,
  ): string {
    const { userContext, steps, workingMemory } = context;
    const previousSteps = steps.map((s) => ({
      thinking: s.thinking,
      action: s.action,
      observation: s.observation,
    }));
    const draftId = workingMemory.get("draftId");

    const promptParts = [
      `You are a conversational AI with a goal: ${userContext.goal}`,
      "Your task is to use the available tools to achieve this goal step-by-step.",
      "Analyze the user's request and the conversation history, then select the single best tool to make progress.",
    ];

    if (userContext.historyContext) {
      promptParts.push(`Conversation history:\n${userContext.historyContext}`);
    }

    promptParts.push(`User message: ${userContext.message}`);

    if (previousSteps.length > 0) {
      promptParts.push(
        `Previous reasoning steps:\n${JSON.stringify(previousSteps, null, 2)}`,
      );
    }

    promptParts.push(
      `You have these tools available: ${Object.keys(userContext.tools).join(", ")}`,
    );
    promptParts.push(
      `CRITICAL: You must use the provided tools to respond or act. To send a message to the user, you must use the 'stream_reply' tool.`,
    );
    promptParts.push(
      `The 'stream_id' for the current conversation is "${userContext.streamId}". You must provide this 'stream_id' when calling 'stream_reply'.`,
    );

    if (draftId) {
      promptParts.push(
        `\nCurrent draft ID: ${draftId} (use this for workspace operations)\n`,
      );
    }

    promptParts.push(
      `Now, think about the next step and call the appropriate tool. If you have gathered information (e.g. using 'library_list'), your next step is to report it to the user with 'stream_reply'.`,
    );

    return promptParts.join("\n\n");
  }

  /**
   * The 'think' implementation for the reasoning machine.
   * @param context - The current reasoning context.
   * @returns A promise that resolves to the thinking and confidence.
   */
  private async _think(
    context: ReasoningContext<ConversationReasoningContext>,
  ): Promise<ReasoningCompletion> {
    const prompt = this._buildThinkingPrompt(context);
    const tools = this.getDaemonCapabilityTools(
      context.userContext.streamId,
    );

    const response = await LLMProvider.generateText(prompt, {
      model: this.agentConfig.model,
      provider: "anthropic",
      temperature: 0.1,
      max_tokens: 4000,
      systemPrompt: "You are a conversational reasoning engine.",
      tools: tools,
      operationContext: {
        operation: "conversation_agent_think",
        conversationId: context.userContext.conversationId,
      },
    });

    const thinking: ReasoningThinking = {
      text: response.text,
      toolCalls: response.toolCalls,
    };

    const confidence = 0.8;

    return { thinking, confidence, isComplete: false };
  }

  /**
   * The 'parseAction' implementation for the reasoning machine.
   * @param thinking - The thinking string from the 'think' step.
   * @returns The parsed reasoning action or null.
   */
  private _parseAction(thinking: ReasoningThinking): ReasoningAction | null {
    this.logger.info("Parsing action from thinking", {
      thinkingTextLength: thinking.text.length,
      toolCallCount: thinking.toolCalls.length,
    });

    if (thinking.toolCalls && thinking.toolCalls.length > 0) {
      const toolCall = thinking.toolCalls[0];
      const action: ReasoningAction = {
        type: "tool_call",
        toolName: toolCall.toolName,
        parameters: toolCall.args || {},
        reasoning: thinking.text || "Tool call from thinking",
        toolCallId: toolCall.toolCallId,
      };
      this.logger.info("Parsed tool_call action", { action: JSON.stringify(action) });
      return action;
    }
    this.logger.info("No action parsed from thinking.");
    return null;
  }

  /**
   * The 'executeAction' implementation for the reasoning machine.
   * @param action - The action to execute.
   * @param context - The current reasoning context.
   * @returns A promise that resolves to the result and observation.
   */
  private async _executeAction(
    action: ReasoningAction,
    context: ReasoningContext<ConversationReasoningContext>,
  ): Promise<ReasoningExecutionResult> {
    this.logger.info("Executing action", { action: JSON.stringify(action) });
    if (action.type === "tool_call") {
      const { toolName, parameters, toolCallId } = action;
      const tools = this.getDaemonCapabilityTools(context.userContext.streamId);

      if (tools[toolName]) {
        this.logger.info(`Tool '${toolName}' found, preparing to execute.`, {
          parameters: JSON.stringify(parameters),
        });
        try {
          const executionOptions: ConversationToolExecutionOptions = {
            toolCallId: toolCallId || crypto.randomUUID(),
            messages: [], // Not available in this context
            agentId: this.id,
            streamId: context.userContext.streamId,
            conversationId: context.userContext.conversationId,
          };
          this.logger.info("Executing tool with options", {
            executionOptions: JSON.stringify(executionOptions),
          });
          const result = await tools[toolName].execute!(parameters, executionOptions);
          this.logger.info(`Tool '${toolName}' executed successfully`, {
            result: JSON.stringify(result),
          });
          context.workingMemory.set("last_tool_result", result);

          const resultString = JSON.stringify(result);
          let observation: string;

          if (toolName === "stream_reply") {
            observation =
              "Successfully sent a message to the user. I should now evaluate if the conversation is complete.";
          } else {
            observation = `Tool '${toolName}' executed successfully with result: ${
              resultString.substring(0, 1000)
            }. I must now use 'stream_reply' to send this result to the user.`;
          }

          return {
            result,
            observation,
          };
        } catch (error) {
          this.logger.error(`Error executing tool ${toolName}`, {
            error: error.message,
            stack: error.stack,
            parameters: JSON.stringify(parameters),
          });
          return {
            result: null,
            observation: `Error executing tool ${toolName}: ${error.message}`,
          };
        }
      } else {
        this.logger.warn(`Tool '${toolName}' not found.`, {
          availableTools: Object.keys(tools),
        });
        return {
          result: null,
          observation: `Tool ${toolName} not found.`,
        };
      }
    }
    this.logger.info("No tool_call action to execute.");
    return {
      result: null,
      observation: "No action was executed.",
    };
  }

  private async _evaluate(
    context: ReasoningContext<ConversationReasoningContext>,
  ): Promise<{ isComplete: boolean }> {
    const { userContext, steps } = context;
    const conversationSummary = steps.map((s) => {
      const actionText = s.action ? `${s.action.type} tool: ${s.action.toolName || "N/A"}` : "None";
      return `Thinking: ${s.thinking}\nAction: ${actionText}\nObservation: ${s.observation}`;
    }).join("\n---\n");

    const prompt = `
The user's goal is: "${userContext.goal}"

Here is a summary of the reasoning steps taken so far:
---
${conversationSummary}
---

Based on this history, has the goal been fully achieved?
The conversation is complete only when the user's request has been fully addressed.
Respond with only 'true' or 'false'.
    `;

    const response = await LLMProvider.generateText(prompt, {
      model: this.agentConfig.model,
      provider: "anthropic",
      temperature: 0,
      operationContext: {
        operation: "conversation_agent_evaluate",
        conversationId: userContext.conversationId,
      },
    });

    const isComplete = response.text.toLowerCase().includes("true");

    return { isComplete };
  }

  /**
   * Creates the user-facing context for the reasoning process.
   */
  private _createReasoningUserContext(
    message: string,
    streamId?: string,
    historyContext?: string,
  ): ConversationReasoningContext {
    const tools = this.getDaemonCapabilityTools(streamId);
    this.logger.info("Reasoning context tools prepared", {
      toolCount: Object.keys(tools).length,
      toolNames: Object.keys(tools),
    });

    return {
      message,
      streamId,
      conversationId: streamId || this.id,
      tools,
      historyContext,
      goal: `Address the user's message: "${message}"`,
      workspaceId: "atlas-conversation",
      sessionId: streamId || this.id,
    };
  }

  /**
   * Creates the callbacks for the reasoning machine.
   */
  private _createReasoningCallbacks(): ReasoningCallbacks<ConversationReasoningContext> {
    return {
      think: (context) => this._think(context),
      parseAction: (thinking) => this._parseAction(thinking),
      executeAction: (action, context) => this._executeAction(action, context),
      evaluate: (context) => this._evaluate(context),
    };
  }

  /**
   * Runs the reasoning machine and returns the result.
   */
  private async _runReasoningMachine(
    machine: ReturnType<
      typeof createReasoningMachine
    >,
    userContext: ConversationReasoningContext,
  ): Promise<ReasoningResult> {
    const actor = createActor(machine, { input: userContext });

    const resultPromise = new Promise<ReasoningResult>(
      (resolve, reject) => {
        actor.subscribe({
          complete: () => {
            const snapshot = actor.getSnapshot();
            resolve(snapshot.output);
          },
          error: (err) => reject(err),
        });
        actor.start();
      },
    );

    const result = await resultPromise;

    this.logger.info("Reasoning completed", {
      status: result.status,
      steps: result.reasoning.totalIterations,
    });

    return result;
  }

  /**
   * Execute conversation with reasoning capabilities
   * Simplified version that ensures stream_reply is called
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
      // Create reasoning context, callbacks, and machine
      const userContext = this._createReasoningUserContext(message, streamId, historyContext);
      const callbacks = this._createReasoningCallbacks();
      const machine = createReasoningMachine(callbacks, {
        maxIterations: this.agentConfig.max_reasoning_steps || 10,
      });

      // Run the machine
      const result = await this._runReasoningMachine(machine, userContext);

      return {
        reasoning: result,
        response: result.jobResults.output,
      };
    } catch (error) {
      this.logger.error("executeWithReasoning failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Invokes the 'conversation_storage' daemon capability.
   * @param streamId - The ID of the conversation stream.
   * @param action - The action to perform (e.g., 'load_history', 'save_message').
   * @param params - The parameters for the action.
   * @returns The result from the capability execution.
   */
  private async _invokeConversationStorage<T>(
    streamId: string,
    action: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    try {
      const tools = this.getDaemonCapabilityTools(streamId);
      if (tools.conversation_storage?.execute) {
        const executionOptions: ConversationToolExecutionOptions = {
          toolCallId: crypto.randomUUID(),
          messages: [],
          agentId: this.id,
          streamId,
        };

        return await tools.conversation_storage.execute(
          { action, stream_id: streamId, ...params },
          executionOptions,
        );
      }
    } catch (error) {
      this.logger.error("Failed to invoke conversation_storage", {
        streamId,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
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
        model: { type: "string", default: "claude-3-7-sonnet-latest" },
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
    const result = await this._invokeConversationStorage<ConversationStorageOutput>(
      streamId,
      "load_history",
      {},
    );
    return result || { success: false, error: "Failed to load conversation history" };
  }

  /**
   * Save message to conversation history using daemon capability
   */
  private async saveMessage(
    streamId: string,
    message: {
      role: "user" | "assistant";
      content: string;
    },
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const params = {
      streamId,
      ...message,
      metadata,
    };
    await this._invokeConversationStorage(streamId, "saveMessage", params);
  }
}
