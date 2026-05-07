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
    // B7 (melodic-strolling-seal-pt2): `retryOnFail` is dropped — the
    // delegate-driven judge has no built-in retry concept. `agent` is
    // added so authors can swap in domain-specific judges. O4 (review-2)
    // dropped `threshold` (parsed-but-never-read).
    const parsed = ValidateStrategySchema.parse({
      strategy: "external",
      skill: "@my/validator-skill",
      agent: "fin-judge",
    });
    expect(parsed).toMatchObject({
      strategy: "external",
      skill: "@my/validator-skill",
      agent: "fin-judge",
    });
  });

  it("rejects retryOnFail (dropped in B7)", () => {
    expect(() => ValidateStrategySchema.parse({ strategy: "self", retryOnFail: true })).toThrow();
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

  it("rejects object form with `threshold` (dropped in O4)", () => {
    expect(() =>
      ValidateStrategySchema.parse({ strategy: "self", threshold: "standard" }),
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

  it("parses object form with skill (O4 dropped threshold)", () => {
    const parsed = schema.parse({ ...base, validate: { strategy: "self", skill: "@my/skill" } });
    expect((parsed as { validate?: unknown }).validate).toMatchObject({
      strategy: "self",
      skill: "@my/skill",
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
