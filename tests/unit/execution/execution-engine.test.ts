/**
 * ExecutionEngine Integration Tests
 *
 * Tests the complete execution engine with all strategies
 */

import { expect } from "jsr:@std/expect";
import {
  ExecutionEngine,
  TaskCharacteristics,
} from "../../../src/core/execution/execution-engine.ts";
import { ExecutionStep } from "../../../src/core/execution/base-execution-strategy.ts";

// Mock execution steps for testing
const createMockSteps = (count: number): ExecutionStep[] => {
  return Array.from({ length: count }, (_, i) => ({
    id: `step-${i + 1}`,
    type: "agent" as const,
    agentId: `agent-${i + 1}`,
    config: {
      task: `Execute task ${i + 1}`,
      input: { message: `Task ${i + 1} input` },
      expectedOutput: { result: `Expected output ${i + 1}` },
    },
  }));
};

const createComplexSteps = (): ExecutionStep[] => [
  {
    id: "step-1",
    type: "agent",
    agentId: "security-scanner",
    config: {
      task: "Scan for security vulnerabilities",
      input: { codebase: "src/", severity: "high" },
      expectedOutput: { findings: [], riskScore: 0 },
    },
  },
  {
    id: "step-2",
    type: "agent",
    agentId: "critical-analyzer",
    config: {
      task: "Analyze critical findings",
      input: { findings: "{{security-scanner.findings}}" },
      expectedOutput: { analysis: "analysis result" },
    },
  },
  {
    id: "step-3",
    type: "agent",
    agentId: "remote-validator",
    config: {
      task: "Validate with external service",
      input: { analysis: "{{critical-analyzer.analysis}}" },
      expectedOutput: { validation: "validated" },
    },
  },
];

Deno.test("ExecutionEngine - Basic initialization", () => {
  const engine = new ExecutionEngine();

  const stats = engine.getPerformanceStats();
  expect(stats.size).toBe(3); // All three strategies initialized
  expect(stats.has("behavior-tree")).toBe(true);
  expect(stats.has("htn")).toBe(true);
  expect(stats.has("mcts")).toBe(true);
});

Deno.test("ExecutionEngine - Strategy recommendation for simple tasks", () => {
  const engine = new ExecutionEngine();
  const simpleSteps = createMockSteps(3);

  const recommendation = engine.recommendStrategy(simpleSteps);

  expect(recommendation.strategy).toBe("behavior-tree");
  expect(recommendation.confidence).toBeGreaterThan(0);
  expect(recommendation.reasoning).toContain("Behavior Tree");
  expect(recommendation.alternatives.length).toBe(2);
});

Deno.test("ExecutionEngine - Strategy recommendation for complex tasks", () => {
  const engine = new ExecutionEngine();
  const complexSteps = createMockSteps(10); // Large number of steps

  const recommendation = engine.recommendStrategy(complexSteps, {
    complexity: 0.8,
    dependency_complexity: 0.7,
  });

  // Should recommend HTN for complex, dependent tasks
  expect(["htn", "mcts"]).toContain(recommendation.strategy);
  expect(recommendation.confidence).toBeGreaterThan(0);
});

Deno.test("ExecutionEngine - Strategy recommendation for uncertain tasks", () => {
  const engine = new ExecutionEngine();
  const uncertainSteps = createComplexSteps(); // Has remote agents

  const recommendation = engine.recommendStrategy(uncertainSteps, {
    uncertainty: 0.8,
    optimization_needed: 0.6,
  });

  // Should recommend MCTS for uncertain/optimization tasks
  expect(recommendation.strategy).toBe("mcts");
  expect(recommendation.reasoning).toContain("MCTS");
});

Deno.test("ExecutionEngine - Manual strategy execution", async () => {
  const engine = new ExecutionEngine();
  const steps = createMockSteps(2);

  const result = await engine.executeWithStrategy(steps, "behavior-tree");

  expect(result.metadata.strategy).toBe("behavior-tree");
  expect((result.metadata as any).selectedStrategy).toBe("behavior-tree");
  expect((result.metadata as any).selectionMethod).toBe("manual");
});

Deno.test("ExecutionEngine - Automatic strategy selection and execution", async () => {
  const engine = new ExecutionEngine();
  const steps = createMockSteps(3);

  const result = await engine.execute(steps);

  expect(result.success).toBe(true);
  expect(result.metadata.strategy).toBeDefined();
  expect((result.metadata as any).selectedStrategy).toBeDefined();
  expect((result.metadata as any).characteristics).toBeDefined();
  expect((result.metadata as any).selectionReason).toBeDefined();
});

Deno.test("ExecutionEngine - Task characteristics analysis", () => {
  const engine = new ExecutionEngine();

  // Simple task
  const simpleSteps = createMockSteps(2);
  const simpleCharacteristics = (engine as any).analyzeTaskCharacteristics(simpleSteps);

  expect(simpleCharacteristics.complexity).toBeLessThan(0.5);
  expect(simpleCharacteristics.step_count).toBe(2);
  expect(simpleCharacteristics.time_critical).toBe(false);

  // Complex task
  const complexSteps = createComplexSteps();
  const complexCharacteristics = (engine as any).analyzeTaskCharacteristics(complexSteps, {
    uncertainty: 0.8,
  });

  expect(complexCharacteristics.uncertainty).toBe(0.8); // Should use hint
  expect(complexCharacteristics.step_count).toBe(3);
});

Deno.test("ExecutionEngine - Performance tracking", async () => {
  const engine = new ExecutionEngine({
    enablePerformanceTracking: true,
  });

  const steps = createMockSteps(2);

  // Execute a few times to build performance history
  await engine.execute(steps);
  await engine.execute(steps);
  await engine.execute(steps);

  const stats = engine.getPerformanceStats();
  const behaviorTreeStats = stats.get("behavior-tree");

  expect(behaviorTreeStats).toBeDefined();
  expect(behaviorTreeStats!.success_rate).toBeGreaterThan(0);
  expect(behaviorTreeStats!.avg_execution_time).toBeGreaterThan(0);
});

Deno.test("ExecutionEngine - Strategy configuration updates", () => {
  const engine = new ExecutionEngine();

  // Update MCTS configuration
  engine.updateStrategyConfig("mcts", {
    maxIterations: 500,
    explorationConstant: 1.4,
  });

  // Strategy should be reinitialized with new config
  const recommendation = engine.recommendStrategy(createMockSteps(5), {
    uncertainty: 0.9,
    optimization_needed: 0.8,
  });

  expect(recommendation.strategy).toBe("mcts");
});

Deno.test("ExecutionEngine - State export and import", () => {
  const engine1 = new ExecutionEngine({
    defaultStrategy: "htn",
    enablePerformanceTracking: true,
  });

  const exportedState = engine1.exportState();

  expect(exportedState.config.defaultStrategy).toBe("htn");
  expect(exportedState.performance).toBeDefined();
  expect(Object.keys(exportedState.performance).length).toBe(3);

  // Create new engine and import state
  const engine2 = new ExecutionEngine();
  engine2.importState(exportedState);

  const newState = engine2.exportState();
  expect(newState.config.defaultStrategy).toBe("htn");
});

Deno.test("ExecutionEngine - Adaptive selection vs rule-based", () => {
  const adaptiveEngine = new ExecutionEngine({
    adaptiveSelection: true,
  });

  const ruleBasedEngine = new ExecutionEngine({
    adaptiveSelection: false,
  });

  const steps = createMockSteps(8);
  const characteristics: Partial<TaskCharacteristics> = {
    complexity: 0.7,
    uncertainty: 0.3,
    dependency_complexity: 0.6,
  };

  const adaptiveRec = adaptiveEngine.recommendStrategy(steps, characteristics);
  const ruleBasedRec = ruleBasedEngine.recommendStrategy(steps, characteristics);

  // Both should be valid strategies
  expect(["behavior-tree", "htn", "mcts"]).toContain(adaptiveRec.strategy);
  expect(["behavior-tree", "htn", "mcts"]).toContain(ruleBasedRec.strategy);

  // Rule-based should prefer HTN for high complexity + dependencies
  expect(ruleBasedRec.strategy).toBe("htn");
});

Deno.test("ExecutionEngine - Error handling", async () => {
  const engine = new ExecutionEngine();

  // Test with invalid strategy
  try {
    await engine.executeWithStrategy(createMockSteps(1), "invalid" as any);
    throw new Error("Should have thrown error for invalid strategy");
  } catch (error) {
    expect((error as Error).message).toContain("not found");
  }
});

Deno.test("ExecutionEngine - Time-critical task handling", () => {
  const engine = new ExecutionEngine();

  const timeCriticalSteps: ExecutionStep[] = [
    {
      id: "step-1",
      type: "agent",
      agentId: "fast-agent",
      config: {
        task: "Time-critical task",
        input: { urgent: true },
        expectedOutput: { result: "fast result" },
        timeout: 5000, // 5 second timeout
      },
    },
  ];

  const recommendation = engine.recommendStrategy(timeCriticalSteps);

  // Should prefer behavior-tree for time-critical tasks (not MCTS which is slower)
  expect(recommendation.strategy).toBe("behavior-tree");
});

Deno.test("ExecutionEngine - Strategy scoring calculation", () => {
  const engine = new ExecutionEngine();

  const highComplexityCharacteristics: TaskCharacteristics = {
    complexity: 0.9,
    uncertainty: 0.2,
    optimization_needed: 0.3,
    time_critical: false,
    step_count: 10,
    dependency_complexity: 0.8,
    failure_tolerance: 0.5,
  };

  const scores = (engine as any).calculateStrategyScores(highComplexityCharacteristics);

  expect(scores["behavior-tree"]).toBeDefined();
  expect(scores["htn"]).toBeDefined();
  expect(scores["mcts"]).toBeDefined();

  // HTN should score highest for high complexity + dependencies
  expect(scores["htn"]).toBeGreaterThan(scores["behavior-tree"]);
  expect(scores["htn"]).toBeGreaterThan(scores["mcts"]);
});
