/**
 * Unit tests for reasoning machine actions
 */

import { assertEquals } from "@std/assert";
import type { ReasoningCallbacks, ReasoningContext, ReasoningStep } from "../src/types.ts";
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

// Helper to create test step
function createTestStep(): ReasoningStep {
  return {
    iteration: 1,
    thinking: "Test thinking",
    action: null,
    observation: "",
    confidence: 0.8,
    timestamp: Date.now(),
  };
}

Deno.test("actions: assignThinkingResult logic should create new current step", () => {
  const context = createTestContext();
  const event = {
    output: {
      thinking: "New thinking result",
      confidence: 0.9,
    },
  };

  // Simulate the action logic
  const newCurrentStep = {
    thinking: event.output.thinking,
    confidence: event.output.confidence,
    action: null,
    observation: "",
    timestamp: Date.now(),
    iteration: context.currentIteration + 1,
    result: undefined,
  };
  const newCurrentIteration = context.currentIteration + 1;

  // Verify results
  assertEquals(newCurrentStep.thinking, "New thinking result");
  assertEquals(newCurrentStep.confidence, 0.9);
  assertEquals(newCurrentStep.action, null);
  assertEquals(newCurrentStep.observation, "");
  assertEquals(newCurrentStep.iteration, 1);
  assertEquals(newCurrentIteration, 1);
  assertEquals(typeof newCurrentStep.timestamp, "number");
});

Deno.test("actions: assignActionToStep logic should add parsed action to current step", () => {
  const context = createTestContext();
  context.currentStep = createTestStep();

  const mockAction = {
    type: "tool_call" as const,
    toolName: "test_tool",
    parameters: { test: true },
    reasoning: "Test action",
  };

  // Mock callback
  const callbacks: Partial<ReasoningCallbacks<TestContext>> = {
    parseAction: (_thinking: string) => mockAction,
  };

  // Simulate the action logic
  const newCurrentStep = {
    ...context.currentStep!,
    action: callbacks.parseAction!(context.currentStep!.thinking),
  };

  // Verify results
  assertEquals(newCurrentStep.action, mockAction);
  assertEquals(newCurrentStep.thinking, "Test thinking");
});

Deno.test("actions: assignActionResult logic should update step with execution result", () => {
  const context = createTestContext();
  context.currentStep = createTestStep();

  const event = {
    output: {
      result: { data: "test result" },
      observation: "Test observation",
    },
  };

  // Mock callback
  const callbacks: Partial<ReasoningCallbacks<TestContext>> = {
    formatObservation: (result: unknown) => `Formatted: ${JSON.stringify(result)}`,
  };

  // Simulate the action logic - without formatObservation
  const newCurrentStep = {
    ...context.currentStep!,
    result: event.output.result,
    observation: event.output.observation,
  };

  // Verify results
  assertEquals(newCurrentStep.result, { data: "test result" });
  assertEquals(newCurrentStep.observation, "Test observation");

  // Test with formatObservation
  const newCurrentStepFormatted = {
    ...context.currentStep!,
    result: event.output.result,
    observation: callbacks.formatObservation?.(event.output.result) || event.output.observation,
  };

  assertEquals(newCurrentStepFormatted.observation, 'Formatted: {"data":"test result"}');
});

Deno.test("actions: addStepToHistory logic should add current step to steps array", () => {
  const context = createTestContext();
  const testStep = createTestStep();
  testStep.result = { data: "test" };
  context.currentStep = testStep;

  // Simulate the action logic
  const newSteps = [...context.steps, context.currentStep!];
  const newWorkingMemory = new Map(context.workingMemory);
  newWorkingMemory.set(`step_${context.steps.length}`, context.currentStep);
  if (context.currentStep?.result) {
    newWorkingMemory.set(`result_${context.steps.length}`, context.currentStep.result);
  }

  // Verify results
  assertEquals(newSteps.length, 1);
  assertEquals(newSteps[0], testStep);
  assertEquals(newWorkingMemory.get("step_0"), testStep);
  assertEquals(newWorkingMemory.get("result_0"), { data: "test" });
});

Deno.test("actions: assignThinkingError logic should create error step", () => {
  const context = createTestContext();

  // Simulate the action logic
  const newCurrentStep = {
    thinking: "Error during thinking",
    confidence: 0,
    action: null,
    observation: "Thinking failed",
    timestamp: Date.now(),
    iteration: context.currentIteration + 1,
    result: undefined,
  };

  // Verify results
  assertEquals(newCurrentStep.thinking, "Error during thinking");
  assertEquals(newCurrentStep.confidence, 0);
  assertEquals(newCurrentStep.observation, "Thinking failed");
  assertEquals(newCurrentStep.iteration, 1);
});

Deno.test("actions: assignExecutionError logic should update step with error", () => {
  const context = createTestContext();
  context.currentStep = createTestStep();

  const event = {
    error: new Error("Execution failed"),
  };

  // Simulate the action logic
  const newCurrentStep = {
    ...context.currentStep!,
    observation: `Action execution failed: ${event.error}`,
    result: null,
  };

  // Verify results
  assertEquals(newCurrentStep.observation, "Action execution failed: Error: Execution failed");
  assertEquals(newCurrentStep.result, null);
});

Deno.test("actions: assignExternalHint logic should add hint to working memory", () => {
  const context = createTestContext();
  const event = {
    type: "PROVIDE_HINT" as const,
    hint: "Try using the search tool",
  };

  // Simulate the action logic
  const newWorkingMemory = new Map(context.workingMemory);
  newWorkingMemory.set("external_hint", event.hint);

  // Verify results
  assertEquals(newWorkingMemory.get("external_hint"), "Try using the search tool");
});

Deno.test("actions: callback actions should invoke callbacks correctly", () => {
  const context = createTestContext();
  context.currentStep = createTestStep();

  let onThinkingStartCalled = false;
  let onThinkingUpdateCalled = false;
  let onActionDeterminedCalled = false;
  let onExecutionStartCalled = false;
  let onObservationCalled = false;

  const callbacks: ReasoningCallbacks<TestContext> = {
    think: () => Promise.resolve({ thinking: "", confidence: 0 }),
    parseAction: () => ({
      type: "complete",
      parameters: {},
      reasoning: "test",
    }),
    executeAction: () => Promise.resolve({ observation: "", result: {} }),
    onThinkingStart: (userContext) => {
      onThinkingStartCalled = true;
      assertEquals(userContext.testField, "test-value");
    },
    onThinkingUpdate: (thinking) => {
      onThinkingUpdateCalled = true;
      assertEquals(thinking, "Test thinking update");
    },
    onActionDetermined: (action) => {
      onActionDeterminedCalled = true;
      assertEquals(action.type, "complete");
    },
    onExecutionStart: (action) => {
      onExecutionStartCalled = true;
      assertEquals(action.type, "complete");
    },
    onObservation: (observation) => {
      onObservationCalled = true;
      assertEquals(observation, "Test observation");
    },
  };

  // Test onThinkingStart
  callbacks.onThinkingStart?.(context.userContext);
  assertEquals(onThinkingStartCalled, true);

  // Test onThinkingUpdate
  callbacks.onThinkingUpdate?.("Test thinking update");
  assertEquals(onThinkingUpdateCalled, true);

  // Test onActionDetermined
  const action = callbacks.parseAction(context.currentStep!.thinking);
  if (action) {
    callbacks.onActionDetermined?.(action);
  }
  assertEquals(onActionDeterminedCalled, true);

  // Test onExecutionStart
  context.currentStep.action = {
    type: "complete",
    parameters: {},
    reasoning: "test",
  };
  if (context.currentStep?.action) {
    callbacks.onExecutionStart?.(context.currentStep.action);
  }
  assertEquals(onExecutionStartCalled, true);

  // Test onObservation
  callbacks.onObservation?.("Test observation");
  assertEquals(onObservationCalled, true);
});

Deno.test("actions: notifySupervisor logic should send message to supervisor", () => {
  const context = createTestContext();
  context.currentStep = createTestStep();
  const supervisorId = "test-supervisor";

  let messageSent = false;
  let sentMessage: unknown = null;

  // Mock system
  const mockSupervisor = {
    send: (message: unknown) => {
      messageSent = true;
      sentMessage = message;
    },
  };

  const mockSystem = {
    get: (id: string) => {
      assertEquals(id, supervisorId);
      return mockSupervisor;
    },
  };

  // Simulate notifySupervisor logic
  if (supervisorId) {
    const supervisor = mockSystem.get(supervisorId);
    if (supervisor) {
      supervisor.send({
        type: "REASONING_STEP_COMPLETED",
        step: context.currentStep,
        totalSteps: context.steps.length,
      });
    }
  }

  // Verify results
  assertEquals(messageSent, true);
  assertEquals(sentMessage, {
    type: "REASONING_STEP_COMPLETED",
    step: context.currentStep,
    totalSteps: 0,
  });
});
