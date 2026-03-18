import { CreateArtifactSchema } from "@atlas/core/artifacts";
import { describe, expect, test } from "vitest";
import { fallbackTaskSummary } from "./index.ts";

describe("fallbackTaskSummary", () => {
  test("produces a non-empty summary", () => {
    const summary = fallbackTaskSummary("deploy service", 3, true);
    expect(summary).toBe("Task: deploy service (3 steps, ok)");
  });

  test("truncates long intents", () => {
    const longIntent = "a]".repeat(100);
    const summary = fallbackTaskSummary(longIntent, 1, false);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary).toContain("...");
    expect(summary).toContain("failed");
  });

  test("always passes CreateArtifactSchema summary validation", () => {
    const cases = [
      fallbackTaskSummary("", 0, true),
      fallbackTaskSummary("x", 1, false),
      fallbackTaskSummary("deploy the big service to prod", 5, true),
    ];
    for (const summary of cases) {
      const result = CreateArtifactSchema.shape.summary.safeParse(summary);
      expect(result.success, `Failed for: "${summary}"`).toBe(true);
    }
  });

  /** Simulates the guard in storeTaskArtifact: rawSummary.trim() || fallback */
  test("guard produces valid summary for empty/whitespace LLM output", () => {
    const emptyOutputs = ["", " ", "  \n\t  "];
    for (const raw of emptyOutputs) {
      const summary = raw.trim() || fallbackTaskSummary("test intent", 2, true);
      const result = CreateArtifactSchema.shape.summary.safeParse(summary);
      expect(result.success, `Failed for raw="${JSON.stringify(raw)}"`).toBe(true);
      expect(summary).toBe("Task: test intent (2 steps, ok)");
    }
  });
});
