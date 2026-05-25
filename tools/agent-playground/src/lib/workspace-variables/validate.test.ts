import { describe, expect, it } from "vitest";
import {
  validateField as setupCardValidateField,
  type VariableRequirement as SetupCardVariableRequirement,
} from "../components/chat/workspace-setup-card.ts";
import { isSecretKey, validateField, type VariableRequirement } from "./validate.ts";

function varReq(
  name: string,
  schema: VariableRequirement["schema"],
  description?: string,
): VariableRequirement {
  return { kind: "variable", name, schema, ...(description !== undefined ? { description } : {}) };
}

describe("validateField — type coverage", () => {
  it("accepts a valid string", () => {
    expect(validateField(varReq("NAME", { type: "string", minLength: 1 }), "alice")).toEqual({
      ok: true,
    });
  });

  it("rejects a string violating minLength", () => {
    const result = validateField(varReq("NAME", { type: "string", minLength: 3 }), "ab");
    expect(result.ok).toBe(false);
  });

  it("accepts a valid integer", () => {
    expect(validateField(varReq("PORT", { type: "integer" }), "8080")).toEqual({ ok: true });
  });

  it("rejects a non-integer for an integer field", () => {
    const result = validateField(varReq("PORT", { type: "integer" }), "3.5");
    expect(result.ok).toBe(false);
  });

  it("accepts a valid number", () => {
    expect(validateField(varReq("RATE", { type: "number" }), "1.5")).toEqual({ ok: true });
  });

  it("rejects a non-numeric string for a number field", () => {
    const result = validateField(varReq("RATE", { type: "number" }), "abc");
    expect(result.ok).toBe(false);
  });

  it("accepts a valid boolean", () => {
    expect(validateField(varReq("DEBUG", { type: "boolean" }), "true")).toEqual({ ok: true });
    expect(validateField(varReq("DEBUG", { type: "boolean" }), "false")).toEqual({ ok: true });
  });

  it("rejects non-boolean strings for a boolean field", () => {
    const result = validateField(varReq("DEBUG", { type: "boolean" }), "yes");
    expect(result.ok).toBe(false);
  });

  it("threads description into the declaration without affecting validation", () => {
    const req = varReq("X", { type: "string", minLength: 1 }, "An X value");
    expect(validateField(req, "x")).toEqual({ ok: true });
  });
});

describe("validateField — schema default fallback presence", () => {
  it("threads schema.default through to the underlying validator", () => {
    const req = varReq("PORT", { type: "integer", default: 8080 });
    expect(validateField(req, "9090")).toEqual({ ok: true });
    expect(validateField(req, "3.5").ok).toBe(false);
  });
});

describe("isSecretKey — heuristic single source of truth", () => {
  it.each(["API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "CLIENT_SECRET", "OAUTH_CREDENTIAL"])(
    "treats %s as a secret-shaped key",
    (key) => {
      expect(isSecretKey(key)).toBe(true);
    },
  );

  it.each(["EMAIL_RECIPIENT", "PORT", "WORKSPACE_NAME", "HOST", "RATE_LIMIT"])(
    "treats %s as a non-secret key",
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    },
  );

  it("matches case-insensitively (heuristic ignores casing)", () => {
    expect(isSecretKey("api_key")).toBe(true);
    expect(isSecretKey("GitHub_Token")).toBe(true);
  });
});

describe("test case #14 — validateField parity across import surfaces", () => {
  const cases: ReadonlyArray<{ label: string; req: VariableRequirement; raw: string }> = [
    { label: "string pass", req: varReq("NAME", { type: "string", minLength: 1 }), raw: "alice" },
    {
      label: "string fail (too short)",
      req: varReq("NAME", { type: "string", minLength: 3 }),
      raw: "ab",
    },
    {
      label: "string fail (empty)",
      req: varReq("NAME", { type: "string", minLength: 1 }),
      raw: "",
    },
    { label: "integer pass", req: varReq("PORT", { type: "integer" }), raw: "8080" },
    { label: "integer fail (decimal)", req: varReq("PORT", { type: "integer" }), raw: "3.5" },
    { label: "integer fail (garbage)", req: varReq("PORT", { type: "integer" }), raw: "abc" },
    { label: "number pass", req: varReq("RATE", { type: "number" }), raw: "1.5" },
    { label: "number fail", req: varReq("RATE", { type: "number" }), raw: "nope" },
    { label: "boolean pass true", req: varReq("DEBUG", { type: "boolean" }), raw: "true" },
    { label: "boolean pass false", req: varReq("DEBUG", { type: "boolean" }), raw: "false" },
    { label: "boolean fail", req: varReq("DEBUG", { type: "boolean" }), raw: "yes" },
    {
      label: "string with default fail",
      req: varReq("PORT_NAME", { type: "string", minLength: 5, default: "primary" }),
      raw: "ab",
    },
  ];

  for (const { label, req, raw } of cases) {
    it(`yields identical result via both surfaces: ${label}`, () => {
      const direct = validateField(req, raw);
      const reExported = setupCardValidateField(req as SetupCardVariableRequirement, raw);
      expect(reExported).toEqual(direct);
      expect(direct.ok).toBe(reExported.ok);
      if (!direct.ok && !reExported.ok) {
        expect(reExported.message).toBe(direct.message);
        expect(reExported.reason).toBe(direct.reason);
      }
    });
  }
});
