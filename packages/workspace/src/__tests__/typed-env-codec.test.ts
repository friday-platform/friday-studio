/**
 * Round-trip tests for the typed env codec.
 *
 * `encodeForEnv(value, decl)` writes a typed value into the `.env`'s
 * string-only world. `decodeFromEnv(raw, decl)` reads it back into the
 * declared type (or `undefined` on type mismatch).
 *
 * The invariant the codec exists to guarantee:
 *
 *   decodeFromEnv(encodeForEnv(v, decl), decl) === v   (for every valid `v`)
 *
 * Without this, an answer-handler write of `"3.14"` to an `integer`-typed
 * variable lands in `.env`, `decodeFromEnv` returns `undefined`, derivation
 * marks the variable "unfilled", and the workspace silently re-enters
 * setup — see review v3 Finding #6.
 */

import type { VariableDeclaration } from "@atlas/config";
import { decodeFromEnv, encodeForEnv } from "@atlas/config";
import { describe, expect, it } from "vitest";

function decl(schema: VariableDeclaration["schema"]): VariableDeclaration {
  return { schema };
}

describe("typed-env-codec round-trip", () => {
  describe("string", () => {
    const d = decl({ type: "string" });
    const cases: string[] = [
      "",
      "hello",
      "alice@example.com",
      "value with spaces",
      "unicode: café 漢字 🚀",
      "leading whitespace ok ",
      "true", // string that looks like a boolean
      "42", // string that looks like a number
      "newlines\nin\nstrings",
      'quotes "and" \'apostrophes\'',
    ];
    for (const v of cases) {
      it(`round-trips ${JSON.stringify(v)}`, () => {
        const encoded = encodeForEnv(v, d);
        expect(typeof encoded).toBe("string");
        expect(decodeFromEnv(encoded, d)).toBe(v);
      });
    }
  });

  describe("number", () => {
    const d = decl({ type: "number" });
    const cases: number[] = [
      0,
      1,
      -1,
      3.14,
      -3.14,
      0.0001,
      -0.0001,
      1e10,
      -1e10,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const v of cases) {
      it(`round-trips ${v}`, () => {
        const encoded = encodeForEnv(v, d);
        expect(typeof encoded).toBe("string");
        expect(decodeFromEnv(encoded, d)).toBe(v);
      });
    }
  });

  describe("integer", () => {
    const d = decl({ type: "integer" });
    const cases: number[] = [
      0,
      1,
      -1,
      42,
      -42,
      100,
      -100,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      1000000,
    ];
    for (const v of cases) {
      it(`round-trips ${v}`, () => {
        const encoded = encodeForEnv(v, d);
        expect(typeof encoded).toBe("string");
        expect(decodeFromEnv(encoded, d)).toBe(v);
      });
    }
  });

  describe("boolean", () => {
    const d = decl({ type: "boolean" });
    for (const v of [true, false]) {
      it(`round-trips ${v}`, () => {
        const encoded = encodeForEnv(v, d);
        expect(typeof encoded).toBe("string");
        expect(decodeFromEnv(encoded, d)).toBe(v);
      });
    }
  });
});

describe("decodeFromEnv — negative cases that must return undefined", () => {
  it("rejects a decimal string for an integer-typed variable (Finding #6 regression)", () => {
    // The load-bearing case. An agent env_set of "3.14" to an integer must
    // be detectable before write, not absorbed and silently re-flagged for
    // setup on the next derivation pass.
    expect(decodeFromEnv("3.14", decl({ type: "integer" }))).toBeUndefined();
  });

  it("rejects non-numeric strings for integer", () => {
    expect(decodeFromEnv("abc", decl({ type: "integer" }))).toBeUndefined();
    expect(decodeFromEnv("", decl({ type: "integer" }))).toBeUndefined();
    expect(decodeFromEnv("1e10", decl({ type: "integer" }))).toBeUndefined();
    expect(decodeFromEnv("0x10", decl({ type: "integer" }))).toBeUndefined();
    expect(decodeFromEnv(" 42", decl({ type: "integer" }))).toBeUndefined();
  });

  it("rejects empty / whitespace strings for number", () => {
    expect(decodeFromEnv("", decl({ type: "number" }))).toBeUndefined();
    expect(decodeFromEnv("   ", decl({ type: "number" }))).toBeUndefined();
  });

  it("rejects NaN / Infinity for number", () => {
    expect(decodeFromEnv("NaN", decl({ type: "number" }))).toBeUndefined();
    expect(decodeFromEnv("Infinity", decl({ type: "number" }))).toBeUndefined();
    expect(decodeFromEnv("-Infinity", decl({ type: "number" }))).toBeUndefined();
  });

  it("rejects anything other than 'true' / 'false' for boolean", () => {
    expect(decodeFromEnv("yes", decl({ type: "boolean" }))).toBeUndefined();
    expect(decodeFromEnv("1", decl({ type: "boolean" }))).toBeUndefined();
    expect(decodeFromEnv("True", decl({ type: "boolean" }))).toBeUndefined();
    expect(decodeFromEnv("FALSE", decl({ type: "boolean" }))).toBeUndefined();
    expect(decodeFromEnv("", decl({ type: "boolean" }))).toBeUndefined();
  });

  it("accepts the empty string for a string-typed variable", () => {
    // Empty string is a valid string; only minLength on the declared schema
    // would reject it, and that's the caller's zod-parse responsibility.
    expect(decodeFromEnv("", decl({ type: "string" }))).toBe("");
  });
});

describe("encodeForEnv — output is always a string", () => {
  it("stringifies a number", () => {
    expect(encodeForEnv(3.14, decl({ type: "number" }))).toBe("3.14");
    expect(encodeForEnv(-0.5, decl({ type: "number" }))).toBe("-0.5");
  });

  it("stringifies an integer", () => {
    expect(encodeForEnv(42, decl({ type: "integer" }))).toBe("42");
    expect(encodeForEnv(-1, decl({ type: "integer" }))).toBe("-1");
  });

  it("stringifies a boolean to lowercase literal", () => {
    expect(encodeForEnv(true, decl({ type: "boolean" }))).toBe("true");
    expect(encodeForEnv(false, decl({ type: "boolean" }))).toBe("false");
  });

  it("passes a string through unchanged", () => {
    expect(encodeForEnv("hello", decl({ type: "string" }))).toBe("hello");
    expect(encodeForEnv("", decl({ type: "string" }))).toBe("");
  });
});
