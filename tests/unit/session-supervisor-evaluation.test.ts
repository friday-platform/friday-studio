import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  AgentResult,
  ExecutionPlan,
  SessionContext,
  SessionSupervisor,
} from "../../src/core/session-supervisor.ts";
import { AtlasMemoryConfig } from "../../src/core/memory-config.ts";

// Test utilities
function createMockSessionSupervisor(): SessionSupervisor {
  const mockMemoryConfig: AtlasMemoryConfig = {
    default: {
      enabled: true,
      storage: "memory",
      cognitive_loop: false,
      retention: {
        max_age_days: 7,
        max_entries: 1000,
        cleanup_interval_hours: 24,
      },
    },
    agent: {
      enabled: true,
      scope: "agent",
      include_in_context: true,
      context_limits: {
        relevant_memories: 10,
        past_successes: 5,
        past_failures: 5,
      },
      memory_types: {
        semantic: { enabled: false, max_entries: 100 },
        episodic: { enabled: false, max_entries: 50 },
        procedural: { enabled: false, max_entries: 25 },
      },
    },
    session: {
      enabled: true,
      scope: "session",
      include_in_context: true,
      context_limits: {
        relevant_memories: 20,
        past_successes: 10,
        past_failures: 10,
      },
      memory_types: {
        semantic: { enabled: false, max_entries: 200 },
        episodic: { enabled: false, max_entries: 100 },
        procedural: { enabled: false, max_entries: 50 },
      },
    },
    workspace: {
      enabled: true,
      scope: "workspace",
      include_in_context: true,
      context_limits: {
        relevant_memories: 30,
        past_successes: 15,
        past_failures: 15,
      },
      memory_types: {
        semantic: { enabled: false, max_entries: 500 },
        episodic: { enabled: false, max_entries: 200 },
        procedural: { enabled: false, max_entries: 100 },
      },
    },
  };

  const supervisor = new SessionSupervisor(mockMemoryConfig, "test-parent-scope");

  // Mock the generateLLM method
  (supervisor as any).generateLLM = async (
    model: string,
    systemPrompt: string,
    userPrompt: string,
    structured: boolean,
    metadata: any,
  ): Promise<string> => {
    // Return different responses based on test scenarios
    if (userPrompt.includes("error scenario")) {
      return "The execution failed with multiple errors. Agent outputs were unsuccessful.";
    }
    if (userPrompt.includes("success scenario")) {
      return "All agents executed successfully. The session goals have been achieved.";
    }
    if (userPrompt.includes("mixed scenario")) {
      return "Some agents succeeded while others encountered issues that need attention.";
    }
    return "Execution completed with standard results.";
  };

  // Mock the log method
  (supervisor as any).log = (message: string) => {
    console.log(`[Test Log] ${message}`);
  };

  return supervisor;
}

function createMockSessionContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: "test-session-123",
    workspaceId: "test-workspace",
    signal: { id: "test-signal", type: "manual", payload: { test: "data" } },
    payload: { test: "data" },
    availableAgents: [
      {
        id: "agent-1",
        name: "Test Agent 1",
        purpose: "Testing",
        type: "llm",
        config: { type: "llm", model: "test-model", purpose: "testing" },
      },
      {
        id: "agent-2",
        name: "Test Agent 2",
        purpose: "Testing",
        type: "llm",
        config: { type: "llm", model: "test-model", purpose: "testing" },
      },
    ],
    filteredMemory: [],
    ...overrides,
  };
}

function createMockExecutionPlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: "test-plan-123",
    sessionId: "test-session-123",
    phases: [
      {
        id: "phase-1",
        name: "Test Phase",
        executionStrategy: "sequential",
        agents: [
          { agentId: "agent-1", task: "Test task 1", inputSource: "signal" },
          { agentId: "agent-2", task: "Test task 2", inputSource: "signal" },
        ],
      },
    ],
    successCriteria: [
      "Execute all 2 agents successfully",
      "Produce meaningful outputs from each agent",
    ],
    adaptationStrategy: "flexible",
    ...overrides,
  };
}

function createMockAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    agentId: "agent-1",
    task: "Test task",
    input: { testInput: "value" },
    output: { testOutput: "result" },
    duration: 1000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// Test suite for current SessionSupervisor evaluation functionality
Deno.test("SessionSupervisor - evaluateProgress - Current Functionality", async (t) => {
  await t.step("should continue when not all agents have executed", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    // Set up supervisor state
    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null; // Disable advanced reasoning

    // Only 1 agent executed out of 2 planned
    const results = [createMockAgentResult({ agentId: "agent-1" })];

    const evaluation = await supervisor.evaluateProgress(results);

    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "continue");
    assertEquals(evaluation.feedback?.includes("1/2 agents executed"), true);
  });

  await t.step("should detect failures using keyword matching", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // All agents executed
    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
    ];

    // Mock LLM to return failure keywords
    (supervisor as any).generateLLM = async () => {
      return "The execution failed with errors. One agent was unsuccessful.";
    };

    const evaluation = await supervisor.evaluateProgress(results);

    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "retry");
    assertEquals(evaluation.feedback?.includes("failed"), true);
  });

  await t.step(
    "should mark complete when all agents executed and no failure keywords",
    async () => {
      const supervisor = createMockSessionSupervisor();
      const sessionContext = createMockSessionContext();
      const executionPlan = createMockExecutionPlan();

      (supervisor as any).sessionContext = sessionContext;
      (supervisor as any).executionPlan = executionPlan;
      (supervisor as any).prompts = { system: "Test system prompt", user: "" };
      (supervisor as any).planningEngine = null;

      const results = [
        createMockAgentResult({ agentId: "agent-1" }),
        createMockAgentResult({ agentId: "agent-2" }),
      ];

      // Mock LLM to return success response
      (supervisor as any).generateLLM = async () => {
        return "All agents executed successfully. The session goals have been achieved.";
      };

      const evaluation = await supervisor.evaluateProgress(results);

      assertEquals(evaluation.isComplete, true);
      assertEquals(evaluation.nextAction, undefined);
      assertEquals(evaluation.feedback?.includes("successfully"), true);
    },
  );

  await t.step("should handle empty results array", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    const results: AgentResult[] = [];

    const evaluation = await supervisor.evaluateProgress(results);

    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "continue");
    assertEquals(evaluation.feedback?.includes("0/2 agents executed"), true);
  });

  await t.step("should use advanced reasoning for complex scenarios", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };

    // Mock planning engine
    (supervisor as any).planningEngine = {
      generatePlan: async (task: any) => ({
        method: "chain-of-thought",
        plan: {
          isComplete: true,
          reasoning: "Advanced reasoning determined successful completion",
          nextAction: undefined,
        },
      }),
    };

    // Create scenario that triggers advanced reasoning (>3 agents)
    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
      createMockAgentResult({ agentId: "agent-3" }),
      createMockAgentResult({ agentId: "agent-4" }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    assertEquals(evaluation.isComplete, true);
    assertEquals(evaluation.feedback?.includes("Advanced reasoning"), true);
  });

  await t.step("should handle LLM evaluation errors gracefully", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Mock LLM to throw error
    (supervisor as any).generateLLM = async () => {
      throw new Error("LLM service unavailable");
    };

    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    // Should fallback to execution count based completion
    assertEquals(evaluation.isComplete, true);
    assertEquals(
      evaluation.feedback?.includes("Evaluation completed based on execution count"),
      true,
    );
  });

  await t.step("should handle missing session context", async () => {
    const supervisor = createMockSessionSupervisor();

    // Don't set session context
    (supervisor as any).sessionContext = null;
    (supervisor as any).executionPlan = null;
    (supervisor as any).planningEngine = null;

    const results = [createMockAgentResult()];

    await assertRejects(
      async () => {
        await supervisor.evaluateProgress(results);
      },
      Error,
      "Session context or execution plan not available",
    );
  });

  await t.step("should use quality critical detection", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext({
      signal: { id: "critical-error-signal", type: "alert" },
      payload: { severity: "critical", message: "Production failure detected" },
    });
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;

    // Mock planning engine for quality critical scenarios
    (supervisor as any).planningEngine = {
      generatePlan: async (task: any) => ({
        method: "tree-of-thoughts",
        plan: {
          isComplete: false,
          reasoning: "Critical scenario requires careful analysis",
          nextAction: "escalate",
        },
      }),
    };

    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    // Should trigger advanced reasoning due to critical keywords
    assertEquals(evaluation.feedback?.includes("Advanced reasoning"), true);
  });
});

// Test edge cases and boundary conditions
Deno.test("SessionSupervisor - evaluateProgress - Edge Cases", async (t) => {
  await t.step("should handle agents with null/undefined outputs", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    const results = [
      createMockAgentResult({ agentId: "agent-1", output: null }),
      createMockAgentResult({ agentId: "agent-2", output: undefined }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    // Should still process results even with null/undefined outputs
    assertEquals(evaluation.isComplete, true); // Based on current keyword logic
  });

  await t.step("should handle very large agent outputs", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Create very large output
    const largeOutput = { data: "x".repeat(10000) };

    const results = [
      createMockAgentResult({ agentId: "agent-1", output: largeOutput }),
      createMockAgentResult({ agentId: "agent-2", output: largeOutput }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    // Should handle large outputs (they get truncated in the prompt)
    assertEquals(typeof evaluation.isComplete, "boolean");
    assertEquals(typeof evaluation.feedback, "string");
  });

  await t.step("should handle execution plan with zero agents", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan({
      phases: [{ agents: [] }], // No agents in plan
    });

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    const results: AgentResult[] = [];

    const evaluation = await supervisor.evaluateProgress(results);

    // Should handle zero agent scenario
    assertEquals(evaluation.isComplete, true); // 0/0 agents executed = complete
  });

  await t.step("should preserve all current nextAction values", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Test continue action
    const continueResults = [createMockAgentResult({ agentId: "agent-1" })];
    const continueEval = await supervisor.evaluateProgress(continueResults);
    assertEquals(continueEval.nextAction, "continue");

    // Test retry action
    const retryResults = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
    ];
    (supervisor as any).generateLLM = async () => "The execution failed with errors.";
    const retryEval = await supervisor.evaluateProgress(retryResults);
    assertEquals(retryEval.nextAction, "retry");

    // Test complete action (undefined nextAction)
    (supervisor as any).generateLLM = async () => "All agents executed successfully.";
    const completeEval = await supervisor.evaluateProgress(retryResults);
    assertEquals(completeEval.nextAction, undefined);
  });
});

// Test current keyword detection logic specifically
Deno.test("SessionSupervisor - Keyword Detection Logic", async (t) => {
  await t.step("should detect 'failed' keyword", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    (supervisor as any).generateLLM = async () => "The agent execution has failed completely.";

    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);
    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "retry");
  });

  await t.step("should detect 'error' keyword", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    (supervisor as any).generateLLM = async () => "There was an error during execution.";

    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);
    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "retry");
  });

  await t.step("should detect 'unsuccessful' keyword", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    (supervisor as any).generateLLM = async () =>
      "The operation was unsuccessful in achieving goals.";

    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);
    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "retry");
  });

  await t.step("should miss failure euphemisms (current limitation)", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Use euphemisms that current keyword detection misses
    (supervisor as any).generateLLM = async () =>
      "There were some issues with the execution. The agents encountered challenges.";

    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    // Current implementation would miss these failures
    assertEquals(evaluation.isComplete, true); // This is the problem we're fixing
    assertEquals(evaluation.nextAction, undefined);
  });
});
