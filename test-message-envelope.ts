#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file

// Test the new message envelope pattern for ConversationSupervisor
import { LLMProviderManager } from "./src/core/agents/llm-provider-manager.ts";
import { jsonSchema, Tool } from "ai";

// Atlas reply tool with message envelope pattern for transparency
const atlasReplyTool: Record<string, Tool> = {
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

async function testMessageEnvelope() {
  console.log("🧠 Testing Message Envelope Pattern");
  console.log("=".repeat(60));

  const testMessages = [
    "Hi there!",
    "Help me review my authentication code for security issues",
    "Can you analyze my microservices architecture for performance bottlenecks?",
  ];

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

  for (const message of testMessages) {
    console.log(`\n👤 User: ${message}`);

    try {
      const result = await LLMProviderManager.generateTextWithTools(message, {
        systemPrompt,
        tools: atlasReplyTool,
        model: "claude-3-5-haiku-20241022",
        temperature: 0.3,
        maxSteps: 1,
        toolChoice: "required",
        operationContext: { operation: "conversation_supervision" },
      });

      console.log(`\n🔧 Tool Called: ${result.toolCalls[0]?.toolName || "None"}`);

      if (result.toolCalls.length > 0) {
        const toolResult = result.toolResults[0]?.result as any;

        if (toolResult) {
          console.log(`\n💬 Message: "${toolResult.message}"`);

          if (toolResult.transparency) {
            console.log(`\n🔍 Transparency:`);
            console.log(`   Analysis: ${toolResult.transparency.analysis}`);
            console.log(`   Confidence: ${(toolResult.transparency.confidence * 100).toFixed(0)}%`);
            console.log(`   Complexity: ${toolResult.transparency.complexity}`);
            console.log(
              `   Requires Coordination: ${
                toolResult.transparency.requiresAgentCoordination ? "Yes" : "No"
              }`,
            );

            if (
              toolResult.transparency.requiresAgentCoordination &&
              toolResult.transparency.coordinationPlan
            ) {
              console.log(`\n📋 Coordination Plan:`);
              console.log(
                `   Agents: ${
                  toolResult.transparency.coordinationPlan.agents?.join(", ") || "None"
                }`,
              );
              console.log(
                `   Strategy: ${
                  toolResult.transparency.coordinationPlan.strategy || "Not specified"
                }`,
              );
              console.log(
                `   Job: ${toolResult.transparency.coordinationPlan.recommendedJob || "Custom"}`,
              );
            }
          }

          if (toolResult.orchestration) {
            console.log(`\n⚡ Atlas Orchestration:`);
            console.log(`   Session: ${toolResult.orchestration.sessionId}`);
            console.log(`   Duration: ${toolResult.orchestration.plan.estimatedDuration}`);
            console.log(`   Steps:`);
            toolResult.orchestration.executionSteps.forEach((step: string, idx: number) => {
              console.log(`     ${idx + 1}. ${step}`);
            });
          }
        }
      }

      // Additional response text (should be empty with required tool use)
      if (result.text && result.text.trim()) {
        console.log(`\n🤖 Additional Text: "${result.text}"`);
      }
    } catch (error) {
      console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log("\n" + "-".repeat(60));
  }

  console.log("\n✅ Message envelope test finished!");
}

if (import.meta.main) {
  await testMessageEnvelope();
}
