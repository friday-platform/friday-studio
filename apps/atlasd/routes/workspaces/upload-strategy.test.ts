/**
 * Tests for upload strategy: CSV→JSONB, markdown/txt→prose, large→artifact_ref.
 */

import { describe, expect, test } from "vitest";
import { classifyUpload, getTabularColumns, isProse, parseCsvToJsonb } from "./upload-strategy.ts";

// ---------------------------------------------------------------------------
// classifyUpload
// ---------------------------------------------------------------------------

describe("classifyUpload", () => {
  const FIVE_MB = 5 * 1024 * 1024;

  const cases = [
    {
      name: "small CSV → document",
      input: { fileName: "contacts.csv", fileSize: 1000 },
      expected: "document",
    },
    {
      name: "small markdown → prose",
      input: { fileName: "notes.md", fileSize: 2000 },
      expected: "prose",
    },
    {
      name: "large CSV → artifact_ref",
      input: { fileName: "huge.csv", fileSize: FIVE_MB + 1 },
      expected: "artifact_ref",
    },
    {
      name: "large markdown → artifact_ref",
      input: { fileName: "huge.md", fileSize: FIVE_MB + 1 },
      expected: "artifact_ref",
    },
    {
      name: "small non-CSV/markdown → artifact_ref",
      input: { fileName: "photo.png", fileSize: 1000 },
      expected: "artifact_ref",
    },
    {
      name: "exactly 5MB CSV → document (threshold is exclusive)",
      input: { fileName: "exact.csv", fileSize: FIVE_MB },
      expected: "document",
    },
    {
      name: "5MB + 1 byte CSV → artifact_ref (over threshold)",
      input: { fileName: "just-over.csv", fileSize: FIVE_MB + 1 },
      expected: "artifact_ref",
    },
    {
      name: "small .markdown extension → prose",
      input: { fileName: "readme.markdown", fileSize: 500 },
      expected: "prose",
    },
    {
      name: "small .txt → prose",
      input: { fileName: "notes.txt", fileSize: 1000 },
      expected: "prose",
    },
    {
      name: "large .txt → artifact_ref",
      input: { fileName: "huge.txt", fileSize: FIVE_MB + 1 },
      expected: "artifact_ref",
    },
  ] as const;

  test.each(cases)("$name", ({ input, expected }) => {
    expect(classifyUpload(input.fileName, input.fileSize)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// parseCsvToJsonb
// ---------------------------------------------------------------------------

describe("parseCsvToJsonb", () => {
  test("parses basic CSV into rows and schema", () => {
    const csv = "id,name,email\n1,Alice,alice@example.com\n2,Bob,bob@example.com";
    const result = parseCsvToJsonb(csv);

    expect(result.rows).toEqual([
      { id: "1", name: "Alice", email: "alice@example.com" },
      { id: "2", name: "Bob", email: "bob@example.com" },
    ]);
    expect(result.schema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, email: { type: "string" } },
    });
  });

  test("handles empty CSV (headers only)", () => {
    const csv = "col_a,col_b\n";
    const result = parseCsvToJsonb(csv);

    expect(result.rows).toHaveLength(0);
    expect(result.schema).toMatchObject({
      type: "object",
      properties: { col_a: { type: "string" }, col_b: { type: "string" } },
    });
  });

  test("handles quoted values with commas and newlines", () => {
    const csv = 'name,bio\nAlice,"likes cats, dogs"\nBob,"line1\nline2"';
    const result = parseCsvToJsonb(csv);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ name: "Alice", bio: "likes cats, dogs" });
    expect(result.rows[1]).toEqual({ name: "Bob", bio: "line1\nline2" });
  });

  test("trims whitespace from headers", () => {
    const csv = " name , age \nAlice,30";
    const result = parseCsvToJsonb(csv);

    expect(result.rows[0]).toMatchObject({ name: "Alice", age: "30" });
    expect(result.schema.properties).toHaveProperty("name");
    expect(result.schema.properties).toHaveProperty("age");
  });

  test("throws on CSV with no headers", () => {
    expect(() => parseCsvToJsonb("")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isProse
// ---------------------------------------------------------------------------

describe("isProse", () => {
  test("returns true for canonical prose schema", () => {
    expect(isProse({ type: "string", format: "markdown" })).toBe(true);
  });

  test("returns true for prose schema with extra properties", () => {
    expect(isProse({ type: "string", format: "markdown", description: "notes" })).toBe(true);
  });

  test("returns false for tabular schema", () => {
    expect(isProse({ type: "object", properties: { name: { type: "string" } } })).toBe(false);
  });

  test("returns false for null", () => {
    expect(isProse(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isProse(undefined)).toBe(false);
  });

  test("returns false for random object", () => {
    expect(isProse({ foo: "bar" })).toBe(false);
  });

  test("returns false for non-markdown format", () => {
    expect(isProse({ type: "string", format: "email" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTabularColumns
// ---------------------------------------------------------------------------

describe("getTabularColumns", () => {
  test("extracts column names from tabular schema", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" }, email: { type: "string" } },
    };
    expect(getTabularColumns(schema)).toEqual(["name", "age", "email"]);
  });

  test("returns empty array for prose schema", () => {
    expect(getTabularColumns({ type: "string", format: "markdown" })).toEqual([]);
  });

  test("returns empty array for null", () => {
    expect(getTabularColumns(null)).toEqual([]);
  });

  test("returns empty array for undefined", () => {
    expect(getTabularColumns(undefined)).toEqual([]);
  });

  test("returns empty array for empty object", () => {
    expect(getTabularColumns({})).toEqual([]);
  });

  test("returns empty array for object without properties field", () => {
    expect(getTabularColumns({ type: "object" })).toEqual([]);
  });
});
