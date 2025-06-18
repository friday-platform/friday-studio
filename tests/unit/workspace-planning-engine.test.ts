#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write

import { expect } from "@std/expect";
import { join } from "@std/path";
import { WorkspacePlanningEngine } from "../../src/core/planning/workspace-planning-engine.ts";
import type { JobSpecification } from "../../src/core/session-supervisor.ts";

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

// Helper to create test environment
async function createTestEnvironment() {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-planning-test-" });
  const engine = new WorkspacePlanningEngine(tempDir);
  return { tempDir, engine };
}

Deno.test("WorkspacePlanningEngine creates and loads plans", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const workspaceId = "test-workspace-123";

    // Generate initial plan
    const plan1 = await engine.loadOrGeneratePlan(workspaceId, mockJobs, mockSignals);

    expect(plan1.id).toBe(workspaceId);
    expect(plan1.version).toBe("1.0");
    expect(plan1.configHash).toBeDefined();
    expect(plan1.signalMappings.size).toBe(2); // Two signals
    expect(plan1.jobAnalysis.size).toBe(2); // Two jobs

    // Load cached plan (should be same)
    const plan2 = await engine.loadOrGeneratePlan(workspaceId, mockJobs, mockSignals);

    expect(plan2.configHash).toBe(plan1.configHash);
    expect(plan2.signalMappings.size).toBe(plan1.signalMappings.size);
    expect(plan2.lastUsed.getTime()).toBeGreaterThan(plan1.lastUsed.getTime());
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspacePlanningEngine analyzes job complexity correctly", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const workspaceId = "complexity-test";
    const plan = await engine.loadOrGeneratePlan(workspaceId, mockJobs, mockSignals);

    // Simple job should have low complexity
    const simpleAnalysis = plan.jobAnalysis.get("simple-job");
    expect(simpleAnalysis).toBeDefined();
    expect(simpleAnalysis!.complexity).toBeLessThan(0.5);
    expect(simpleAnalysis!.requiresToolUse).toBe(false);
    expect(simpleAnalysis!.qualityCritical).toBe(false);

    // Complex job should have high complexity
    const complexAnalysis = plan.jobAnalysis.get("complex-job");
    expect(complexAnalysis).toBeDefined();
    expect(complexAnalysis!.complexity).toBeGreaterThan(0.7);
    expect(complexAnalysis!.requiresToolUse).toBe(true); // "tools" in description
    expect(complexAnalysis!.qualityCritical).toBe(true); // "security" and "critical" in description
    expect(complexAnalysis!.parallelizable).toBe(true); // "staged" strategy
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspacePlanningEngine selects appropriate reasoning methods", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const workspaceId = "reasoning-test";
    const plan = await engine.loadOrGeneratePlan(workspaceId, mockJobs, mockSignals);

    // Simple job should use Chain-of-Thought
    const simpleExecution = plan.signalMappings.get("test-signal");
    expect(simpleExecution).toBeDefined();
    expect(simpleExecution!.reasoningMethod).toBe("cot");

    // Complex job should use self-refine because it's quality critical
    const complexExecution = plan.signalMappings.get("complex-signal");
    expect(complexExecution).toBeDefined();
    expect(complexExecution!.reasoningMethod).toBe("self-refine"); // Quality critical overrides tool use
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspacePlanningEngine creates proper signal mappings", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const workspaceId = "mapping-test";
    const plan = await engine.loadOrGeneratePlan(workspaceId, mockJobs, mockSignals);

    // Check signal-to-execution mapping
    const testSignalExecution = plan.signalMappings.get("test-signal");
    expect(testSignalExecution).toBeDefined();
    expect(testSignalExecution!.jobId).toBe("simple-job");
    expect(testSignalExecution!.executionStrategy).toBe("sequential");
    expect(testSignalExecution!.agentChain.length).toBe(1);
    expect(testSignalExecution!.agentChain[0].agentId).toBe("test-agent");

    const complexSignalExecution = plan.signalMappings.get("complex-signal");
    expect(complexSignalExecution).toBeDefined();
    expect(complexSignalExecution!.jobId).toBe("complex-job");
    expect(complexSignalExecution!.executionStrategy).toBe("staged");
    expect(complexSignalExecution!.agentChain.length).toBe(3);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspacePlanningEngine invalidates cache on config changes", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const workspaceId = "cache-test";

    // Generate initial plan
    const plan1 = await engine.loadOrGeneratePlan(workspaceId, mockJobs, mockSignals);
    const originalHash = plan1.configHash;

    // Modify jobs (add new job)
    const modifiedJobs = {
      ...mockJobs,
      "new-job": {
        name: "new-job",
        description: "New job added",
        execution: {
          strategy: "sequential" as const,
          agents: [{ id: "new-agent" }],
        },
      },
    };

    // Generate plan with modified config
    const plan2 = await engine.loadOrGeneratePlan(workspaceId, modifiedJobs, mockSignals);

    expect(plan2.configHash).not.toBe(originalHash);
    expect(plan2.jobAnalysis.size).toBe(3); // Now has 3 jobs
    expect(plan2.jobAnalysis.has("new-job")).toBe(true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspacePlanningEngine persists plans to .atlas directory", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const workspaceId = "persist-test";

    // Generate plan
    await engine.loadOrGeneratePlan(workspaceId, mockJobs, mockSignals);

    // Check that plan file was created
    const planPath = join(tempDir, ".atlas", "plans", `workspace-${workspaceId}-plan.json`);
    const planExists = await Deno.stat(planPath).then(() => true).catch(() => false);
    expect(planExists).toBe(true);

    // Check plan file content
    const planContent = await Deno.readTextFile(planPath);
    const planData = JSON.parse(planContent);

    expect(planData.id).toBe(workspaceId);
    expect(planData.version).toBe("1.0");
    expect(planData.signalMappings).toBeDefined();
    expect(planData.jobAnalysis).toBeDefined();
    expect(Array.isArray(planData.signalMappings)).toBe(true); // Serialized as array
    expect(Array.isArray(planData.jobAnalysis)).toBe(true); // Serialized as array
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspacePlanningEngine estimates execution duration", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const workspaceId = "duration-test";
    const plan = await engine.loadOrGeneratePlan(workspaceId, mockJobs, mockSignals);

    const simpleExecution = plan.signalMappings.get("test-signal");
    const complexExecution = plan.signalMappings.get("complex-signal");

    expect(simpleExecution!.estimatedDuration).toBeGreaterThan(0);
    expect(complexExecution!.estimatedDuration).toBeGreaterThan(simpleExecution!.estimatedDuration);

    // Complex job should take longer due to more agents and higher complexity
    expect(complexExecution!.estimatedDuration).toBeGreaterThan(60); // At least 1 minute
    expect(simpleExecution!.estimatedDuration).toBeLessThan(60); // Less than 1 minute
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
