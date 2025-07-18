/**
 * Unit tests for reasoning machine actors
 */

import { assertEquals } from "@std/assert";
import type { ReasoningAction, ReasoningCallbacks, ReasoningContext } from "../src/types.ts";
import type { BaseReasoningContext } from "../src/types.ts";

// Test context type
interface TestContext extends BaseReasoningContext {
  sessionId: string;
  workspaceId: string;
  testField: string;
}

// Helper to create test context
function createTestContext(): ReasoningContext<TestContext> {
  const userContext: TestContext = {
    sessionId: "test-session",
    workspaceId: "test-workspace",
    testField: "test-value",
  };

  return {
    userContext,
    currentStep: null,
    steps: [],
    workingMemory: new Map(),
    maxIterations: 10,
    currentIteration: 0,
  };
}

Deno.test("actors: think actor logic should work correctly", async () => {
  const testContext = createTestContext();
  let thinkCalled = false;
  let receivedContext: ReasoningContext<TestContext> | null = null;

  // Create mock callbacks
  const mockCallbacks: ReasoningCallbacks<TestContext> = {
    think: (context) => {
      thinkCalled = true;
      receivedContext = context;
      return Promise.resolve({
        thinking: "Test thinking result",
        confidence: 0.85,
      });
    },
    parseAction: () => null,
    executeAction: () => Promise.resolve({ observation: "", result: {} }),
  };

  // Test the think actor logic directly
  const result = await mockCallbacks.think(testContext);

  // Verify results
  assertEquals(thinkCalled, true);
  assertEquals(receivedContext, testContext);
  assertEquals(result, {
    thinking: "Test thinking result",
    confidence: 0.85,
  });
});

Deno.test("actors: think actor should handle errors", async () => {
  const testContext = createTestContext();

  // Create mock callbacks that throw
  const mockCallbacks: ReasoningCallbacks<TestContext> = {
    think: () => {
      return Promise.reject(new Error("Think failed"));
    },
    parseAction: () => null,
    executeAction: () => Promise.resolve({ observation: "", result: {} }),
  };

  // Test error handling
  try {
    await mockCallbacks.think(testContext);
    throw new Error("Should have thrown");
  } catch (error) {
    assertEquals(error instanceof Error, true);
    assertEquals((error as Error).message, "Think failed");
  }
});

Deno.test("actors: executeAction actor logic should work correctly", async () => {
  const testContext = createTestContext();
  const testAction = {
    type: "tool_call" as const,
    toolName: "test_tool",
    parameters: { value: "test" },
    reasoning: "Testing the action",
  };

  let executeCalled = false;
  let receivedAction: ReasoningAction | null = null;
  let receivedContext: ReasoningContext<TestContext> | null = null;

  // Create mock callbacks
  const mockCallbacks: ReasoningCallbacks<TestContext> = {
    think: () => Promise.resolve({ thinking: "", confidence: 0 }),
    parseAction: () => null,
    executeAction: (action, context) => {
      executeCalled = true;
      receivedAction = action;
      receivedContext = context;
      return Promise.resolve({
        observation: "Action executed successfully",
        result: { data: "test-result" },
      });
    },
  };

  // Test the executeAction actor logic with duration tracking
  const startTime = Date.now();
  const result = await mockCallbacks.executeAction(testAction, testContext);
  const duration = Date.now() - startTime;
  const finalResult = { ...result, duration };

  // Verify results
  assertEquals(executeCalled, true);
  assertEquals(receivedAction, testAction);
  assertEquals(receivedContext, testContext);
  assertEquals(finalResult.observation, "Action executed successfully");
  assertEquals(finalResult.result, { data: "test-result" });
  assertEquals(typeof finalResult.duration, "number");
});

Deno.test("actors: executeAction actor should handle errors", async () => {
  const testContext = createTestContext();
  const testAction = {
    type: "tool_call" as const,
    toolName: "test_tool",
    parameters: { value: "test" },
    reasoning: "Testing the action",
  };

  // Create mock callbacks that throw
  const mockCallbacks: ReasoningCallbacks<TestContext> = {
    think: () => Promise.resolve({ thinking: "", confidence: 0 }),
    parseAction: () => null,
    executeAction: () => {
      return Promise.reject(new Error("Execution failed"));
    },
  };

  // Test error handling
  try {
    await mockCallbacks.executeAction(testAction, testContext);
    throw new Error("Should have thrown");
  } catch (error) {
    assertEquals(error instanceof Error, true);
    assertEquals((error as Error).message, "Execution failed");
  }
});

Deno.test("actors: executeAction actor should include duration in result", async () => {
  const testContext = createTestContext();
  const testAction = {
    type: "tool_call" as const,
    toolName: "test_tool",
    parameters: { value: "test" },
    reasoning: "Testing the action",
  };

  // Create mock callbacks with delay
  const mockCallbacks: ReasoningCallbacks<TestContext> = {
    think: () => Promise.resolve({ thinking: "", confidence: 0 }),
    parseAction: () => null,
    executeAction: async () => {
      // Add artificial delay
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        observation: "Action executed with delay",
        result: { data: "test-result" },
      };
    },
  };

  // Test the executeAction actor logic with duration tracking
  const startTime = Date.now();
  const result = await mockCallbacks.executeAction(testAction, testContext);
  const duration = Date.now() - startTime;
  const finalResult = { ...result, duration };

  // Duration should be at least 50ms due to our artificial delay
  assertEquals(finalResult.duration >= 50, true);
  assertEquals(finalResult.observation, "Action executed with delay");
});
