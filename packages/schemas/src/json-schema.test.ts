import { describe, expect, it } from "vitest";
import { JSONSchemaSchema, sanitizeJsonSchema, type ValidatedJSONSchema } from "./json-schema.ts";

// ---------------------------------------------------------------------------
// JSONSchemaSchema — rejects composition keywords
// ---------------------------------------------------------------------------

describe("JSONSchemaSchema", () => {
  it("strips anyOf, oneOf, allOf, not during parse", () => {
    const raw = {
      type: "object",
      properties: { name: { type: "string" } },
      anyOf: [{ type: "string" }],
      oneOf: [{ type: "number" }],
      allOf: [{ type: "boolean" }],
      not: { type: "null" },
    };

    const result = JSONSchemaSchema.parse(raw);

    expect(result).toEqual({ type: "object", properties: { name: { type: "string" } } });
    expect(result).not.toHaveProperty("anyOf");
    expect(result).not.toHaveProperty("oneOf");
    expect(result).not.toHaveProperty("allOf");
    expect(result).not.toHaveProperty("not");
  });

  it("accepts schemas with only engine-supported keywords", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", description: "User name" },
        age: { type: "number", minimum: 0 },
      },
      required: ["name"],
    };

    expect(JSONSchemaSchema.parse(schema)).toEqual(schema);
  });

  it("rejects invalid type values", () => {
    expect(() => JSONSchemaSchema.parse({ type: "nonsense" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// sanitizeJsonSchema
// ---------------------------------------------------------------------------

describe("sanitizeJsonSchema", () => {
  it("passes through schemas that only use supported keywords", () => {
    const schema: ValidatedJSONSchema = {
      type: "object",
      properties: {
        name: { type: "string", description: "User name" },
        age: { type: "number", minimum: 0 },
      },
      required: ["name"],
    };
    expect(sanitizeJsonSchema(schema)).toEqual(schema);
  });

  it("strips composition keywords from nested properties", () => {
    const raw = {
      type: "object",
      properties: { rowCount: { anyOf: [{ type: "number" }, { type: "null" }] } },
      required: ["rowCount"],
    };

    // anyOf is stripped at parse time; nested schemas only keep supported keys
    expect(sanitizeJsonSchema(raw)).toEqual({
      type: "object",
      properties: { rowCount: {} },
      required: ["rowCount"],
    });
  });

  it("strips unknown keywords like $ref, $defs, const", () => {
    const raw = {
      type: "string",
      description: "keep this",
      $ref: "#/defs/Foo",
      $defs: { Foo: { type: "string" } },
      const: "literal",
    };

    expect(sanitizeJsonSchema(raw)).toEqual({ type: "string", description: "keep this" });
  });

  it("recurses into nested properties and items", () => {
    const raw = {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: {
            type: "object",
            properties: { sql: { type: "string" }, rowCount: { type: "number" } },
            required: ["sql", "rowCount"],
          },
        },
      },
      required: ["queries"],
    };

    expect(sanitizeJsonSchema(raw)).toEqual(raw);
  });

  it("rejects invalid input", () => {
    expect(() => sanitizeJsonSchema({ type: "nonsense" })).toThrow();
  });
});
