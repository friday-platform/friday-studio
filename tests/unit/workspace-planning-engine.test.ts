#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write

import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  type PlanningEngineConfig,
  WorkspacePlanningEngine,
} from "../../src/core/planning/workspace-planning-engine.ts";
import {
  DEFAULT_PLANNING_CONFIG,
  type PlanningConfig,
} from "../../src/core/planning/planning-config.ts";
import type { JobSpecification } from "../../src/core/session-supervisor.ts";

// Prevent logger from initializing during tests
Deno.env.set("DENO_TESTING", "true");

// Test fixtures
const mockJobs: Record<string, JobSpecification> = {
  "simple-job": {
    name: "simple-job",
    description: "A simple test job",
    triggers: [{ signal: "test-signal" }],
    execution: {
      strategy: "sequential",
      agents: [{ id: "test-agent" }],
    },
  },
  "complex-job": {
    name: "complex-job",
    description:
      "A complex job requiring security analysis with multiple tools and critical validation steps for production deployment",
    triggers: [{ signal: "complex-signal", condition: "priority === 'high'" }],
    execution: {
      strategy: "staged",
      agents: [
        { id: "security-agent", config: { strict: true } },
        { id: "validation-agent", prompt: "Validate all outputs" },
        { id: "deployment-agent" },
      ],
      stages: [
        {
          name: "security",
          strategy: "sequential",
          agents: [{ id: "security-agent", config: { strict: true } }],
        },
        {
          name: "validation",
          strategy: "sequential",
          agents: [{ id: "validation-agent", prompt: "Validate all outputs" }],
        },
        {
          name: "deployment",
          strategy: "sequential",
          agents: [{ id: "deployment-agent" }],
        },
      ],
    },
  },
};

const mockSignals: Record<string, any> = {
  "test-signal": {
    id: "test-signal",
    description: "Test signal",
    provider: { id: "cli", name: "CLI Provider" },
    schema: {},
  },
  "complex-signal": {
    id: "complex-signal",
    description: "Complex signal for production deployments",
    provider: { id: "http", name: "HTTP Provider" },
    schema: {},
  },
};

// Test planning configuration
const testPlanningConfig: PlanningConfig = {
  ...DEFAULT_PLANNING_CONFIG,
  execution: {
    ...DEFAULT_PLANNING_CONFIG.execution,
    precomputation: "aggressive",
  },
};

// Helper to create test environment
async function createTestEnvironment() {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-planning-test-" });
  const engineConfig: Partial<PlanningEngineConfig> = {
    persistPlans: true,
    planStoragePath: join(tempDir, ".atlas", "plans"),
  };
  const engine = new WorkspacePlanningEngine(engineConfig);
  return { tempDir, engine };
}

// Helper to clean up after tests
async function cleanupTestEnvironment(tempDir: string) {
  // Clean up temp directory
  try {
    await Deno.remove(tempDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

Deno.test("WorkspacePlanningEngine precomputes plans", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    // Precompute all plans
    await engine.precomputeAllPlans(mockJobs, testPlanningConfig);

    // Check that plans were precomputed
    const allPlans = engine.getAllPrecomputedPlans();
    expect(allPlans.size).toBeGreaterThan(0);

    // Check analytics
    const analytics = engine.getAnalytics();
    expect(analytics.totalJobs).toBe(2);
    expect(analytics.precomputedPlans).toBeGreaterThan(0);

    // Check cache stats
    const cacheStats = engine.getCacheStats();
    expect(cacheStats.size).toBeGreaterThan(0);
  } finally {
    await cleanupTestEnvironment(tempDir);
  }
});

Deno.test("WorkspacePlanningEngine analyzes job complexity correctly", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    // Analyze individual jobs
    const simpleCharacteristics = engine.analyzeJobCharacteristics(mockJobs["simple-job"]);
    const complexCharacteristics = engine.analyzeJobCharacteristics(mockJobs["complex-job"]);

    // Simple job should have low complexity
    expect(simpleCharacteristics.complexity).toBeLessThan(0.5);
    expect(simpleCharacteristics.uncertainty).toBeLessThan(0.5);
    expect(simpleCharacteristics.has_conditional_logic).toBe(false);
    expect(simpleCharacteristics.has_dynamic_selection).toBe(false);

    // Complex job should have high complexity
    expect(complexCharacteristics.complexity).toBeGreaterThanOrEqual(0.5);
    expect(complexCharacteristics.has_conditional_logic).toBe(false); // No actual conditions in execution
    expect(complexCharacteristics.has_goal_decomposition).toBe(true); // "staged" strategy
    expect(complexCharacteristics.step_count).toBe(3); // 3 stages
  } finally {
    await cleanupTestEnvironment(tempDir);
  }
});

Deno.test("WorkspacePlanningEngine selects appropriate plan types", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    // Determine plan types for jobs
    const simpleCharacteristics = engine.analyzeJobCharacteristics(mockJobs["simple-job"]);
    const complexCharacteristics = engine.analyzeJobCharacteristics(mockJobs["complex-job"]);

    const simplePlanType = engine.determinePlanType(simpleCharacteristics, testPlanningConfig);
    const complexPlanType = engine.determinePlanType(complexCharacteristics, testPlanningConfig);

    // Simple job should use static sequential
    expect(simplePlanType).toBe("static_sequential");

    // Complex job might use behavior tree or HTN due to staged execution
    expect(["behavior_tree", "htn", "static_sequential"]).toContain(complexPlanType);
  } finally {
    await cleanupTestEnvironment(tempDir);
  }
});

Deno.test("WorkspacePlanningEngine creates proper execution plans", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    // Precompute plans
    await engine.precomputeAllPlans(mockJobs, testPlanningConfig);

    // Get precomputed plan for simple job
    const simplePlan = await engine.getPrecomputedPlan("simple-job");
    expect(simplePlan).toBeDefined();
    expect(simplePlan!.jobName).toBe("simple-job");
    expect(simplePlan!.steps.length).toBe(1);
    expect(simplePlan!.steps[0].agentId).toBe("test-agent");

    // Get precomputed plan for complex job (might not be precomputed if too complex)
    const complexPlan = await engine.getPrecomputedPlan("complex-job");
    if (complexPlan) {
      expect(complexPlan.jobName).toBe("complex-job");
      expect(complexPlan.steps.length).toBeGreaterThan(0);
    }
  } finally {
    await cleanupTestEnvironment(tempDir);
  }
});

Deno.test("WorkspacePlanningEngine handles cache operations", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    // Initially cache should be empty
    let cacheStats = engine.getCacheStats();
    expect(cacheStats.size).toBe(0);

    // Precompute plans
    await engine.precomputeAllPlans(mockJobs, testPlanningConfig);

    // Cache should have entries
    cacheStats = engine.getCacheStats();
    expect(cacheStats.size).toBeGreaterThan(0);

    // Test cache hit
    const plan1 = engine.getExecutionPlan("simple-job");
    const plan2 = engine.getExecutionPlan("simple-job");
    expect(plan1).toBe(plan2); // Same reference

    // Clear cache
    engine.clearCache();
    cacheStats = engine.getCacheStats();
    expect(cacheStats.size).toBe(0);
  } finally {
    await cleanupTestEnvironment(tempDir);
  }
});

Deno.test("WorkspacePlanningEngine provides analytics", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    // Get initial analytics
    let analytics = engine.getAnalytics();
    expect(analytics.totalJobs).toBe(0);
    expect(analytics.precomputedPlans).toBe(0);

    // Precompute plans
    await engine.precomputeAllPlans(mockJobs, testPlanningConfig);

    // Check updated analytics
    analytics = engine.getAnalytics();
    expect(analytics.totalJobs).toBe(2);
    expect(analytics.precomputedPlans).toBeGreaterThan(0);
    expect(analytics.avgPlanComputeTime).toBeGreaterThanOrEqual(0);

    // Access plans to test cache hits
    engine.getExecutionPlan("simple-job");
    engine.getExecutionPlan("simple-job");
    engine.getExecutionPlan("non-existent");

    // Get updated analytics after cache operations
    const updatedAnalytics = engine.getAnalytics();
    expect(updatedAnalytics.cacheHits).toBeGreaterThanOrEqual(2);
    expect(updatedAnalytics.cacheMisses).toBeGreaterThanOrEqual(1);
  } finally {
    await cleanupTestEnvironment(tempDir);
  }
});

Deno.test("WorkspacePlanningEngine estimates execution duration", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    // Precompute plans
    await engine.precomputeAllPlans(mockJobs, testPlanningConfig);

    // Get plans
    const simplePlan = await engine.getPrecomputedPlan("simple-job");
    const complexPlan = await engine.getPrecomputedPlan("complex-job");

    if (simplePlan) {
      expect(simplePlan.metadata.estimatedDuration).toBeGreaterThan(0);
      expect(simplePlan.metadata.estimatedDuration).toBeLessThan(60000); // Less than 1 minute
    }

    if (complexPlan) {
      expect(complexPlan.metadata.estimatedDuration).toBeGreaterThan(0);
      // Complex jobs should take longer if they have more steps
      if (simplePlan) {
        expect(complexPlan.metadata.estimatedDuration).toBeGreaterThanOrEqual(
          simplePlan.metadata.estimatedDuration,
        );
      }
    }
  } finally {
    await cleanupTestEnvironment(tempDir);
  }
});
