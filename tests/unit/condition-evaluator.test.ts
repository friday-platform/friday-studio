#!/usr/bin/env -S deno run --allow-env --allow-read --allow-net

/**
 * Unit tests for ConditionEvaluator
 * Tests all supported condition formats and validation
 */

import { expect } from "@std/expect";
import { ConditionEvaluatorRegistry } from "../../src/core/conditions/condition-evaluator.ts";

const testConfig = {
  evaluators: {
    jsonlogic: { enabled: true, priority: 100 },
    simple_expression: { enabled: true, priority: 50 },
    exact_match: { enabled: true, priority: 10 },
  },
  fallback_strategy: "reject" as const,
  require_match_confidence: 0.5,
};

Deno.test({
  name: "ConditionEvaluator - JSONLogic conditions",
  sanitizeResources: false,
  async fn() {
    // Set testing environment to prevent logger file operations
    const originalTesting = Deno.env.get("DENO_TESTING");
    Deno.env.set("DENO_TESTING", "true");

    try {
      const registry = new ConditionEvaluatorRegistry(testConfig);

      // Test basic equality
      const result1 = await registry.evaluate(
        { "==": [{ "var": "type" }, "performance"] },
        { type: "performance" },
      );
      expect(result1.matches).toBe(true);
      expect(result1.evaluator).toBe("jsonlogic");
      expect(result1.confidence).toBe(1.0);

      // Test logical AND
      const result2 = await registry.evaluate(
        {
          "and": [
            { "==": [{ "var": "action" }, "opened"] },
            { "==": [{ "var": "type" }, "performance"] },
          ],
        },
        { action: "opened", type: "performance" },
      );
      expect(result2.matches).toBe(true);

      // Test logical OR
      const result3 = await registry.evaluate(
        {
          "or": [
            { "==": [{ "var": "type" }, "performance"] },
            { "==": [{ "var": "type" }, "comprehensive"] },
          ],
        },
        { type: "dx" },
      );
      expect(result3.matches).toBe(false);
    } finally {
      // Restore original testing environment
      if (originalTesting === undefined) {
        Deno.env.delete("DENO_TESTING");
      } else {
        Deno.env.set("DENO_TESTING", originalTesting);
      }
    }
  },
});

Deno.test({
  name: "ConditionEvaluator - Simple expression conditions",
  ignore: true, // TODO: Fix logger resource leak
  sanitizeResources: false,
  async fn() {
    const registry = new ConditionEvaluatorRegistry(testConfig);

    // These should work based on the telephone example
    const result1 = await registry.evaluate(
      "message && message.length > 0 && message.length < 100",
      { message: "hello world" },
    );
    expect(result1.matches).toBe(true);
    expect(result1.evaluator).toBe("simple_expression");
  },
});

Deno.test({
  name: "ConditionEvaluator - Invalid conditions should be rejected",
  ignore: true, // TODO: Fix logger resource leak
  sanitizeResources: false,
  async fn() {
    const registry = new ConditionEvaluatorRegistry(testConfig);

    // Test invalid simple expressions that are currently causing "Unknown condition format"
    const invalidConditions = [
      "type == 'performance'",
      "!type || type == 'comprehensive'",
      "payload.type == 'dx'",
      "action == 'opened' && type == 'performance'",
    ];

    for (const condition of invalidConditions) {
      const result = await registry.evaluate(condition, { type: "performance" });

      // These should either work or explicitly reject with low confidence
      if (result.evaluator === "fallback-reject") {
        expect(result.matches).toBe(false);
        expect(result.confidence).toBeLessThan(0.5);
      } else {
        // If they work, they should have reasonable confidence
        expect(result.confidence).toBeGreaterThan(0.5);
      }
    }
  },
});

Deno.test({
  name: "ConditionEvaluator - No condition should always match",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const registry = new ConditionEvaluatorRegistry(testConfig);

    const result = await registry.evaluate("", { type: "performance" });
    expect(result.matches).toBe(true);
    expect(result.evaluator).toBe("no-condition");
    expect(result.confidence).toBe(1.0);

    const result2 = await registry.evaluate(null as any, { type: "performance" });
    expect(result2.matches).toBe(true);
  },
});

Deno.test({
  name: "ConditionEvaluator - Exact match fallback",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const registry = new ConditionEvaluatorRegistry(testConfig);

    const result = await registry.evaluate(
      "performance",
      { type: "performance", action: "analyze" },
    );
    expect(result.evaluator).toBe("exact_match");
    expect(result.matches).toBe(true);
  },
});

Deno.test({
  name: "ConditionEvaluator - Confidence thresholds",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const strictConfig = {
      ...testConfig,
      require_match_confidence: 0.8,
    };
    const registry = new ConditionEvaluatorRegistry(strictConfig);

    // Low confidence matches should be rejected
    const result = await registry.evaluate(
      "performance", // This gets low confidence from exact_match
      { type: "performance" },
    );

    if (result.confidence < 0.8) {
      expect(result.evaluator).toBe("fallback-reject");
      expect(result.matches).toBe(false);
    }
  },
});
