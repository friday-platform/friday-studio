import { jsonSchema, Tool } from "ai";
import { LLMProviderManager } from "./agents/llm-provider-manager.ts";
import { AtlasLogger } from "../utils/logger.ts";
import { z } from "zod";

export interface ConversationSession {
  id: string;
  workspaceId: string;
  mode: "private" | "shared";
  participants: Array<{
    userId: string;
    clientType: string;
    joinedAt: string;
    lastSeen: string;
  }>;
  createdAt: string;
  lastActivity: string;
  messageHistory: ConversationMessage[];
}

export interface ConversationMessage {
  id: string;
  sessionId: string;
  fromUser: string;
  content: string;
  timestamp: string;
  type: "user" | "assistant" | "system";
}

export interface ConversationEvent {
  type:
    | "thinking"
    | "tool_call"
    | "message_chunk"
    | "transparency"
    | "orchestration"
    | "message_complete"
    | "user_message"
    | "user_joined"
    | "user_left";
  data: any;
  timestamp: string;
  messageId?: string;
  sessionId: string;
}

// CX reply tool with message envelope pattern for transparency
const cxTools: Record<string, Tool> = {
  cx_reply: {
    description:
      "Reply to user with structured transparency envelope containing reasoning and potential agent coordination",
    parameters: jsonSchema({
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Natural conversational response to the user",
        },
        transparency: {
          type: "object",
          properties: {
            analysis: {
              type: "string",
              description: "Your detailed reasoning about this interaction",
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Confidence level in your understanding and response",
            },
            complexity: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "Task complexity assessment",
            },
            requiresAgentCoordination: {
              type: "boolean",
              description: "Whether this request needs Atlas agent coordination",
            },
            coordinationPlan: {
              type: "object",
              properties: {
                agents: {
                  type: "array",
                  items: { type: "string" },
                  description: "Atlas agents to coordinate if coordination is needed",
                },
                strategy: {
                  type: "string",
                  enum: ["sequential", "parallel", "staged"],
                  description: "Execution strategy for agent coordination",
                },
                recommendedJob: {
                  type: "string",
                  description: "Atlas job to recommend or trigger",
                },
              },
              required: [],
              additionalProperties: false,
            },
          },
          required: ["analysis", "confidence", "complexity", "requiresAgentCoordination"],
          additionalProperties: false,
        },
      },
      required: ["message", "transparency"],
      additionalProperties: false,
    }),
    execute: async ({ message, transparency }) => {
      // Simple reply tool - just return the message and transparency
      // No fake orchestration or session creation
      return {
        message,
        transparency,
      };
    },
  },
  // Add workspace_create tool for actual workspace creation
  workspace_create: {
    description: "Create a new workspace with the specified configuration",
    parameters: jsonSchema({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Workspace name (lowercase with hyphens)",
        },
        description: {
          type: "string",
          description: "Workspace description",
        },
        path: {
          type: "string",
          description: "Optional path where workspace should be created",
        },
      },
      required: ["name", "description"],
      additionalProperties: false,
    }),
    execute: async ({ name, description, path }) => {
      const logger = AtlasLogger.getInstance();
      logger.info("ConversationSupervisor: workspace_create tool called", {
        name,
        description,
        path,
      });

      try {
        // Call the daemon API to actually create the workspace
        const daemonUrl = Deno.env.get("ATLAS_DAEMON_URL") || "http://localhost:8080";
        const response = await fetch(`${daemonUrl}/api/workspaces`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name,
            description,
            path,
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          logger.error("Failed to create workspace", { error, status: response.status });
          return {
            success: false,
            error: `Failed to create workspace: ${error}`,
          };
        }

        const workspace = await response.json();
        logger.info("Workspace created successfully", { workspace });

        return {
          success: true,
          workspace,
          message: `Workspace '${name}' created successfully with ID: ${workspace.id}`,
        };
      } catch (error) {
        logger.error("Error creating workspace", { error });
        return {
          success: false,
          error: `Error creating workspace: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  },
};

export class ConversationSupervisor {
  constructor(
    private workspaceId: string,
    private workspaceContext?: any, // TODO: Add proper workspace context type
  ) {}

  async *processMessage(
    sessionId: string,
    messageId: string,
    message: string,
    fromUser: string,
    messageHistory?: ConversationMessage[], // QUICK FIX: Accept conversation history
  ): AsyncIterableIterator<ConversationEvent> {
    const timestamp = new Date().toISOString();

    // Emit thinking event
    yield {
      type: "thinking",
      data: {
        status: "processing",
        message: "ConversationSupervisor is analyzing your request...",
        fromUser,
      },
      timestamp,
      messageId,
      sessionId,
    };

    // QUICK FIX: Build conversation context from message history
    let conversationContext = "";
    if (messageHistory && messageHistory.length > 0) {
      // Include last 10 messages for context (5 exchanges)
      const recentHistory = messageHistory.slice(-10);
      conversationContext = "\n\nRECENT CONVERSATION HISTORY:\n";

      const logger = AtlasLogger.getInstance();
      logger.debug("ConversationSupervisor: Including conversation history", {
        sessionId,
        historyLength: messageHistory.length,
        recentHistoryLength: recentHistory.length,
      });

      for (const msg of recentHistory) {
        const role = msg.type === "user" ? "User" : "Assistant";
        conversationContext += `${role}: ${msg.content}\n`;
      }

      conversationContext += "\nCurrent message:\n";
    }

    const systemPrompt =
      `You are Atlas Assistant. In your FIRST interaction only, you can mention users can call you "Addy" for short if they prefer. After that, don't mention it again.

You help users create and manage AI agent workspaces in Atlas. Workspaces are YAML-configured environments where AI agents collaborate.

WORKSPACE CONFIGURATION:
A workspace.yml file defines:
- workspace: Basic identity (name, description)  
- agents: AI agents that perform tasks (LLM, remote, or Tempest agents)
- jobs: Multi-agent workflows with execution strategies
- signals: External triggers that start jobs (webhooks, CLI, etc)
- tools: MCP servers that provide capabilities to agents

WORKSPACE CREATION GUIDANCE:
When users want to create a workspace:
1. If they provide a name, use it directly (e.g., "kentest1", "my-workspace")
2. If they don't specify what it's for, use "A basic workspace for testing" as description
3. ACTUALLY CREATE IT using the workspace_create tool - don't just say you did
4. The workspace_create tool will create real files and directories

CRITICAL INSTRUCTIONS:
- When user says "create a workspace" or "make a workspace" YOU MUST:
  1. Call workspace_create with {name: "their-name", description: "their description or default"}
  2. Then call cx_reply to tell them the result
- NEVER just use cx_reply alone for workspace creation
- NEVER pretend you created something without calling workspace_create
- The workspace_create tool ACTUALLY creates real workspaces in the system

Available tools that you MUST use:
- workspace_create: Creates real workspaces (USE THIS FOR ANY WORKSPACE CREATION REQUEST)
- cx_reply: Communicates with the user (USE THIS TO TELL THEM THE RESULT)${conversationContext}`;

    try {
      const logger = AtlasLogger.getInstance();
      logger.debug("ConversationSupervisor: Calling LLM with tools", {
        message,
        toolNames: Object.keys(cxTools),
        sessionId,
      });

      const result = await LLMProviderManager.generateTextWithTools(message, {
        systemPrompt,
        tools: cxTools,
        model: "claude-3-5-haiku-20241022",
        temperature: 0.3,
        maxSteps: 3, // Allow multiple tool calls (workspace_create + cx_reply)
        toolChoice: "required", // Force the model to use tools
        operationContext: { operation: "conversation_supervision" },
      });

      logger.debug("ConversationSupervisor: LLM result", {
        toolCallsCount: result.toolCalls.length,
        toolNames: result.toolCalls.map((tc) => tc.toolName),
        hasText: !!result.text,
        sessionId,
      });

      // Emit tool call event
      if (result.toolCalls.length > 0) {
        const logger = AtlasLogger.getInstance();
        for (const toolCall of result.toolCalls) {
          logger.debug("ConversationSupervisor tool call", {
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
      }

      // Process tool results and emit events
      if (result.toolResults.length > 0) {
        // Process ALL tool results, not just the first one
        for (const toolResultWrapper of result.toolResults) {
          const toolResult = toolResultWrapper.result as any;

          // Find which tool was called
          const toolCall = result.toolCalls.find((tc) =>
            tc.toolCallId === toolResultWrapper.toolCallId
          );
          const toolName = toolCall?.toolName;

          if (!toolResult) continue;

          // Handle cx_reply tool result
          if (toolName === "cx_reply" && toolResult.message) {
            const words = toolResult.message.split(" ");
            let content = "";

            for (let i = 0; i < words.length; i++) {
              content += (i > 0 ? " " : "") + words[i];

              yield {
                type: "message_chunk",
                data: {
                  content,
                  partial: i < words.length - 1,
                },
                timestamp: new Date().toISOString(),
                messageId,
                sessionId,
              };

              // Small delay for realistic typing feel
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }

          // Emit transparency data (from cx_reply)
          if (toolName === "cx_reply" && toolResult.transparency) {
            const logger = AtlasLogger.getInstance();
            logger.debug("ConversationSupervisor reasoning", {
              analysis: toolResult.transparency.analysis,
              confidence: toolResult.transparency.confidence,
              complexity: toolResult.transparency.complexity,
              requiresAgentCoordination: toolResult.transparency.requiresAgentCoordination,
              sessionId,
              messageId,
            });

            yield {
              type: "transparency",
              data: toolResult.transparency,
              timestamp: new Date().toISOString(),
              messageId,
              sessionId,
            };
          }

          // Emit orchestration data if present
          if (toolResult.orchestration) {
            yield {
              type: "orchestration",
              data: toolResult.orchestration,
              timestamp: new Date().toISOString(),
              messageId,
              sessionId,
            };
          }
        } // End of for loop processing all tool results
      }

      // Emit completion event
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
}
