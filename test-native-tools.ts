#!/usr/bin/env -S deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file

// Test native tool calling implementation
import { LLMProviderManager } from "./src/core/agents/llm-provider-manager.ts";
import { Tool } from "ai";
import { z } from "zod/v4";

// Atlas orchestration proxy tools with reasoning transparency
const atlasOrchestrationTools: Record<string, Tool> = {
  atlas_coordinate_agents: {
    description: "Coordinate Atlas agents with transparent reasoning",
    parameters: z.object({
      analysis: z.string().describe("Your detailed reasoning for this coordination decision"),
      agents: z.array(z.string()).describe(
        "Atlas agents to coordinate (security-agent, code-reviewer, architect, performance-analyzer)",
      ),
      strategy: z.enum(["sequential", "parallel", "staged"]).describe(
        "Execution strategy for agent coordination",
      ),
      confidence: z.number().min(0).max(1).describe(
        "Confidence level in this coordination approach",
      ),
      complexity: z.enum(["low", "medium", "high"]).describe("Task complexity assessment"),
      recommendedJob: z.string().optional().describe(
        "Existing Atlas job to use (security-audit, code-review, architecture-review) or null for custom coordination",
      ),
    }),
    execute: async ({ analysis, agents, strategy, confidence, complexity, recommendedJob }) => {
      const sessionId = `sess_${Math.random().toString(36).substring(2, 8)}`;

      const result = {
        success: true,
        sessionId,
        orchestrationPlan: {
          agents: agents as string[],
          strategy,
          estimatedDuration: complexity === "high"
            ? "10-15min"
            : complexity === "medium"
            ? "5-10min"
            : "2-5min",
        },
        reasoning: {
          analysis,
          confidence,
          complexity,
          recommendedJob: recommendedJob || "custom coordination",
        },
        executionSteps: [
          `✅ Created WorkspaceSession ${sessionId}`,
          `🤖 Initialized ${(agents as string[]).length} agents: ${
            (agents as string[]).join(", ")
          }`,
          `⚡ Configured ${strategy} execution strategy`,
          `📊 Enabled real-time monitoring and supervision`,
          `🎯 ${
            recommendedJob
              ? `Triggered Atlas job: ${recommendedJob}`
              : "Started custom agent coordination"
          }`,
        ],
      };

      return result;
    },
  },

  atlas_provide_info: {
    description: "Provide information about Atlas capabilities without agent coordination",
    parameters: z.object({
      query_type: z.enum(["capabilities", "greeting", "help", "status"]).describe(
        "Type of information request",
      ),
      reasoning: z.string().describe("Why no agent coordination is needed"),
    }),
    execute: async ({ query_type, reasoning }) => {
      const responses = {
        capabilities:
          "Atlas is an AI agent orchestration platform with security-agent, code-reviewer, architect, and performance-analyzer agents. We coordinate them through hierarchical supervision with session management.",
        greeting:
          "Hi! I'm the Atlas ConversationSupervisor. I coordinate AI agents for software development tasks.",
        help:
          "I can coordinate Atlas agents for security audits, code reviews, architecture analysis, and performance optimization. Just describe what you need help with!",
        status: "Atlas platform is operational with 4 specialized agents ready for coordination.",
      };

      return {
        response: responses[query_type as keyof typeof responses] || "Atlas platform information",
        reasoning,
        requiresAgentCoordination: false,
      };
    },
  },
};

async function testNativeToolCalling() {
  console.log("🧠 Testing Native Tool Calling with Atlas Orchestration Proxy");
  console.log("=".repeat(60));

  const testMessages = [
    "Hi there!",
    "Help me review my authentication code for security issues",
  ];

  for (const message of testMessages) {
    console.log(`\n👤 User: ${message}`);

    const systemPrompt =
      `You are an Atlas ConversationSupervisor with access to Atlas agent orchestration tools.

AVAILABLE ATLAS AGENTS:
- security-agent: Security vulnerability analysis, penetration testing, code security review
- code-reviewer: Static code analysis, best practices, maintainability assessment  
- architect: System architecture analysis, design patterns, scalability assessment
- performance-analyzer: Performance bottleneck detection, optimization recommendations

AVAILABLE ATLAS JOBS:
- security-audit: Parallel security and code quality review
- code-review: Sequential code quality and architecture analysis
- architecture-review: Staged architecture, performance, and security evaluation

TOOL USAGE GUIDELINES:
- Use atlas_coordinate_agents for requests requiring agent coordination (code review, security analysis, architecture assessment)
- Use atlas_provide_info for simple greetings, help requests, or informational queries
- Always provide detailed reasoning in your tool calls
- Be transparent about your confidence level and complexity assessment

Respond conversationally while using tools to coordinate Atlas agents when appropriate.`;

    try {
      const result = await LLMProviderManager.generateTextWithTools(message, {
        systemPrompt,
        tools: atlasOrchestrationTools,
        model: "claude-3-5-haiku-20241022",
        temperature: 0.3,
        maxSteps: 1,
        toolChoice: "auto",
        operationContext: { operation: "conversation_supervision" },
      });

      console.log(`\n🔧 Tool Calls: ${result.toolCalls.length}`);

      if (result.toolCalls.length > 0) {
        result.toolCalls.forEach((call, idx) => {
          console.log(`  [${idx + 1}] ${call.toolName}`);
          console.log(`      Args: ${JSON.stringify(call.args, null, 2)}`);
        });

        console.log(`\n✅ Tool Results:`);
        result.toolResults.forEach((toolResult, idx) => {
          console.log(`  [${idx + 1}] ${result.toolCalls[idx]?.toolName}:`);
          try {
            const parsed = JSON.parse(toolResult.result as string);
            if (parsed.reasoning) {
              console.log(
                `      💭 Reasoning: ${
                  typeof parsed.reasoning === "string"
                    ? parsed.reasoning
                    : parsed.reasoning.analysis
                }`,
              );
            }
            if (parsed.orchestrationPlan) {
              console.log(
                `      📋 Plan: ${
                  parsed.orchestrationPlan.agents?.join(", ")
                } (${parsed.orchestrationPlan.strategy})`,
              );
            }
          } catch {
            console.log(`      Result: ${String(toolResult.result).substring(0, 100)}...`);
          }
        });
      }

      console.log(`\n🤖 Response: ${result.text}`);
    } catch (error) {
      console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log("\n" + "-".repeat(40));
  }

  console.log("\n✅ Test completed!");
}

if (import.meta.main) {
  await testNativeToolCalling();
}
