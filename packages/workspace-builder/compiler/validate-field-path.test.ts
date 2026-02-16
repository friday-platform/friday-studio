import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import { validateFieldPath } from "./validate-field-path.ts";

// ---------------------------------------------------------------------------
// validateFieldPath — non-composition scenarios
// ---------------------------------------------------------------------------

describe("validateFieldPath", () => {
  const schema: ValidatedJSONSchema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      count: { type: "number" },
      queries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            sql: { type: "string" },
            result: { type: "object", properties: { rows: { type: "number" } } },
          },
        },
      },
    },
  };

  it("accepts valid root-level path", () => {
    expect(validateFieldPath(schema, "summary")).toEqual({ valid: true, type: "string" });
  });

  it("accepts valid nested path", () => {
    expect(validateFieldPath(schema, "queries[].result.rows")).toEqual({
      valid: true,
      type: "number",
    });
  });

  it("handles numeric index as array item access", () => {
    expect(validateFieldPath(schema, "queries.0.sql")).toEqual({ valid: true, type: "string" });
  });

  it("rejects invalid path and returns available siblings", () => {
    expect(validateFieldPath(schema, "nonexistent")).toEqual({
      valid: false,
      available: ["summary", "count", "queries"],
    });
  });

  it("rejects invalid nested path at correct depth", () => {
    expect(validateFieldPath(schema, "queries[].bogus")).toEqual({
      valid: false,
      available: ["sql", "result"],
    });
  });

  it("returns empty available for schema with no properties", () => {
    const leaf: ValidatedJSONSchema = { type: "string" };
    expect(validateFieldPath(leaf, "anything")).toEqual({ valid: false, available: [] });
  });

  it("returns 'unknown' type when leaf has no type field", () => {
    const noType: ValidatedJSONSchema = { type: "object", properties: { flexible: {} } };
    expect(validateFieldPath(noType, "flexible")).toEqual({ valid: true, type: "unknown" });
  });

  it("rejects array access on non-array field", () => {
    expect(validateFieldPath(schema, "summary[]")).toEqual({ valid: false, available: [] });
  });
});
