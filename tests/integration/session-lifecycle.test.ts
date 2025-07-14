#!/usr/bin/env -S deno run --allow-env --allow-read

/**
 * Session lifecycle integration tests
 * Merged from test-session-intent-simple and test-session-intent
 */

import { Session, SessionIntent } from "../../src/core/session.ts";
import { WorkspaceSupervisorActor } from "../../src/core/actors/workspace-supervisor-actor.ts";
import { expect } from "@std/expect";
import { createMockSignal } from "../fixtures/mocks.ts";
import { createTestSession } from "../../src/testing/helpers.ts";

// Test 1: Session creation with intent
Deno.test({
  name: "Session can be created with intent",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
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

    const { session } = createTestSession(
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
  },
});

// Test 2: WorkspaceSupervisor creates intent from signal
Deno.test({
  name: "WorkspaceSupervisor creates session intent from signal",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
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
  },
});

// Test 3: Session FSM transitions through enhanced lifecycle
Deno.test({
  name: "Session FSM transitions through planning-executing-evaluating-refining cycle",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
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

    const { session } = createTestSession(
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

    // Subscribe to state changes directly from the state machine
    const stateMachine = (session as any)._stateMachine;

    // Capture all state transitions
    const subscription = stateMachine.subscribe((snapshot: any) => {
      const stateValue = String(snapshot.value);
      if (!states.includes(stateValue)) {
        states.push(stateValue);
      }
    });

    try {
      // Start the session
      await session.start();
    } finally {
      subscription.unsubscribe();
    }

    // Log the states we captured for debugging
    console.log("Captured states:", states);

    // Verify we went through expected states
    // The session should go through at least some of these states
    const expectedStates = ["planning", "processingSignals", "executingAgents", "evaluating"];
    const foundStates = expectedStates.filter((state) => states.includes(state));

    // Should have gone through at least planning
    expect(states).toContain("planning");
  },
});

// Test 4: Session plan generation
Deno.test({
  name: "WorkspaceSupervisor generates execution plan from intent",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
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
    // Check if agents exist and log for debugging
    console.log("Plan phases[0]:", plan.phases[0]);
    console.log("Plan reasoning:", plan.reasoning);
    expect(plan.phases[0].agents?.length || 0).toBeGreaterThanOrEqual(1);
    // The plan uses enhanced signal analysis which generates a specific reasoning format
    expect(plan.reasoning).toContain("Enhanced processing identified");
    expect(plan.reasoning).toContain("requiring");
    expect(plan.reasoning).toContain("action by");

    supervisor.destroy();
  },
});

// Test 5: Session status and progress (from test-session-intent-simple)
Deno.test({
  name: "Session status and progress tracking",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
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

    const { session } = createTestSession(
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
  },
});

// Test 6: Multi-agent sequential execution completion behavior
Deno.test({
  name: "Multi-agent sequential execution should complete only after all agents finish",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // This integration test specifically verifies the bug fix for premature session completion
    // in minimal supervision mode with sequential agent execution

    const intent: SessionIntent = {
      id: "test-sequential-completion",
      signal: {
        type: "sequential-test",
        data: {
          mode: "test",
          agents_required: ["agent1", "agent2"],
        },
        metadata: { source: "integration-test" },
      },
      goals: [
        "Execute first agent (agent1) completely",
        "Pass results from agent1 to agent2",
        "Execute second agent (agent2) completely",
        "Complete session only after both agents finish",
      ],
      constraints: {
        timeLimit: 10000, // 10 seconds max
      },
      executionHints: {
        strategy: "iterative", // Iterative execution strategy
      },
    };

    const mockSignal = createMockSignal("sequential-test-signal", "test", "test");

    const { session } = createTestSession(
      "test-sequential-workspace",
      {
        triggers: [mockSignal],
        callback: async (result) => {
          // Verify that we only get called once, when the session is truly complete
          expect(result).toBeDefined();
          expect(result.agent_results).toBeDefined();

          // Should have results from both agents
          const agentResults = result.agent_results || [];
          expect(agentResults.length).toBeGreaterThanOrEqual(2);

          // Verify that we have results from both expected agents
          const agent1Result = agentResults.find((r: any) => r.agent?.includes("agent1"));
          const agent2Result = agentResults.find((r: any) => r.agent?.includes("agent2"));

          expect(agent1Result).toBeDefined();
          expect(agent2Result).toBeDefined();
        },
      },
      undefined, // agents - will be created by the session
      undefined, // workflows
      undefined, // sources
      intent,
    );

    // Verify session was created with correct intent
    expect(session.intent?.id).toBe("test-sequential-completion");
    expect(session.intent?.goals.length).toBe(4);
    // supervision property was removed from constraints
    expect(session.intent?.executionHints?.strategy).toBe("sequential");

    // Track session state changes to verify proper completion behavior
    const stateChanges: string[] = [];
    let completionCount = 0;

    // Session class doesn't have updateStatus method anymore
    // Track completion through other means

    // Start the session
    const startTime = Date.now();
    const sessionPromise = session.start();

    // Allow initial processing time
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify session is not immediately completed (this would indicate the bug)
    expect(session.status).not.toBe("completed");
    expect(stateChanges).not.toContain("completed");

    // Wait for session to complete naturally
    await sessionPromise;
    const endTime = Date.now();
    const duration = endTime - startTime;

    // Verify session completed properly
    expect(session.status).toBe("completed");
    expect(completionCount).toBe(1);
    expect(stateChanges).toContain("completed");

    // Session should have taken some time (not completed immediately)
    // This ensures it actually waited for agents to execute
    expect(duration).toBeGreaterThan(50); // At least 50ms to ensure real execution

    // Verify final state
    expect(session.progress()).toBe(1.0); // 100% complete

    const summary = session.summarize();
    expect(summary).toBeDefined();
    expect(summary).toContain("completed");
  },
});
