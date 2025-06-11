#!/usr/bin/env -S deno run --allow-env --allow-read

/**
 * Session lifecycle integration tests
 * Merged from test-session-intent-simple and test-session-intent
 */

import { Session, SessionIntent } from "../../src/core/session.ts";
import { WorkspaceSupervisor } from "../../src/core/supervisor.ts";
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createMockSignal } from "../fixtures/mocks.ts";

// Test 1: Session creation with intent
Deno.test("Session can be created with intent", async () => {
  const intent: SessionIntent = {
    id: "test-intent-1",
    signal: {
      type: "test",
      data: { message: "Hello, World!" },
      metadata: { source: "test" },
    },
    goals: [
      "Process the test message",
      "Transform the message",
      "Return the result",
    ],
    constraints: {
      timeLimit: 5000,
    },
    executionHints: {
      strategy: "iterative",
      maxIterations: 2,
    },
  };

  const mockSignal = createMockSignal(
    "test-signal",
    "test-provider",
    "test-provider",
  );

  const session = new Session(
    "test-workspace",
    {
      triggers: [mockSignal],
      callback: async (result) => {
        console.log("Session callback received:", result);
      },
    },
    undefined, // agents
    undefined, // workflows
    undefined, // sources
    intent,
  );

  assertEquals(session.intent?.id, "test-intent-1");
  assertEquals(session.intent?.goals.length, 3);
  assertEquals(session.intent?.executionHints?.maxIterations, 2);

  console.log("✓ Session created with intent successfully");
});

// Test 2: WorkspaceSupervisor creates intent from signal
Deno.test("WorkspaceSupervisor creates session intent from signal", () => {
  const supervisor = new WorkspaceSupervisor("test-workspace", {
    model: "claude-3-5-sonnet-20241022",
  });

  const payload = { message: "Test message for telephone game" };
  const telephoneSignal = createMockSignal("telephone-message", "test", "test");

  const intent = supervisor.createSessionIntent(telephoneSignal, payload);

  assertEquals(intent.signal.type, "telephone-message");
  assertEquals(intent.signal.data, payload);
  assertEquals(intent.goals.length > 0, true);
  assertEquals(intent.executionHints?.strategy, "iterative");

  console.log("✓ Supervisor created intent with goals:", intent.goals);

  supervisor.destroy();
});

// Test 3: Session FSM transitions through enhanced lifecycle
Deno.test("Session FSM transitions through planning-executing-evaluating-refining cycle", async () => {
  const states: string[] = [];
  const mockSignal = createMockSignal("test-signal", "test-provider", "test-provider");

  const intent: SessionIntent = {
    id: "test-intent-fsm",
    signal: {
      type: "test",
      data: { value: 42 },
    },
    goals: ["Test FSM transitions"],
    executionHints: {
      strategy: "iterative",
      maxIterations: 2,
    },
  };

  const session = new Session(
    "test-workspace",
    {
      triggers: [mockSignal],
      callback: async (result) => {
        console.log("Session completed with result:", result);
      },
    },
    undefined,
    undefined,
    undefined,
    intent,
  );

  // Monitor state changes
  const checkStates = () => {
    const currentState = session.getCurrentState();
    if (!states.includes(currentState)) {
      states.push(currentState);
      console.log(`  → State: ${currentState}`);
    }
  };

  // Start monitoring
  const interval = setInterval(checkStates, 50);

  try {
    // Start the session
    await session.start();

    // Give it time to complete
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } finally {
    clearInterval(interval);
  }

  // Verify we went through expected states
  console.log("States traversed:", states);
  assertEquals(states.includes("planning"), true, "Should have planning state");
  assertEquals(
    states.includes("executingAgents"),
    true,
    "Should have executingAgents state",
  );
  assertEquals(
    states.includes("evaluating"),
    true,
    "Should have evaluating state",
  );

  console.log("✓ Session FSM transitioned through enhanced lifecycle");
});

// Test 4: Session plan generation
Deno.test("WorkspaceSupervisor generates execution plan from intent", async () => {
  const supervisor = new WorkspaceSupervisor("test-workspace", {
    model: "claude-3-5-sonnet-20241022",
  });

  // Mock the generateLLM method to return a predictable plan
  supervisor.generateLLM = async (
    model: string,
    system: string,
    prompt: string,
  ) => {
    return JSON.stringify({
      phases: [{
        id: "phase-1",
        name: "Test Phase",
        agents: [
          { agentId: "agent-1", task: "Process data" },
          {
            agentId: "agent-2",
            task: "Transform result",
            dependencies: ["agent-1"],
          },
        ],
        executionStrategy: "sequential",
      }],
      reasoning: "Test execution plan",
    });
  };

  const signal = createMockSignal("test-signal", "test", "test");

  const plan = await supervisor.generateExecutionPlan(signal, { data: "test" });

  assertEquals(plan.phases.length, 1);
  assertEquals(plan.phases[0].agents.length, 2);
  assertEquals(plan.reasoning, "Test execution plan");

  console.log("✓ Supervisor generated execution plan with phases");

  supervisor.destroy();
});

// Test 5: Session status and progress (from test-session-intent-simple)
Deno.test("Session status and progress tracking", async () => {
  const intent: SessionIntent = {
    id: "test-intent-progress",
    signal: {
      type: "test",
      data: { message: "Progress test" },
    },
    goals: ["Track progress through session"],
    executionHints: {
      strategy: "iterative",
      maxIterations: 1,
    },
  };

  const mockSignal = createMockSignal("test-signal", "test", "test");

  const session = new Session(
    "test-workspace",
    {
      triggers: [mockSignal],
      callback: async (result) => {
        console.log("Session callback:", result);
      },
    },
    undefined,
    undefined,
    undefined,
    intent,
  );

  console.log("✓ Session created with status:", session.status);
  console.log("✓ Initial progress:", session.progress(), "%");

  // Start session and monitor progress
  const progressPromise = session.start();

  // Allow some processing time
  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log("✓ Mid-session progress:", session.progress(), "%");
  console.log("✓ Session summary:", session.summarize());

  await progressPromise;

  console.log("✓ Final status:", session.status);
  console.log("✓ Final progress:", session.progress(), "%");
});

console.log("\n✅ All session lifecycle tests completed!");
