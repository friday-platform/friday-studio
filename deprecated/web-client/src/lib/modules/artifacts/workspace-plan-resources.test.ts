import type { ValidatedJSONSchema } from "@atlas/schemas/json-schema";
import { ExternalRefDeclarationSchema, type ResourceDeclaration } from "@atlas/schemas/workspace";
import { describe, expect, it, test } from "vitest";
import {
  humanizeColumnName,
  transformResourcesForDisplay,
} from "./workspace-plan-resources.svelte.ts";

// ---------------------------------------------------------------------------
// Helpers — builder for document resources with JSON Schema
// ---------------------------------------------------------------------------

function documentResource(
  overrides: Partial<{
    slug: string;
    name: string;
    description: string;
    schema: Record<string, unknown>;
  }> = {},
): ResourceDeclaration {
  return {
    type: "document" as const,
    slug: overrides.slug ?? "test_resource",
    name: overrides.name ?? "Test Resource",
    description: overrides.description ?? "A test resource",
    // ValidatedJSONSchema cast is allowed — typed unknown from z.lazy()
    schema: (overrides.schema ?? {
      type: "object",
      properties: { title: { type: "string" } },
    }) as ValidatedJSONSchema,
  };
}

function externalRef(
  overrides: Partial<{
    slug: string;
    name: string;
    description: string;
    provider: string;
    ref: string;
  }> = {},
): ResourceDeclaration {
  return ExternalRefDeclarationSchema.parse({
    type: "external_ref",
    slug: overrides.slug ?? "ext_ref",
    name: overrides.name ?? "External Ref",
    description: overrides.description ?? "An external reference",
    provider: overrides.provider ?? "google-sheets",
    ...(overrides.ref !== undefined ? { ref: overrides.ref } : {}),
  });
}

// ---------------------------------------------------------------------------
// transformResourcesForDisplay
// ---------------------------------------------------------------------------

describe("transformResourcesForDisplay", () => {
  it("returns empty items and zero overflow for empty input", () => {
    const result = transformResourcesForDisplay([]);
    expect(result.items).toHaveLength(0);
    expect(result.overflow).toBe(0);
  });

  // -------------------------------------------------------------------------
  // External ref detection
  // -------------------------------------------------------------------------

  describe("external refs", () => {
    it("detects external ref with provider and ref", () => {
      const { items } = transformResourcesForDisplay([
        externalRef({ provider: "google-sheets", ref: "https://sheets.google.com/abc" }),
      ]);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "external",
        name: "External Ref",
        description: "An external reference",
        provider: "google-sheets",
        ref: "https://sheets.google.com/abc",
      });
    });

    it("external ref without ref omits ref property", () => {
      const { items } = transformResourcesForDisplay([externalRef({ provider: "notion" })]);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "external", provider: "notion" });
      expect(items[0]).not.toHaveProperty("ref");
    });
  });

  // -------------------------------------------------------------------------
  // Structured resource detection
  // -------------------------------------------------------------------------

  describe("structured resources", () => {
    it("4 scalar columns produce structured with friendly types", () => {
      const { items } = transformResourcesForDisplay([
        documentResource({
          name: "Grocery List",
          description: "Items to buy",
          schema: {
            type: "object",
            properties: {
              item: { type: "string" },
              quantity: { type: "integer" },
              price: { type: "number" },
              purchased: { type: "boolean" },
            },
          },
        }),
      ]);

      expect(items).toHaveLength(1);
      const item = items[0];
      if (!item || item.kind !== "structured") throw new Error("Expected structured display item");
      expect(item.columns).toEqual([
        { name: "Item", type: "text" },
        { name: "Quantity", type: "number" },
        { name: "Price", type: "number" },
        { name: "Purchased", type: "yes/no" },
      ]);
    });

    it("2 columns with mixed types stay structured (not document)", () => {
      const { items } = transformResourcesForDisplay([
        documentResource({
          schema: {
            type: "object",
            properties: { name: { type: "string" }, price: { type: "number" } },
          },
        }),
      ]);

      expect(items[0]).toMatchObject({ kind: "structured" });
    });

    it("3 columns including text stays structured", () => {
      const { items } = transformResourcesForDisplay([
        documentResource({
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              content: { type: "string" },
              count: { type: "integer" },
            },
          },
        }),
      ]);

      expect(items[0]).toMatchObject({ kind: "structured" });
    });
  });

  // -------------------------------------------------------------------------
  // Nested table extraction
  // -------------------------------------------------------------------------

  describe("nested tables", () => {
    it("extracts array-of-objects as nested sub-table", () => {
      const { items } = transformResourcesForDisplay([
        documentResource({
          name: "Recipes",
          description: "Saved recipes",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              servings: { type: "integer" },
              cook_time: { type: "number" },
              ingredients: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    quantity: { type: "number" },
                    unit: { type: "string" },
                  },
                },
              },
            },
          },
        }),
      ]);

      expect(items).toHaveLength(1);
      const item = items[0];
      if (!item || item.kind !== "structured") throw new Error("Expected structured display item");
      expect(item.columns).toEqual([
        { name: "Name", type: "text" },
        { name: "Servings", type: "number" },
        { name: "Cook Time", type: "number" },
      ]);
      expect(item.nested).toEqual([
        {
          name: "Ingredients",
          columns: [
            { name: "Name", type: "text" },
            { name: "Quantity", type: "number" },
            { name: "Unit", type: "text" },
          ],
        },
      ]);
    });

    it("deeply nested structure shows inner level as list, not recursed", () => {
      const { items } = transformResourcesForDisplay([
        documentResource({
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              sections: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    heading: { type: "string" },
                    items: {
                      type: "array",
                      items: { type: "object", properties: { text: { type: "string" } } },
                    },
                  },
                },
              },
            },
          },
        }),
      ]);

      const item = items[0];
      if (!item || item.kind !== "structured") throw new Error("Expected structured display item");

      // Inner nested array-of-objects at second level should be "list", not recursed
      expect.assert(item.nested !== undefined);
      expect(item.nested).toHaveLength(1);
      const sections = item.nested[0];
      expect.assert(sections !== undefined);
      expect(sections.name).toBe("Sections");
      expect(sections.columns).toContainEqual({ name: "Heading", type: "text" });
      expect(sections.columns).toContainEqual({ name: "Items", type: "list" });
    });
  });

  // -------------------------------------------------------------------------
  // Document detection
  // -------------------------------------------------------------------------

  describe("document detection", () => {
    it("1 text column is document", () => {
      const { items } = transformResourcesForDisplay([
        documentResource({
          name: "Meeting Notes",
          description: "Running log",
          schema: { type: "object", properties: { content: { type: "string" } } },
        }),
      ]);

      expect(items[0]).toMatchObject({
        kind: "document",
        name: "Meeting Notes",
        description: "Running log",
      });
    });

    it("2 text columns (title + content) is document", () => {
      const { items } = transformResourcesForDisplay([
        documentResource({
          schema: {
            type: "object",
            properties: { title: { type: "string" }, content: { type: "string" } },
          },
        }),
      ]);

      expect(items[0]).toMatchObject({ kind: "document" });
    });
  });

  // -------------------------------------------------------------------------
  // Graceful degradation
  // -------------------------------------------------------------------------

  describe("graceful degradation", () => {
    it("missing properties yields structured with empty columns", () => {
      const { items } = transformResourcesForDisplay([
        documentResource({
          name: "Broken",
          description: "Missing props",
          schema: { type: "object" },
        }),
      ]);

      expect(items[0]).toMatchObject({
        kind: "structured",
        name: "Broken",
        description: "Missing props",
        columns: [],
      });
    });

    it("empty properties yields structured with empty columns", () => {
      const { items } = transformResourcesForDisplay([
        documentResource({ schema: { type: "object", properties: {} } }),
      ]);

      expect(items[0]).toMatchObject({ kind: "structured", columns: [] });
    });
  });

  // -------------------------------------------------------------------------
  // Type label mapping
  // -------------------------------------------------------------------------

  describe("type labels", () => {
    const typeLabelCases = [
      { name: "boolean → yes/no", schema: { type: "boolean" }, expected: "yes/no" },
      { name: "string → text", schema: { type: "string" }, expected: "text" },
      { name: "integer → number", schema: { type: "integer" }, expected: "number" },
      { name: "number → number", schema: { type: "number" }, expected: "number" },
      { name: "array → list", schema: { type: "array" }, expected: "list" },
      { name: "object (no props) → data", schema: { type: "object" }, expected: "data" },
      {
        name: 'format: "date" → date',
        schema: { type: "string", format: "date" },
        expected: "date",
      },
      {
        name: 'format: "date-time" → date/time',
        schema: { type: "string", format: "date-time" },
        expected: "date/time",
      },
      {
        name: 'format: "email" → email',
        schema: { type: "string", format: "email" },
        expected: "email",
      },
      { name: 'format: "uri" → link', schema: { type: "string", format: "uri" }, expected: "link" },
      {
        name: "enum → choice",
        schema: { type: "string", enum: ["a", "b", "c"] },
        expected: "choice",
      },
      {
        name: "enum takes priority over format",
        schema: { type: "string", enum: ["a", "b"], format: "date" },
        expected: "choice",
      },
      {
        name: "unknown format falls through to text",
        schema: { type: "string", format: "custom-thing" },
        expected: "text",
      },
    ] as const;

    test.each(typeLabelCases)("$name", ({ schema, expected }) => {
      // Always include a non-string anchor column to prevent document detection
      // (≤2 all-text columns → document), keeping the result structured.
      const { items } = transformResourcesForDisplay([
        documentResource({
          schema: {
            type: "object",
            properties: { field: schema as Record<string, unknown>, anchor: { type: "integer" } },
          },
        }),
      ]);

      const item = items[0];
      if (!item || item.kind !== "structured") throw new Error("Expected structured display item");
      const firstCol = item.columns[0];
      expect.assert(firstCol !== undefined);
      expect(firstCol.type).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // Display cap
  // -------------------------------------------------------------------------

  describe("display cap", () => {
    it("5 or fewer resources have zero overflow", () => {
      const resources = Array.from({ length: 5 }, (_, i) =>
        documentResource({ slug: `r_${i}`, name: `Resource ${i}` }),
      );
      const result = transformResourcesForDisplay(resources);

      expect(result.items).toHaveLength(5);
      expect(result.overflow).toBe(0);
    });

    it("6 resources returns 5 items with overflow 1", () => {
      const resources = Array.from({ length: 6 }, (_, i) =>
        documentResource({ slug: `r_${i}`, name: `Resource ${i}` }),
      );
      const result = transformResourcesForDisplay(resources);

      expect(result.items).toHaveLength(5);
      expect(result.overflow).toBe(1);
    });

    it("10 resources returns 5 items with overflow 5", () => {
      const resources = Array.from({ length: 10 }, (_, i) =>
        documentResource({ slug: `r_${i}`, name: `Resource ${i}` }),
      );
      const result = transformResourcesForDisplay(resources);

      expect(result.items).toHaveLength(5);
      expect(result.overflow).toBe(5);
      // First 5 should be the first 5 resources in order
      expect(result.items[0]).toMatchObject({ name: "Resource 0" });
      expect(result.items[4]).toMatchObject({ name: "Resource 4" });
    });
  });
});

// ---------------------------------------------------------------------------
// humanizeColumnName
// ---------------------------------------------------------------------------

describe("humanizeColumnName", () => {
  const cases = [
    { name: "single word", input: "name", expected: "Name" },
    { name: "snake_case", input: "cook_time", expected: "Cook Time" },
    { name: "multi underscore", input: "created_at_utc", expected: "Created At Utc" },
  ] as const;

  test.each(cases)("$name: $input → $expected", ({ input, expected }) => {
    expect(humanizeColumnName(input)).toBe(expected);
  });
});
