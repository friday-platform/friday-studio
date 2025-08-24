/**
 * Simple unit tests for SessionSupervisor execution planning with AI SDK
 * Tests real API calls to the LLM for simple planning tasks
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import {
  type SessionContext,
  SessionSupervisorActor,
} from "../src/core/actors/session-supervisor-actor.ts";

// Skip tests in CI or when no API key is available
const skipIfNoKey =
  !Deno.env.get("ANTHROPIC_API_KEY") ||
  Deno.env.get("CI") === "true" ||
  Deno.env.get("GITHUB_ACTIONS") === "true";

// Helper function to create basic session context
const createTestSessionContext = (overrides: Partial<SessionContext> = {}): SessionContext => ({
  sessionId: "test-session-123",
  workspaceId: "test-workspace",
  signal: { id: "sig-123", type: "test", payload: { message: "test signal" } },
  payload: { message: "test signal" },
  availableAgents: ["agent1", "agent2"],
  ...overrides,
});

Deno.test({
  name: "SessionSupervisor - Simple Signal Planning with AI SDK",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("session-123", "workspace-123");
    const context = createTestSessionContext();

    console.log("Testing simple signal planning with real API...");
    console.log(`Signal: ${JSON.stringify(context.signal)}`);

    supervisor.initializeSession(context);
    const plan = await supervisor.createExecutionPlan();

    // Verify the response structure
    assertExists(plan);
    assertExists(plan.id);
    assertExists(plan.phases);
    assertExists(plan.reasoning);
    assertExists(plan.strategy);
    assertExists(plan.confidence);

    // Verify plan has at least one phase
    assertEquals(plan.phases.length > 0, true, "Plan should have at least one phase");

    // Verify strategy indicates AI planning
    assertEquals(plan.strategy, "ai-planned");

    // Verify reasoning is present and meaningful
    assertEquals(plan.reasoning.length > 20, true, "Plan reasoning should be substantial");
    // Should contain planning-related content
    const hasValidContent =
      plan.reasoning.toLowerCase().includes("execution") ||
      plan.reasoning.toLowerCase().includes("plan") ||
      plan.reasoning.toLowerCase().includes("agent") ||
      plan.reasoning.toLowerCase().includes("phase");
    assertEquals(hasValidContent, true, "Plan reasoning should contain planning concepts");

    // Verify phases have proper structure
    const firstPhase = plan.phases[0];
    assertExists(firstPhase.id);
    assertExists(firstPhase.name);
    assertExists(firstPhase.executionStrategy);
    assertExists(firstPhase.agents);

    // Verify agents are included
    assertEquals(firstPhase.agents.length > 0, true, "Phase should have at least one agent");

    const firstAgent = firstPhase.agents[0];
    assertExists(firstAgent.agentId);
    assertExists(firstAgent.task);
    assertExists(firstAgent.inputSource);
    assertExists(firstAgent.reasoning);

    console.log("Test passed!");
    console.log(`Plan created with ${plan.phases.length} phases and strategy: ${plan.strategy}`);
  },
});

Deno.test({
  name: "SessionSupervisor - Cached Job Spec Planning",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("session-456", "workspace-456");

    // Create context with job spec (should trigger cached plan)
    const context = createTestSessionContext({
      jobSpec: {
        name: "test-job",
        execution: { strategy: "parallel", agents: ["agent1", "agent2"] },
      },
    });

    console.log("Testing cached job spec planning...");

    supervisor.initializeSession(context);
    const plan = await supervisor.createExecutionPlan();

    // Verify cached plan structure
    assertExists(plan);
    assertEquals(plan.strategy, "job-based");
    assertEquals(plan.confidence, 1.0);
    assertStringIncludes(plan.reasoning, "test-job");

    // Verify execution strategy from job spec
    assertEquals(plan.phases[0].executionStrategy, "parallel");

    console.log("Test passed!");
    console.log(`Cached plan created with strategy: ${plan.strategy}`);
  },
});

Deno.test({
  name: "SessionSupervisor - JobSpec without Agents",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("session-789", "workspace-789");

    // Create context with job spec but no execution agents
    const context = createTestSessionContext({
      jobSpec: {
        name: "empty-job",
        // No execution block - this creates a job-based plan with 0 agents
      },
    });

    console.log("Testing job spec without execution agents...");

    supervisor.initializeSession(context);
    const plan = await supervisor.createExecutionPlan();

    // Verify job-based plan structure with no agents
    assertExists(plan);
    assertEquals(plan.strategy, "job-based");
    assertEquals(plan.confidence, 1.0);
    assertEquals(plan.phases.length, 1);
    assertEquals(plan.phases[0].agents.length, 0); // No agents specified
    assertStringIncludes(plan.reasoning, "empty-job");

    console.log("Test passed!");
    console.log(`Job-based plan created with 0 agents: ${plan.reasoning}`);
  },
});

Deno.test({
  name: "SessionSupervisor - Planning with Additional Prompts",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("session-101", "workspace-101");

    // Create context with additional planning prompts
    const context = createTestSessionContext({
      additionalPrompts: {
        planning:
          "Focus on data processing and validation tasks. Prioritize sequential execution for reliability.",
      },
    });

    console.log("Testing planning with additional prompts...");

    supervisor.initializeSession(context);
    const plan = await supervisor.createExecutionPlan();

    // Verify the response structure
    assertExists(plan);
    assertEquals(plan.strategy, "ai-planned");

    // Additional prompts should influence the planning
    // The AI should consider the guidance in its reasoning
    assertExists(plan.reasoning);

    console.log("Test passed!");
    console.log(`Plan created with additional prompts guidance`);
  },
});

Deno.test({
  name: "SessionSupervisor - Planning with Different Signal Types",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("session-202", "workspace-202");

    // Test with different signal types
    const signalTypes = ["webhook", "scheduled", "manual", "api"];

    for (const signalType of signalTypes) {
      console.log(`Testing planning with signal type: ${signalType}`);

      const context = createTestSessionContext({
        signal: {
          id: `sig-${signalType}`,
          type: signalType,
          payload: {
            message: `${signalType} signal test`,
            priority: signalType === "manual" ? "high" : "normal",
          },
        },
        payload: {
          message: `${signalType} signal test`,
          priority: signalType === "manual" ? "high" : "normal",
        },
      });

      supervisor.initializeSession(context);
      const plan = await supervisor.createExecutionPlan();

      // Verify plan is created for each signal type
      assertExists(plan);
      assertEquals(plan.strategy, "ai-planned");
      assertExists(plan.phases);
      assertEquals(plan.phases.length > 0, true);

      console.log(`✓ Plan created for ${signalType} signal`);
    }

    console.log("Test passed!");
    console.log("All signal types handled successfully");
  },
});
