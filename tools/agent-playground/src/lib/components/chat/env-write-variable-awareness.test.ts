import type { VariableDeclaration } from "@atlas/config";
import { describe, expect, it } from "vitest";
import {
  findDeclaredVariableForKey,
  validateProposedValue,
} from "./env-write-variable-awareness.ts";

describe("findDeclaredVariableForKey", () => {
  const declarations: Record<string, VariableDeclaration> = {
    email_recipient: {
      description: "Where price-drop alerts are sent.",
      schema: { type: "string", minLength: 3 },
    },
    threshold: { schema: { type: "integer", minimum: 0 } },
  };

  it("matches the auto-derived UPPER_SNAKE_CASE env key", () => {
    expect(findDeclaredVariableForKey(declarations, "EMAIL_RECIPIENT")).toEqual({
      name: "email_recipient",
      declaration: declarations.email_recipient,
    });
    expect(findDeclaredVariableForKey(declarations, "THRESHOLD")).toEqual({
      name: "threshold",
      declaration: declarations.threshold,
    });
  });

  it("returns null for keys that do not belong to any declared variable", () => {
    expect(findDeclaredVariableForKey(declarations, "OPENAI_API_KEY")).toBeNull();
  });

  it("returns null when declarations are absent", () => {
    expect(findDeclaredVariableForKey(undefined, "EMAIL_RECIPIENT")).toBeNull();
    expect(findDeclaredVariableForKey({}, "EMAIL_RECIPIENT")).toBeNull();
  });
});

describe("validateProposedValue", () => {
  it("accepts a string within declared bounds", () => {
    const decl: VariableDeclaration = { schema: { type: "string", minLength: 3, maxLength: 20 } };
    expect(validateProposedValue(decl, "alice@example.com")).toEqual({ ok: true });
  });

  it("rejects a string violating minLength with a schema-derived message", () => {
    const decl: VariableDeclaration = { schema: { type: "string", minLength: 5 } };
    const result = validateProposedValue(decl, "no");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("schema");
    expect(result.message).toBeTruthy();
  });

  it("coerces and validates integers", () => {
    const decl: VariableDeclaration = { schema: { type: "integer", minimum: 1, maximum: 100 } };
    expect(validateProposedValue(decl, "42")).toEqual({ ok: true });

    const tooBig = validateProposedValue(decl, "9001");
    expect(tooBig.ok).toBe(false);
    if (tooBig.ok) return;
    expect(tooBig.reason).toBe("schema");
  });

  it("flags non-integer strings as a type mismatch", () => {
    const decl: VariableDeclaration = { schema: { type: "integer" } };
    const result = validateProposedValue(decl, "12.5");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("type");
    expect(result.message).toMatch(/integer/i);
  });

  it("coerces booleans from the canonical strings only", () => {
    const decl: VariableDeclaration = { schema: { type: "boolean" } };
    expect(validateProposedValue(decl, "true")).toEqual({ ok: true });
    expect(validateProposedValue(decl, "false")).toEqual({ ok: true });

    const bad = validateProposedValue(decl, "yes");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.reason).toBe("type");
  });

  it("allows empty string when the schema permits it", () => {
    const decl: VariableDeclaration = { schema: { type: "string" } };
    expect(validateProposedValue(decl, "")).toEqual({ ok: true });
  });

  it("rejects empty string when minLength forbids it", () => {
    const decl: VariableDeclaration = { schema: { type: "string", minLength: 1 } };
    const result = validateProposedValue(decl, "");
    expect(result.ok).toBe(false);
  });
});
