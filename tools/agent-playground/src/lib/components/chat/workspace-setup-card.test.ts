import type { SetupRequirement } from "@atlas/core/elicitations/model";
import { describe, expect, it } from "vitest";
import {
  allFieldsValid,
  buildSetupAnswerValue,
  credentialProviders,
  credentialRequirements,
  labelFor,
  validateField,
  variableRequirements,
  type CredentialRequirement,
  type VariableRequirement,
} from "./workspace-setup-card.ts";

function varReq(
  name: string,
  schema: VariableRequirement["schema"],
  description?: string,
): VariableRequirement {
  return { kind: "variable", name, schema, ...(description !== undefined ? { description } : {}) };
}

function credReq(
  provider: string,
  path: string = `credentials.${provider}`,
  key: string = "id",
  reason: CredentialRequirement["reason"] = "no_default",
): CredentialRequirement {
  return { kind: "credential", provider, path, key, reason };
}

describe("labelFor", () => {
  it("returns display_name when present", () => {
    const req: VariableRequirement = {
      kind: "variable",
      name: "email_recipient",
      display_name: "Email Recipient",
      schema: { type: "string" },
    };
    expect(labelFor(req)).toBe("Email Recipient");
  });

  it("falls back to name when display_name is absent", () => {
    const req: VariableRequirement = {
      kind: "variable",
      name: "email_recipient",
      schema: { type: "string" },
    };
    expect(labelFor(req)).toBe("email_recipient");
  });
});

describe("variableRequirements", () => {
  it("filters out non-variable requirements", () => {
    const reqs: SetupRequirement[] = [
      varReq("API_TOKEN", { type: "string", minLength: 1 }),
      credReq("gmail"),
      varReq("DEBUG", { type: "boolean" }),
    ];
    const result = variableRequirements(reqs);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name)).toEqual(["API_TOKEN", "DEBUG"]);
  });
});

describe("credentialRequirements", () => {
  it("filters out non-credential requirements", () => {
    const reqs: SetupRequirement[] = [
      varReq("DEBUG", { type: "boolean" }),
      credReq("gmail"),
      credReq("slack"),
    ];
    const result = credentialRequirements(reqs);
    expect(result.map((r) => r.provider)).toEqual(["gmail", "slack"]);
  });
});

describe("credentialProviders", () => {
  it("dedupes providers across multiple credential requirements", () => {
    const reqs: SetupRequirement[] = [
      credReq("gmail", "credentials.gmail_primary"),
      credReq("gmail", "credentials.gmail_secondary"),
      credReq("slack"),
      varReq("DEBUG", { type: "boolean" }),
    ];
    expect(credentialProviders(reqs)).toEqual(["gmail", "slack"]);
  });

  it("returns an empty array when no credential requirements are present", () => {
    expect(credentialProviders([varReq("X", { type: "string", minLength: 1 })])).toEqual([]);
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
  it("is false when any required variable field is empty", () => {
    const reqs = [
      varReq("A", { type: "string", minLength: 1 }),
      varReq("B", { type: "string", minLength: 1 }),
    ];
    expect(allFieldsValid(reqs, { A: "hi" }, [], {})).toBe(false);
  });

  it("is false when any variable field fails validation", () => {
    const reqs = [varReq("PORT", { type: "integer" })];
    expect(allFieldsValid(reqs, { PORT: "abc" }, [], {})).toBe(false);
  });

  it("is true when every variable field has a passing value and no credentials are needed", () => {
    const reqs = [
      varReq("NAME", { type: "string", minLength: 1 }),
      varReq("PORT", { type: "integer" }),
      varReq("DEBUG", { type: "boolean" }),
    ];
    expect(allFieldsValid(reqs, { NAME: "alice", PORT: "8080", DEBUG: "true" }, [], {})).toBe(true);
  });

  it("is false when a credential provider has no chosen credential id", () => {
    expect(allFieldsValid([], {}, ["gmail"], {})).toBe(false);
  });

  it("is false when a credential provider's choice is an empty string", () => {
    expect(allFieldsValid([], {}, ["gmail"], { gmail: "" })).toBe(false);
  });

  it("is true when both variables and credential providers are satisfied", () => {
    const reqs = [varReq("NAME", { type: "string", minLength: 1 })];
    expect(allFieldsValid(reqs, { NAME: "alice" }, ["gmail"], { gmail: "cred_123" })).toBe(true);
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
    expect(buildSetupAnswerValue(reqs, values, [], {})).toEqual({
      variableValues: { NAME: "alice", PORT: 8080, RATE: 1.5, DEBUG: true },
      credentialChoices: {},
    });
  });

  it("ships an empty credentialChoices when no providers are passed", () => {
    const reqs = [varReq("X", { type: "string", minLength: 1 })];
    const result = buildSetupAnswerValue(reqs, { X: "y" }, [], {});
    expect(result.credentialChoices).toEqual({});
  });

  it("omits variable fields that cannot coerce to their declared type", () => {
    const reqs = [
      varReq("PORT", { type: "integer" }),
      varReq("NAME", { type: "string", minLength: 1 }),
    ];
    const result = buildSetupAnswerValue(reqs, { PORT: "garbage", NAME: "ok" }, [], {});
    expect(result.variableValues).toEqual({ NAME: "ok" });
  });

  it("packages both variables and credential choices when both are present", () => {
    const reqs = [varReq("EMAIL_RECIPIENT", { type: "string", minLength: 1 })];
    const result = buildSetupAnswerValue(
      reqs,
      { EMAIL_RECIPIENT: "ops@example.com" },
      ["gmail", "slack"],
      { gmail: "cred_g", slack: "cred_s" },
    );
    expect(result).toEqual({
      variableValues: { EMAIL_RECIPIENT: "ops@example.com" },
      credentialChoices: { gmail: "cred_g", slack: "cred_s" },
    });
  });

  it("omits credential providers without a choice", () => {
    const result = buildSetupAnswerValue([], {}, ["gmail", "slack"], { gmail: "cred_g" });
    expect(result.credentialChoices).toEqual({ gmail: "cred_g" });
  });

  it("treats empty-string credential choices as missing", () => {
    const result = buildSetupAnswerValue([], {}, ["gmail"], { gmail: "" });
    expect(result.credentialChoices).toEqual({});
  });
});
