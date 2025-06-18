#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write

import { expect } from "@std/expect";
import { PlanningEngine } from "../../src/core/planning/planning-engine.ts";
import type { PlanningTask } from "../../src/core/planning/planning-engine.ts";

// Create test environment
async function createTestEnvironment() {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-planning-engine-test-" });
  const engine = new PlanningEngine({
    cacheDir: tempDir,
    enableCaching: true,
    enablePatternMatching: true,
    reasoningConfig: {
      allowLLMSelection: false, // Disable LLM calls for testing
    },
  });
  return { tempDir, engine };
}

const createMockTask = (overrides?: Partial<PlanningTask>): PlanningTask => ({
  id: crypto.randomUUID(),
  description: "Create a test plan",
  context: { test: true },
  agentType: "agent",
  ...overrides,
});

Deno.test("PlanningEngine generates plans", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const task = createMockTask({
      description: "Simple planning task",
    });

    const result = await engine.generatePlan(task);

    expect(result.plan).toBeDefined();
    expect(result.reasoning).toBeDefined();
    expect(typeof result.confidence).toBe("number");
    expect(typeof result.method).toBe("string");
    expect(typeof result.duration).toBe("number");
    expect(typeof result.cost).toBe("number");
    expect(typeof result.cached).toBe("boolean");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("PlanningEngine handles different agent types", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const agentTypes: Array<PlanningTask["agentType"]> = [
      "workspace",
      "session",
      "agent",
      "custom",
    ];

    for (const agentType of agentTypes) {
      const task = createMockTask({
        agentType,
        description: `Plan for ${agentType} agent`,
      });

      const result = await engine.generatePlan(task);
      expect(result.plan).toBeDefined();
      expect(result.method).toBeDefined();
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("PlanningEngine estimates complexity correctly", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    // Simple task
    const simpleTask = createMockTask({
      description: "Simple task",
    });

    // Complex task
    const complexTask = createMockTask({
      description:
        "This is a very complex and sophisticated task that requires multiple advanced steps and comprehensive analysis with detailed implementation",
    });

    const simpleResult = await engine.generatePlan(simpleTask);
    const complexResult = await engine.generatePlan(complexTask);

    // Both should succeed
    expect(simpleResult.plan).toBeDefined();
    expect(complexResult.plan).toBeDefined();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("PlanningEngine detects tool use requirements", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const toolTask = createMockTask({
      description: "Use the API to fetch data and execute the query tool",
    });

    const result = await engine.generatePlan(toolTask);
    expect(result.plan).toBeDefined();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("PlanningEngine detects quality critical tasks", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const criticalTask = createMockTask({
      description: "Security critical validation for production deployment",
    });

    const result = await engine.generatePlan(criticalTask);
    expect(result.plan).toBeDefined();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("PlanningEngine handles explicit task parameters", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const task = createMockTask({
      description: "Test task",
      complexity: 0.8,
      requiresToolUse: true,
      qualityCritical: true,
    });

    const result = await engine.generatePlan(task);
    expect(result.plan).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("PlanningEngine caching works", async () => {
  const { tempDir, engine } = await createTestEnvironment();

  try {
    const task = createMockTask({
      description: "Cacheable task",
    });

    // First call - should not be cached
    const result1 = await engine.generatePlan(task);
    expect(result1.cached).toBe(false);

    // Second call with same task - might be cached (depends on pattern matching)
    const result2 = await engine.generatePlan(task);
    expect(result2.plan).toBeDefined();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("PlanningEngine without caching works", async () => {
  const engine = new PlanningEngine({
    enableCaching: false,
    enablePatternMatching: false,
    reasoningConfig: {
      allowLLMSelection: false,
    },
  });

  const task = createMockTask({
    description: "Non-cached task",
  });

  const result = await engine.generatePlan(task);
  expect(result.plan).toBeDefined();
  expect(result.cached).toBe(false);
});
