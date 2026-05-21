/**
 * Behavioral tests for `resolveVariableState` — the single resolution helper
 * shared by `resolveWorkspaceSetupRequirements` (unfilled-only view) and the
 * Settings → Variables daemon endpoint (all-variables view).
 *
 * Tests are written against the public function shape; we don't mock the
 * internal decode + schema pipeline, since drift between those internals and
 * the real call sites is exactly what the helper exists to prevent.
 */

import { VariableDeclarationSchema } from "@atlas/config";
import { describe, expect, it } from "vitest";
import { resolveVariableState } from "../variable-state.ts";

function decl(input: unknown) {
  return VariableDeclarationSchema.parse(input);
}

describe("resolveVariableState — env passes schema", () => {
  it("returns source=env, effective_value coerced from env, no validation_error", () => {
    const d = decl({ schema: { type: "string", format: "email" } });
    const state = resolveVariableState("email_recipient", d, "alice@example.com");
    expect(state).toEqual({
      name: "email_recipient",
      declaration: d,
      value: "alice@example.com",
      effective_value: "alice@example.com",
      source: "env",
      is_filled: true,
    });
  });

  it("stringifies coerced numeric env values for transport", () => {
    const d = decl({ schema: { type: "integer", minimum: 0 } });
    const state = resolveVariableState("max_retries", d, "5");
    expect(state.source).toBe("env");
    expect(state.effective_value).toBe("5");
    expect(state.is_filled).toBe(true);
    expect(state.validation_error).toBeUndefined();
  });
});

describe("resolveVariableState — env absent", () => {
  it("falls through to schema default when default passes", () => {
    const d = decl({ schema: { type: "number", minimum: 0, maximum: 1, default: 0.5 } });
    const state = resolveVariableState("threshold", d, undefined);
    expect(state).toEqual({
      name: "threshold",
      declaration: d,
      value: null,
      effective_value: "0.5",
      source: "default",
      is_filled: true,
    });
  });

  it("returns unset when no env and no default", () => {
    const d = decl({ schema: { type: "string", format: "email" } });
    const state = resolveVariableState("email_recipient", d, undefined);
    expect(state).toEqual({
      name: "email_recipient",
      declaration: d,
      value: null,
      effective_value: null,
      source: "unset",
      is_filled: false,
    });
  });

  it("returns unset when default itself fails schema", () => {
    const d = decl({ schema: { type: "integer", minimum: 5, default: 1 } });
    const state = resolveVariableState("max_retries", d, undefined);
    expect(state.source).toBe("unset");
    expect(state.is_filled).toBe(false);
    expect(state.effective_value).toBeNull();
    expect(state.validation_error).toBeUndefined();
  });
});

describe("resolveVariableState — env present but invalid", () => {
  it("populates validation_error and falls back to default when default passes", () => {
    const d = decl({ schema: { type: "integer", minimum: 5, maximum: 10, default: 7 } });
    const state = resolveVariableState("max_retries", d, "1");
    expect(state.value).toBe("1");
    expect(state.source).toBe("default");
    expect(state.effective_value).toBe("7");
    expect(state.is_filled).toBe(true);
    expect(state.validation_error).toBeTruthy();
  });

  it("populates validation_error and reports unset when no default to fall back on", () => {
    const d = decl({ schema: { type: "integer", minimum: 5, maximum: 10 } });
    const state = resolveVariableState("max_retries", d, "1");
    expect(state.value).toBe("1");
    expect(state.source).toBe("unset");
    expect(state.effective_value).toBeNull();
    expect(state.is_filled).toBe(false);
    expect(state.validation_error).toBeTruthy();
  });

  it("flags type-mismatch (decode failure) with a type message", () => {
    const d = decl({ schema: { type: "boolean" } });
    const state = resolveVariableState("enabled", d, "yes");
    expect(state.source).toBe("unset");
    expect(state.validation_error).toBe("Expected `true` or `false`.");
  });

  it("treats empty string as filled when schema does not require min length", () => {
    const d = decl({ schema: { type: "string" } });
    const state = resolveVariableState("note", d, "");
    expect(state.source).toBe("env");
    expect(state.effective_value).toBe("");
    expect(state.is_filled).toBe(true);
  });

  it("treats empty string as unfilled when schema demands minLength: 1", () => {
    const d = decl({ schema: { type: "string", minLength: 1 } });
    const state = resolveVariableState("note", d, "");
    expect(state.value).toBe("");
    expect(state.source).toBe("unset");
    expect(state.is_filled).toBe(false);
    expect(state.validation_error).toBeTruthy();
  });
});

describe("resolveVariableState — is_filled invariant", () => {
  it("is_filled is true iff source !== 'unset'", () => {
    const cases = [
      { d: decl({ schema: { type: "string" } }), env: "hello", expectFilled: true },
      {
        d: decl({ schema: { type: "string", default: "fallback" } }),
        env: undefined,
        expectFilled: true,
      },
      { d: decl({ schema: { type: "string", minLength: 5 } }), env: "ab", expectFilled: false },
    ] as const;
    for (const c of cases) {
      const state = resolveVariableState("x", c.d, c.env);
      expect(state.is_filled).toBe(state.source !== "unset");
      expect(state.is_filled).toBe(c.expectFilled);
    }
  });
});
