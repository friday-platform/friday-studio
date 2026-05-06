/**
 * Schema parsing tests for the per-action `validate:` field added in B2 of
 * melodic-strolling-seal-pt2. The field exists on both LLMActionSchema and
 * AgentActionSchema; behavior at runtime is exercised in
 * tests/validate-gating.test.ts.
 */

import { describe, expect, it } from "vitest";
import { AgentActionSchema, LLMActionSchema, ValidateStrategySchema } from "./schema.ts";

const baseLLM = {
  type: "llm" as const,
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  prompt: "do something useful",
};

const baseAgent = { type: "agent" as const, agentId: "test-agent" };

describe("ValidateStrategySchema", () => {
  it.each(["skip", "self", "external", "auto"] as const)("accepts string form %s", (value) => {
    expect(ValidateStrategySchema.parse(value)).toEqual(value);
  });

  it("accepts object form with all optional fields", () => {
    const parsed = ValidateStrategySchema.parse({
      strategy: "self",
      skill: "@my/validator-skill",
      threshold: "standard",
      retryOnFail: true,
    });
    expect(parsed).toMatchObject({
      strategy: "self",
      skill: "@my/validator-skill",
      threshold: "standard",
      retryOnFail: true,
    });
  });

  it("accepts object form with strategy=external + bare strategy", () => {
    expect(ValidateStrategySchema.parse({ strategy: "external" })).toMatchObject({
      strategy: "external",
    });
  });

  it("rejects unknown string keyword", () => {
    expect(() => ValidateStrategySchema.parse("wrong")).toThrow();
  });

  it("rejects object form with strategy=skip (string-only escape hatch)", () => {
    expect(() => ValidateStrategySchema.parse({ strategy: "skip" })).toThrow();
  });

  it("rejects object form with strategy=auto", () => {
    expect(() => ValidateStrategySchema.parse({ strategy: "auto" })).toThrow();
  });

  it("rejects object form with extra fields (strict)", () => {
    expect(() => ValidateStrategySchema.parse({ strategy: "self", extraField: true })).toThrow();
  });

  it("rejects object form with bad threshold value", () => {
    expect(() =>
      ValidateStrategySchema.parse({ strategy: "self", threshold: "lenient" }),
    ).toThrow();
  });
});

describe.each([
  { name: "LLMActionSchema", schema: LLMActionSchema, base: baseLLM },
  { name: "AgentActionSchema", schema: AgentActionSchema, base: baseAgent },
])("$name validate field", ({ schema, base }) => {
  it("parses with no validate field (backwards compat)", () => {
    const parsed = schema.parse({ ...base });
    expect((parsed as { validate?: unknown }).validate).toBeUndefined();
  });

  it.each(["skip", "self", "external", "auto"] as const)("parses validate: %s", (value) => {
    const parsed = schema.parse({ ...base, validate: value });
    expect((parsed as { validate?: unknown }).validate).toEqual(value);
  });

  it("parses object form with skill + threshold", () => {
    const parsed = schema.parse({
      ...base,
      validate: { strategy: "self", skill: "@my/skill", threshold: "standard" },
    });
    expect((parsed as { validate?: unknown }).validate).toMatchObject({
      strategy: "self",
      skill: "@my/skill",
      threshold: "standard",
    });
  });

  it("rejects validate: 'wrong'", () => {
    expect(() => schema.parse({ ...base, validate: "wrong" })).toThrow();
  });

  it("rejects object form with strategy=skip", () => {
    expect(() => schema.parse({ ...base, validate: { strategy: "skip" } })).toThrow();
  });

  it("rejects object form with extra unknown field", () => {
    expect(() =>
      schema.parse({ ...base, validate: { strategy: "self", extraField: true } }),
    ).toThrow();
  });
});
