import { assertExists } from "@std/assert";
import { createReasoningMachine } from "../src/machine.ts";
import type { BaseReasoningContext } from "../src/types.ts";

// Test user context
interface TestUserContext extends BaseReasoningContext {
  sessionId: string;
  workspaceId: string;
  test: string;
}

// Mock callbacks
const mockCallbacks = {
  think: () => Promise.resolve({ thinking: "test", confidence: 0.8 }),
  executeAction: () => Promise.resolve({ result: {}, observation: "test" }),
  parseAction: () => null,
};

Deno.test("machine.setup - createReasoningMachine creates machine successfully", () => {
  const machine = createReasoningMachine<TestUserContext>(mockCallbacks, {
    maxIterations: 5,
    supervisorId: "test-supervisor",
    jobGoal: "Test goal",
  });

  assertExists(machine);
  // The machine object from setup has a different structure
  assertExists(machine.config);
  assertExists(machine.config.id);
  assertExists(machine.config.initial);
  assertExists(machine.config.states);
});
