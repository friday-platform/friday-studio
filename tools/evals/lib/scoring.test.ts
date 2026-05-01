import { describe, expect, it } from "vitest";
import { aggregateScores, createScore } from "./scoring.ts";

describe("createScore", () => {
  it("creates score with name, value, and optional reason", () => {
    expect(createScore("accuracy", 0.85)).toMatchObject({ name: "accuracy", value: 0.85 });
    expect(createScore("accuracy", 0.85, "matched 17/20 rows")).toMatchObject({
      name: "accuracy",
      value: 0.85,
      reason: "matched 17/20 rows",
    });
  });

  it("accepts boundary values", () => {
    expect(createScore("empty", 0).value).toBe(0);
    expect(createScore("perfect", 1).value).toBe(1);
  });

  it.each([
    { name: "below 0", value: -0.1 },
    { name: "above 1", value: 1.1 },
    { name: "NaN", value: NaN },
  ])("rejects $name", ({ value }) => {
    expect(() => createScore("bad", value)).toThrow("Score value must be between 0 and 1");
  });
});

describe("aggregateScores", () => {
  it("returns mean of values", () => {
    const scores = [createScore("a", 0.8), createScore("b", 0.6), createScore("c", 1.0)];
    expect(aggregateScores(scores)).toBeCloseTo(0.8);
  });

  it("single score returns its value", () => {
    expect(aggregateScores([createScore("only", 0.5)])).toBe(0.5);
  });

  it("empty array returns 0", () => {
    expect(aggregateScores([])).toBe(0);
  });
});
