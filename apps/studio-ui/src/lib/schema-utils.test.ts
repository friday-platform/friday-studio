import { describe, expect, it } from "vitest";
import { flattenSchema, schemaToRows } from "./schema-utils.ts";

describe("schemaToRows", () => {
  it("returns empty array for null schema", () => {
    expect(schemaToRows(null)).toEqual([]);
  });

  it("returns empty array for schema without properties", () => {
    expect(schemaToRows({ type: "object" })).toEqual([]);
  });

  it("returns empty array for non-object properties value", () => {
    expect(schemaToRows({ type: "object", properties: "nope" })).toEqual([]);
  });

  it("flattens simple string properties", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string", description: "The name" }, age: { type: "integer" } },
      required: ["name"],
    };

    const rows = schemaToRows(schema);
    expect(rows).toEqual([
      { name: "name", type: "string", description: "The name", required: true, depth: 0 },
      { name: "age", type: "integer", description: "", required: false, depth: 0 },
    ]);
  });

  it("formats array types as itemType[]", () => {
    const schema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } }, items: { type: "array" } },
    };

    const rows = schemaToRows(schema);
    expect(rows[0]).toMatchObject({ name: "tags", type: "string[]" });
    expect(rows[1]).toMatchObject({ name: "items", type: "unknown[]" });
  });

  it("flattens nested object properties with dot-notation", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
            repo: { type: "string" },
          },
          required: ["path"],
        },
      },
      required: ["data"],
    };

    const rows = schemaToRows(schema);
    expect(rows).toEqual([
      { name: "data", type: "object", description: "", required: true, depth: 0 },
      { name: "data.path", type: "string", description: "File path", required: true, depth: 1 },
      { name: "data.repo", type: "string", description: "", required: false, depth: 1 },
    ]);
  });

  it("stops recursion at depth 1 (no 3-level nesting)", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "object",
              description: "Should not recurse further",
              properties: { deep: { type: "string" } },
            },
          },
        },
      },
    };

    const rows = schemaToRows(schema);
    // outer (depth 0) + inner (depth 1, treated as leaf object — no recursion)
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ name: "outer.inner", type: "object", depth: 1 });
  });

  it("handles missing type gracefully", () => {
    const schema = { type: "object", properties: { mystery: { description: "No type declared" } } };

    const rows = schemaToRows(schema);
    expect(rows[0]).toMatchObject({ type: "unknown" });
  });

  it("handles real-world pr-review clone-result schema", () => {
    const schema = {
      type: "object",
      properties: {
        operation: { type: "string" },
        success: { type: "boolean" },
        data: {
          type: "object",
          properties: {
            path: { type: "string" },
            repo: { type: "string" },
            branch: { type: "string" },
            head_sha: { type: "string" },
            pr_number: { type: "number" },
            pr_metadata: { type: "object" },
            changed_files: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["operation", "success", "data"],
    };

    const rows = schemaToRows(schema);

    // operation, success, data (parent), then 7 nested children
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({ name: "operation", required: true, depth: 0 });
    expect(rows[2]).toMatchObject({ name: "data", type: "object", depth: 0 });
    expect(rows[3]).toMatchObject({ name: "data.path", type: "string", depth: 1 });
    expect(rows[8]).toMatchObject({ name: "data.pr_metadata", type: "object", depth: 1 });
    expect(rows[9]).toMatchObject({ name: "data.changed_files", type: "string[]", depth: 1 });
  });
});

describe("flattenSchema", () => {
  it("returns empty array when properties is missing", () => {
    expect(flattenSchema({}, "", new Set(), 0)).toEqual([]);
  });

  it("uses prefix for dot-notation names", () => {
    const schema = { properties: { id: { type: "string" } } };
    const rows = flattenSchema(schema, "parent", new Set(), 1);
    expect(rows[0]).toMatchObject({ name: "parent.id" });
  });
});
