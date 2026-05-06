/**
 * B4 (melodic-strolling-seal-pt2). Tests for the helpers that thread the
 * resolved validate decision through `AgentContext.config` to the
 * orchestrator-side prompt-assembly site (`convertLLMToAgent`). The helpers
 * themselves are intentionally tiny — these tests pin the wire format so
 * the FSM-engine→runtime adapter (B4) and the
 * `convertLLMToAgent` reader (B4) can't drift.
 */

import { describe, expect, it } from "vitest";
import {
  buildValidateDecisionConfig,
  readValidateDecisionFromConfig,
  VALIDATE_DECISION_CONFIG_KEY,
} from "./validate-decision.ts";

describe("readValidateDecisionFromConfig", () => {
  it("returns skip when config is undefined", () => {
    expect(readValidateDecisionFromConfig(undefined)).toEqual({ decision: "skip" });
  });

  it("returns skip when key is absent", () => {
    expect(readValidateDecisionFromConfig({ otherKey: "x" })).toEqual({ decision: "skip" });
  });

  it("returns skip when value is malformed (non-object)", () => {
    expect(readValidateDecisionFromConfig({ [VALIDATE_DECISION_CONFIG_KEY]: "self" })).toEqual({
      decision: "skip",
    });
  });

  it("returns skip when decision string is invalid", () => {
    expect(
      readValidateDecisionFromConfig({ [VALIDATE_DECISION_CONFIG_KEY]: { decision: "weird" } }),
    ).toEqual({ decision: "skip" });
  });

  it("decodes the self decision without skill override", () => {
    expect(
      readValidateDecisionFromConfig({ [VALIDATE_DECISION_CONFIG_KEY]: { decision: "self" } }),
    ).toEqual({ decision: "self" });
  });

  it("decodes the self decision with a custom skill name", () => {
    expect(
      readValidateDecisionFromConfig({
        [VALIDATE_DECISION_CONFIG_KEY]: { decision: "self", skill: "my-validator" },
      }),
    ).toEqual({ decision: "self", skill: "my-validator" });
  });

  it("decodes external and skip decisions", () => {
    expect(
      readValidateDecisionFromConfig({ [VALIDATE_DECISION_CONFIG_KEY]: { decision: "external" } }),
    ).toEqual({ decision: "external" });
    expect(
      readValidateDecisionFromConfig({ [VALIDATE_DECISION_CONFIG_KEY]: { decision: "skip" } }),
    ).toEqual({ decision: "skip" });
  });

  it("ignores non-string skill values", () => {
    expect(
      readValidateDecisionFromConfig({
        [VALIDATE_DECISION_CONFIG_KEY]: { decision: "self", skill: 42 },
      }),
    ).toEqual({ decision: "self" });
  });
});

describe("buildValidateDecisionConfig", () => {
  it("emits the reserved key with decision-only payload", () => {
    expect(buildValidateDecisionConfig("skip")).toEqual({
      [VALIDATE_DECISION_CONFIG_KEY]: { decision: "skip" },
    });
  });

  it("includes skill when provided", () => {
    expect(buildValidateDecisionConfig("self", "my-skill")).toEqual({
      [VALIDATE_DECISION_CONFIG_KEY]: { decision: "self", skill: "my-skill" },
    });
  });

  it("round-trips through readValidateDecisionFromConfig", () => {
    const cfg = buildValidateDecisionConfig("self", "custom");
    expect(readValidateDecisionFromConfig(cfg)).toEqual({ decision: "self", skill: "custom" });
  });

  it("preserves other config keys when merged into a config object", () => {
    const merged = { foo: "bar", ...buildValidateDecisionConfig("external") };
    expect(merged.foo).toEqual("bar");
    expect(readValidateDecisionFromConfig(merged)).toEqual({ decision: "external" });
  });

  it("E1: includes hasOutputType when provided", () => {
    expect(buildValidateDecisionConfig("self", undefined, true)).toEqual({
      [VALIDATE_DECISION_CONFIG_KEY]: { decision: "self", hasOutputType: true },
    });
  });

  it("E1: round-trips hasOutputType", () => {
    const cfg = buildValidateDecisionConfig("self", "custom", true);
    expect(readValidateDecisionFromConfig(cfg)).toEqual({
      decision: "self",
      skill: "custom",
      hasOutputType: true,
    });
  });

  it("E1: omits hasOutputType when false", () => {
    expect(buildValidateDecisionConfig("self", undefined, false)).toEqual({
      [VALIDATE_DECISION_CONFIG_KEY]: { decision: "self" },
    });
  });
});
