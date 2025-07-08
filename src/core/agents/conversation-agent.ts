/**
 * Conversation Agent - Handles conversations with built-in history management
 *
 * This agent encapsulates conversation history management using KV storage,
 * keyed by stream_id for persistence across agent instances.
 */

import { BaseAgent } from "./base-agent.ts";
import { type ConversationMessage, getConversationStorage } from "./conversation-storage.ts";
import { LLMProvider } from "../../utils/llm/provider.ts";

export interface ConversationAgentInput {
  streamId: string;
  message: string;
  userId: string;
  _atlas_context?: {
    session_id: string;
    task: string;
    previous_executions?: unknown[];
  };
}

export interface ConversationAgentConfig {
  model: string;
  temperature?: number;
  max_tokens?: number;
  system_prompt: string;
  tools: string[];
  parameters?: Record<string, unknown>;
}

export interface ConversationAgentResult {
  agent_type: "conversation";
  agent_id: string;
  result: string;
  tool_calls: unknown[];
  tool_results: unknown[];
  conversation_metadata: {
    streamId: string;
    messagesInHistory: number;
    isNewConversation: boolean;
  };
}

export class ConversationAgent extends BaseAgent {
  private conversationStorage: any = null;
  private config: ConversationAgentConfig;

  constructor(
    agentId: string,
    config: ConversationAgentConfig,
    private workspaceId?: string,
  ) {
    super(undefined, agentId);
    this.config = config;

    // Set conversation-specific prompts
    this.setPrompts(
      config.system_prompt,
      "Process conversation messages with context awareness and history management.",
    );

    this.log(`ConversationAgent initialized with workspaceId: ${workspaceId}`, "info", {
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      tools: config.tools,
    });
  }

  // Required BaseAgent implementations
  name(): string {
    return "ConversationAgent";
  }

  nickname(): string {
    return "conversation";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "tempest";
  }

  purpose(): string {
    return "Handle conversations with scope awareness and built-in history management";
  }

  controls(): object {
    return {
      model: this.config.model,
      tools: this.config.tools,
      streaming: true,
      historyManagement: true,
    };
  }

  async execute(input: ConversationAgentInput): Promise<ConversationAgentResult> {
    const startTime = Date.now();

    try {
      this.log(`Execute called with streamId: ${input.streamId}`, "info", {
        streamId: input.streamId,
        userId: input.userId,
        messageLength: input.message.length,
      });

      // Initialize conversation storage lazily
      if (!this.conversationStorage) {
        this.log("Initializing conversation storage", "debug");
        this.conversationStorage = getConversationStorage();
      }

      const { streamId, message, userId } = input;

      // Load existing conversation history
      this.log(`Loading conversation history for streamId: ${streamId}`, "debug");
      const existingHistory = await this.conversationStorage.getConversationHistory(streamId);

      const isNewConversation = !existingHistory || !existingHistory.messages ||
        existingHistory.messages.length === 0;

      this.log(`Conversation history loaded`, "debug", {
        messagesCount: existingHistory?.messages?.length || 0,
        isNewConversation,
      });

      // Save user message to history
      const userMessage: ConversationMessage = {
        messageId: crypto.randomUUID(),
        userId,
        content: message,
        timestamp: new Date().toISOString(),
        role: "user",
        metadata: {
          streamId,
          workspaceContext: this.workspaceId,
        },
      };

      await this.conversationStorage.saveMessage(streamId, userMessage);
      this.log("Saved user message to history", "debug", { messageId: userMessage.messageId });

      // Build prompt with conversation history
      let userPrompt = message;
      if (existingHistory && existingHistory.messages && existingHistory.messages.length > 0) {
        const historyContext = this.conversationStorage.formatHistoryForContext(
          existingHistory.messages,
        );
        userPrompt = `${historyContext}\n\nCurrent message: ${message}`;
        this.log("Built prompt with history context", "debug", {
          historyLength: existingHistory.messages.length,
          contextLength: historyContext.length,
        });
      } else {
        this.log("No history found, using original message as prompt", "debug");
      }

      // Execute LLM with tools support
      this.log("Generating LLM response with tools", "debug", {
        model: this.config.model,
        tools: this.config.tools,
        toolsCount: this.config.tools?.length || 0,
      });

      let assistantMessage: string;
      let toolCalls: any[] = [];
      let toolResults: any[] = [];

      // Check if we have tools configured
      if (this.config.tools && this.config.tools.length > 0) {
        this.log("Using generateTextWithTools for tool-aware generation", "debug");

        // Get workspace tools from request environment if available
        const workspaceTools = (input._atlas_context as any)?.workspace_tools || {};

        const result = await LLMProvider.generateTextWithTools(
          userPrompt,
          {
            provider: "anthropic", // Default to anthropic
            model: this.config.model,
            systemPrompt: this.config.system_prompt,
            temperature: this.config.temperature || 0.7,
            maxTokens: this.config.max_tokens || 4000,
            timeout: 120000, // 2 minutes timeout for claude-sonnet-4
            tools: workspaceTools, // Pass workspace capability tools
            operationContext: {
              operation: "conversation_agent",
              agentId: this.id,
              streamId,
            },
          },
        );

        assistantMessage = result.text;
        toolCalls = result.toolCalls || [];
        toolResults = result.toolResults || [];

        this.log("Tool-aware generation completed", "debug", {
          responseLength: assistantMessage.length,
          toolCallsCount: toolCalls.length,
          toolResultsCount: toolResults.length,
        });
      } else {
        this.log("No tools configured, using standard generation", "debug");

        assistantMessage = await this.generateLLM(
          this.config.model,
          this.config.system_prompt,
          userPrompt,
          false, // Don't include memory context as we have conversation history
          {
            operation: "conversation_agent",
            agentId: this.id,
            streamId,
          },
        );
      }

      this.log("LLM response generated successfully", "debug", {
        responseLength: assistantMessage.length,
      });

      // Manually trigger streaming via daemon capability
      this.log("Triggering streaming response", "debug", { streamId });
      try {
        await this.handleStreamReply(streamId, assistantMessage, input);
        this.log("Streaming completed successfully", "debug");
      } catch (error) {
        this.log("Streaming failed", "error", { error: error.message });
      }

      // Save assistant message to history
      const assistantMessageObj: ConversationMessage = {
        messageId: crypto.randomUUID(),
        userId,
        content: assistantMessage,
        timestamp: new Date().toISOString(),
        role: "assistant",
        metadata: {
          streamId,
          workspaceContext: this.workspaceId,
        },
      };

      await this.conversationStorage.saveMessage(streamId, assistantMessageObj);

      // Get updated conversation stats
      const updatedHistory = await this.conversationStorage.getConversationHistory(streamId);
      const duration = Date.now() - startTime;

      // Remember this conversation interaction
      this.rememberTask(
        `conversation_${streamId}_${Date.now()}`,
        {
          streamId,
          userId,
          messageLength: message.length,
          isNewConversation,
          duration,
        },
        {
          responseLength: assistantMessage.length,
          messagesInHistory: updatedHistory?.messages?.length || 0,
          streamingSuccess: true,
        },
        true,
      );

      this.log("Conversation execution completed", "info", {
        streamId,
        duration,
        messagesInHistory: updatedHistory?.messages?.length || 0,
        isNewConversation,
      });

      return {
        agent_type: "conversation",
        agent_id: this.id,
        result: assistantMessage,
        tool_calls: toolCalls,
        tool_results: toolResults,
        conversation_metadata: {
          streamId,
          messagesInHistory: updatedHistory?.messages?.length || 0,
          isNewConversation,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      // Remember the failure for learning
      this.rememberTask(
        `conversation_error_${input.streamId}_${Date.now()}`,
        {
          streamId: input.streamId,
          userId: input.userId,
          messageLength: input.message.length,
          duration,
        },
        {
          error: error instanceof Error ? error.message : String(error),
        },
        false,
      );

      this.log("Conversation execution failed", "error", {
        streamId: input.streamId,
        duration,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      throw error;
    }
  }

  private async handleStreamReply(
    streamId: string,
    message: string,
    input: ConversationAgentInput,
  ): Promise<void> {
    this.log("Attempting to stream reply", "debug", { streamId, messageLength: message.length });

    try {
      // Import and use the daemon capability registry to call stream_reply
      const { DaemonCapabilityRegistry } = await import("../daemon-capabilities.ts");

      const context = {
        sessionId: streamId,
        agentId: this.id,
        workspaceId: this.workspaceId || "unknown",
        daemon: null, // Will be set by registry
        conversationId: streamId, // Use streamId as conversationId for now
      };

      this.log("Calling stream_reply capability", "debug", {
        streamId,
        agentId: this.id,
        workspaceId: this.workspaceId,
      });

      const result = await DaemonCapabilityRegistry.executeCapability(
        "stream_reply",
        context,
        streamId,
        message,
        undefined, // metadata
        streamId, // conversationId
      );

      this.log("Stream reply completed", "debug", {
        success: result.success,
        messageId: result.messageId,
      });

      if (!result.success) {
        throw new Error(`Stream reply failed: ${result.error || result.message}`);
      }
    } catch (error) {
      this.log("Stream reply failed", "error", {
        streamId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
