import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  AgentResult,
  ExecutionPlan,
  SessionContext,
  SessionSupervisor,
} from "../../src/core/session-supervisor.ts";
import { AtlasMemoryConfig } from "../../src/core/memory-config.ts";

// Test utilities
function createMockMemoryConfig(): AtlasMemoryConfig {
  return {
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
}

function createMockSessionSupervisor(): SessionSupervisor {
  const supervisor = new SessionSupervisor(createMockMemoryConfig(), "test-parent-scope");

  // Mock the generateLLM method to return structured assessments
  (supervisor as any).generateLLM = (
    _model: string,
    _systemPrompt: string,
    userPrompt: string,
    _structured: boolean,
    _metadata: unknown,
  ): string => {
    // Return valid structured assessment based on test scenario
    if (userPrompt.includes("successful execution scenario")) {
      return `\`\`\`json
{
  "sessionSuccess": true,
  "confidence": 90,
  "overallReasoning": "All agents executed successfully with high-quality outputs meeting all criteria",
  "agentEvaluations": [
    {
      "agentId": "agent-1",
      "individualSuccess": true,
      "completeness": {
        "score": 95,
        "reasoning": "Agent produced all required outputs with complete data",
        "issues": [],
        "evidence": ["All expected fields present", "No missing data detected"]
      },
      "accuracy": {
        "score": 90,
        "reasoning": "Outputs are factually correct and consistent",
        "issues": [],
        "evidence": ["Data validation passed", "Logic checks successful"]
      },
      "format": {
        "score": 100,
        "reasoning": "Perfect JSON structure with proper types",
        "issues": [],
        "evidence": ["Valid JSON schema", "Correct data types"]
      },
      "relevance": {
        "score": 88,
        "reasoning": "Output directly addresses all task requirements",
        "issues": [],
        "evidence": ["Task objectives fully met", "Output addresses signal intent"]
      },
      "outputSummary": "Generated comprehensive configuration with all required components"
    },
    {
      "agentId": "agent-2", 
      "individualSuccess": true,
      "completeness": {
        "score": 92,
        "reasoning": "Agent provided complete analysis results",
        "issues": [],
        "evidence": ["All analysis sections present", "Complete data coverage"]
      },
      "accuracy": {
        "score": 88,
        "reasoning": "Analysis results are accurate and well-reasoned",
        "issues": [],
        "evidence": ["Cross-validation successful", "No logical inconsistencies"]
      },
      "format": {
        "score": 95,
        "reasoning": "Well-structured output with minor formatting variations",
        "issues": ["Minor spacing inconsistencies"],
        "evidence": ["Overall structure correct", "Data types appropriate"]
      },
      "relevance": {
        "score": 90,
        "reasoning": "Analysis directly supports session objectives",
        "issues": [],
        "evidence": ["Addresses core requirements", "Provides actionable insights"]
      },
      "outputSummary": "Comprehensive analysis with actionable recommendations"
    }
  ],
  "successCriteriaEvaluation": [
    {
      "criterion": "Execute all 2 agents successfully",
      "met": true,
      "evidence": "Both agents completed execution without errors",
      "reasoning": "All planned agents executed and produced valid outputs",
      "confidence": 95
    },
    {
      "criterion": "Produce meaningful outputs from each agent",
      "met": true,
      "evidence": "All agents produced comprehensive, relevant outputs",
      "reasoning": "Outputs meet quality standards and address task requirements",
      "confidence": 90
    }
  ],
  "qualityIssues": [
    {
      "severity": "minor",
      "description": "Minor formatting inconsistencies in agent-2 output",
      "affectedAgents": ["agent-2"],
      "recommendation": "Consider standardizing output formatting",
      "impact": "cosmetic"
    }
  ],
  "nextAction": "complete",
  "actionReasoning": "All success criteria met with high confidence. Minor issues are cosmetic and don't affect functionality."
}
\`\`\``;
    }

    if (userPrompt.includes("failed execution scenario")) {
      return `\`\`\`json
{
  "sessionSuccess": false,
  "confidence": 85,
  "overallReasoning": "Critical failures detected in agent outputs requiring retry for session completion",
  "agentEvaluations": [
    {
      "agentId": "agent-1",
      "individualSuccess": false,
      "completeness": {
        "score": 25,
        "reasoning": "Agent output missing critical required fields",
        "issues": ["No 'result' field in output", "Missing configuration data", "Incomplete processing"],
        "evidence": ["Output schema validation failed", "Required fields array empty"]
      },
      "accuracy": {
        "score": 10,
        "reasoning": "Output contains multiple logical errors and inconsistencies",
        "issues": ["Contradictory configuration values", "Invalid data relationships", "Logic validation failures"],
        "evidence": ["Cross-reference checks failed", "Consistency validation errors"]
      },
      "format": {
        "score": 60,
        "reasoning": "Basic JSON structure present but with type errors",
        "issues": ["Several fields have incorrect types", "Missing nested structures"],
        "evidence": ["JSON parsing successful", "Schema validation failed on types"]
      },
      "relevance": {
        "score": 30,
        "reasoning": "Output only partially addresses task requirements",
        "issues": ["Core functionality missing", "Does not address signal intent", "Incomplete task execution"],
        "evidence": ["Only 2 of 6 requirements addressed", "Primary objectives not met"]
      },
      "outputSummary": "Severely incomplete configuration with critical errors and missing data"
    },
    {
      "agentId": "agent-2",
      "individualSuccess": false,
      "completeness": {
        "score": 20,
        "reasoning": "Agent output missing most required components",
        "issues": ["Incomplete data processing", "Missing analysis results"],
        "evidence": ["Output validation failed", "Required analysis sections missing"]
      },
      "accuracy": {
        "score": 15,
        "reasoning": "Output contains errors and invalid assumptions",
        "issues": ["Logical inconsistencies", "Invalid data interpretations"],
        "evidence": ["Analysis validation failed", "Cross-check failures"]
      },
      "format": {
        "score": 70,
        "reasoning": "Basic structure present but content issues",
        "issues": ["Some formatting inconsistencies"],
        "evidence": ["JSON structure valid", "Content validation failed"]
      },
      "relevance": {
        "score": 25,
        "reasoning": "Output does not address core requirements",
        "issues": ["Primary objectives not met", "Analysis incomplete"],
        "evidence": ["Requirements mapping failed", "Objective coverage insufficient"]
      },
      "outputSummary": "Incomplete analysis with significant gaps and errors"
    }
  ],
  "successCriteriaEvaluation": [
    {
      "criterion": "Execute all 2 agents successfully",
      "met": false,
      "evidence": "Both agents failed to execute properly, producing invalid outputs",
      "reasoning": "Execution failures prevent meeting this criterion",
      "confidence": 90
    },
    {
      "criterion": "Produce meaningful outputs from each agent",
      "met": false,
      "evidence": "Both agent outputs are incomplete and contain critical errors",
      "reasoning": "Output quality is below acceptable standards for both agents",
      "confidence": 95
    }
  ],
  "qualityIssues": [
    {
      "severity": "critical",
      "description": "Agent outputs missing critical data and contain logical errors",
      "affectedAgents": ["agent-1", "agent-2"],
      "recommendation": "Retry execution with enhanced validation and error handling",
      "impact": "blocking"
    },
    {
      "severity": "major",
      "description": "Task requirements not fully addressed by available outputs",
      "affectedAgents": ["agent-1", "agent-2"],
      "recommendation": "Review task specification and agent configuration",
      "impact": "degraded"
    }
  ],
  "nextAction": "retry",
  "actionReasoning": "Critical failures require retry. Agent outputs are insufficient for session completion."
}
\`\`\``;
    }

    // Default case - basic completion
    return `\`\`\`json
{
  "sessionSuccess": true,
  "confidence": 75,
  "overallReasoning": "Agents completed execution with acceptable quality",
  "agentEvaluations": [
    {
      "agentId": "agent-1",
      "individualSuccess": true,
      "completeness": {"score": 80, "reasoning": "Most requirements met", "issues": [], "evidence": ["Core data present"]},
      "accuracy": {"score": 85, "reasoning": "Generally accurate results", "issues": [], "evidence": ["Validation passed"]},
      "format": {"score": 90, "reasoning": "Well-formatted output", "issues": [], "evidence": ["Valid JSON structure"]},
      "relevance": {"score": 82, "reasoning": "Addresses main requirements", "issues": [], "evidence": ["Task objectives met"]},
      "outputSummary": "Standard execution output"
    }
  ],
  "successCriteriaEvaluation": [
    {
      "criterion": "Execute all agents successfully",
      "met": true,
      "evidence": "All agents completed execution",
      "reasoning": "No execution failures detected",
      "confidence": 80
    }
  ],
  "qualityIssues": [],
  "nextAction": "complete", 
  "actionReasoning": "Standard successful completion"
}
\`\`\``;
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
    signal: { id: "test-signal", payload: { test: "data" } } as any,
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
    output: { testOutput: "result", status: "completed" },
    duration: 1000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// Integration tests for the new quality assessment system
Deno.test("Quality Assessment Integration", async (t) => {
  await t.step("should perform structured assessment for successful execution", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext({
      payload: { test: "successful execution scenario" },
    });
    const executionPlan = createMockExecutionPlan();

    // Set up supervisor state
    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null; // Disable advanced reasoning

    // All agents executed successfully
    const results = [
      createMockAgentResult({
        agentId: "agent-1",
        output: { result: "success", data: "complete" },
      }),
      createMockAgentResult({
        agentId: "agent-2",
        output: { analysis: "thorough", recommendations: ["item1", "item2"] },
      }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    assertEquals(evaluation.isComplete, true);
    assertEquals(evaluation.nextAction, "continue"); // "complete" becomes "continue"
    assertExists(evaluation.feedback);
    assertEquals(evaluation.feedback?.includes("Assessment (90% confidence)"), true);
  });

  await t.step("should detect failures with structured assessment", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext({
      payload: { test: "failed execution scenario" },
    });
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Failed agent execution - must have all agents to trigger structured assessment
    const results = [
      createMockAgentResult({
        agentId: "agent-1",
        output: { error: "processing failed", incomplete: true },
      }),
      createMockAgentResult({
        agentId: "agent-2",
        output: { error: "processing failed", incomplete: true },
      }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "retry");
    assertExists(evaluation.feedback);
    assertEquals(evaluation.feedback?.includes("Critical failures"), true);
  });

  await t.step("should continue when not all agents executed", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Only 1 agent executed out of 2 planned
    const results = [createMockAgentResult({ agentId: "agent-1" })];

    const evaluation = await supervisor.evaluateProgress(results);

    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "continue");
    assertEquals(evaluation.feedback?.includes("1/2 agents executed"), true);
  });

  await t.step("should fallback gracefully when structured assessment fails", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Mock LLM to return invalid JSON
    (supervisor as any).generateLLM = () => {
      return "This is not valid JSON and will cause parsing to fail";
    };

    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    // Should fallback to conservative assessment
    assertEquals(evaluation.isComplete, true);
    assertEquals(evaluation.feedback?.includes("Fallback assessment"), true);
    assertEquals(evaluation.feedback?.includes("Manual review recommended"), true);
  });

  await t.step("should detect empty outputs in fallback assessment", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Mock LLM to fail
    (supervisor as any).generateLLM = () => {
      throw new Error("LLM service unavailable");
    };

    // Results with empty outputs
    const results = [
      createMockAgentResult({ agentId: "agent-1", output: {} }),
      createMockAgentResult({ agentId: "agent-2", output: null }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "retry");
    assertEquals(evaluation.feedback?.includes("empty outputs"), true);
  });

  await t.step("should handle zero agents scenario", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan({
      phases: [{
        id: "empty-phase",
        name: "Empty Phase",
        executionStrategy: "sequential",
        agents: [],
      }],
    });

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    const results: AgentResult[] = [];

    const evaluation = await supervisor.evaluateProgress(results);

    // Should complete immediately when no agents planned
    assertEquals(evaluation.isComplete, true);
    assertExists(evaluation.feedback);
  });

  await t.step("should preserve advanced reasoning path when available", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext({
      signal: { id: "critical-alert", payload: { severity: "critical" } } as any,
    });
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };

    // Mock planning engine for quality critical scenarios
    (supervisor as any).planningEngine = {
      generatePlan: async (task: any) => ({
        method: "tree-of-thoughts",
        plan: {
          isComplete: true,
          reasoning: "Advanced reasoning determined successful completion with critical analysis",
          nextAction: undefined,
        },
      }),
    };

    // Multiple agents to trigger advanced reasoning
    const results = [
      createMockAgentResult({ agentId: "agent-1" }),
      createMockAgentResult({ agentId: "agent-2" }),
      createMockAgentResult({ agentId: "agent-3" }),
      createMockAgentResult({ agentId: "agent-4" }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    // Should use advanced reasoning instead of structured assessment
    assertEquals(evaluation.isComplete, true);
    assertEquals(evaluation.feedback?.includes("Advanced reasoning"), true);
  });
});

// Test edge cases and backward compatibility
Deno.test("Quality Assessment Edge Cases", async (t) => {
  await t.step("should handle malformed agent outputs gracefully", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Mock generateLLM to throw error during structured assessment
    (supervisor as any).generateLLM = () => {
      throw new Error("Network timeout");
    };

    const results = [
      createMockAgentResult({
        agentId: "agent-1",
        output: { circular: {} },
      }),
      createMockAgentResult({
        agentId: "agent-2",
        output: undefined,
      }),
    ];

    // Set up circular reference
    (results[0].output as any).circular.self = results[0].output;

    const evaluation = await supervisor.evaluateProgress(results);

    // Should fallback gracefully
    assertEquals(evaluation.isComplete, false);
    assertEquals(evaluation.nextAction, "retry");
    assertEquals(evaluation.feedback?.includes("Fallback assessment"), true);
  });

  await t.step("should maintain existing method signatures", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    // Set up required context
    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Verify evaluateProgress signature unchanged
    const results: AgentResult[] = [];
    const evaluation = await supervisor.evaluateProgress(results);

    // Should return expected interface
    assertEquals(typeof evaluation.isComplete, "boolean");
    assertEquals(
      ["continue", "retry", "adapt", "escalate", undefined].includes(evaluation.nextAction),
      true,
    );
    assertEquals(typeof evaluation.feedback, "string");
  });

  await t.step("should handle very large outputs without memory issues", async () => {
    const supervisor = createMockSessionSupervisor();
    const sessionContext = createMockSessionContext();
    const executionPlan = createMockExecutionPlan();

    (supervisor as any).sessionContext = sessionContext;
    (supervisor as any).executionPlan = executionPlan;
    (supervisor as any).prompts = { system: "Test system prompt", user: "" };
    (supervisor as any).planningEngine = null;

    // Create very large output
    const largeData = "x".repeat(100000);
    const results = [
      createMockAgentResult({
        agentId: "agent-1",
        output: { data: largeData, status: "completed" },
      }),
      createMockAgentResult({
        agentId: "agent-2",
        output: { analysis: largeData },
      }),
    ];

    const evaluation = await supervisor.evaluateProgress(results);

    // Should handle large outputs without crashing
    assertEquals(typeof evaluation.isComplete, "boolean");
    assertExists(evaluation.feedback);
  });
});
