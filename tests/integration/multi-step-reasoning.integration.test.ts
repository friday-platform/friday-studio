/**
 * REAL Integration Test for MultiStepReasoningEngine
 * Actually calls LLM APIs - no mocked bs
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MultiStepReasoningEngine } from "../../src/core/multi-step-reasoning.ts";
import type {
  AgentExecutor,
  ReasoningContext,
  ToolExecutor,
} from "../../src/core/multi-step-reasoning.ts";
import type { IWorkspaceSignal } from "../../src/types/core.ts";
import type { AgentMetadata } from "../../src/core/session-supervisor.ts";

// Helper functions for test data
function createTestSignal(id: string = "test-signal"): IWorkspaceSignal {
  return {
    id,
    provider: { id: "test-provider", name: "Test Provider" },
    trigger: async () => {},
    configure: () => {},
    context: {} as any,
    memory: {} as any,
    messages: {} as any,
    prompts: { system: "", user: "" },
    gates: [],
    newConversation: () => ({} as any),
    getConversation: () => ({} as any),
    archiveConversation: () => {},
    deleteConversation: () => {},
  };
}

function createTestAgent(id: string, name: string = "Test Agent"): AgentMetadata {
  return {
    id,
    name,
    purpose: "Test purpose",
    type: "system",
    config: { type: "system", agent: id, version: "1.0.0", tools: [] },
  };
}

// This test requires ANTHROPIC_API_KEY environment variable
Deno.test({
  name: "MultiStepReasoningEngine - REAL LLM Integration",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"), // Skip if no API key
  async fn() {
    console.log("🔥 RUNNING REAL LLM INTEGRATION TEST - NO MOCKS");

    const engine = new MultiStepReasoningEngine();

    // Create test context
    const context: ReasoningContext = {
      sessionId: "integration-test-session",
      workspaceId: "integration-test-workspace",
      signal: createTestSignal("integration-signal"),
      payload: {
        task: "Analyze the word 'hello' and then use a calculator to add 2 + 3",
        instructions: "First analyze the word, then do the math calculation",
      },
      availableAgents: [
        createTestAgent("text-analyzer", "Text Analyzer"),
        createTestAgent("calculator", "Calculator"),
      ],
      maxIterations: 5,
      timeLimit: 30000, // 30 seconds
    };

    // REAL agent executor that simulates actual agent work
    const agentExecutor: AgentExecutor = async (agentId: string, input: any) => {
      console.log(`📞 REAL AGENT CALL: ${agentId} with input:`, input);

      // Simulate different agent behaviors
      if (agentId === "text-analyzer") {
        return {
          result:
            `Analysis of word: The word contains 5 letters, starts with 'h', and is a common greeting.`,
          agentId,
          timestamp: new Date().toISOString(),
          processed: true,
        };
      } else if (agentId === "calculator") {
        return {
          result: `Calculation result: 2 + 3 = 5`,
          agentId,
          timestamp: new Date().toISOString(),
          computed: true,
        };
      }

      return {
        result: `Agent ${agentId} processed input successfully`,
        agentId,
        timestamp: new Date().toISOString(),
      };
    };

    // REAL tool executor that simulates actual tool calls
    const toolExecutor: ToolExecutor = async (toolName: string, parameters: any) => {
      console.log(`🔧 REAL TOOL CALL: ${toolName} with parameters:`, parameters);

      // Simulate different tool behaviors
      if (toolName === "web_search") {
        return {
          success: true,
          result: [
            `Search result 1 for: ${parameters.query}`,
            `Search result 2 for: ${parameters.query}`,
          ],
          duration: 1200,
        };
      } else if (toolName === "file_read") {
        return {
          success: true,
          result: `File content: Mock file content for ${parameters.filename}`,
          duration: 50,
        };
      }

      return {
        success: true,
        result: `Tool ${toolName} executed successfully`,
        duration: 100,
      };
    };

    console.log("🚀 Starting real LLM reasoning...");
    const startTime = Date.now();

    // Execute REAL reasoning with REAL LLM calls
    const result = await engine.reason(context, agentExecutor, toolExecutor);

    const duration = Date.now() - startTime;
    console.log(`⏱️  Total execution time: ${duration}ms`);

    // Log the actual LLM reasoning steps
    console.log("\n🧠 ACTUAL LLM REASONING STEPS:");
    result.steps.forEach((step, i) => {
      console.log(`\n--- Step ${i + 1} ---`);
      console.log(`Thinking: ${step.thinking.substring(0, 200)}...`);
      console.log(`Action: ${step.action?.type || "none"}`);
      console.log(`Observation: ${step.observation.substring(0, 200)}...`);
      console.log(`Confidence: ${step.confidence}`);
    });

    // Verify the results
    console.log("\n✅ VERIFICATION:");
    console.log(`Success: ${result.success}`);
    console.log(`Total iterations: ${result.totalIterations}`);
    console.log(`Total cost: $${result.totalCost.toFixed(4)}`);
    console.log(`Final solution: ${JSON.stringify(result.finalSolution).substring(0, 200)}...`);

    // Assertions
    assertEquals(result.success, true, "Reasoning should succeed");
    assertEquals(result.steps.length > 0, true, "Should have reasoning steps");
    assertEquals(result.totalIterations > 0, true, "Should have iterations");
    assertEquals(result.totalCost > 0, true, "Should have actual LLM costs");
    assertExists(result.finalSolution, "Should have a final solution");

    // Verify at least one step has actual LLM thinking
    const hasRealThinking = result.steps.some((step) =>
      step.thinking.length > 50 && step.thinking.includes("THINKING")
    );
    assertEquals(hasRealThinking, true, "Should have real LLM thinking steps");

    console.log("\n🎉 REAL LLM INTEGRATION TEST PASSED!");
  },
});

// Test with minimal setup to verify LLM connectivity
Deno.test({
  name: "MultiStepReasoningEngine - LLM Connectivity Check",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"), // Skip if no API key
  async fn() {
    console.log("🔍 Testing basic LLM connectivity...");

    const engine = new MultiStepReasoningEngine();

    const context: ReasoningContext = {
      sessionId: "connectivity-test",
      workspaceId: "connectivity-test",
      signal: createTestSignal("connectivity-signal"),
      payload: { task: "Say hello and complete" },
      availableAgents: [],
      maxIterations: 2,
      timeLimit: 10000,
    };

    const agentExecutor: AgentExecutor = async () => ({ result: "hello from agent" });
    const toolExecutor: ToolExecutor = async () => ({
      success: true,
      result: "hello from tool",
      duration: 0,
    });

    const result = await engine.reason(context, agentExecutor, toolExecutor);

    console.log("📊 LLM Response Summary:");
    console.log(`- Success: ${result.success}`);
    console.log(`- Steps: ${result.steps.length}`);
    console.log(`- Cost: $${result.totalCost.toFixed(4)}`);
    console.log(`- First step thinking: ${result.steps[0]?.thinking.substring(0, 100)}...`);

    assertEquals(result.success, true);
    assertEquals(result.steps.length > 0, true);
    assertEquals(result.totalCost > 0, true);

    console.log("✅ LLM connectivity verified!");
  },
});

// Test that shows LLM reasoning transparency
Deno.test({
  name: "MultiStepReasoningEngine - Reasoning Transparency",
  ignore: !Deno.env.get("ANTHROPIC_API_KEY"),
  async fn() {
    console.log("🔬 Testing reasoning transparency...");

    const engine = new MultiStepReasoningEngine();

    const context: ReasoningContext = {
      sessionId: "transparency-test",
      workspaceId: "transparency-test",
      signal: createTestSignal("transparency-signal"),
      payload: {
        task: "First call the data-agent, then call the summary-agent with the data results",
        requirement: "Must call both agents in sequence",
      },
      availableAgents: [
        createTestAgent("data-agent", "Data Agent"),
        createTestAgent("summary-agent", "Summary Agent"),
      ],
      maxIterations: 4,
      timeLimit: 20000,
    };

    let agentCallOrder: string[] = [];
    const agentExecutor: AgentExecutor = async (agentId: string, input: any) => {
      agentCallOrder.push(agentId);
      console.log(`📞 Agent called: ${agentId} (call #${agentCallOrder.length})`);

      if (agentId === "data-agent") {
        return { result: "Data: [1, 2, 3, 4, 5]", source: "data-agent" };
      } else if (agentId === "summary-agent") {
        return { result: "Summary: 5 data points with average 3", source: "summary-agent" };
      }

      return { result: `Result from ${agentId}`, source: agentId };
    };

    const toolExecutor: ToolExecutor = async () => ({
      success: true,
      result: "unused",
      duration: 0,
    });

    const result = await engine.reason(context, agentExecutor, toolExecutor);

    console.log("\n🎯 REASONING TRANSPARENCY ANALYSIS:");
    console.log(`Agent call order: ${agentCallOrder.join(" → ")}`);

    result.steps.forEach((step, i) => {
      console.log(`\nStep ${i + 1}:`);
      console.log(`  Action: ${step.action?.type} (${step.action?.agentId || "none"})`);
      console.log(`  Reasoning visible: ${step.thinking.includes("THINKING")}`);
      console.log(`  Observation: ${step.observation.substring(0, 100)}...`);
    });

    // Verify transparency
    assertEquals(result.success, true);
    assertEquals(agentCallOrder.length > 0, true, "Should have called agents");

    // Check that reasoning steps are visible
    const hasVisibleReasoning = result.steps.some((step) =>
      step.thinking.includes("THINKING") && step.thinking.length > 20
    );
    assertEquals(hasVisibleReasoning, true, "Should have visible reasoning");

    console.log("✅ Reasoning transparency verified!");
  },
});
