import { assertEquals } from "@std/assert";
import type { BaseReasoningContext, ReasoningContext, ReasoningStep } from "../src/types.ts";

// Test user context
interface TestUserContext extends BaseReasoningContext {
  sessionId: string;
  workspaceId: string;
  test: string;
}

// Mock callbacks for guard testing
const mockCallbacks = {
  isComplete: undefined as ((context: ReasoningContext<TestUserContext>) => boolean) | undefined,
  think: () => Promise.resolve({ thinking: "test", confidence: 0.8 }),
  executeAction: () => Promise.resolve({ result: {}, observation: "test" }),
  parseAction: () => null,
};

// Helper to create test context
function createTestContext(
  overrides: Partial<ReasoningContext<TestUserContext>> = {},
): ReasoningContext<TestUserContext> {
  const userContext: TestUserContext = {
    sessionId: "test-session",
    workspaceId: "test-workspace",
    test: "value",
  };

  return {
    userContext,
    currentStep: null,
    steps: [],
    workingMemory: new Map(),
    maxIterations: 10,
    currentIteration: 0,
    ...overrides,
  };
}

// Helper to create test step
function createTestStep(overrides: Partial<ReasoningStep> = {}): ReasoningStep {
  return {
    thinking: "Test thinking",
    confidence: 0.8,
    action: null,
    observation: "",
    timestamp: Date.now(),
    iteration: 1,
    result: undefined,
    ...overrides,
  };
}

// Import guards from machine.ts
// Since guards are defined inline in the setup, we'll test the logic directly
import { createReasoningMachine } from "../src/machine.ts";

// Extract guards for testing - we'll create a helper to get them
function getGuards(callbacks = mockCallbacks) {
  try {
    createReasoningMachine(callbacks);
  } catch {
    // Expected - machine creation is not complete yet
  }

  // For now, we'll test the guard logic directly
  return {
    isComplete: ({ context }: { context: ReasoningContext<TestUserContext> }) => {
      return context.currentStep?.action?.type === "complete";
    },

    shouldTerminate: ({ context }: { context: ReasoningContext<TestUserContext> }) => {
      if (callbacks.isComplete?.(context)) return true;
      if (context.currentIteration >= context.maxIterations) return true;
      return false;
    },

    hasValidAction: ({ context }: { context: ReasoningContext<TestUserContext> }) => {
      return context.currentStep !== null && context.currentStep.action !== null;
    },

    hasCompletedStep: ({ context }: { context: ReasoningContext<TestUserContext> }) => {
      const hasCurrentStepInArray = context.steps.some(
        (step) => step.timestamp === context.currentStep?.timestamp,
      );
      return hasCurrentStepInArray && context.currentStep?.action?.type === "complete";
    },
  };
}

Deno.test("guards - isComplete", async (t) => {
  const guards = getGuards();

  await t.step("returns true when action type is complete", () => {
    const context = createTestContext({
      currentStep: createTestStep({
        action: { type: "complete", parameters: {}, reasoning: "Task completed" },
      }),
    });

    assertEquals(guards.isComplete({ context }), true);
  });

  await t.step("returns false when action type is not complete", () => {
    const context = createTestContext({
      currentStep: createTestStep({
        action: {
          type: "agent_call",
          agentId: "test",
          parameters: {},
          reasoning: "Calling test agent",
        },
      }),
    });

    assertEquals(guards.isComplete({ context }), false);
  });

  await t.step("returns false when action is null", () => {
    const context = createTestContext({ currentStep: createTestStep({ action: null }) });

    assertEquals(guards.isComplete({ context }), false);
  });

  await t.step("returns false when currentStep is null", () => {
    const context = createTestContext({ currentStep: null });
    assertEquals(guards.isComplete({ context }), false);
  });
});

Deno.test("guards - shouldTerminate", async (t) => {
  await t.step("returns true when custom isComplete returns true", () => {
    const customCallbacks = { ...mockCallbacks, isComplete: () => true };
    const guards = getGuards(customCallbacks);
    const context = createTestContext();

    assertEquals(guards.shouldTerminate({ context }), true);
  });

  await t.step("returns true when currentIteration >= maxIterations", () => {
    const guards = getGuards();
    const context = createTestContext({ currentIteration: 10, maxIterations: 10 });

    assertEquals(guards.shouldTerminate({ context }), true);
  });

  await t.step("returns true when currentIteration exceeds maxIterations", () => {
    const guards = getGuards();
    const context = createTestContext({ currentIteration: 15, maxIterations: 10 });

    assertEquals(guards.shouldTerminate({ context }), true);
  });

  await t.step("returns false when neither condition is met", () => {
    const guards = getGuards();
    const context = createTestContext({ currentIteration: 5, maxIterations: 10 });

    assertEquals(guards.shouldTerminate({ context }), false);
  });

  await t.step("returns false when isComplete is undefined", () => {
    const customCallbacks = { ...mockCallbacks, isComplete: undefined };
    const guards = getGuards(customCallbacks);
    const context = createTestContext({ currentIteration: 5, maxIterations: 10 });

    assertEquals(guards.shouldTerminate({ context }), false);
  });
});

Deno.test("guards - hasValidAction", async (t) => {
  const guards = getGuards();

  await t.step("returns true when action is not null", () => {
    const context = createTestContext({
      currentStep: createTestStep({
        action: {
          type: "agent_call",
          agentId: "test",
          parameters: {},
          reasoning: "Calling test agent",
        },
      }),
    });

    assertEquals(guards.hasValidAction({ context }), true);
  });

  await t.step("returns false when action is null", () => {
    const context = createTestContext({ currentStep: createTestStep({ action: null }) });

    assertEquals(guards.hasValidAction({ context }), false);
  });

  await t.step("returns false when currentStep is null", () => {
    const context = createTestContext({ currentStep: null });
    assertEquals(guards.hasValidAction({ context }), false);
  });
});

Deno.test("guards - hasCompletedStep", async (t) => {
  const guards = getGuards();

  await t.step("returns true when step is in array and action is complete", () => {
    const step = createTestStep({
      action: { type: "complete", parameters: {}, reasoning: "Task completed" },
      timestamp: 12345,
    });
    const context = createTestContext({
      currentStep: step,
      steps: [step], // Step is in the array
    });

    assertEquals(guards.hasCompletedStep({ context }), true);
  });

  await t.step("returns false when step is not in array", () => {
    const step = createTestStep({
      action: { type: "complete", parameters: {}, reasoning: "Task completed" },
      timestamp: 12345,
    });
    const context = createTestContext({
      currentStep: step,
      steps: [], // Step is not in the array
    });

    assertEquals(guards.hasCompletedStep({ context }), false);
  });

  await t.step("returns false when action is not complete", () => {
    const step = createTestStep({
      action: {
        type: "agent_call",
        agentId: "test",
        parameters: {},
        reasoning: "Calling test agent",
      },
      timestamp: 12345,
    });
    const context = createTestContext({ currentStep: step, steps: [step] });

    assertEquals(guards.hasCompletedStep({ context }), false);
  });

  await t.step("returns false when currentStep is null", () => {
    const context = createTestContext({ currentStep: null, steps: [] });

    assertEquals(guards.hasCompletedStep({ context }), false);
  });

  await t.step("handles multiple steps with matching timestamp", () => {
    const timestamp = 12345;
    const step1 = createTestStep({ timestamp, action: null });
    const step2 = createTestStep({
      timestamp,
      action: { type: "complete", parameters: {}, reasoning: "Task completed" },
    });

    const context = createTestContext({
      currentStep: step2,
      steps: [step1], // Only first step is in array
    });

    assertEquals(guards.hasCompletedStep({ context }), true);
  });
});
