import { describe, expect, it } from "vitest";
import { validateResourceSchemas } from "./validate-resource-schemas.ts";

describe("validateResourceSchemas", () => {
  it("passes valid document resource schemas", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "tasks",
        name: "Tasks",
        description: "Task list",
        schema: {
          type: "object" as const,
          properties: { title: { type: "string" as const }, done: { type: "boolean" as const } },
          required: ["title"],
        },
      },
    ];

    expect(() => validateResourceSchemas(resources)).not.toThrow();
  });

  it("skips prose declarations", () => {
    const resources = [
      { type: "prose" as const, slug: "notes", name: "Notes", description: "Meeting notes" },
    ];

    expect(() => validateResourceSchemas(resources)).not.toThrow();
  });

  it("skips artifact ref declarations", () => {
    const resources = [
      {
        type: "artifact_ref" as const,
        slug: "data",
        name: "Data",
        description: "Uploaded data",
        artifactId: "abc-123",
      },
    ];

    expect(() => validateResourceSchemas(resources)).not.toThrow();
  });

  it("skips external ref declarations", () => {
    const resources = [
      {
        type: "external_ref" as const,
        slug: "tracker",
        name: "Tracker",
        description: "Project tracker",
        provider: "notion" as const,
      },
    ];

    expect(() => validateResourceSchemas(resources)).not.toThrow();
  });

  it("skips when resources array is empty", () => {
    expect(() => validateResourceSchemas([])).not.toThrow();
  });

  it("rejects schema where top-level type is not object", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "bad",
        name: "Bad",
        description: "Bad schema",
        schema: { type: "array" as const, items: { type: "string" as const } },
      },
    ];

    expect(() => validateResourceSchemas(resources)).toThrow(/bad.*type.*object/i);
  });

  it("rejects schema with missing properties", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "empty",
        name: "Empty",
        description: "No properties",
        schema: { type: "object" as const },
      },
    ];

    expect(() => validateResourceSchemas(resources)).toThrow(/empty.*properties/i);
  });

  it("rejects schema with empty properties", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "empty",
        name: "Empty",
        description: "Empty properties",
        schema: { type: "object" as const, properties: {} },
      },
    ];

    expect(() => validateResourceSchemas(resources)).toThrow(/empty.*properties/i);
  });

  it("accepts all supported property types", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "all_types",
        name: "All Types",
        description: "All supported types",
        schema: {
          type: "object" as const,
          properties: {
            text: { type: "string" as const },
            count: { type: "integer" as const },
            score: { type: "number" as const },
            active: { type: "boolean" as const },
            tags: { type: "array" as const },
            meta: { type: "object" as const },
          },
        },
      },
    ];

    expect(() => validateResourceSchemas(resources)).not.toThrow();
  });

  it("rejects unsupported property type", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "test",
        name: "Test",
        description: "Test",
        schema: { type: "object" as const, properties: { data: { type: "null" as const } } },
      },
    ];

    expect(() => validateResourceSchemas(resources)).toThrow(/data.*unsupported type/i);
  });

  it("rejects empty property name", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "test",
        name: "Test",
        description: "Test",
        schema: { type: "object" as const, properties: { "": { type: "string" as const } } },
      },
    ];

    expect(() => validateResourceSchemas(resources)).toThrow(/non-empty/i);
  });

  it("accepts camelCase and leading-digit property names", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "test",
        name: "Test",
        description: "Test",
        schema: {
          type: "object" as const,
          properties: {
            meetingDate: { type: "string" as const },
            "2024_revenue": { type: "number" as const },
            ID: { type: "string" as const },
          },
        },
      },
    ];

    expect(() => validateResourceSchemas(resources)).not.toThrow();
  });

  it("validates all document resources and reports first failure", () => {
    const resources = [
      {
        type: "document" as const,
        slug: "good",
        name: "Good",
        description: "Valid",
        schema: { type: "object" as const, properties: { name: { type: "string" as const } } },
      },
      {
        type: "document" as const,
        slug: "bad",
        name: "Bad",
        description: "Invalid",
        schema: { type: "array" as const },
      },
    ];

    expect(() => validateResourceSchemas(resources)).toThrow(/bad/i);
  });
});
