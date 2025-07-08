import { BaseConversationAgent } from "./base-conversation-agent.ts";
import { jsonSchema, Tool } from "ai";
import { AtlasLogger } from "../../utils/logger.ts";
import { LLMProvider } from "../../utils/llm/provider.ts";
import type {
  ConversationEvent,
  ConversationMessage,
  ConversationSession,
} from "../conversation-supervisor.old.ts";

/**
 * ConversationSupervisorAgent: Proper Atlas agent for handling conversations
 * Extends BaseConversationAgent and runs in a worker with full supervision
 */
export class ConversationSupervisorAgent extends BaseConversationAgent {
  private conversationScope?: {
    workspaceId?: string;
    jobId?: string;
    sessionId?: string;
  };

  constructor(workspaceId: string = "atlas-global") {
    super(workspaceId);

    // Initialize conversation tools
    this.conversationTools = this.createConversationTools();

    // Set up prompts
    this.setPrompts(this.createSystemPrompt(), "");
  }

  // Set the conversation scope for this agent
  setConversationScope(scope: { workspaceId?: string; jobId?: string; sessionId?: string }) {
    this.conversationScope = scope;
    // Update prompts to include scope context
    this.setPrompts(this.createSystemPrompt(), "");
  }

  // IAtlasAgent implementation
  name(): string {
    return "ConversationSupervisor";
  }

  nickname(): string {
    return "Addy";
  }

  version(): string {
    return "1.0.0";
  }

  purpose(): string {
    return "Handle natural language conversations and orchestrate Atlas workspace operations";
  }

  // Create conversation-specific tools
  private createConversationTools(): Record<string, Tool> {
    return {
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
          this.log("cx_reply tool executed", "info", {
            message: message.substring(0, 500),
            messageLength: message.length,
            fullMessage: message,
            transparency,
          });
          return {
            message,
            transparency,
          };
        },
      },
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
          this.log("ConversationSupervisor: workspace_create tool called", "info", {
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
              this.log("Failed to create workspace", "error", { error, status: response.status });
              return {
                success: false,
                error: `Failed to create workspace: ${error}`,
              };
            }

            const workspace = await response.json();
            this.log("Workspace created successfully", "info", { workspace });

            return {
              success: true,
              workspace,
              message: `Workspace '${name}' created successfully with ID: ${workspace.id}`,
            };
          } catch (error) {
            this.log("Error creating workspace", "error", { error });
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
  }

  private createSystemPrompt(): string {
    const basePrompt = `You are Addy, the Atlas AI assistant.

MANDATORY RESPONSE FOR SPECIFIC QUESTIONS:
When the current message is exactly "what is atlas?" (case insensitive), you MUST:
1. IGNORE all conversation history
2. Use cx_reply with message field containing EXACTLY this text:
"Atlas is an AI agent orchestration platform where engineers create workspaces for AI agents to collaborate on tasks. Think of it as Kubernetes for AI agents. You define agents, jobs, and signals in YAML files, and Atlas manages the execution."

CRITICAL INSTRUCTIONS FOR ALL RESPONSES:
- The "message" field in cx_reply MUST contain your COMPLETE response
- NEVER split your response across multiple tool calls
- Include ALL explanations, comparisons, details in the message field
- If you want to ask a follow-up question, include it at the END of your full response
- Example: If comparing Atlas to Claude Code, put the ENTIRE comparison in the message field

WRONG:
message: "Would you like me to elaborate on X?" (missing the actual content)

RIGHT:
message: "Atlas differs from Claude Code in several ways: [full comparison here]. Would you like me to elaborate on any specific aspect?"`;

    // Add scope context if available
    let scopeContext = "";
    if (this.conversationScope) {
      if (this.conversationScope.sessionId) {
        scopeContext =
          `\n\nCONVERSATION SCOPE: You are operating within a specific session (${this.conversationScope.sessionId}) of job ${this.conversationScope.jobId} in workspace ${this.conversationScope.workspaceId}. You have access to session-specific context and tools.`;
      } else if (this.conversationScope.jobId) {
        scopeContext =
          `\n\nCONVERSATION SCOPE: You are operating within job ${this.conversationScope.jobId} in workspace ${this.conversationScope.workspaceId}. You have access to job-specific context and tools.`;
      } else if (this.conversationScope.workspaceId) {
        scopeContext =
          `\n\nCONVERSATION SCOPE: You are operating within workspace ${this.conversationScope.workspaceId}. You have access to workspace-specific tools and context.`;
      }
    } else {
      scopeContext =
        "\n\nCONVERSATION SCOPE: Global Atlas conversation. You have access to Atlas platform-level tools.";
    }

    return basePrompt + scopeContext + `

Available tools:
- cx_reply: Send messages to the user (REQUIRED for all responses) - message field must contain COMPLETE response
- workspace_create: Create new workspaces`;
  }

  // Main conversation processing method
  async *processConversationMessage(
    sessionId: string,
    messageId: string,
    message: string,
    fromUser: string,
    messageHistory?: ConversationMessage[],
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

    // Build conversation context
    const conversationContext = this.buildConversationContext(messageHistory);

    // Process with LLM and tools
    const systemPrompt = this.createSystemPrompt() + conversationContext;

    try {
      this.log("ConversationSupervisor: Calling LLM with tools", "debug", {
        message,
        toolNames: Object.keys(this.conversationTools),
        sessionId,
        systemPromptLength: systemPrompt.length,
        systemPromptPreview: systemPrompt.substring(0, 200) + "...",
      });

      const result = await LLMProvider.generateTextWithTools(message, {
        systemPrompt,
        tools: this.conversationTools,
        model: "claude-3-5-haiku-20241022",
        temperature: 0.7,
        maxSteps: 1, // Only allow ONE tool call per message
        toolChoice: "required", // Force the model to use tools
        operationContext: { operation: "conversation_supervision" },
      });

      this.log("ConversationSupervisor: LLM result", "debug", {
        toolCallsCount: result.toolCalls.length,
        toolNames: result.toolCalls.map((tc) => tc.toolName),
        toolResultsCount: result.toolResults.length,
        hasText: !!result.text,
        sessionId,
      });

      // Emit tool call event
      if (result.toolCalls.length > 0) {
        for (const toolCall of result.toolCalls) {
          this.log("ConversationSupervisor tool call", "debug", {
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
      yield* this.processToolResults(result, messageId, sessionId);

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

  // Process tool results and emit appropriate events
  protected override async *processToolResults(
    result: any,
    messageId: string,
    sessionId: string,
  ): AsyncIterableIterator<ConversationEvent> {
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
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }

        // Emit transparency data (from cx_reply)
        if (toolName === "cx_reply" && toolResult.transparency) {
          this.log("ConversationSupervisor reasoning", "debug", {
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
      }
    }
  }
}
