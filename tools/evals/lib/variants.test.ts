import { describe, expect, it } from "vitest";
import { PR_MODELS, resolveVariants, STANDARD_MODELS } from "./variants.ts";

describe("variants", () => {
  it("STANDARD_MODELS covers all three tiers", () => {
    const tiers = STANDARD_MODELS.map((m) => m.tier);
    expect(tiers).toContain("sm");
    expect(tiers).toContain("md");
    expect(tiers).toContain("lg");
  });

  it("PR_MODELS excludes lg tier", () => {
    expect(PR_MODELS.every((m) => m.tier !== "lg")).toBe(true);
    expect(PR_MODELS.length).toBeLessThan(STANDARD_MODELS.length);
  });

  it("PR_MODELS is a subset of STANDARD_MODELS", () => {
    for (const m of PR_MODELS) {
      expect(STANDARD_MODELS).toContainEqual(m);
    }
  });

  it("resolveVariants defaults to full set when env unset", () => {
    expect(resolveVariants({})).toEqual(STANDARD_MODELS);
  });

  it("resolveVariants returns PR set on EVAL_MATRIX=pr", () => {
    expect(resolveVariants({ EVAL_MATRIX: "pr" })).toEqual(PR_MODELS);
  });

  it("resolveVariants returns full set on EVAL_MATRIX=full", () => {
    expect(resolveVariants({ EVAL_MATRIX: "full" })).toEqual(STANDARD_MODELS);
  });

  it("resolveVariants returns single variant on name match", () => {
    const result = resolveVariants({ EVAL_MATRIX: "Haiku" });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Haiku");
  });

  it("resolveVariants throws on unknown name", () => {
    expect(() => resolveVariants({ EVAL_MATRIX: "Gemini" })).toThrow(/Unknown EVAL_MATRIX/);
  });
});
