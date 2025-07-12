#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write

/**
 * Unit tests for SessionSupervisor completion evaluation logic
 * Tests the fix for the sequential agent execution bug
 */

import { SessionSupervisorActor } from "../../src/core/actors/session-supervisor-actor.ts";
// NOTE: SupervisionLevel may be in a different location now
// import { SupervisionLevel } from "../../src/core/caching/supervision-cache.ts";
import { type AtlasMemoryConfig } from "../../src/core/memory-config.ts";
import { expect } from "@std/expect";

// Mock types for testing
interface MockAgentResult {
  output: any;
  agent: string;
  success: boolean;
}

interface MockExecutionPlan {
  phases: Array<{
    id: string;
    agents: Array<{ id: string; name: string }>;
  }>;
}

// Create minimal memory config for testing
const mockMemoryConfig: AtlasMemoryConfig = {
  default: {
    enabled: true,
    storage: "in-memory",
    cognitive_loop: false,
    retention: {
      max_age_days: 1,
      max_entries: 100,
      cleanup_interval_hours: 1,
    },
  },
  streaming: {
    enabled: false,
    queue_max_size: 100,
    batch_size: 10,
    flush_interval_ms: 1000,
    background_processing: false,
    persistence_enabled: false,
    error_retry_attempts: 1,
    priority_processing: false,
    dual_write_enabled: false,
    legacy_batch_enabled: false,
    stream_everything: false,
    performance_tracking: false,
  },
  agent: {
    enabled: false,
    scope: "agent",
    include_in_context: false,
    context_limits: { relevant_memories: 1, past_successes: 1, past_failures: 1 },
    memory_types: {},
  },
  session: {
    enabled: false,
    scope: "session",
    include_in_context: false,
    context_limits: { relevant_memories: 1, past_successes: 1, past_failures: 1 },
    memory_types: {},
  },
  workspace: {
    enabled: false,
    scope: "workspace",
    include_in_context: false,
    context_limits: { relevant_memories: 1, past_successes: 1, past_failures: 1 },
    memory_types: {},
  },
};

// Helper function to create a mock SessionSupervisor for testing
function createMockSessionSupervisor(
  executionPlan: MockExecutionPlan,
  supervisionLevel: SupervisionLevel = SupervisionLevel.MINIMAL,
): SessionSupervisor {
  const supervisor = new SessionSupervisor(mockMemoryConfig, "test-scope");

  // Set private properties for testing
  (supervisor as any).executionPlan = executionPlan;
  (supervisor as any).supervisionLevel = supervisionLevel;

  return supervisor;
}

// Helper function to create agent results
function createAgentResult(agentId: string, success: boolean = true): MockAgentResult {
  return {
    output: success ? { result: `Success from ${agentId}` } : { error: `Error from ${agentId}` },
    agent: agentId,
    success,
  };
}

Deno.test({
  name: "SessionSupervisor - Minimal supervision should not complete after first agent in sequence",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Create execution plan with 2 agents (like TopicSummarizer)
    const executionPlan: MockExecutionPlan = {
      phases: [{
        id: "main-phase",
        agents: [
          { id: "github-researcher", name: "github-researcher" },
          { id: "topic-summarizer", name: "topic-summarizer" },
        ],
      }],
    };

    const supervisor = createMockSessionSupervisor(executionPlan, SupervisionLevel.MINIMAL);

    // Test with only first agent completed
    const resultsAfterFirstAgent = [
      createAgentResult("github-researcher", true),
    ];

    const progressAfterFirst = await supervisor.evaluateProgress(resultsAfterFirstAgent as any);

    // Should NOT be complete after first agent
    expect(progressAfterFirst.isComplete).toBe(false);
    expect(progressAfterFirst.nextAction).toBe("continue");
    expect(progressAfterFirst.feedback).toContain("1/2 agents executed");
    expect(progressAfterFirst.feedback).toContain("Continuing with next agent");
  },
});

Deno.test({
  name: "SessionSupervisor - Minimal supervision should complete after all agents in sequence",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Create execution plan with 2 agents
    const executionPlan: MockExecutionPlan = {
      phases: [{
        id: "main-phase",
        agents: [
          { id: "github-researcher", name: "github-researcher" },
          { id: "topic-summarizer", name: "topic-summarizer" },
        ],
      }],
    };

    const supervisor = createMockSessionSupervisor(executionPlan, SupervisionLevel.MINIMAL);

    // Test with both agents completed successfully
    const resultsAfterBothAgents = [
      createAgentResult("github-researcher", true),
      createAgentResult("topic-summarizer", true),
    ];

    const progressAfterBoth = await supervisor.evaluateProgress(resultsAfterBothAgents as any);

    // Should be complete after all agents
    expect(progressAfterBoth.isComplete).toBe(true);
    expect(progressAfterBoth.nextAction).toBeUndefined();
    expect(progressAfterBoth.feedback).toContain("basic completion check (success)");
  },
});

Deno.test({
  name: "SessionSupervisor - Minimal supervision should handle errors in completed agents",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Create execution plan with 2 agents
    const executionPlan: MockExecutionPlan = {
      phases: [{
        id: "main-phase",
        agents: [
          { id: "github-researcher", name: "github-researcher" },
          { id: "topic-summarizer", name: "topic-summarizer" },
        ],
      }],
    };

    const supervisor = createMockSessionSupervisor(executionPlan, SupervisionLevel.MINIMAL);

    // Test with both agents completed but one has errors
    const resultsWithError = [
      createAgentResult("github-researcher", true),
      createAgentResult("topic-summarizer", false), // Error in second agent
    ];

    const progressWithError = await supervisor.evaluateProgress(resultsWithError as any);

    // Should NOT be complete if there are errors
    expect(progressWithError.isComplete).toBe(false);
    expect(progressWithError.nextAction).toBe("retry");
    expect(progressWithError.feedback).toContain("basic completion check (has errors)");
  },
});

Deno.test({
  name: "SessionSupervisor - Multiple phases with multiple agents should work correctly",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Create execution plan with multiple phases and agents
    const executionPlan: MockExecutionPlan = {
      phases: [
        {
          id: "research-phase",
          agents: [
            { id: "github-researcher", name: "github-researcher" },
            { id: "web-researcher", name: "web-researcher" },
          ],
        },
        {
          id: "analysis-phase",
          agents: [
            { id: "topic-summarizer", name: "topic-summarizer" },
          ],
        },
      ],
    };

    const supervisor = createMockSessionSupervisor(executionPlan, SupervisionLevel.MINIMAL);

    // Test with partial completion (2 out of 3 agents)
    const partialResults = [
      createAgentResult("github-researcher", true),
      createAgentResult("web-researcher", true),
    ];

    const partialProgress = await supervisor.evaluateProgress(partialResults as any);

    // Should NOT be complete with partial results
    expect(partialProgress.isComplete).toBe(false);
    expect(partialProgress.nextAction).toBe("continue");
    expect(partialProgress.feedback).toContain("2/3 agents executed");

    // Test with all agents completed
    const completeResults = [
      createAgentResult("github-researcher", true),
      createAgentResult("web-researcher", true),
      createAgentResult("topic-summarizer", true),
    ];

    const completeProgress = await supervisor.evaluateProgress(completeResults as any);

    // Should be complete with all results
    expect(completeProgress.isComplete).toBe(true);
    expect(completeProgress.nextAction).toBeUndefined();
    expect(completeProgress.feedback).toContain("basic completion check (success)");
  },
});

Deno.test({
  name: "SessionSupervisor - getTotalPlannedAgents helper method should work correctly",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Test single phase with multiple agents
    const singlePhaseExecutionPlan: MockExecutionPlan = {
      phases: [{
        id: "main-phase",
        agents: [
          { id: "agent1", name: "agent1" },
          { id: "agent2", name: "agent2" },
          { id: "agent3", name: "agent3" },
        ],
      }],
    };

    const supervisor1 = createMockSessionSupervisor(singlePhaseExecutionPlan);
    const totalAgents1 = (supervisor1 as any).getTotalPlannedAgents();
    expect(totalAgents1).toBe(3);

    // Test multiple phases with multiple agents
    const multiPhaseExecutionPlan: MockExecutionPlan = {
      phases: [
        {
          id: "phase1",
          agents: [
            { id: "agent1", name: "agent1" },
            { id: "agent2", name: "agent2" },
          ],
        },
        {
          id: "phase2",
          agents: [
            { id: "agent3", name: "agent3" },
          ],
        },
        {
          id: "phase3",
          agents: [
            { id: "agent4", name: "agent4" },
            { id: "agent5", name: "agent5" },
          ],
        },
      ],
    };

    const supervisor2 = createMockSessionSupervisor(multiPhaseExecutionPlan);
    const totalAgents2 = (supervisor2 as any).getTotalPlannedAgents();
    expect(totalAgents2).toBe(5);

    // Test empty execution plan
    const emptyExecutionPlan: MockExecutionPlan = {
      phases: [],
    };

    const supervisor3 = createMockSessionSupervisor(emptyExecutionPlan);
    const totalAgents3 = (supervisor3 as any).getTotalPlannedAgents();
    expect(totalAgents3).toBe(0);
  },
});

Deno.test({
  name: "SessionSupervisor - Edge case: No execution plan should return 0 agents",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const supervisor = new SessionSupervisor(mockMemoryConfig, "test-scope");

    // Don't set execution plan (undefined)
    const totalAgents = (supervisor as any).getTotalPlannedAgents();
    expect(totalAgents).toBe(0);
  },
});
