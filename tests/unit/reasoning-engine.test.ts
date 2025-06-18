#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write

import { expect } from "@std/expect";
import { ReasoningEngine } from "../../src/core/reasoning/reasoning-engine.ts";
import type { ReasoningContext } from "../../src/core/reasoning/base-reasoning.ts";

// Mock reasoning context for testing
const createMockContext = (overrides?: Partial<ReasoningContext>): ReasoningContext => ({
  task: "Create a simple test plan",
  context: "Testing context",
  complexity: 0.3,
  requiresToolUse: false,
  qualityCritical: false,
  agentType: "agent",
  ...overrides,
});

Deno.test("ReasoningEngine initializes with default methods", () => {
  const engine = new ReasoningEngine();

  const methods = engine.getAvailableMethods();
  expect(methods).toContain("chain-of-thought");
  expect(methods).toContain("react");
  expect(methods).toContain("self-refine");
  expect(methods.length).toBe(3);
});

Deno.test("ReasoningEngine allows custom configuration", () => {
  const engine = new ReasoningEngine({
    defaultMethod: "react",
    allowLLMSelection: false,
  });

  const methods = engine.getAvailableMethods();
  expect(methods.length).toBe(3); // Still has all built-in methods
});

Deno.test("ReasoningEngine selects method heuristically", async () => {
  const engine = new ReasoningEngine({
    allowLLMSelection: false, // Force heuristic selection
    defaultMethod: "chain-of-thought",
  });

  // Simple task should use chain-of-thought
  const simpleResult = await engine.reason(createMockContext({
    complexity: 0.2,
    requiresToolUse: false,
    qualityCritical: false,
  }));
  expect(simpleResult.method).toBe("chain-of-thought");

  // Tool use task should use react
  const toolResult = await engine.reason(createMockContext({
    complexity: 0.5,
    requiresToolUse: true,
    qualityCritical: false,
  }));
  expect(toolResult.method).toBe("react");

  // Quality critical task should use self-refine
  const qualityResult = await engine.reason(createMockContext({
    complexity: 0.6,
    requiresToolUse: false,
    qualityCritical: true,
  }));
  expect(qualityResult.method).toBe("self-refine");
});

Deno.test("ReasoningEngine provides method information", () => {
  const engine = new ReasoningEngine();

  const cotInfo = engine.getMethodInfo("chain-of-thought");
  expect(cotInfo).toBeDefined();
  expect(cotInfo!.cost).toBe("low");
  expect(cotInfo!.reliability).toBe(0.85);

  const reactInfo = engine.getMethodInfo("react");
  expect(reactInfo).toBeDefined();
  expect(reactInfo!.cost).toBe("medium");
  expect(reactInfo!.reliability).toBe(0.92);

  const unknownInfo = engine.getMethodInfo("unknown-method");
  expect(unknownInfo).toBeNull();
});

Deno.test("ReasoningEngine handles fast path for simple tasks", async () => {
  const engine = new ReasoningEngine();

  // Very simple task should trigger fast path
  const result = await engine.reason(createMockContext({
    complexity: 0.1, // Very low complexity
    task: "Simple task",
  }));

  // Should still get a result, potentially with fast path
  expect(result.solution).toBeDefined();
  expect(result.method).toBeDefined();
  expect(result.confidence).toBeGreaterThan(0);
});

Deno.test("ReasoningEngine returns structured results", async () => {
  const engine = new ReasoningEngine({
    allowLLMSelection: false, // Force heuristic to avoid LLM calls in test
  });

  const result = await engine.reason(createMockContext());

  expect(result.solution).toBeDefined();
  expect(result.reasoning).toBeDefined();
  expect(typeof result.confidence).toBe("number");
  expect(typeof result.method).toBe("string");
  expect(typeof result.cost).toBe("number");
  expect(typeof result.duration).toBe("number");
});

Deno.test("ReasoningEngine handles errors gracefully", async () => {
  const engine = new ReasoningEngine();

  // Test with malformed context
  const result = await engine.reason(createMockContext({
    task: "", // Empty task
    context: "",
  }));

  // Should still return a result, not throw
  expect(result).toBeDefined();
  expect(result.method).toBeDefined();
});
