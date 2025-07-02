import { BaseAgent } from "./base-agent.ts";
import { LLMProviderManager } from "./llm-provider-manager.ts";
import { Tool } from "ai";
import { AtlasLogger } from "../../utils/logger.ts";
import { ConversationEvent, ConversationMessage } from "../conversation-supervisor.old.ts";
import { CoALAMemoryType } from "../memory/coala-memory.ts";

/**
 * BaseConversationAgent: Extends BaseAgent to provide conversation-specific capabilities
 * Following the "everything is a workspace" paradigm, conversations are workspace agents
 */
export abstract class BaseConversationAgent extends BaseAgent {
  protected conversationTools: Record<string, Tool> = {};

  constructor(workspaceId: string, memoryConfig?: any) {
    super(memoryConfig);
    this.parentScopeId = workspaceId;

    // Set base conversation prompts
    this.setPrompts(
      "You are a helpful assistant for Atlas workspace operations.",
      "",
    );
  }

  // Abstract methods for conversation agents
  abstract processConversationMessage(
    sessionId: string,
    messageId: string,
    message: string,
    fromUser: string,
    messageHistory?: ConversationMessage[],
  ): AsyncIterableIterator<ConversationEvent>;

  /**
   * Build conversation context from message history
   */
  protected buildConversationContext(messageHistory?: ConversationMessage[]): string {
    if (!messageHistory || messageHistory.length === 0) {
      return "";
    }

    const recentHistory = messageHistory.slice(-10); // Last 10 messages
    let context = "\n\nRECENT CONVERSATION HISTORY:\n";

    for (const msg of recentHistory) {
      const role = msg.type === "user" ? "User" : "Assistant";
      context += `${role}: ${msg.content}\n`;
    }

    context += "\nCurrent message:\n";

    // Remember the conversation context
    this.rememberInteraction("conversation_context", {
      historyLength: messageHistory.length,
      recentHistoryLength: recentHistory.length,
    });

    return context;
  }

  /**
   * Process a conversation turn using the LLM with tools
   */
  protected async *processWithTools(
    message: string,
    systemPrompt: string,
    messageId: string,
    sessionId: string,
    model: string = "claude-3-5-haiku-20241022",
  ): AsyncIterableIterator<ConversationEvent> {
    const timestamp = new Date().toISOString();
    const logger = AtlasLogger.getInstance();

    // Emit thinking event
    yield {
      type: "thinking",
      data: {
        status: "processing",
        message: `${this.name()} is analyzing your request...`,
      },
      timestamp,
      messageId,
      sessionId,
    };

    try {
      // Use LLMProviderManager for tool calling
      const result = await LLMProviderManager.generateTextWithTools(message, {
        systemPrompt,
        tools: this.conversationTools,
        model,
        temperature: 0.3,
        maxSteps: 2,
        toolChoice: "required",
        operationContext: {
          operation: "conversation_agent",
          agentId: this.id,
          agentName: this.name(),
          sessionId,
        },
      });

      // Remember the LLM interaction
      this.rememberTask(
        `conversation_${messageId}`,
        {
          message: message.substring(0, 200),
          toolCallsCount: result.toolCalls.length,
          model,
        },
        {
          success: true,
          toolNames: result.toolCalls.map((tc) => tc.toolName),
        },
        true,
      );

      // Emit tool call events
      for (const toolCall of result.toolCalls) {
        logger.debug(`${this.name()} tool call`, {
          toolName: toolCall.toolName,
          args: toolCall.args,
          sessionId,
          messageId,
        });

        yield {
          type: "tool_call",
          data: {
            toolName: toolCall.toolName,
            args: toolCall.args,
          },
          timestamp: new Date().toISOString(),
          messageId,
          sessionId,
        };
      }

      // Process tool results
      yield* this.processToolResults(result, messageId, sessionId);

      // Emit completion
      yield {
        type: "message_complete",
        data: {
          messageId,
          complete: true,
        },
        timestamp: new Date().toISOString(),
        messageId,
        sessionId,
      };
    } catch (error) {
      // Remember the failure
      this.rememberTask(
        `conversation_error_${messageId}`,
        {
          message: message.substring(0, 200),
          error: error instanceof Error ? error.message : String(error),
        },
        {
          success: false,
        },
        false,
      );

      // Emit error event
      yield {
        type: "message_complete",
        data: {
          messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        timestamp: new Date().toISOString(),
        messageId,
        sessionId,
      };
    }
  }

  /**
   * Process tool results and emit appropriate events
   */
  protected async *processToolResults(
    result: any,
    messageId: string,
    sessionId: string,
  ): AsyncIterableIterator<ConversationEvent> {
    // Override in subclasses to handle specific tool results
    const logger = AtlasLogger.getInstance();
    logger.debug(`${this.name()} processing ${result.toolResults.length} tool results`);
  }

  /**
   * Remember conversation turn for future context
   */
  protected rememberConversationTurn(
    sessionId: string,
    message: string,
    response: string,
    metadata?: any,
  ): void {
    this.memory.rememberWithMetadata(
      `conversation_turn_${sessionId}_${Date.now()}`,
      {
        sessionId,
        userMessage: message,
        assistantResponse: response,
        timestamp: new Date(),
        ...metadata,
      },
      {
        memoryType: CoALAMemoryType.EPISODIC,
        tags: ["conversation", this.name(), sessionId],
        relevanceScore: 0.7,
        confidence: 1.0,
        decayRate: 0.05,
      },
    );
  }

  // Base agent interface implementation
  provider(): string {
    return "conversation";
  }

  controls(): object {
    return {
      tools: Object.keys(this.conversationTools),
    };
  }
}
