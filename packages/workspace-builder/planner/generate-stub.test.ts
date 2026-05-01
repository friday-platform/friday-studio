import type { ValidatedJSONSchema } from "@atlas/core/artifacts";
import { describe, expect, it } from "vitest";
import { generateStubFromSchema } from "./generate-stub.ts";

// ---------------------------------------------------------------------------
// Real schemas extracted from proto/runs csv-analysis-reporter phase3.json
// ---------------------------------------------------------------------------

const analysisOutputSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Analysis narrative" },
    queries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sql: { type: "string" },
          success: { type: "boolean" },
          rowCount: { type: "number" },
          error: { type: "string" },
          durationMs: { type: "number" },
          tool: { type: "string", enum: ["execute_sql", "save_results"] },
        },
        required: ["sql", "success", "rowCount", "error", "durationMs", "tool"],
      },
    },
  },
  required: ["summary", "queries"],
} satisfies ValidatedJSONSchema;

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------

describe("generateStubFromSchema — primitives", () => {
  const cases: Array<{
    name: string;
    schema: ValidatedJSONSchema;
    fieldName?: string;
    expected: unknown;
  }> = [
    {
      name: "string with fieldName",
      schema: { type: "string" },
      fieldName: "title",
      expected: "mock_title",
    },
    { name: "string without fieldName", schema: { type: "string" }, expected: "mock_value" },
    { name: "number", schema: { type: "number" }, expected: 42 },
    { name: "boolean", schema: { type: "boolean" }, expected: true },
    { name: "null", schema: { type: "null" }, expected: null },
    {
      name: "enum picks first value",
      schema: { type: "string", enum: ["execute_sql", "save_results"] },
      expected: "execute_sql",
    },
  ];

  it.each(cases)("$name → $expected", ({ schema, fieldName, expected }) => {
    expect(generateStubFromSchema(schema, fieldName)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Objects: required vs optional
// ---------------------------------------------------------------------------

describe("generateStubFromSchema — objects", () => {
  it("generates only required fields when required is set", () => {
    const schema = {
      type: "object",
      properties: {
        response: { type: "string", description: "Email send confirmation" },
        message_id: { type: "string", description: "SendGrid message ID" },
      },
      required: ["response"],
    } satisfies ValidatedJSONSchema;

    expect(generateStubFromSchema(schema)).toEqual({ response: "mock_response" });
  });

  it("generates all properties when none are required", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
    } satisfies ValidatedJSONSchema;
    expect(generateStubFromSchema(schema)).toEqual({ name: "mock_name", age: 42 });
  });

  it("object with no properties → empty object", () => {
    expect(generateStubFromSchema({ type: "object" })).toEqual({});
  });

  it("infers object type from properties when type is missing", () => {
    expect(
      generateStubFromSchema({ properties: { name: { type: "string" } }, required: ["name"] }),
    ).toEqual({ name: "mock_name" });
  });
});

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

describe("generateStubFromSchema — arrays", () => {
  it("array of strings → single-element array", () => {
    expect(generateStubFromSchema({ type: "array", items: { type: "string" } })).toEqual([
      "mock_value",
    ]);
  });

  it("array of objects → single-element with stubbed properties", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "number" }, label: { type: "string" } },
        required: ["id", "label"],
      },
    } satisfies ValidatedJSONSchema;
    expect(generateStubFromSchema(schema)).toEqual([{ id: 42, label: "mock_label" }]);
  });

  it("array with no items schema → empty array", () => {
    expect(generateStubFromSchema({ type: "array" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nested: real schema from csv-analysis-reporter
// ---------------------------------------------------------------------------

describe("generateStubFromSchema — nested recursion", () => {
  it("produces correct nested structure with objects, arrays, and enums", () => {
    expect(generateStubFromSchema(analysisOutputSchema)).toEqual({
      summary: "mock_summary",
      queries: [
        {
          sql: "mock_sql",
          success: true,
          rowCount: 42,
          error: "mock_error",
          durationMs: 42,
          tool: "execute_sql",
        },
      ],
    });
  });
});
