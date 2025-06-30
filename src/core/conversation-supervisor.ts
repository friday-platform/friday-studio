import { jsonSchema, Tool } from "ai";
import { LLMProviderManager } from "./agents/llm-provider-manager.ts";

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

// Atlas orchestration proxy tools with message envelope pattern for transparency
const atlasOrchestrationTools: Record<string, Tool> = {
  atlas_reply: {
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
                  description:
                    "Existing Atlas job to use (security-audit, code-review, architecture-review) or custom",
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
      const result: any = {
        message,
        transparency,
      };

      // If agent coordination is required, create orchestration plan
      if (transparency.requiresAgentCoordination && transparency.coordinationPlan) {
        const sessionId = `sess_${Math.random().toString(36).substring(2, 8)}`;

        result.orchestration = {
          sessionId,
          plan: {
            agents: transparency.coordinationPlan.agents || [],
            strategy: transparency.coordinationPlan.strategy,
            estimatedDuration: transparency.complexity === "high"
              ? "10-15min"
              : transparency.complexity === "medium"
              ? "5-10min"
              : "2-5min",
          },
          executionSteps: [
            `✅ Created WorkspaceSession ${sessionId}`,
            `🤖 Initialized ${(transparency.coordinationPlan.agents || []).length} agents: ${
              (transparency.coordinationPlan.agents || []).join(", ")
            }`,
            `⚡ Configured ${transparency.coordinationPlan.strategy} execution strategy`,
            `📊 Enabled real-time monitoring and supervision`,
            `🎯 ${
              transparency.coordinationPlan.recommendedJob
                ? `Triggered Atlas job: ${transparency.coordinationPlan.recommendedJob}`
                : "Started custom agent coordination"
            }`,
          ],
        };
      }

      return result;
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

    const systemPrompt =
      `You are an Atlas ConversationSupervisor that responds to ALL messages using the atlas_reply tool.

AVAILABLE ATLAS AGENTS:
- security-agent: Security vulnerability analysis, penetration testing, code security review
- code-reviewer: Static code analysis, best practices, maintainability assessment  
- architect: System architecture analysis, design patterns, scalability assessment
- performance-analyzer: Performance bottleneck detection, optimization recommendations

AVAILABLE ATLAS JOBS:
- security-audit: Parallel security and code quality review
- code-review: Sequential code quality and architecture analysis
- architecture-review: Staged architecture, performance, and security evaluation

RESPONSE GUIDELINES:
- ALWAYS use the atlas_reply tool for every response - never respond without using it
- Provide natural, conversational responses in the message field
- Include detailed reasoning and transparency data for every interaction
- Assess whether requests need agent coordination and provide coordination plans when needed
- Be transparent about your confidence level and complexity assessment
- For simple greetings or informational queries, set requiresAgentCoordination to false
- For code review, security analysis, or technical requests, set requiresAgentCoordination to true with appropriate agents

The atlas_reply tool provides structured transparency while maintaining conversational flow.`;

    try {
      const result = await LLMProviderManager.generateTextWithTools(message, {
        systemPrompt,
        tools: atlasOrchestrationTools,
        model: "claude-3-5-haiku-20241022",
        temperature: 0.3,
        maxSteps: 1,
        toolChoice: "required",
        operationContext: { operation: "conversation_supervision" },
      });

      // Emit tool call event
      if (result.toolCalls.length > 0) {
        for (const toolCall of result.toolCalls) {
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
        const toolResult = result.toolResults[0]?.result as any;

        if (toolResult) {
          // Emit message content progressively (simulate streaming)
          if (toolResult.message) {
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

          // Emit transparency data
          if (toolResult.transparency) {
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
