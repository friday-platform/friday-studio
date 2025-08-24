/**
 * Complex unit tests for SessionSupervisor execution planning
 * Tests multi-agent scenarios, error handling, and advanced planning features
 */

import type { SessionSupervisorConfig } from "@atlas/core";
import { assertEquals, assertExists } from "@std/assert";
import {
  type SessionContext,
  SessionSupervisorActor,
} from "../src/core/actors/session-supervisor-actor.ts";

// Skip tests in CI or when no API key is available
const skipIfNoKey =
  !Deno.env.get("ANTHROPIC_API_KEY") ||
  Deno.env.get("CI") === "true" ||
  Deno.env.get("GITHUB_ACTIONS") === "true";

// Helper function to create session context with multiple agents
const createComplexSessionContext = (overrides: Partial<SessionContext> = {}): SessionContext => ({
  sessionId: "complex-session",
  workspaceId: "complex-workspace",
  signal: {
    id: "complex-sig",
    type: "data-processing",
    payload: {
      dataset: "user-analytics",
      operations: ["extract", "transform", "validate", "load"],
      priority: "high",
    },
  },
  payload: {
    dataset: "user-analytics",
    operations: ["extract", "transform", "validate", "load"],
    priority: "high",
  },
  // DELIBERATELY WRONG ORDER to test AI intelligence
  // Correct order would be: data-extractor, data-transformer, data-validator, data-loader, notification-sender
  availableAgents: [
    "notification-sender", // Should be LAST
    "data-validator", // Should be 3rd
    "data-loader", // Should be 4th
    "data-extractor", // Should be FIRST
    "data-transformer", // Should be 2nd
  ],
  ...overrides,
});

// Helper function to create supervisor config
const createTestSupervisorConfig = (): SessionSupervisorConfig => ({
  job: { name: "test-job", execution: { strategy: "sequential" } },
  agents: {
    "data-extractor": {
      type: "llm",
      config: { model: "claude-3-7-sonnet-20250219", tools: ["file-reader", "api-client"] },
    },
    "data-transformer": {
      type: "llm",
      config: { model: "claude-3-7-sonnet-20250219", tools: ["data-processor"] },
    },
    "data-validator": { type: "system", config: { tools: ["schema-validator"] } },
    "data-loader": {
      type: "llm",
      config: { model: "claude-3-7-sonnet-20250219", tools: ["database-client"] },
    },
    "notification-sender": {
      type: "system",
      config: { tools: ["email-sender", "slack-notifier"] },
    },
  },
});

Deno.test({
  name: "SessionSupervisor - Multi-Agent Complex Planning",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("complex-123", "workspace-123");
    const config = createTestSupervisorConfig();
    supervisor.setConfig(config);

    const context = createComplexSessionContext();

    console.log("Testing complex multi-agent planning...");
    console.log(`Available agents: ${context.availableAgents.join(", ")}`);
    console.log(`Signal payload: ${JSON.stringify(context.payload)}`);

    supervisor.initializeSession(context);
    const plan = await supervisor.createExecutionPlan();

    // Verify comprehensive plan structure
    assertExists(plan);
    assertExists(plan.id);
    assertEquals(plan.strategy, "ai-planned");

    // Should have meaningful reasoning for complex scenario
    assertExists(plan.reasoning);

    // Verify phases structure
    assertExists(plan.phases);
    assertEquals(plan.phases.length > 0, true);

    const firstPhase = plan.phases[0];
    assertExists(firstPhase.agents);
    assertEquals(firstPhase.agents.length > 0, true);

    // Log the planned execution
    console.log(`Plan created with ${plan.phases.length} phase(s)`);
    for (const [i, phase] of plan.phases.entries()) {
      console.log(`Phase ${i + 1}: ${phase.name} (${phase.executionStrategy})`);
      console.log(`  Agents: ${phase.agents.map((a) => a.agentId).join(", ")}`);

      // Log individual agent tasks to see if AI is planning intelligently
      for (const agent of phase.agents) {
        console.log(`    - ${agent.agentId}: ${agent.task}`);
      }
    }

    // NEW: Validate intelligent planning for data processing pipeline
    // The AI should understand that data processing requires logical order:
    // 1. Extract data first
    // 2. Transform it
    // 3. Validate the transformed data
    // 4. Load it into destination
    // 5. Send notifications last

    const allAgents = plan.phases.flatMap((phase) => phase.agents);
    const agentIds = allAgents.map((a) => a.agentId);

    console.log(`\nAnalyzing AI planning intelligence...`);
    console.log(`Agent execution order: ${agentIds.join(" → ")}`);

    // Check if AI planned a logical data pipeline order
    const extractorIndex = agentIds.indexOf("data-extractor");
    const transformerIndex = agentIds.indexOf("data-transformer");
    const validatorIndex = agentIds.indexOf("data-validator");

    if (extractorIndex !== -1 && transformerIndex !== -1) {
      if (extractorIndex < transformerIndex) {
        console.log("✅ AI correctly planned extractor before transformer");
      } else {
        console.log("⚠️  AI placed transformer before extractor - may not be optimal");
      }
    }

    if (transformerIndex !== -1 && validatorIndex !== -1) {
      if (transformerIndex < validatorIndex) {
        console.log("✅ AI correctly planned transformer before validator");
      } else {
        console.log("⚠️  AI placed validator before transformer - may not be optimal");
      }
    }

    // Check if notification is planned last (good practice)
    const notifierIndex = agentIds.indexOf("notification-sender");
    if (notifierIndex === agentIds.length - 1) {
      console.log("✅ AI correctly planned notifications at the end");
    } else if (notifierIndex !== -1) {
      console.log("⚠️  AI placed notifications in middle of pipeline");
    }

    console.log("Test passed!");
  },
});

Deno.test({
  name: "SessionSupervisor - Planning with Large Payload",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("large-payload", "workspace-large");

    // Create context with large, complex payload
    const context = createComplexSessionContext({
      payload: {
        dataset: "user-analytics-2024",
        operations: [
          "extract",
          "transform",
          "validate",
          "aggregate",
          "analyze",
          "report",
          "archive",
        ],
        priority: "critical",
        metadata: {
          source: "production-database",
          format: "json",
          size: "10GB",
          schema: {
            users: { id: "string", name: "string", email: "string", created_at: "datetime" },
            events: { id: "string", user_id: "string", event_type: "string", data: "json" },
            sessions: {
              id: "string",
              user_id: "string",
              start_time: "datetime",
              end_time: "datetime",
            },
          },
        },
        configuration: { batch_size: 1000, parallel_workers: 4, timeout: 3600, retry_attempts: 3 },
      },
    });

    console.log("Testing planning with large, complex payload...");

    supervisor.initializeSession(context);
    const plan = await supervisor.createExecutionPlan();

    // Should handle large payloads gracefully
    assertExists(plan);
    assertEquals(plan.strategy, "ai-planned");

    // Should create reasonable execution plan despite large payload
    assertExists(plan.phases);
    assertEquals(plan.phases.length > 0, true);

    console.log("Test passed!");
    console.log(`Plan created for large payload (${JSON.stringify(context.payload).length} chars)`);
  },
});

Deno.test({
  name: "SessionSupervisor - Planning with No Available Agents",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("no-agents", "workspace-no-agents");

    const context = createComplexSessionContext({
      availableAgents: [], // No agents available
    });

    console.log("Testing planning with no available agents...");

    supervisor.initializeSession(context);
    const plan = await supervisor.createExecutionPlan();

    // Should still create a plan structure
    assertExists(plan);
    assertEquals(plan.strategy, "ai-planned");

    // Should handle empty agents gracefully
    assertExists(plan.phases);
    assertEquals(plan.phases.length > 0, true);
    assertEquals(plan.phases[0].agents.length, 0);

    console.log("Test passed!");
    console.log("Plan created gracefully with no available agents");
  },
});

Deno.test({
  name: "SessionSupervisor - Planning with Detailed Supervision Level",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("detailed-super", "workspace-detailed");

    const context = createComplexSessionContext({
      // Remove jobSpec so we test AI planning with detailed supervision
      // The supervision level will be determined by SessionSupervisorActor.getSupervisionLevel()
      additionalPrompts: {
        planning: "Use detailed supervision level. Be thorough and careful in planning.",
      },
    });

    console.log("Testing planning with detailed supervision level...");

    supervisor.initializeSession(context);
    const plan = await supervisor.createExecutionPlan();

    // Should create detailed plan
    assertExists(plan);
    assertEquals(plan.strategy, "ai-planned");

    // With detailed supervision, planning should be thorough
    assertExists(plan.reasoning);

    console.log("Test passed!");
    console.log("Plan created with detailed supervision level");
  },
});

Deno.test({
  name: "SessionSupervisor - Planning Performance Test",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("perf-test", "workspace-perf");
    const context = createComplexSessionContext();

    console.log("Testing planning performance...");

    supervisor.initializeSession(context);

    const startTime = Date.now();
    const plan = await supervisor.createExecutionPlan();
    const duration = Date.now() - startTime;

    // Verify plan was created
    assertExists(plan);
    assertEquals(plan.strategy, "ai-planned");

    // Performance check - should complete reasonably quickly
    // Allow up to 45 seconds for API call (realistic for AI planning with thinking)
    assertEquals(duration < 45000, true, `Planning took ${duration}ms, should be under 45s`);

    console.log(`Test passed! Planning completed in ${duration}ms`);
  },
});

Deno.test({
  name: "SessionSupervisor - Planning Consistency Test",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Test that planning is relatively consistent for same input
    const context = createComplexSessionContext();
    const plans: string[] = [];

    console.log("Testing planning consistency across multiple runs...");

    // Run planning multiple times with same input
    for (let i = 0; i < 3; i++) {
      const supervisor = new SessionSupervisorActor(`consistency-${i}`, "workspace-consistency");
      supervisor.initializeSession(context);

      const plan = await supervisor.createExecutionPlan();
      assertExists(plan);
      assertEquals(plan.strategy, "ai-planned");

      plans.push(plan.reasoning);
      console.log(`Run ${i + 1}: Plan created with ${plan.phases.length} phases`);
    }

    // All plans should be created successfully
    assertEquals(plans.length, 3);

    // Plans should have some consistency (all should be meaningful text)
    for (const planReasoning of plans) {
      // Check that we have substantive reasoning (not just placeholder text)
      assertEquals(planReasoning.length > 50, true, "Plan reasoning should be substantial");
      // Should contain planning-related terms
      const hasValidContent =
        planReasoning.toLowerCase().includes("execution") ||
        planReasoning.toLowerCase().includes("phase") ||
        planReasoning.toLowerCase().includes("data") ||
        planReasoning.toLowerCase().includes("etl");
      assertEquals(hasValidContent, true, "Plan reasoning should contain planning concepts");
    }

    console.log("Test passed!");
    console.log("Planning showed reasonable consistency across runs");
  },
});

Deno.test({
  name: "SessionSupervisor - Intelligent Planning Validation",
  ignore: skipIfNoKey,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supervisor = new SessionSupervisorActor("intelligent-test", "workspace-intelligent");

    // Create a scenario where random agent order would be clearly wrong
    const context = createComplexSessionContext({
      signal: {
        id: "validation-signal",
        type: "etl-pipeline",
        payload: {
          task: "Process user data: extract from database, clean and transform data, validate results, load into warehouse, notify stakeholders",
          priority: "high",
        },
      },
      payload: {
        task: "Process user data: extract from database, clean and transform data, validate results, load into warehouse, notify stakeholders",
        priority: "high",
      },
      // Deliberately provide agents in WRONG order to test AI reordering
      availableAgents: [
        "notification-sender", // Should be LAST
        "data-loader", // Should be 4th
        "data-validator", // Should be 3rd
        "data-transformer", // Should be 2nd
        "data-extractor", // Should be FIRST
      ],
    });

    console.log("Testing AI's ability to reorder agents intelligently...");
    console.log(`Input agent order (deliberately wrong): ${context.availableAgents.join(" → ")}`);
    console.log(`Task description: ${context.payload.task}`);

    supervisor.initializeSession(context);
    const plan = await supervisor.createExecutionPlan();

    // Verify plan structure
    assertExists(plan);
    assertEquals(plan.strategy, "ai-planned");
    assertExists(plan.phases);

    const allAgents = plan.phases.flatMap((phase) => phase.agents);
    const actualOrder = allAgents.map((a) => a.agentId);

    console.log(`\nAI planned order: ${actualOrder.join(" → ")}`);

    // If AI is actually planning (not just returning input order), we should see:
    // 1. Different order than input
    // 2. Logical ETL sequence: extract → transform → validate → load → notify

    const inputOrder = context.availableAgents.join(",");
    const outputOrder = actualOrder.join(",");

    if (inputOrder !== outputOrder) {
      console.log("✅ AI reordered the agents (not using input order)");

      // Check for logical ETL sequence
      const extractorPos = actualOrder.indexOf("data-extractor");
      const transformerPos = actualOrder.indexOf("data-transformer");
      const validatorPos = actualOrder.indexOf("data-validator");
      const loaderPos = actualOrder.indexOf("data-loader");
      const notifierPos = actualOrder.indexOf("notification-sender");

      let logicalSequence = true;
      const sequenceIssues = [];

      if (extractorPos > transformerPos) {
        logicalSequence = false;
        sequenceIssues.push("extractor should come before transformer");
      }
      if (transformerPos > validatorPos) {
        logicalSequence = false;
        sequenceIssues.push("transformer should come before validator");
      }
      if (validatorPos > loaderPos) {
        logicalSequence = false;
        sequenceIssues.push("validator should come before loader");
      }
      if (loaderPos > notifierPos) {
        logicalSequence = false;
        sequenceIssues.push("loader should come before notification");
      }

      if (logicalSequence) {
        console.log("✅ AI planned a logical ETL sequence!");
      } else {
        console.log("⚠️  AI reordered agents but sequence has issues:", sequenceIssues.join(", "));
      }
    } else {
      console.log("❌ AI returned the same order as input - may not be actually planning");
      console.log("This suggests the AI response parsing is not working correctly");
    }

    // Log the actual tasks assigned to verify AI understanding
    console.log("\nAgent task assignments:");
    for (const agent of allAgents) {
      console.log(`  ${agent.agentId}: ${agent.task}`);
    }

    console.log("Test completed - check output above to validate intelligent planning");
  },
});
