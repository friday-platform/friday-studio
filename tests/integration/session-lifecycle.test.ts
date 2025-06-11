#!/usr/bin/env -S deno run --allow-env --allow-read

/**
 * Session lifecycle integration tests
 * Merged from test-session-intent-simple and test-session-intent
 */

import { Session, SessionIntent } from "../../src/core/session.ts";
import { WorkspaceSupervisor } from "../../src/core/supervisor.ts";
import { expect } from "@std/expect";
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
      callback: async (result) => {},
    },
    undefined, // agents
    undefined, // workflows
    undefined, // sources
    intent,
  );

  expect(session.intent?.id).toBe("test-intent-1");
  expect(session.intent?.goals.length).toBe(3);
  expect(session.intent?.executionHints?.maxIterations).toBe(2);
});

// Test 2: WorkspaceSupervisor creates intent from signal
Deno.test("WorkspaceSupervisor creates session intent from signal", () => {
  const supervisor = new WorkspaceSupervisor("test-workspace", {
    model: "claude-3-5-sonnet-20241022",
  });

  const payload = { message: "Test message for telephone game" };
  const telephoneSignal = createMockSignal("telephone-message", "test", "test");

  const intent = supervisor.createSessionIntent(telephoneSignal, payload);

  expect(intent.signal.type).toBe("telephone-message");
  expect(intent.signal.data).toBe(payload);
  expect(intent.goals.length).toBeGreaterThan(0);
  expect(intent.executionHints?.strategy).toBe("iterative");

  supervisor.destroy();
});

// Test 3: Session FSM transitions through enhanced lifecycle
Deno.test(
  "Session FSM transitions through planning-executing-evaluating-refining cycle",
  async () => {
    const states: string[] = [];
    const mockSignal = createMockSignal(
      "test-signal",
      "test-provider",
      "test-provider",
    );

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
        callback: async (result) => {},
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
    expect(states).toContain("planning");
    expect(states).toContain("executingAgents");
    expect(states).toContain("evaluating");
  },
);

// Test 4: Session plan generation
Deno.test(
  "WorkspaceSupervisor generates execution plan from intent",
  async () => {
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
        phases: [
          {
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
          },
        ],
        reasoning: "Test execution plan",
      });
    };

    const signal = createMockSignal("test-signal", "test", "test");

    const plan = await supervisor.generateExecutionPlan(signal, {
      data: "test",
    });

    expect(plan.phases.length).toBe(1);
    expect(plan.phases[0].agents.length).toBe(2);
    expect(plan.reasoning).toBe("Test execution plan");

    supervisor.destroy();
  },
);

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
      callback: async (result) => {},
    },
    undefined,
    undefined,
    undefined,
    intent,
  );

  expect(session.status).toBeDefined();
  expect(session.progress()).toBeGreaterThanOrEqual(0);

  // Start session and monitor progress
  const progressPromise = session.start();

  // Allow some processing time
  await new Promise((resolve) => setTimeout(resolve, 500));

  expect(session.progress()).toBeGreaterThanOrEqual(0);
  expect(session.summarize()).toBeDefined();

  await progressPromise;

  expect(session.status).toBeDefined();
  expect(session.progress()).toBeGreaterThanOrEqual(0);
});
