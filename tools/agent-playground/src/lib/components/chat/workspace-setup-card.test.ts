import { describe, it, expect } from "vitest";
import type { SetupRequirement } from "@atlas/core/elicitations/model";
import {
  allFieldsValid,
  buildSetupAnswerValue,
  variableRequirements,
  validateField,
  type VariableRequirement,
} from "./workspace-setup-card.ts";

function varReq(
  name: string,
  schema: VariableRequirement["schema"],
  description?: string,
): VariableRequirement {
  return {
    kind: "variable",
    name,
    schema,
    ...(description !== undefined ? { description } : {}),
  };
}

describe("variableRequirements", () => {
  it("filters out non-variable requirements", () => {
    const reqs: SetupRequirement[] = [
      varReq("API_TOKEN", { type: "string", minLength: 1 }),
      {
        kind: "credential",
        provider: "gmail",
        path: "credentials.gmail",
        key: "id",
        reason: "no_default",
      },
      varReq("DEBUG", { type: "boolean" }),
    ];
    const result = variableRequirements(reqs);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual(["API_TOKEN", "DEBUG"]);
  });
});

describe("validateField", () => {
  it("accepts a valid string", () => {
    const req = varReq("NAME", { type: "string", minLength: 1 });
    expect(validateField(req, "alice")).toEqual({ ok: true });
  });

  it("rejects a string violating minLength", () => {
    const req = varReq("NAME", { type: "string", minLength: 3 });
    const result = validateField(req, "ab");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-integer for an integer field", () => {
    const req = varReq("RETRIES", { type: "integer" });
    const result = validateField(req, "3.5");
    expect(result.ok).toBe(false);
  });

  it("rejects non-boolean strings for a boolean field", () => {
    const req = varReq("DEBUG", { type: "boolean" });
    const result = validateField(req, "yes");
    expect(result.ok).toBe(false);
  });
});

describe("allFieldsValid", () => {
  it("is false when any required field is empty", () => {
    const reqs = [
      varReq("A", { type: "string", minLength: 1 }),
      varReq("B", { type: "string", minLength: 1 }),
    ];
    expect(allFieldsValid(reqs, { A: "hi" })).toBe(false);
  });

  it("is false when any field fails validation", () => {
    const reqs = [varReq("PORT", { type: "integer" })];
    expect(allFieldsValid(reqs, { PORT: "abc" })).toBe(false);
  });

  it("is true when every field has a passing value", () => {
    const reqs = [
      varReq("NAME", { type: "string", minLength: 1 }),
      varReq("PORT", { type: "integer" }),
      varReq("DEBUG", { type: "boolean" }),
    ];
    expect(allFieldsValid(reqs, { NAME: "alice", PORT: "8080", DEBUG: "true" })).toBe(true);
  });
});

describe("buildSetupAnswerValue", () => {
  it("coerces typed values for the answer payload", () => {
    const reqs = [
      varReq("NAME", { type: "string", minLength: 1 }),
      varReq("PORT", { type: "integer" }),
      varReq("RATE", { type: "number" }),
      varReq("DEBUG", { type: "boolean" }),
    ];
    const values = { NAME: "alice", PORT: "8080", RATE: "1.5", DEBUG: "true" };
    expect(buildSetupAnswerValue(reqs, values)).toEqual({
      variableValues: { NAME: "alice", PORT: 8080, RATE: 1.5, DEBUG: true },
      credentialChoices: {},
    });
  });

  it("ships empty credentialChoices in v1", () => {
    const reqs = [varReq("X", { type: "string", minLength: 1 })];
    const result = buildSetupAnswerValue(reqs, { X: "y" });
    expect(result.credentialChoices).toEqual({});
  });

  it("omits fields that cannot coerce to their declared type", () => {
    const reqs = [
      varReq("PORT", { type: "integer" }),
      varReq("NAME", { type: "string", minLength: 1 }),
    ];
    const result = buildSetupAnswerValue(reqs, { PORT: "garbage", NAME: "ok" });
    expect(result.variableValues).toEqual({ NAME: "ok" });
  });
});
