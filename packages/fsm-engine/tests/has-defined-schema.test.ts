import { describe, expect, it } from "vitest";
import { hasDefinedSchema, isRecord } from "../schema-utils.ts";
import type { JSONSchema } from "../types.ts";

/**
 * Tests for `hasDefinedSchema` utility function.
 *
 * Determines whether a JSON schema defines meaningful properties that
 * warrant structured output enforcement via the `complete` tool.
 *
 * Returns `false` for empty schemas or pure catch-all schemas
 * (`additionalProperties: true` without properties).
 */
describe("hasDefinedSchema", () => {
  it("returns true for schema with properties defined", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        ticket_id: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["ticket_id"],
    };

    expect(hasDefinedSchema(schema)).toBe(true);
  });

  it("returns true for schema with properties but no required fields", () => {
    const schema: JSONSchema = { type: "object", properties: { foo: { type: "string" } } };

    expect(hasDefinedSchema(schema)).toBe(true);
  });

  it("returns false for empty properties object", () => {
    const schema: JSONSchema = { type: "object", properties: {}, additionalProperties: true };

    expect(hasDefinedSchema(schema)).toBe(false);
  });

  it("returns false for pure additionalProperties schema without properties", () => {
    const schema: JSONSchema = { type: "object", additionalProperties: true };

    expect(hasDefinedSchema(schema)).toBe(false);
  });

  it("returns false for schema with undefined properties", () => {
    const schema: JSONSchema = { type: "object" };

    expect(hasDefinedSchema(schema)).toBe(false);
  });

  it("returns false for undefined schema", () => {
    expect(hasDefinedSchema(undefined)).toBe(false);
  });

  it("returns true when additionalProperties is true but properties are also defined", () => {
    // Mixed schema: has both defined properties AND allows extras
    const schema: JSONSchema = {
      type: "object",
      properties: { id: { type: "string" } },
      additionalProperties: true,
    };

    expect(hasDefinedSchema(schema)).toBe(true);
  });

  it("returns false for additionalProperties with nested schema but no properties", () => {
    // Allows any additional properties with object type, but no defined fields
    const schema: JSONSchema = { type: "object", additionalProperties: { type: "string" } };

    expect(hasDefinedSchema(schema)).toBe(false);
  });
});

/**
 * Tests for `isRecord` type guard function.
 *
 * Used to safely narrow `unknown` types from LLM tool call args
 * without using type assertions.
 */
describe("isRecord", () => {
  it("returns true for plain object", () => {
    expect(isRecord({ foo: "bar" })).toBe(true);
    expect(isRecord({})).toBe(true);
    expect(isRecord({ nested: { value: 1 } })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2, 3])).toBe(false);
    expect(isRecord([{ foo: "bar" }])).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isRecord("string")).toBe(false);
    expect(isRecord(123)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });

  it("returns false for functions", () => {
    expect(isRecord(() => {})).toBe(false);
    expect(isRecord(function () {})).toBe(false);
  });

  it("narrows type correctly in conditional", () => {
    const value: unknown = { ticket_id: "TEST-123", priority: "high" };

    if (isRecord(value)) {
      // TypeScript knows value is Record<string, unknown> here
      expect(value.ticket_id).toEqual("TEST-123");
      expect(Object.keys(value)).toContain("priority");
    } else {
      throw new Error("Expected isRecord to return true");
    }
  });
});
