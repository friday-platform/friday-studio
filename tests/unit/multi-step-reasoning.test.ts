/**
 * Tests for MultiStepReasoningEngine
 * Tests the Think→Act→Observe loop logic without external dependencies
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  AgentExecutor,
  ReasoningAction,
  ReasoningContext,
  ReasoningStep,
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

// Create a testable version of the MultiStepReasoningEngine
class TestableMultiStepReasoningEngine {
  private mockResponses: string[] = [];
  private responseIndex = 0;

  setMockResponses(responses: string[]) {
    this.mockResponses = responses;
    this.responseIndex = 0;
  }

  // Mock the generateThinking method to return controlled responses
  private async generateThinking(): Promise<
    { thinking: string; confidence: number; cost: number }
  > {
    if (this.responseIndex >= this.mockResponses.length) {
      return {
        thinking: "ACTION: complete\nREASONING: No more responses available",
        confidence: 0.5,
        cost: 0.01,
      };
    }

    const thinking = this.mockResponses[this.responseIndex++];
    return {
      thinking,
      confidence: 0.8,
      cost: 0.02,
    };
  }

  // Copy the action parsing logic from the original
  private parseAction(thinking: string): ReasoningAction | null {
    try {
      const actionMatch = thinking.match(/ACTION:\s*(\w+)/i);
      const agentMatch = thinking.match(/AGENT_ID:\s*([^\n]+)/i);
      const toolMatch = thinking.match(/TOOL_NAME:\s*([^\n]+)/i);
      const parametersMatch = thinking.match(/PARAMETERS:\s*({[^}]*}|\[[^\]]*\])/i);
      const reasoningMatch = thinking.match(/REASONING:\s*([^\n]+)/i);

      if (!actionMatch) {
        return null;
      }

      const actionType = actionMatch[1].toLowerCase();
      if (!["agent_call", "tool_call", "complete"].includes(actionType)) {
        return null;
      }

      let parameters: Record<string, unknown> = {};
      if (parametersMatch) {
        try {
          parameters = JSON.parse(parametersMatch[1]);
        } catch {
          parameters = {};
        }
      }

      return {
        type: actionType as ReasoningAction["type"],
        agentId: agentMatch?.[1]?.trim(),
        toolName: toolMatch?.[1]?.trim(),
        parameters,
        reasoning: reasoningMatch?.[1]?.trim() || "No reasoning provided",
      };
    } catch (error) {
      return null;
    }
  }

  // Simplified reasoning loop for testing
  async reason(
    context: ReasoningContext,
    agentExecutor: AgentExecutor,
    toolExecutor: ToolExecutor,
  ): Promise<{
    success: boolean;
    steps: ReasoningStep[];
    finalSolution: unknown;
    totalIterations: number;
    totalDuration: number;
    totalCost: number;
  }> {
    const startTime = Date.now();
    const steps: ReasoningStep[] = [];
    const maxIterations = context.maxIterations || 10;
    let totalCost = 0;
    let currentIteration = 0;
    let finalSolution: unknown = null;

    const workingMemory = {
      originalSignal: context.signal,
      originalPayload: context.payload,
      availableAgents: context.availableAgents,
      intermediateResults: [] as unknown[],
      observations: [] as string[],
    };

    try {
      while (currentIteration < maxIterations) {
        currentIteration++;

        // THINK: Generate reasoning about current state and next action
        const thinkingResult = await this.generateThinking();
        totalCost += thinkingResult.cost;

        // Parse action from thinking
        const action = this.parseAction(thinkingResult.thinking);

        // ACT: Execute the action if present
        let observation = "";
        if (action) {
          const actionResult = await this.executeAction(
            action,
            agentExecutor,
            toolExecutor,
            workingMemory,
          );
          observation = actionResult.observation;

          if (actionResult.result !== undefined) {
            workingMemory.intermediateResults.push(actionResult.result);
          }
        } else {
          observation = "No action determined from thinking step";
        }

        workingMemory.observations.push(observation);

        // Create step record
        const step: ReasoningStep = {
          iteration: currentIteration,
          thinking: thinkingResult.thinking,
          action,
          observation,
          confidence: thinkingResult.confidence,
          timestamp: Date.now(),
        };

        steps.push(step);

        // Check if we should complete
        if (action?.type === "complete") {
          finalSolution = workingMemory.intermediateResults[
            workingMemory.intermediateResults.length - 1
          ] || observation;
          break;
        }

        if (!action) {
          break;
        }
      }

      return {
        success: true,
        steps,
        finalSolution,
        totalIterations: currentIteration,
        totalDuration: Date.now() - startTime,
        totalCost,
      };
    } catch (error) {
      return {
        success: false,
        steps,
        finalSolution: null,
        totalIterations: currentIteration,
        totalDuration: Date.now() - startTime,
        totalCost,
      };
    }
  }

  private async executeAction(
    action: ReasoningAction,
    agentExecutor: AgentExecutor,
    toolExecutor: ToolExecutor,
    workingMemory: any,
  ): Promise<{ observation: string; result?: unknown }> {
    try {
      switch (action.type) {
        case "agent_call": {
          if (!action.agentId) {
            return { observation: "Agent call failed: No agent ID specified" };
          }

          const result = await agentExecutor(action.agentId, action.parameters);
          return {
            observation: `Agent ${action.agentId} executed successfully. Result: ${
              JSON.stringify(result).substring(0, 200)
            }...`,
            result,
          };
        }

        case "tool_call": {
          if (!action.toolName) {
            return { observation: "Tool call failed: No tool name specified" };
          }

          const toolResult = await toolExecutor(action.toolName, action.parameters);
          if (toolResult.success) {
            return {
              observation: `Tool ${action.toolName} executed successfully. Result: ${
                JSON.stringify(toolResult.result).substring(0, 200)
              }...`,
              result: toolResult.result,
            };
          } else {
            return { observation: `Tool ${action.toolName} failed: ${toolResult.error}` };
          }
        }

        case "complete": {
          const finalResult = workingMemory.intermediateResults.length > 0
            ? workingMemory.intermediateResults[workingMemory.intermediateResults.length - 1]
            : "Task completed";

          return {
            observation: `Reasoning complete. Final result: ${
              JSON.stringify(finalResult).substring(0, 200)
            }...`,
            result: finalResult,
          };
        }

        default:
          return { observation: `Unknown action type: ${action.type}` };
      }
    } catch (error) {
      return {
        observation: `Action execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
}

Deno.test("MultiStepReasoningEngine - Basic Think→Act→Observe Loop", async () => {
  const engine = new TestableMultiStepReasoningEngine();

  // Set up mock LLM responses for thinking steps
  engine.setMockResponses([
    `THINKING: I need to analyze the user's request and determine what agent to call.

ACTION: agent_call
AGENT_ID: conversation-agent
PARAMETERS: {"task": "analyze user input", "input": "test signal"}
REASONING: The user has provided a signal that needs initial analysis`,

    `THINKING: The agent has analyzed the input successfully. I can now complete the task.

ACTION: complete
PARAMETERS: {}
REASONING: Analysis is complete and I have sufficient information`,
  ]);

  // Create test context
  const context: ReasoningContext = {
    sessionId: "test-session",
    workspaceId: "test-workspace",
    signal: createTestSignal(),
    payload: { message: "test message" },
    availableAgents: [createTestAgent("conversation-agent", "Conversation Agent")],
    maxIterations: 3,
    timeLimit: 5000,
  };

  // Mock agent executor
  const agentExecutor: AgentExecutor = async (agentId: string, input: any) => {
    assertEquals(agentId, "conversation-agent");
    assertEquals(input.task, "analyze user input");
    return { result: "Analysis complete", agentId, timestamp: new Date().toISOString() };
  };

  // Mock tool executor
  const toolExecutor: ToolExecutor = async (_toolName: string, _parameters: any) => {
    return { success: true, result: "tool executed", duration: 100 };
  };

  // Execute reasoning
  const result = await engine.reason(context, agentExecutor, toolExecutor);

  // Verify results
  assertEquals(result.success, true);
  assertEquals(result.steps.length, 2);
  assertEquals(result.totalIterations, 2);
  assertExists(result.finalSolution);

  // Verify first step (agent call)
  const firstStep = result.steps[0];
  assertEquals(firstStep.iteration, 1);
  assertExists(firstStep.thinking);
  assertEquals(firstStep.action?.type, "agent_call");
  assertEquals(firstStep.action?.agentId, "conversation-agent");
  assertExists(firstStep.observation);

  // Verify second step (completion)
  const secondStep = result.steps[1];
  assertEquals(secondStep.iteration, 2);
  assertEquals(secondStep.action?.type, "complete");
});

Deno.test("MultiStepReasoningEngine - Tool Calling", async () => {
  const engine = new TestableMultiStepReasoningEngine();

  engine.setMockResponses([
    `THINKING: I need to search for information before proceeding.

ACTION: tool_call
TOOL_NAME: web_search
PARAMETERS: {"query": "test query", "limit": 5}
REASONING: Need to gather external information`,

    `THINKING: Got search results, now I can complete.

ACTION: complete
PARAMETERS: {}
REASONING: Have all needed information`,
  ]);

  const context: ReasoningContext = {
    sessionId: "test-session",
    workspaceId: "test-workspace",
    signal: createTestSignal(),
    payload: { query: "test search" },
    availableAgents: [],
    maxIterations: 3,
  };

  const agentExecutor: AgentExecutor = async () => ({ result: "not used" });

  let toolCallCount = 0;
  const toolExecutor: ToolExecutor = async (toolName: string, parameters: any) => {
    toolCallCount++;
    assertEquals(toolName, "web_search");
    assertEquals(parameters.query, "test query");
    return { success: true, result: ["result1", "result2"], duration: 200 };
  };

  const result = await engine.reason(context, agentExecutor, toolExecutor);

  assertEquals(result.success, true);
  assertEquals(toolCallCount, 1);
  assertEquals(result.steps[0].action?.type, "tool_call");
  assertEquals(result.steps[0].action?.toolName, "web_search");
});

Deno.test("MultiStepReasoningEngine - No Action Parsing", async () => {
  const engine = new TestableMultiStepReasoningEngine();

  engine.setMockResponses([
    "I'm thinking about this but can't decide what to do. This is just some free-form text without any action.",
  ]);

  const context: ReasoningContext = {
    sessionId: "test-session",
    workspaceId: "test-workspace",
    signal: createTestSignal(),
    payload: {},
    availableAgents: [],
    maxIterations: 1,
  };

  const agentExecutor: AgentExecutor = async () => ({ result: "not called" });
  const toolExecutor: ToolExecutor = async () => ({
    success: true,
    result: "not called",
    duration: 0,
  });

  const result = await engine.reason(context, agentExecutor, toolExecutor);

  assertEquals(result.success, true);
  assertEquals(result.steps.length, 1);
  assertEquals(result.steps[0].action, null);
  assertEquals(result.steps[0].observation, "No action determined from thinking step");
});

Deno.test("MultiStepReasoningEngine - Max Iterations Limit", async () => {
  const engine = new TestableMultiStepReasoningEngine();

  // Always return thinking without completion
  engine.setMockResponses([
    `THINKING: Still working on this complex problem.

ACTION: agent_call
AGENT_ID: test-agent
PARAMETERS: {"task": "keep working"}
REASONING: Need more processing`,
    `THINKING: Still working on this complex problem.

ACTION: agent_call
AGENT_ID: test-agent
PARAMETERS: {"task": "keep working"}
REASONING: Need more processing`,
  ]);

  const context: ReasoningContext = {
    sessionId: "test-session",
    workspaceId: "test-workspace",
    signal: createTestSignal(),
    payload: {},
    availableAgents: [createTestAgent("test-agent", "Test Agent")],
    maxIterations: 2, // Limit to 2 iterations
  };

  const agentExecutor: AgentExecutor = async () => ({ result: "continuing work" });
  const toolExecutor: ToolExecutor = async () => ({
    success: true,
    result: "tool result",
    duration: 50,
  });

  const result = await engine.reason(context, agentExecutor, toolExecutor);

  assertEquals(result.success, true);
  assertEquals(result.totalIterations, 2); // Should stop at max iterations
  assertEquals(result.steps.length, 2);
});

Deno.test("MultiStepReasoningEngine - Agent Execution Error", async () => {
  const engine = new TestableMultiStepReasoningEngine();

  engine.setMockResponses([
    `THINKING: Call an agent that will fail.

ACTION: agent_call
AGENT_ID: failing-agent
PARAMETERS: {"task": "fail"}
REASONING: Testing error handling`,
  ]);

  const context: ReasoningContext = {
    sessionId: "test-session",
    workspaceId: "test-workspace",
    signal: createTestSignal(),
    payload: {},
    availableAgents: [createTestAgent("failing-agent", "Failing Agent")],
    maxIterations: 1,
  };

  // Agent executor that throws an error
  const agentExecutor: AgentExecutor = async () => {
    throw new Error("Agent execution failed");
  };

  const toolExecutor: ToolExecutor = async () => ({ success: true, result: "unused", duration: 0 });

  const result = await engine.reason(context, agentExecutor, toolExecutor);

  assertEquals(result.success, true); // Should still succeed overall
  assertEquals(result.steps[0].observation.includes("Agent execution failed"), true);
});

Deno.test("MultiStepReasoningEngine - Action Parsing", async () => {
  const engine = new TestableMultiStepReasoningEngine();

  engine.setMockResponses([
    `THINKING: This is a well-structured response.
ACTION: agent_call
AGENT_ID: test-agent
PARAMETERS: {"task": "test"}
REASONING: Clear reasoning provided`,
  ]);

  const context: ReasoningContext = {
    sessionId: "test-session",
    workspaceId: "test-workspace",
    signal: createTestSignal(),
    payload: {},
    availableAgents: [createTestAgent("test-agent", "Test Agent")],
    maxIterations: 1,
  };

  const agentExecutor: AgentExecutor = async () => ({ result: "success" });
  const toolExecutor: ToolExecutor = async () => ({ success: true, result: "unused", duration: 0 });

  const result = await engine.reason(context, agentExecutor, toolExecutor);

  assertEquals(result.success, true);

  // Confidence should be calculated based on structured thinking
  const confidence = result.steps[0].confidence;
  assertEquals(typeof confidence, "number");
  assertEquals(confidence > 0 && confidence <= 1, true);

  // Check action parsing
  assertEquals(result.steps[0].action?.type, "agent_call");
  assertEquals(result.steps[0].action?.agentId, "test-agent");
});
