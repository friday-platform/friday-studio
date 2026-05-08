import { describe, expect, it } from "vitest";
import { severityForCategory, ValidationFailedError, ValidationVerdictSchema } from "./verdict.ts";

describe("severityForCategory", () => {
  it("sourcing → error", () => {
    expect(severityForCategory("sourcing")).toBe("error");
  });
  it("no-tools-called → warn", () => {
    expect(severityForCategory("no-tools-called")).toBe("warn");
  });
  it("judge-uncertain → info", () => {
    expect(severityForCategory("judge-uncertain")).toBe("info");
  });
  it("judge-error → info", () => {
    expect(severityForCategory("judge-error")).toBe("info");
  });
});

describe("ValidationVerdictSchema", () => {
  it("accepts a minimal pass verdict", () => {
    const parsed = ValidationVerdictSchema.parse({ verdict: "pass" });
    expect(parsed.verdict).toBe("pass");
    expect(parsed.issues).toBeUndefined();
  });

  it("accepts an advisory verdict with issues", () => {
    const parsed = ValidationVerdictSchema.parse({
      verdict: "advisory",
      issues: [{ claim: "Reported user count is unsourced", category: "sourcing" }],
    });
    expect(parsed.verdict).toBe("advisory");
    expect(parsed.issues).toHaveLength(1);
  });

  it("accepts a blocking verdict", () => {
    const parsed = ValidationVerdictSchema.parse({
      verdict: "blocking",
      issues: [{ claim: "Fabricated tool output" }],
    });
    expect(parsed.verdict).toBe("blocking");
  });

  it("rejects an unknown verdict literal", () => {
    expect(() => ValidationVerdictSchema.parse({ verdict: "fail" })).toThrow();
  });
});

describe("ValidationFailedError", () => {
  it("carries the verdict and surfaces issues in its message", () => {
    const verdict = {
      verdict: "blocking" as const,
      issues: [{ claim: "no source for total" }, { claim: "no tool called" }],
    };
    const err = new ValidationFailedError(verdict, "agent-x");
    expect(err.verdict).toEqual(verdict);
    expect(err.message).toContain("agent-x");
    expect(err.message).toContain("no source for total");
  });
});
